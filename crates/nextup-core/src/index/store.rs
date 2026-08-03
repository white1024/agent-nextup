use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::index::chunker::Chunk;
use crate::index::scanner::ScannedFile;
use crate::workspace::context::now_rfc3339;

/// SQLite/FTS5 store at `.nextup/index.sqlite`. Strictly a rebuildable
/// derivative (D4): dropping the file loses nothing — files are the truth.
/// It is deliberately excluded from backups and the watcher whitelist.
pub struct IndexStore {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub built_at: String,
    pub files: u32,
    pub chunks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// FTS5 snippet with «»-marked matches.
    pub snippet: String,
}

fn db_err(e: rusqlite::Error) -> NextUpError {
    NextUpError::Workspace(format!("index database error: {e}"))
}

impl IndexStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).map_err(db_err)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS files(
               path TEXT PRIMARY KEY, size INTEGER NOT NULL,
               language TEXT, chunk_count INTEGER NOT NULL);
             CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
               content, path UNINDEXED, start_line UNINDEXED,
               end_line UNINDEXED, language UNINDEXED);",
        )
        .map_err(db_err)?;
        Ok(Self { conn })
    }

    /// Full rebuild = wipe and refill (files-as-truth; no incremental
    /// bookkeeping to drift out of sync).
    pub fn clear(&mut self) -> Result<()> {
        self.conn
            .execute_batch("DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;")
            .map_err(db_err)
    }

    pub fn insert_file(&mut self, file: &ScannedFile, chunks: &[Chunk]) -> Result<()> {
        let tx = self.conn.transaction().map_err(db_err)?;
        tx.execute(
            "INSERT OR REPLACE INTO files(path, size, language, chunk_count) VALUES (?1, ?2, ?3, ?4)",
            params![file.rel_path, file.size as i64, file.language, chunks.len() as i64],
        )
        .map_err(db_err)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO chunks(content, path, start_line, end_line, language)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(db_err)?;
            for c in chunks {
                stmt.execute(params![
                    c.content,
                    file.rel_path,
                    c.start_line as i64,
                    c.end_line as i64,
                    file.language
                ])
                .map_err(db_err)?;
            }
        }
        tx.commit().map_err(db_err)
    }

    pub fn finish(&mut self, files: u32, chunks: u32) -> Result<()> {
        for (key, value) in [
            ("builtAt", now_rfc3339()),
            ("files", files.to_string()),
            ("chunks", chunks.to_string()),
        ] {
            self.conn
                .execute(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)",
                    params![key, value],
                )
                .map_err(db_err)?;
        }
        Ok(())
    }

    pub fn info(&self) -> Result<Option<IndexInfo>> {
        let mut stmt =
            self.conn.prepare("SELECT key, value FROM meta").map_err(db_err)?;
        let mut built_at = None;
        let mut files = 0u32;
        let mut chunks = 0u32;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(db_err)?;
        for row in rows {
            let (k, v) = row.map_err(db_err)?;
            match k.as_str() {
                "builtAt" => built_at = Some(v),
                "files" => files = v.parse().unwrap_or(0),
                "chunks" => chunks = v.parse().unwrap_or(0),
                _ => {}
            }
        }
        Ok(built_at.map(|built_at| IndexInfo { built_at, files, chunks }))
    }

    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<SearchHit>> {
        let fts = fts_query(query);
        if fts.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT path, start_line, end_line, language,
                        snippet(chunks, 0, '«', '»', ' … ', 14)
                 FROM chunks WHERE chunks MATCH ?1
                 ORDER BY rank LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![fts, limit as i64], |r| {
                Ok(SearchHit {
                    path: r.get(0)?,
                    start_line: r.get::<_, i64>(1)? as u32,
                    end_line: r.get::<_, i64>(2)? as u32,
                    language: r.get(3)?,
                    snippet: r.get(4)?,
                })
            })
            .map_err(db_err)?;
        let mut hits = Vec::new();
        for row in rows {
            hits.push(row.map_err(db_err)?);
        }
        Ok(hits)
    }
}

/// Quote every whitespace token so user input can never hit FTS5 query
/// syntax (`AND`, `*`, unbalanced quotes ⇒ hard errors). Tokens are
/// implicitly ANDed.
fn fts_query(user: &str) -> String {
    user.split_whitespace()
        .map(|tok| format!("\"{}\"", tok.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::chunker::chunk_text;

    fn file(rel: &str, language: Option<&str>) -> ScannedFile {
        ScannedFile {
            rel_path: rel.into(),
            size: 100,
            language: language.map(str::to_string),
            is_markdown: false,
        }
    }

    fn store() -> (tempfile::TempDir, IndexStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = IndexStore::open(&dir.path().join(".nextup/index.sqlite")).unwrap();
        (dir, store)
    }

    #[test]
    fn fts5_roundtrip_search_and_rank() {
        let (_g, mut store) = store();
        store.clear().unwrap();
        let code_chunks = chunk_text("fn decrypt_envelope() { aes_gcm_open() }", false);
        store.insert_file(&file("src/crypto.rs", Some("rust")), &code_chunks).unwrap();
        let md = ScannedFile {
            rel_path: "docs/backup.md".into(),
            size: 50,
            language: Some("markdown".into()),
            is_markdown: true,
        };
        let md_chunks = chunk_text("# 備份說明\n通行片語重新加密 envelope", true);
        store.insert_file(&md, &md_chunks).unwrap();
        store.finish(2, 2).unwrap();

        let hits = store.search("envelope", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.path == "src/crypto.rs"));
        assert!(hits[0].snippet.contains('«'));

        let hits = store.search("decrypt_envelope", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].language.as_deref(), Some("rust"));
        assert_eq!(hits[0].start_line, 1);
    }

    #[test]
    fn hostile_query_syntax_cannot_break_fts5() {
        let (_g, mut store) = store();
        store.insert_file(&file("a.txt", None), &chunk_text("hello world", false)).unwrap();
        for hostile in ["AND OR NOT", "\"unbalanced", "col:x", "a*", "(((", "-x"] {
            let _ = store.search(hostile, 5).unwrap(); // must not error
        }
        assert!(store.search("   ", 5).unwrap().is_empty());
    }

    #[test]
    fn info_is_none_until_finished_then_reports_counts() {
        let (_g, mut store) = store();
        assert!(store.info().unwrap().is_none());
        store.finish(3, 17).unwrap();
        let info = store.info().unwrap().unwrap();
        assert_eq!((info.files, info.chunks), (3, 17));
        assert!(!info.built_at.is_empty());
    }

    #[test]
    fn clear_wipes_previous_build() {
        let (_g, mut store) = store();
        store.insert_file(&file("a.txt", None), &chunk_text("needle", false)).unwrap();
        store.finish(1, 1).unwrap();
        store.clear().unwrap();
        assert!(store.search("needle", 5).unwrap().is_empty());
        assert!(store.info().unwrap().is_none());
    }
}
