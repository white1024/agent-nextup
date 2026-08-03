use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::index::chunker::chunk_text;
use crate::index::draft::{collect_todos, draft_adoption, AdoptionDraft, TodoHit};
use crate::index::scanner::{looks_binary, scan};
use crate::index::store::{IndexInfo, IndexStore, SearchHit};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{ledger_for, LedgerEvent, LedgerKind};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub indexed: u32,
    pub total: u32,
}

/// How many skip-reason examples the summary carries. Enough to answer "why
/// is my file missing from search" without bloating the payload.
const SKIP_SAMPLE_CAP: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub files: u32,
    pub chunks: u32,
    /// Total skipped (scan-stage noise + the two breakdowns below).
    pub skipped: u32,
    /// Candidates that could not be read (permissions, races).
    #[serde(default)]
    pub skipped_unreadable: u32,
    /// Candidates whose content sniffed as binary despite a texty extension.
    #[serde(default)]
    pub skipped_binary: u32,
    /// First few skipped paths with their reason, for diagnostics.
    #[serde(default)]
    pub skipped_samples: Vec<String>,
    pub todos: u32,
    pub duration_ms: u64,
}

/// Full rebuild of the workspace index (scan → chunk → FTS5), streaming
/// progress through `on_progress` so the IPC layer can forward it as
/// events. Files are read exactly once; TODO/FIXME markers are collected
/// on the same pass and the count lands in the summary.
pub fn build_index(
    paths: &WorkspacePaths,
    on_progress: &mut dyn FnMut(IndexProgress),
) -> Result<IndexSummary> {
    let started = Instant::now();
    let summary = scan(paths.root())?;
    let total = summary.candidates.len() as u32;
    let mut skipped = summary.skipped;

    let mut store = IndexStore::open(&paths.index_file())?;
    store.clear()?;

    let mut files = 0u32;
    let mut chunks_total = 0u32;
    let mut skipped_unreadable = 0u32;
    let mut skipped_binary = 0u32;
    let mut skipped_samples: Vec<String> = Vec::new();
    let mut todos: Vec<TodoHit> = Vec::new();
    for (i, file) in summary.candidates.iter().enumerate() {
        let abs = paths.root().join(&file.rel_path);
        let Ok(bytes) = std::fs::read(&abs) else {
            skipped += 1;
            skipped_unreadable += 1;
            if skipped_samples.len() < SKIP_SAMPLE_CAP {
                skipped_samples.push(format!("{}: unreadable", file.rel_path));
            }
            continue;
        };
        if looks_binary(&bytes) {
            skipped += 1;
            skipped_binary += 1;
            if skipped_samples.len() < SKIP_SAMPLE_CAP {
                skipped_samples.push(format!("{}: binary content", file.rel_path));
            }
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        collect_todos(&file.rel_path, &content, &mut todos);
        let chunks = chunk_text(&content, file.is_markdown);
        if !chunks.is_empty() {
            store.insert_file(file, &chunks)?;
            files += 1;
            chunks_total += chunks.len() as u32;
        }
        on_progress(IndexProgress { indexed: (i + 1) as u32, total });
    }
    store.finish(files, chunks_total)?;

    ledger_for(paths).append(&LedgerEvent::new(
        LedgerKind::IndexBuilt,
        format!("full-text index rebuilt: {files} files, {chunks_total} chunks"),
        None,
    ))?;

    Ok(IndexSummary {
        files,
        chunks: chunks_total,
        skipped,
        skipped_unreadable,
        skipped_binary,
        skipped_samples,
        todos: todos.len() as u32,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Hard ceiling on search results. Lives here — not in the delivery layers —
/// so the GUI and the MCP hub cannot drift apart on policy.
pub const SEARCH_LIMIT_MAX: u32 = 100;

pub fn search_index(paths: &WorkspacePaths, query: &str, limit: u32) -> Result<Vec<SearchHit>> {
    if !paths.index_file().is_file() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, SEARCH_LIMIT_MAX);
    IndexStore::open(&paths.index_file())?.search(query, limit)
}

pub fn index_status(paths: &WorkspacePaths) -> Result<Option<IndexInfo>> {
    if !paths.index_file().is_file() {
        return Ok(None);
    }
    IndexStore::open(&paths.index_file())?.info()
}

/// Turn a confirmed draft into a real workspace: initialize the `.nextup`
/// layer + takeover files (existing content is never overwritten), then
/// create the user-approved suggested tasks through the consistency layer
/// so ledger and handoff stay coherent.
pub fn adopt_legacy_project(
    params: &crate::workspace::init::InitProjectParams,
    tasks: Vec<crate::workspace::tasks::NewTask>,
    keys: &dyn crate::security::keystore::KeyProvider,
    app_version: &str,
) -> Result<crate::workspace::context::ProjectContext> {
    let context = crate::workspace::init::initialize_project(params, keys, app_version)?;
    let paths = WorkspacePaths::new(params.root.trim());
    for task in tasks {
        crate::workspace::ops::create_task(&paths, app_version, task)?;
    }
    Ok(context)
}

/// Analyze a *legacy* root (not necessarily an Agent NextUp workspace) and draft
/// adoption material. Read-only: nothing is written until the user
/// confirms via the normal initialize/scaffold flow.
pub fn draft_legacy(root: &Path) -> Result<AdoptionDraft> {
    let summary = scan(root)?;
    let mut todos: Vec<TodoHit> = Vec::new();
    for file in &summary.candidates {
        let Ok(bytes) = std::fs::read(root.join(&file.rel_path)) else { continue };
        if looks_binary(&bytes) {
            continue;
        }
        collect_todos(&file.rel_path, &String::from_utf8_lossy(&bytes), &mut todos);
    }
    Ok(draft_adoption(root, &summary.candidates, &todos))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    fn write(paths: &WorkspacePaths, rel: &str, content: &str) {
        let p = paths.root().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn build_search_status_roundtrip_with_progress() {
        let (_g, paths) = workspace();
        write(&paths, "src/lib.rs", "pub fn seal_envelope() {}\n// TODO: harden nonce handling\n");
        write(&paths, "docs/guide.md", "# 使用說明\n備份與 envelope 重加密\n");

        let mut ticks = 0u32;
        let summary = build_index(&paths, &mut |p| {
            ticks += 1;
            assert!(p.indexed <= p.total);
        })
        .unwrap();
        assert_eq!(summary.files, 2);
        assert!(summary.chunks >= 2);
        assert_eq!(summary.todos, 1);
        assert_eq!(ticks, 2);

        let hits = search_index(&paths, "envelope", 10).unwrap();
        assert_eq!(hits.len(), 2);

        let info = index_status(&paths).unwrap().unwrap();
        assert_eq!(info.files, 2);

        // Rebuild after a file changes reflects the new truth.
        write(&paths, "src/lib.rs", "pub fn open_envelope() {}\n");
        build_index(&paths, &mut |_| {}).unwrap();
        let hits = search_index(&paths, "seal_envelope", 10).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn ledger_records_the_rebuild() {
        let (_g, paths) = workspace();
        write(&paths, "a.txt", "hello index");
        build_index(&paths, &mut |_| {}).unwrap();
        let events = ledger_for(&paths).recent_of_kind(LedgerKind::IndexBuilt, 5).unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].message.contains("1 files"));
    }

    #[test]
    fn missing_index_gives_empty_results_not_errors() {
        let (_g, paths) = workspace();
        assert!(search_index(&paths, "anything", 5).unwrap().is_empty());
        assert!(index_status(&paths).unwrap().is_none());
    }

    #[test]
    fn draft_legacy_is_read_only_analysis() {
        let (_g, paths) = workspace();
        write(&paths, "src/app.py", "# TODO: split module\nprint('hi')\n");
        let draft = draft_legacy(paths.root()).unwrap();
        assert_eq!(draft.domain, "coding");
        assert_eq!(draft.languages, vec!["python"]);
        assert_eq!(draft.suggested_tasks.len(), 1);
        // Nothing written: no .nextup dir, no index file.
        assert!(!paths.nextup_dir().exists());
    }

    #[test]
    fn adopt_legacy_initializes_and_creates_approved_tasks() {
        use crate::security::keystore::StaticKeyProvider;
        use crate::workspace::init::InitProjectParams;
        use crate::workspace::tasks::TaskStore;

        let (_g, paths) = workspace();
        write(&paths, "src/app.py", "# TODO: split module\nprint('hi')\n");
        let draft = draft_legacy(paths.root()).unwrap();

        let params = InitProjectParams {
            root: paths.root().to_string_lossy().into_owned(),
            name: draft.name.clone(),
            domain: draft.domain.clone(),
            description: draft.description.clone(),
            goals: vec![],
            boundaries: vec![],
            ..Default::default()
        };
        let ctx = adopt_legacy_project(
            &params,
            draft.suggested_tasks.clone(),
            &StaticKeyProvider([5u8; 32]),
            "0.1.0",
        )
        .unwrap();
        assert_eq!(ctx.domain, "coding");
        assert!(paths.nextup_dir().exists());
        // The legacy source file is untouched, tasks were created.
        assert!(paths.root().join("src/app.py").exists());
        let tasks = TaskStore::new(paths.tasks_dir()).list().unwrap();
        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].title.contains("Handle marker"));
    }
}
