use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Directories that never contain indexable project knowledge. `.nextup` is
/// engine data (ledger/snapshots churn would pollute search results).
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".nextup",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
];

/// Obvious binary payloads by extension — cheaper than sniffing them all.
const BINARY_EXTS: &[&str] = &[
    "exe", "dll", "so", "dylib", "bin", "obj", "o", "a", "lib", "pdb", "png", "jpg", "jpeg",
    "gif", "webp", "ico", "bmp", "mp3", "mp4", "avi", "mov", "zip", "gz", "xz", "zst", "7z",
    "rar", "pdf", "woff", "woff2", "ttf", "otf", "eot", "sqlite", "db", "lock",
];

/// Files above this size are skipped: generated bundles and data dumps
/// drown out real code in search results.
pub const MAX_FILE_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    /// Forward-slash relative path (stable across OSes for the index).
    pub rel_path: String,
    pub size: u64,
    /// Extension-based hint ("rust", "typescript", …); None = plain text.
    pub language: Option<String>,
    pub is_markdown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub candidates: Vec<ScannedFile>,
    pub skipped: u32,
}

/// Walk `root` and collect text-file candidates. Content is *not* read
/// here — the indexing pass streams file-by-file to keep memory flat.
pub fn scan(root: &Path) -> Result<ScanSummary> {
    let mut candidates = Vec::new();
    let mut skipped: u32 = 0;

    let walker = walkdir::WalkDir::new(root).follow_links(false).into_iter();
    for entry in walker.filter_entry(|e| !is_skipped_dir(e)) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
        let Ok(rel) = entry.path().strip_prefix(root) else {
            skipped += 1;
            continue;
        };
        let rel_path = rel.to_string_lossy().replace('\\', "/");
        let ext = extension_of(&rel_path);

        if size > MAX_FILE_BYTES || BINARY_EXTS.contains(&ext.as_str()) {
            skipped += 1;
            continue;
        }
        candidates.push(ScannedFile {
            language: language_for(&ext),
            is_markdown: ext == "md" || ext == "markdown",
            rel_path,
            size,
        });
    }
    candidates.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(ScanSummary { candidates, skipped })
}

/// Null byte in the first 4 KiB ⇒ binary despite a texty extension.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(4096).any(|&b| b == 0)
}

fn is_skipped_dir(entry: &walkdir::DirEntry) -> bool {
    entry.file_type().is_dir()
        && entry
            .file_name()
            .to_str()
            .is_some_and(|name| SKIP_DIRS.contains(&name))
}

fn extension_of(rel_path: &str) -> String {
    rel_path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase()
}

fn language_for(ext: &str) -> Option<String> {
    let lang = match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "sh" | "bash" => "shell",
        "ps1" | "psm1" => "powershell",
        "sql" => "sql",
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" | "markdown" => "markdown",
        _ => return None,
    };
    Some(lang.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, content: &[u8]) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn collects_text_files_and_skips_noise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "src/main.rs", b"fn main() {}\n");
        write(root, "README.md", b"# hello\n");
        write(root, "logo.png", &[0x89, 0x50, 0x4E, 0x47]);
        write(root, "node_modules/pkg/index.js", b"x");
        write(root, ".git/HEAD", b"ref: refs/heads/main");
        write(root, ".nextup/ledger.jsonl", b"{}");

        let summary = scan(root).unwrap();
        let paths: Vec<&str> = summary.candidates.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["README.md", "src/main.rs"]);
        assert_eq!(summary.skipped, 1); // the png; skipped dirs are pruned silently
        assert_eq!(summary.candidates[1].language.as_deref(), Some("rust"));
        assert!(summary.candidates[0].is_markdown);
    }

    #[test]
    fn oversized_files_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "big.txt", &vec![b'a'; (MAX_FILE_BYTES + 1) as usize]);
        let summary = scan(dir.path()).unwrap();
        assert!(summary.candidates.is_empty());
        assert_eq!(summary.skipped, 1);
    }

    #[test]
    fn binary_sniff_catches_null_bytes() {
        assert!(looks_binary(b"MZ\x00\x03"));
        assert!(!looks_binary("普通文字 plain text".as_bytes()));
    }
}
