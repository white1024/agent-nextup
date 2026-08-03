//! Module B foundation (Phase 3c): scan an existing codebase, chunk it
//! language-agnostically, and keep a rebuildable SQLite/FTS5 full-text
//! index under `.nextup/index.sqlite` (D4: files are the truth, the index
//! is a derivative — excluded from backups and the watcher whitelist).
//! `draft_legacy` turns a scan into adoption material (context + tasks)
//! for taking over projects that were never Agent NextUp workspaces.

pub mod chunker;
pub mod draft;
pub mod ops;
pub mod scanner;
pub mod store;

pub use draft::AdoptionDraft;
pub use ops::{
    adopt_legacy_project, build_index, draft_legacy, index_status, search_index, IndexProgress,
    IndexSummary,
};
pub use store::{IndexInfo, SearchHit};
