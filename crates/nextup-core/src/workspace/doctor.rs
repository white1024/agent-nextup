//! Workspace doctor: machine-checkable document health (nextup_docs/04, D18).
//!
//! The takeover layer only works while its documents stay honest: the field
//! survey's most common failure was a bloated CLAUDE.md plus index files whose
//! references quietly died ("routing table lists it ≠ it exists"). The doctor
//! turns those health rules into deterministic checks instead of prose
//! guidelines.
//!
//! Two modes, detected from the target directory:
//! - **Managed** (`.nextup/context.json` present): full check set — document
//!   checks plus engine surfaces (marker block, task files, handoff
//!   freshness).
//! - **Docs-only** (anything else): the generic document checks only. This is
//!   the dogfood mode — the Agent NextUp development repo itself is the first
//!   patient, so the doctor must not require an `.nextup/` to be useful.
//!
//! Read-only by design: running the doctor never mutates the workspace, so it
//! sits in the read tier of the agent hub and can back a workflow gate.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::workspace::bootstrap::{STATE_BEGIN, STATE_END};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{ledger_for, LedgerKind};
use crate::workspace::tasks::{Task, TaskStatus};

/// The survey's bloat line: every 20KB+ CLAUDE.md examined had drifted into a
/// multi-source-of-truth swamp.
pub const CLAUDE_MD_MAX_BYTES: u64 = 20 * 1024;
/// A handoff older than this while open tasks exist is treated as stale.
pub const HANDOFF_STALE_DAYS: i64 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorMode {
    Managed,
    DocsOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorSeverity {
    /// Health risk — worth attention, does not fail a gate.
    Warning,
    /// A takeover mechanism is broken (dead reference, unparsable state).
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFinding {
    /// Stable check id, e.g. `broken_link`, `claude_md_size`.
    pub check: String,
    pub severity: DoctorSeverity,
    /// Workspace-relative path (or path-like locator) the finding is about.
    pub target: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub mode: DoctorMode,
    pub checked_at: String,
    pub errors: usize,
    pub warnings: usize,
    pub findings: Vec<DoctorFinding>,
}

impl DoctorReport {
    /// Gate semantics: warnings advise, errors block.
    pub fn is_clean(&self) -> bool {
        self.errors == 0
    }
}

/// Run every applicable check against `root`. Read-only.
pub fn run_doctor(root: &Path) -> Result<DoctorReport> {
    run_doctor_at(root, Utc::now())
}

/// Deterministic core with an injected clock (staleness checks are the only
/// time-dependent part).
pub fn run_doctor_at(root: &Path, now: DateTime<Utc>) -> Result<DoctorReport> {
    let paths = WorkspacePaths::new(root);
    let mode = if paths.is_initialized() { DoctorMode::Managed } else { DoctorMode::DocsOnly };
    let mut findings = Vec::new();

    check_entry_document(&paths, mode, &mut findings);
    check_links(root, &mut findings);

    if mode == DoctorMode::Managed {
        check_entry_shell(&paths, &mut findings);
        check_marker_block(&paths, &mut findings);
        check_skill_mirrors(&paths, &mut findings);
        check_context(&paths, &mut findings);
        check_modules(&paths, &mut findings);
        check_task_files(&paths, &mut findings)?;
        check_handoff(&paths, now, &mut findings)?;
        check_shipped_assets(&paths, &mut findings);
        check_exchange(&paths, &mut findings);
        check_specs(&paths, &mut findings)?;
    }

    let errors = findings.iter().filter(|f| f.severity == DoctorSeverity::Error).count();
    let warnings = findings.len() - errors;
    Ok(DoctorReport {
        mode,
        checked_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        errors,
        warnings,
        findings,
    })
}

fn finding(
    check: &str,
    severity: DoctorSeverity,
    target: impl Into<String>,
    message: impl Into<String>,
) -> DoctorFinding {
    DoctorFinding { check: check.into(), severity, target: target.into(), message: message.into() }
}

// ── Generic document checks (both modes) ────────────────────────────────────

/// Size and presence of the entry document.
///
/// Which file that *is* depends on the mode (D82): a managed workspace carries
/// the body in `AGENTS.md` with `CLAUDE.md` reduced to an import shell, while a
/// docs-only repo (this one included) has no `AGENTS.md` at all and its
/// `CLAUDE.md` is still the real index. Checking the wrong one would either
/// nag every plain repo about a file it should not have, or measure the shell
/// and call a bloated body healthy.
fn check_entry_document(paths: &WorkspacePaths, mode: DoctorMode, findings: &mut Vec<DoctorFinding>) {
    let (file, name) = match mode {
        DoctorMode::Managed => (paths.agents_md_file(), "AGENTS.md"),
        DoctorMode::DocsOnly => (paths.claude_md_file(), "CLAUDE.md"),
    };
    match std::fs::metadata(&file) {
        Ok(meta) => {
            if meta.len() > CLAUDE_MD_MAX_BYTES {
                findings.push(finding(
                    "claude_md_size",
                    DoctorSeverity::Warning,
                    name,
                    format!(
                        "{name} is {} KB (bloat line: {} KB) — facts belong in their \
                         source-of-truth files, the entry point stays an index",
                        meta.len() / 1024,
                        CLAUDE_MD_MAX_BYTES / 1024
                    ),
                ));
            }
        }
        Err(_) => {
            // A managed workspace scaffolds it; its absence means the takeover
            // entry point is gone. A plain repo merely goes without.
            let severity = match mode {
                DoctorMode::Managed => DoctorSeverity::Error,
                DoctorMode::DocsOnly => DoctorSeverity::Warning,
            };
            findings.push(finding(
                "claude_md_missing",
                severity,
                name,
                format!("no {name} — AI sessions have no takeover entry point"),
            ));
        }
    }
}

/// The `CLAUDE.md` shell must exist and must still import `AGENTS.md` (D82).
///
/// This is the one failure in the inverted layout that is both easy to cause
/// and completely silent: Claude Code reads `CLAUDE.md` and nothing else, so a
/// shell that lost its `@AGENTS.md` line leaves the session with **no** state
/// block, no protocol and no index — and every other check still passes,
/// because `AGENTS.md` itself is perfectly healthy.
fn check_entry_shell(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) {
    let Ok(content) = std::fs::read_to_string(paths.claude_md_file()) else {
        findings.push(finding(
            "entry_shell",
            DoctorSeverity::Error,
            "CLAUDE.md",
            "no CLAUDE.md — Claude Code reads only this name, so the AGENTS.md \
             body is unreachable from it",
        ));
        return;
    };
    if !crate::workspace::bootstrap::imports_agents_md(&content) {
        findings.push(finding(
            "entry_shell",
            DoctorSeverity::Error,
            "CLAUDE.md",
            "CLAUDE.md no longer imports AGENTS.md (@AGENTS.md) — Claude Code \
             sessions load none of the takeover layer, and nothing else reports it",
        ));
    }
}

/// The two skill copies must stay byte-identical (D82).
///
/// A single compiled-in source guarantees the engine *writes* the same bytes
/// to both; it guarantees nothing about what is on disk afterwards. Writes are
/// write-if-missing, `upgrade_assets` never overwrites a `Customized` file and
/// the asset check stays quiet about one — so a user editing the `.claude/`
/// copy (the only one Claude Code reads) gets a permanent, silent fork. That
/// is not hypothetical: a reference repo in the same survey had already drifted
/// its two copies apart by a few hundred bytes.
fn check_skill_mirrors(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) {
    for (name, _) in crate::workspace::bootstrap::WORKSPACE_SKILLS {
        let [(canon_rel, canon), (mirror_rel, mirror)] = paths.skill_files(name);
        // Missing files are the shipped-asset check's business, not ours; we
        // only speak up when both exist and disagree.
        let (Ok(a), Ok(b)) =
            (std::fs::read_to_string(&canon), std::fs::read_to_string(&mirror))
        else {
            continue;
        };
        if a != b {
            findings.push(finding(
                "skill_mirror",
                DoctorSeverity::Error,
                mirror_rel.clone(),
                format!(
                    "{canon_rel} and {mirror_rel} have drifted apart — they are meant to be \
                     the same file, and Claude Code only reads the second one, so the \
                     canonical copy is no longer what runs"
                ),
            ));
        }
    }
}

/// Route integrity: every relative markdown link in the takeover documents
/// must resolve. A dead reference in an index is exactly how "the routing
/// table lists it" and "it exists" drift apart.
fn check_links(root: &Path, findings: &mut Vec<DoctorFinding>) {
    for file in doc_files(root) {
        let Ok(content) = std::fs::read_to_string(&file) else { continue };
        let base = file.parent().unwrap_or(root);
        for target in extract_relative_links(&content) {
            if !base.join(&target).exists() {
                let rel = file.strip_prefix(root).unwrap_or(&file).display().to_string();
                findings.push(finding(
                    "broken_link",
                    DoctorSeverity::Error,
                    rel.replace('\\', "/"),
                    format!("dead reference: links to '{target}' which does not exist"),
                ));
            }
        }
    }
}

/// The documents the takeover layer routes through: root-level markdown plus
/// one directory level of `nextup_docs/` and `memory/`.
fn doc_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut collect = |dir: &Path| {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                files.push(path);
            }
        }
    };
    collect(root);
    let paths = WorkspacePaths::new(root);
    collect(&paths.nextup_docs_dir());
    collect(&paths.memory_dir());
    files
}

/// Pull the targets of `[text](target)` links, keeping only ones that can
/// name a workspace file (no URLs, no pure anchors), fragments stripped.
/// Code is prose here, not routing: fenced blocks and inline code spans are
/// dropped first, so link-format *examples* don't count as references.
fn extract_relative_links(raw: &str) -> Vec<String> {
    let mut prose = String::with_capacity(raw.len());
    let mut in_fence = false;
    for line in raw.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Between an odd and the next even backtick lies inline code.
        for (idx, segment) in line.split('`').enumerate() {
            if idx % 2 == 0 {
                prose.push_str(segment);
            }
        }
        prose.push('\n');
    }
    let content = prose.as_str();

    let mut targets = Vec::new();
    let mut i = 0;
    while let Some(pos) = content[i..].find("](") {
        let start = i + pos + 2;
        let Some(len) = content[start..].find(')') else { break };
        let raw = &content[start..start + len];
        i = start + len;
        // `[x](a "title")` — the target ends at the first whitespace.
        let raw = raw.split_whitespace().next().unwrap_or("");
        // Drop the fragment; a pure anchor link needs no file check.
        let target = raw.split('#').next().unwrap_or("");
        if target.is_empty() || target.contains("://") || target.starts_with("mailto:") {
            continue;
        }
        targets.push(target.to_string());
    }
    targets
}

// ── Managed-workspace checks ────────────────────────────────────────────────

fn check_marker_block(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) {
    let Ok(content) = std::fs::read_to_string(paths.agents_md_file()) else { return };
    let begin = content.find(STATE_BEGIN);
    let end = content.find(STATE_END);
    let ok = matches!((begin, end), (Some(b), Some(e)) if b < e);
    if !ok {
        findings.push(finding(
            "marker_block",
            DoctorSeverity::Error,
            "AGENTS.md",
            "engine state markers missing or malformed — bootstrap::refresh silently \
             skips this file, so the state block will never update again",
        ));
    }
}

fn check_context(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) {
    if let Err(e) = crate::workspace::context::load_context(&paths.context_file()) {
        findings.push(finding(
            "context_file",
            DoctorSeverity::Error,
            ".nextup/context.json",
            format!("context.json does not load: {e}"),
        ));
    }
}

/// TaskStore::list skips unparsable files silently (by design, so one corrupt
/// file never poisons the list) — the doctor is where that corruption becomes
/// visible instead of invisible.
fn check_task_files(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) -> Result<()> {
    let dir = paths.tasks_dir();
    if !dir.exists() {
        return Ok(());
    }
    let mut parsed: Vec<Task> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read(&path).ok().and_then(|raw| serde_json::from_slice::<Task>(&raw).ok()) {
            Some(task) => parsed.push(task),
            None => {
                let name = entry.file_name().to_string_lossy().into_owned();
                findings.push(finding(
                    "task_file",
                    DoctorSeverity::Error,
                    format!("tasks/{name}"),
                    "task file does not parse — it is invisible to listings, counts and gates",
                ));
            }
        }
    }
    // Dependency integrity (D31): an edge into a missing task permanently
    // locks its dependents and misleads a takeover session about what is
    // startable — the graph is part of the takeover surface.
    let ids: std::collections::HashSet<&str> = parsed.iter().map(|t| t.id.as_str()).collect();
    for task in &parsed {
        for dep in &task.depends_on {
            if !ids.contains(dep.as_str()) {
                findings.push(finding(
                    "task_dependency",
                    DoctorSeverity::Error,
                    format!("tasks/{}.json", task.id),
                    format!("depends on {dep}, which does not exist — the task can never unlock"),
                ));
            }
        }
    }
    Ok(())
}

/// Shipped-curriculum freshness (D38): outdated / missing / undetermined
/// engine-shipped files warn — this is the agent's discovery channel for
/// "this workspace's teaching materials lag the engine". Customized files
/// are a legitimate, `write_if_missing`-guaranteed state and stay silent
/// (the GUI upgrade panel is where they show). Read-only like every check:
/// fingerprint backfill lives in scaffold/upgrade, never here.
/// An unreadable `modules.json` is an error in its own right (D82). Every
/// module-shaped surface reads it — the tool list, the STATE block, and the
/// curriculum that keeps module guides upgraded — and each of those degrades
/// *quietly* when the read fails (`check_shipped_assets` below simply returns).
/// Without this check the workspace would look healthy while an agent silently
/// lost both the tools and the contract for a capability it is supposed to have.
fn check_modules(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) {
    let file = paths.modules_file();
    if !file.is_file() {
        return; // absent = nothing enabled, the documented default
    }
    let modules = match crate::workspace::modules::get_modules(paths) {
        Ok(m) => m,
        Err(err) => {
            findings.push(finding(
                "modules",
                DoctorSeverity::Error,
                ".nextup/modules.json",
                format!(
                    "cannot be read ({err}) — module tools, the STATE module-guide line and \
                     module-guide upgrades all silently fall back to 'nothing enabled' until \
                     this parses"
                ),
            ));
            return;
        }
    };

    // Prime is keyed on the workspace's stable id (D116): `Team.prime` names
    // an id, so a workspace without one cannot be designated and every prime
    // tool fails with "never joined a team" — while the switch sits visibly
    // on. Only pre-D48 workspaces reach this (init has minted ids since), and
    // joining any team backfills it.
    if modules.is_enabled(crate::workspace::modules::MODULE_PRIME) {
        let missing_id = crate::workspace::context::load_context(&paths.context_file())
            .map(|ctx| ctx.workspace_id.is_none())
            .unwrap_or(false);
        if missing_id {
            findings.push(finding(
                "prime_without_identity",
                DoctorSeverity::Warning,
                ".nextup/context.json",
                "the prime module is on but this workspace has no stable id, so it cannot be \
                 named as any team's coordinator — join a team once from the team view and the \
                 id is minted",
            ));
        }
    }
}

fn check_shipped_assets(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) {
    let Ok(ctx) = crate::workspace::context::load_context(&paths.context_file()) else {
        return; // check_context already reports an unloadable context
    };
    let Ok(statuses) = crate::workspace::assets::assets_status_with(paths, &ctx) else {
        return;
    };
    use crate::workspace::assets::AssetState;
    for status in statuses {
        let message = match status.state {
            AssetState::UpgradeSafe => {
                "engine-shipped file is outdated — upgrade it from the Agent NextUp tools page \
                 or the upgrade_workspace_assets tool (pristine: nothing of yours is lost)"
            }
            AssetState::Missing => {
                "engine-shipped file is missing — the tools-page upgrade (or scaffold \
                 repair) recreates it"
            }
            AssetState::ManualReview => {
                "cannot tell engine-shipped from customized (predates fingerprinting) — \
                 decide once in the Agent NextUp tools page: keep as yours, or upgrade with backup"
            }
            AssetState::UpToDate | AssetState::Customized => continue,
        };
        findings.push(finding("shipped_asset", DoctorSeverity::Warning, status.path, message));
    }
}

#[cfg(test)]
mod modules_check_tests {
    use super::*;

    /// Break the file, and the doctor must say so — the whole point of D82's
    /// module gating is that "what is enabled" stays knowable.
    #[test]
    fn corrupt_modules_json_is_reported_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.modules_file().parent().unwrap()).unwrap();
        let mut findings = Vec::new();

        check_modules(&paths, &mut findings);
        assert!(findings.is_empty(), "no file = nothing enabled, not a problem");

        std::fs::write(paths.modules_file(), b"{ not json").unwrap();
        check_modules(&paths, &mut findings);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].severity, DoctorSeverity::Error);
        assert_eq!(findings[0].target, ".nextup/modules.json");
    }
}

/// Delivery envelopes (D48): a torn/unparsable envelope is invisible to
/// listings (they deliberately skip it), so the doctor is the surface that
/// names it. Warning, not error — the takeover chain itself is intact.
// ── Spec layer (D79) ────────────────────────────────────────────────────────

/// Warning-level checks over `specs/` and the task delta bundles
/// (nextup_docs/15 §7): parse health, oversized specs, orphaned or
/// stale-after-fold bundles, and fold conflicts that will make the archive
/// refuse (or the auto sweep skip) a task. All read-only dry-runs.
fn check_specs(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) -> Result<()> {
    use crate::workspace::layout::SPEC_FILE;
    use crate::workspace::specs;
    use crate::workspace::tasks::TaskStore;
    const SPEC_SIZE_LIMIT: usize = 32 * 1024;

    for capability in specs::list_capabilities(paths)? {
        let rel = format!("specs/{capability}/spec.md");
        // Unreadable content (e.g. a Big5 file from an old editor) is this
        // file's finding, never a doctor crash (the check_task_files rule).
        let content = match specs::read_current_spec(paths, &capability) {
            Ok(Some(content)) => content,
            Ok(None) => continue,
            Err(e) => {
                findings.push(finding("spec_parse", DoctorSeverity::Warning, rel, e.to_string()));
                continue;
            }
        };
        if content.len() > SPEC_SIZE_LIMIT {
            findings.push(finding(
                "spec_size",
                DoctorSeverity::Warning,
                rel.clone(),
                format!(
                    "spec file is {}KB (limit 32KB) — split the capability or prune stale requirements",
                    content.len() / 1024
                ),
            ));
        }
        if specs::parse_spec(&content).unclosed_fence {
            findings.push(finding(
                "spec_parse",
                DoctorSeverity::Warning,
                rel,
                "unclosed code fence masks everything after it — folds will refuse this file",
            ));
        }
    }

    // A corrupt task file is check_task_files' finding, not a doctor crash.
    let Ok(tasks) = TaskStore::new(paths.tasks_dir()).list() else { return Ok(()) };
    for task in &tasks {
        let rel = format!("tasks/{}/specs/", task.id);
        let deltas = match specs::read_task_deltas(paths, &task.id) {
            Ok(deltas) => deltas,
            Err(e) => {
                findings.push(finding(
                    "spec_parse",
                    DoctorSeverity::Warning,
                    rel,
                    format!("unreadable delta bundle: {e}"),
                ));
                continue;
            }
        };
        if deltas.is_empty() {
            continue;
        }
        if let Some(folded_at) = &task.spec_folded_at {
            // Folded, then the bundle changed: those edits never fold again
            // by themselves — the marker only clears when the task reopens.
            let Ok(folded) = DateTime::parse_from_rfc3339(folded_at) else { continue };
            let folded = folded.with_timezone(&Utc);
            let dir = paths.task_delta_specs_dir(&task.id);
            // One second of tolerance: the marker is truncated to whole
            // seconds (now_rfc3339) while NTFS mtimes carry sub-second
            // precision — a fold landing in the same wall-clock second as
            // the delta's last write must not read as an edit (batch ②
            // review: scripted flows hit this 3/3).
            let edited_after = deltas.iter().any(|d| {
                std::fs::metadata(dir.join(&d.capability).join(SPEC_FILE))
                    .and_then(|m| m.modified())
                    .map(|t| DateTime::<Utc>::from(t) > folded + chrono::Duration::seconds(1))
                    .unwrap_or(false)
            });
            if edited_after {
                findings.push(finding(
                    "spec_delta_stale",
                    DoctorSeverity::Warning,
                    rel,
                    format!(
                        "{} delta specs were edited after their fold ({folded_at}) — reopen and re-archive the task to fold the new edits",
                        task.id
                    ),
                ));
            }
            continue;
        }
        if task.archived {
            findings.push(finding(
                "spec_delta_orphan",
                DoctorSeverity::Warning,
                rel,
                format!(
                    "{} is archived but its delta specs were never folded — unarchive and re-archive to fold them",
                    task.id
                ),
            ));
            continue;
        }
        // Dry-run the fold for every unfolded bundle; sweep candidates get
        // the sharper wording (the auto sweep will silently skip them).
        let plan = match specs::plan_task_fold(paths, &deltas) {
            Ok(plan) => plan,
            Err(e) => {
                findings.push(finding(
                    "spec_parse",
                    DoctorSeverity::Warning,
                    rel,
                    format!("unreadable main spec for dry-run: {e}"),
                ));
                continue;
            }
        };
        if let Err(problems) = plan {
            let lead = if task.status == TaskStatus::Done && task.is_verified() {
                "fold would conflict — archive will refuse and the auto sweep will skip this task"
            } else {
                "delta specs do not fold cleanly yet"
            };
            findings.push(finding(
                "spec_fold_conflict",
                DoctorSeverity::Warning,
                rel,
                format!("{}: {lead}: {}", task.id, problems.join("; ")),
            ));
        }
    }

    // Bundle directories whose task file is gone (a failed removal after a
    // delete, or a hand-copied dir): the task-driven checks above cannot
    // see them, so they would silently rot.
    if let Ok(entries) = std::fs::read_dir(paths.tasks_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if !tasks.iter().any(|t| t.id == id) {
                findings.push(finding(
                    "spec_delta_orphan",
                    DoctorSeverity::Warning,
                    format!("tasks/{id}/"),
                    "artifact bundle has no task file (left over from a failed delete?) — remove the directory by hand",
                ));
            }
        }
    }
    Ok(())
}

fn check_exchange(paths: &WorkspacePaths, findings: &mut Vec<DoctorFinding>) {
    use crate::workspace::exchange::{DeliveryEnvelope, ENVELOPE_SCHEMA_VERSION};
    for (label, dir) in [("inbox", paths.inbox_dir()), ("outbox", paths.outbox_dir())] {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        // Attachment bytes live in a `<id>/` sibling directory; collect the
        // envelope file stems so a folder with no envelope reads as an orphan.
        let mut json_stems: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut subdirs: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                subdirs.push(name);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                json_stems.insert(stem.to_string());
            }
            let target = format!(".nextup/exchange/{label}/{name}");
            match crate::workspace::atomic::read_json_file::<DeliveryEnvelope>(&path) {
                Err(_) => findings.push(finding(
                    "delivery_envelope",
                    DoctorSeverity::Warning,
                    target,
                    "delivery envelope does not parse — it is invisible to listings; \
                     ask the sender to re-publish (or remove the file)",
                )),
                Ok(envelope) if envelope.schema_version > ENVELOPE_SCHEMA_VERSION => {
                    findings.push(finding(
                        "delivery_envelope",
                        DoctorSeverity::Warning,
                        target,
                        "delivery envelope schema is newer than this app supports — \
                         upgrade Agent NextUp to read it",
                    ))
                }
                Ok(envelope) => {
                    // Each listed attachment's bytes must be present and sized
                    // as the manifest says — warning, not error: the takeover
                    // chain itself is intact.
                    for att in &envelope.payload.attachments {
                        let att_target = format!(
                            ".nextup/exchange/{label}/{}/{}",
                            envelope.id,
                            att.stored_path()
                        );
                        // A manifest path is data from another workspace, so it
                        // is checked before it is joined; an unusable one is
                        // reported rather than resolved.
                        let Ok(relative) = att.safe_relative() else {
                            findings.push(finding(
                                "delivery_attachment",
                                DoctorSeverity::Warning,
                                att_target,
                                "attachment path in the envelope is not a safe relative path — \
                                 the envelope is malformed; ask the sender to re-publish",
                            ));
                            continue;
                        };
                        match std::fs::metadata(dir.join(&envelope.id).join(relative)) {
                            Err(_) => findings.push(finding(
                                "delivery_attachment",
                                DoctorSeverity::Warning,
                                att_target,
                                "attachment file is missing — the envelope lists it but the bytes \
                                 are gone; ask the sender to re-publish",
                            )),
                            Ok(m) if m.len() != att.size_bytes => findings.push(finding(
                                "delivery_attachment",
                                DoctorSeverity::Warning,
                                att_target,
                                "attachment size does not match the envelope manifest",
                            )),
                            Ok(_) => {}
                        }
                    }
                }
            }
        }
        for sub in subdirs {
            if !json_stems.contains(&sub) {
                findings.push(finding(
                    "delivery_attachment",
                    DoctorSeverity::Warning,
                    format!(".nextup/exchange/{label}/{sub}"),
                    "orphan attachment directory — no envelope references it; safe to remove",
                ));
            }
        }
    }
}

fn check_handoff(
    paths: &WorkspacePaths,
    now: DateTime<Utc>,
    findings: &mut Vec<DoctorFinding>,
) -> Result<()> {
    let file = paths.handoff_file();
    if !file.is_file() {
        findings.push(finding(
            "handoff_missing",
            DoctorSeverity::Warning,
            ".nextup/snapshots/latest_handoff.md",
            "no handoff snapshot yet — a new session has no state to bootstrap from",
        ));
        return Ok(());
    }
    // When the engine last refreshed the snapshot — from the ledger's own
    // structured record (`handoff_generated` is appended on every sync), not
    // from parsing the "> Generated: …" header prose (D75). No event on file
    // means the snapshot is hand-maintained, and the freshness of what a
    // person writes themselves is not the engine's to judge.
    let generated = ledger_for(paths)
        .recent_of_kind(LedgerKind::HandoffGenerated, 1)?
        .pop()
        .and_then(|e| DateTime::parse_from_rfc3339(&e.at).ok());
    let Some(generated) = generated else {
        return Ok(());
    };
    let age_days = (now - generated.with_timezone(&Utc)).num_days();
    if age_days >= HANDOFF_STALE_DAYS {
        let tasks = crate::workspace::tasks::TaskStore::new(paths.tasks_dir()).list()?;
        let open = tasks.iter().filter(|t| t.status != TaskStatus::Done).count();
        if open > 0 {
            findings.push(finding(
                "handoff_stale",
                DoctorSeverity::Warning,
                ".nextup/snapshots/latest_handoff.md",
                format!(
                    "handoff snapshot is {age_days} days old while {open} task(s) are \
                     still open — regenerate it so the next session starts from reality"
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::tasks::NewTask;

    fn managed_workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "doctor-test".into(),
                domain: "coding".into(),
                description: String::new(),
                goals: vec![],
                boundaries: vec![],
                ..Default::default()
            },
            &StaticKeyProvider([9u8; 32]),
            "0.0.0-test",
        )
        .unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    fn checks_of(report: &DoctorReport) -> Vec<&str> {
        report.findings.iter().map(|f| f.check.as_str()).collect()
    }

    /// A prime workspace is keyed on its stable id, so one without an id has a
    /// switch that is visibly on and does nothing (D116).
    #[test]
    fn prime_without_a_stable_id_is_named() {
        let (_guard, paths) = managed_workspace();
        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_PRIME,
            true,
        )
        .unwrap();

        // Init has minted ids since D48 — a healthy workspace stays silent.
        assert!(!checks_of(&run_doctor(paths.root()).unwrap()).contains(&"prime_without_identity"));

        // Strip it back to the pre-D48 shape.
        let mut ctx = crate::workspace::context::load_context(&paths.context_file()).unwrap();
        ctx.workspace_id = None;
        crate::workspace::context::save_context(&paths.context_file(), &ctx).unwrap();

        assert!(checks_of(&run_doctor(paths.root()).unwrap()).contains(&"prime_without_identity"));
    }

    #[test]
    fn fresh_managed_workspace_is_clean() {
        let (_g, paths) = managed_workspace();
        let report = run_doctor(paths.root()).unwrap();
        assert_eq!(report.mode, DoctorMode::Managed);
        assert!(report.is_clean(), "unexpected findings: {:?}", report.findings);
        assert_eq!(report.warnings, 0, "unexpected findings: {:?}", report.findings);
    }

    #[test]
    fn oversized_claude_md_warns() {
        let (_g, paths) = managed_workspace();
        let mut content = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        content.push_str(&"x".repeat(CLAUDE_MD_MAX_BYTES as usize));
        std::fs::write(paths.agents_md_file(), content).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        assert!(checks_of(&report).contains(&"claude_md_size"));
        assert!(report.is_clean(), "size is a warning, not an error");
    }

    #[test]
    fn dead_reference_is_an_error() {
        let (_g, paths) = managed_workspace();
        let mut content = std::fs::read_to_string(paths.claude_md_file()).unwrap();
        content.push_str("\n[phantom](nextup_docs/does-not-exist.md)\n");
        std::fs::write(paths.claude_md_file(), content).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let broken: Vec<_> =
            report.findings.iter().filter(|f| f.check == "broken_link").collect();
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].target, "CLAUDE.md");
        assert!(broken[0].message.contains("does-not-exist.md"));
        assert!(!report.is_clean());
    }

    #[test]
    fn urls_anchors_and_titles_are_not_link_findings() {
        let links = extract_relative_links(
            "[a](https://example.com) [b](#section) [c](mailto:x@y.z) \
             [d](nextup_docs/x.md#part) [e](y.md \"title\") ![img](img.png)",
        );
        assert_eq!(links, vec!["nextup_docs/x.md", "y.md", "img.png"]);
    }

    #[test]
    fn code_spans_and_fences_are_prose_not_references() {
        let links = extract_relative_links(
            "convention: `- [Title](file.md) — hook`\n\
             ```\n[sample](inside-fence.md)\n```\n\
             [real](real.md)\n",
        );
        assert_eq!(links, vec!["real.md"]);
    }

    #[test]
    fn removed_markers_are_an_error() {
        let (_g, paths) = managed_workspace();
        let content = std::fs::read_to_string(paths.agents_md_file()).unwrap();
        let content = content.replace(STATE_BEGIN, "").replace(STATE_END, "");
        std::fs::write(paths.agents_md_file(), content).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        assert!(checks_of(&report).contains(&"marker_block"));
        assert!(!report.is_clean());
    }

    /// The shell losing its import is the silent total failure of the D82
    /// layout: AGENTS.md stays perfectly healthy, so nothing else notices that
    /// Claude Code now loads none of the takeover layer.
    #[test]
    fn a_shell_that_stops_importing_the_body_is_an_error() {
        let (_g, paths) = managed_workspace();
        std::fs::write(paths.claude_md_file(), "# my project\n\nnotes I typed myself\n").unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let hit = report.findings.iter().find(|f| f.check == "entry_shell").unwrap();
        assert_eq!(hit.target, "CLAUDE.md");
        assert_eq!(hit.severity, DoctorSeverity::Error);
        // The body is untouched, so the checks that watch it stay quiet —
        // which is exactly why this check has to exist separately.
        assert!(!checks_of(&report).contains(&"marker_block"));
    }

    /// The host skips imports inside fences and code spans, so the check must
    /// too — otherwise it blesses a shell that loads nothing.
    #[test]
    fn import_detection_matches_what_the_host_actually_honours() {
        assert!(crate::workspace::bootstrap::imports_agents_md("# x\n\n@AGENTS.md\n"));
        assert!(crate::workspace::bootstrap::imports_agents_md("See @AGENTS.md for details.\n"), "inline imports fire");
        assert!(crate::workspace::bootstrap::imports_agents_md("- @AGENTS.md\n"), "list item");

        assert!(!crate::workspace::bootstrap::imports_agents_md("```\n@AGENTS.md\n```\n"), "fenced is skipped by the host");
        assert!(!crate::workspace::bootstrap::imports_agents_md("~~~\n@AGENTS.md\n~~~\n"), "tilde fences too");
        assert!(!crate::workspace::bootstrap::imports_agents_md("Write `@AGENTS.md` to import.\n"), "code span is skipped");
        assert!(!crate::workspace::bootstrap::imports_agents_md("@AGENTS.mdx\n"), "a different file is not this file");
        assert!(!crate::workspace::bootstrap::imports_agents_md("# just my own notes\n"));
    }

    #[test]
    fn a_deleted_shell_is_an_error_even_though_the_body_is_fine() {
        let (_g, paths) = managed_workspace();
        std::fs::remove_file(paths.claude_md_file()).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        assert!(checks_of(&report).contains(&"entry_shell"));
        // AGENTS.md is the entry document in managed mode, and it is still
        // there — so the missing-entry check must NOT fire for CLAUDE.md.
        assert!(!checks_of(&report).contains(&"claude_md_missing"));
    }

    /// A single compiled-in source guarantees identical *writes*, not identical
    /// files. Editing the `.claude/` copy (the only one Claude Code reads) is
    /// the realistic way the pair forks, and every other check stays silent.
    #[test]
    fn drifted_skill_copies_are_an_error() {
        let (_g, paths) = managed_workspace();
        let (name, _) = crate::workspace::bootstrap::WORKSPACE_SKILLS[0];
        let [(canon_rel, _), (mirror_rel, mirror)] = paths.skill_files(name);
        std::fs::write(&mirror, "# hand-edited only on the Claude Code side\n").unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let hit = report.findings.iter().find(|f| f.check == "skill_mirror").unwrap();
        assert_eq!(hit.severity, DoctorSeverity::Error);
        assert_eq!(hit.target, mirror_rel);
        assert!(hit.message.contains(&canon_rel));
        assert!(!report.is_clean());
    }

    #[test]
    fn matching_skill_copies_are_silent_and_a_missing_one_is_not_our_business() {
        let (_g, paths) = managed_workspace();
        let report = run_doctor(paths.root()).unwrap();
        assert!(!checks_of(&report).contains(&"skill_mirror"), "identical copies say nothing");

        // A missing file is the shipped-asset check's job; reporting it here
        // too would double-count the same fact under a misleading name.
        let (name, _) = crate::workspace::bootstrap::WORKSPACE_SKILLS[0];
        std::fs::remove_file(paths.skill_file(name)).unwrap();
        let report = run_doctor(paths.root()).unwrap();
        assert!(!checks_of(&report).contains(&"skill_mirror"));
    }

    #[test]
    fn corrupt_task_file_is_an_error() {
        let (_g, paths) = managed_workspace();
        std::fs::create_dir_all(paths.tasks_dir()).unwrap();
        std::fs::write(paths.tasks_dir().join("T-0666.json"), b"{broken").unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let hit = report.findings.iter().find(|f| f.check == "task_file").unwrap();
        assert_eq!(hit.target, "tasks/T-0666.json");
        assert!(!report.is_clean());
    }

    #[test]
    fn dependency_on_missing_task_is_an_error() {
        let (_g, paths) = managed_workspace();
        let a = crate::workspace::ops::create_task(
            &paths,
            "0.1.0",
            NewTask { title: "prereq".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        let b = crate::workspace::ops::create_task(
            &paths,
            "0.1.0",
            NewTask {
                title: "dependent".into(),
                priority: 1,
                depends_on: vec![a.id.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        // The prerequisite's file vanishes (manual delete, botched merge…):
        // the dependent can never unlock, and a takeover session must see it.
        std::fs::remove_file(paths.tasks_dir().join(format!("{}.json", a.id))).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let hit = report.findings.iter().find(|f| f.check == "task_dependency").unwrap();
        assert_eq!(hit.target, format!("tasks/{}.json", b.id));
        assert!(hit.message.contains(&a.id));
        assert!(!report.is_clean());
    }

    /// D38: outdated/undetermined shipped curriculum warns; customized stays
    /// silent (a legitimate state the panel shows but the doctor respects).
    #[test]
    fn shipped_asset_states_warn_or_stay_silent_as_designed() {
        let (_g, paths) = managed_workspace();

        // Simulate "an older engine shipped the guide": different content,
        // fingerprint matching that content.
        let guide_rel = "nextup_docs/01-nextup-guide.md";
        std::fs::write(paths.nextup_guide_file(), "old engine guide\n").unwrap();
        let raw = std::fs::read(paths.shipped_assets_file()).unwrap();
        let mut shipped: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        use sha2::Digest;
        let old_hash = sha2::Sha256::digest(b"old engine guide\n")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        shipped["assets"][guide_rel] = serde_json::Value::String(old_hash);
        std::fs::write(paths.shipped_assets_file(), shipped.to_string()).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let hit = report.findings.iter().find(|f| f.check == "shipped_asset").unwrap();
        assert_eq!(hit.severity, DoctorSeverity::Warning);
        assert_eq!(hit.target, guide_rel);
        assert!(hit.message.contains("outdated"));
        assert!(report.is_clean(), "staleness advises, never blocks a gate");

        // A customized file (disk differs from the recorded fingerprint) is
        // legitimate — no finding.
        std::fs::write(paths.nextup_guide_file(), "my very own guide\n").unwrap();
        let report = run_doctor(paths.root()).unwrap();
        assert!(
            !report.findings.iter().any(|f| f.check == "shipped_asset"),
            "customized assets stay silent: {:?}",
            report.findings
        );

        // No fingerprint at all (pre-D38 workspace) with drifted content:
        // provenance unknown — warn once so the fleet discovers the panel.
        std::fs::remove_file(paths.shipped_assets_file()).unwrap();
        let report = run_doctor(paths.root()).unwrap();
        let hit = report.findings.iter().find(|f| f.check == "shipped_asset").unwrap();
        assert!(hit.message.contains("decide once"));
    }

    #[test]
    fn torn_or_future_delivery_envelopes_warn() {
        let (_guard, paths) = managed_workspace();
        std::fs::create_dir_all(paths.inbox_dir()).unwrap();
        std::fs::create_dir_all(paths.outbox_dir()).unwrap();
        std::fs::write(paths.inbox_dir().join("torn.json"), b"{not json").unwrap();
        std::fs::write(
            paths.outbox_dir().join("future.json"),
            br#"{"schemaVersion":999,"id":"x","from":{"workspaceId":"w","name":"n"},"payloadType":"note","payload":{"note":"m"},"publishedAt":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        // A healthy envelope stays silent.
        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_TEAM,
            true,
        )
        .unwrap();
        crate::workspace::exchange::publish_delivery(&paths, "0.1.0", Some("healthy".into()), &[], crate::workspace::exchange::PublishOptions::default())
            .unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let envelope_findings: Vec<_> =
            report.findings.iter().filter(|f| f.check == "delivery_envelope").collect();
        assert_eq!(envelope_findings.len(), 2, "torn + future schema, healthy one silent");
        assert!(envelope_findings.iter().all(|f| f.severity == DoctorSeverity::Warning));
        assert!(envelope_findings.iter().any(|f| f.target.ends_with("inbox/torn.json")));
        assert!(envelope_findings.iter().any(|f| f.target.ends_with("outbox/future.json")));
    }

    #[test]
    fn missing_and_orphan_attachments_warn() {
        let (_guard, paths) = managed_workspace();
        crate::workspace::modules::set_module_enabled(
            &paths,
            crate::workspace::modules::MODULE_TEAM,
            true,
        )
        .unwrap();
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.txt");
        std::fs::write(&f, b"hello").unwrap();
        let envelope =
            crate::workspace::exchange::publish_delivery(&paths, "0.1.0", None, &[f], crate::workspace::exchange::PublishOptions::default()).unwrap();

        // A published attachment with its bytes present stays silent.
        let report = run_doctor(paths.root()).unwrap();
        assert!(!checks_of(&report).contains(&"delivery_attachment"));

        // Remove the bytes (envelope still lists them) and add an orphan dir.
        std::fs::remove_file(paths.outbox_dir().join(&envelope.id).join("a.txt")).unwrap();
        std::fs::create_dir_all(paths.outbox_dir().join("deadbeef")).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let att: Vec<_> =
            report.findings.iter().filter(|f| f.check == "delivery_attachment").collect();
        assert_eq!(att.len(), 2, "one missing file, one orphan directory");
        assert!(att.iter().all(|f| f.severity == DoctorSeverity::Warning));
        assert!(att.iter().any(|f| f.target.ends_with("outbox/deadbeef")));
        assert!(att.iter().any(|f| f.target.ends_with(&format!("{}/a.txt", envelope.id))));
    }

    #[test]
    fn stale_handoff_with_open_tasks_warns() {
        let (_g, paths) = managed_workspace();
        crate::workspace::ops::create_task(&paths, "0.1.0", NewTask { title: "open work".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        crate::workspace::handoff::generate_handoff(&paths, "0.0.0-test").unwrap();

        let later = Utc::now() + chrono::Duration::days(HANDOFF_STALE_DAYS + 1);
        let report = run_doctor_at(paths.root(), later).unwrap();
        assert!(checks_of(&report).contains(&"handoff_stale"));
        assert!(report.is_clean(), "staleness is a warning");

        // Fresh again right after regeneration.
        let report = run_doctor(paths.root()).unwrap();
        assert!(!checks_of(&report).contains(&"handoff_stale"));
    }

    /// The freshness source is the ledger's structured record, not the
    /// "> Generated:" header prose (D75): a snapshot the engine has no
    /// `handoff_generated` event for is hand-maintained and never judged.
    #[test]
    fn hand_written_handoff_without_engine_record_is_not_judged() {
        let (_g, paths) = managed_workspace();
        crate::workspace::ops::create_task(&paths, "0.1.0", NewTask { title: "open work".into(), priority: 1, ..Default::default() },
        )
        .unwrap();

        // Simulate a hand-maintained snapshot: the file exists, but every
        // engine regeneration record is gone from the ledger.
        let ledger_file = paths.ledger_file();
        let kept: String = std::fs::read_to_string(&ledger_file)
            .unwrap()
            .lines()
            .filter(|l| !l.contains("handoff_generated"))
            .map(|l| format!("{l}\n"))
            .collect();
        std::fs::write(&ledger_file, kept).unwrap();
        std::fs::write(paths.handoff_file(), "# my own notes\n").unwrap();

        let later = Utc::now() + chrono::Duration::days(HANDOFF_STALE_DAYS + 1);
        let report = run_doctor_at(paths.root(), later).unwrap();
        assert!(!checks_of(&report).contains(&"handoff_stale"));
    }

    #[test]
    fn docs_only_mode_checks_documents_but_not_engine_surfaces() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("CLAUDE.md"),
            "# index\n[live](README.md)\n[dead](nextup_docs/ghost.md)\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("README.md"), "# readme\n").unwrap();

        let report = run_doctor(dir.path()).unwrap();
        assert_eq!(report.mode, DoctorMode::DocsOnly);
        let checks = checks_of(&report);
        assert!(checks.contains(&"broken_link"));
        // No engine-surface findings in docs-only mode.
        assert!(!checks.contains(&"marker_block"));
        assert!(!checks.contains(&"handoff_missing"));
        assert_eq!(report.errors, 1);
    }

    #[test]
    fn docs_only_without_claude_md_is_a_warning() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.md"), "hello\n").unwrap();
        let report = run_doctor(dir.path()).unwrap();
        let hit = report.findings.iter().find(|f| f.check == "claude_md_missing").unwrap();
        assert_eq!(hit.severity, DoctorSeverity::Warning);
        assert!(report.is_clean());
    }

    // ── Spec layer (D79) ────────────────────────────────────────────────

    fn write_task_delta(paths: &WorkspacePaths, task_id: &str, capability: &str, content: &str) {
        let dir = paths.task_delta_specs_dir(task_id).join(capability);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spec.md"), content).unwrap();
    }

    fn done_verified(paths: &WorkspacePaths, title: &str) -> crate::workspace::tasks::Task {
        use crate::workspace::ops;
        let t = ops::create_task(
            paths,
            "0.0.0-test",
            NewTask { title: title.into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        ops::update_task_status(paths, "0.0.0-test", &t.id, TaskStatus::Done, None).unwrap();
        ops::set_task_verification(paths, "0.0.0-test", &t.id, true, Some("ran".into()))
            .unwrap()
            .task
    }

    #[test]
    fn spec_checks_flag_oversize_and_sweep_blocking_conflicts_as_warnings() {
        let (_g, paths) = managed_workspace();
        std::fs::create_dir_all(paths.spec_file("big").parent().unwrap()).unwrap();
        std::fs::write(
            paths.spec_file("big"),
            format!(
                "# big Specification\n\n## Requirements\n\n### Requirement: A\n必須。\n\n{}\n",
                "x".repeat(33 * 1024)
            ),
        )
        .unwrap();
        let t = done_verified(&paths, "broken delta");
        write_task_delta(
            &paths,
            &t.id,
            "billing",
            "## MODIFIED Requirements\n\n### Requirement: Ghost\nMUST.\n\n#### Scenario: s\n- **WHEN** x\n",
        );

        let report = run_doctor(paths.root()).unwrap();
        let size = report.findings.iter().find(|f| f.check == "spec_size").unwrap();
        assert_eq!(size.severity, DoctorSeverity::Warning);
        let conflict = report.findings.iter().find(|f| f.check == "spec_fold_conflict").unwrap();
        assert_eq!(conflict.severity, DoctorSeverity::Warning);
        assert!(
            conflict.message.contains("skip") && conflict.message.contains(&t.id),
            "sweep candidates get the sharper wording: {}",
            conflict.message
        );
    }

    #[test]
    fn spec_checks_flag_orphan_and_stale_bundles() {
        let (_g, paths) = managed_workspace();
        use crate::workspace::ops;
        use crate::workspace::tasks::TaskStore;
        const DELTA: &str = "## ADDED Requirements\n\n### Requirement: 匯出\n必須。\n\n#### Scenario: s\n- **WHEN** x\n";

        // Orphan: archived at the store level without a fold — pre-D79 data
        // or hand-edited files (the ops path can no longer produce this).
        let orphan = done_verified(&paths, "legacy archived");
        write_task_delta(&paths, &orphan.id, "export", DELTA);
        TaskStore::new(paths.tasks_dir()).set_archived(&orphan.id, true).unwrap();

        // Stale: folded through the real archive path, then the bundle
        // edited afterwards. The marker is backdated so the file mtime is
        // deterministically newer than the fold.
        let stale = done_verified(&paths, "edited after fold");
        write_task_delta(&paths, &stale.id, "billing", DELTA);
        ops::set_task_archived(&paths, "0.0.0-test", &stale.id, true).unwrap();
        TaskStore::new(paths.tasks_dir())
            .set_spec_folded_at(&stale.id, Some("2020-01-01T00:00:00Z".into()))
            .unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let orphan_hit = report.findings.iter().find(|f| f.check == "spec_delta_orphan").unwrap();
        assert!(orphan_hit.message.contains(&orphan.id), "{}", orphan_hit.message);
        let stale_hit = report.findings.iter().find(|f| f.check == "spec_delta_stale").unwrap();
        assert!(stale_hit.message.contains(&stale.id), "{}", stale_hit.message);
        assert_eq!(stale_hit.severity, DoctorSeverity::Warning);
    }

    /// Batch ② review error: a Big5 spec or delta file crashed the whole
    /// doctor. Unreadable content is that file's finding — every other
    /// check still reports.
    #[test]
    fn unreadable_spec_files_are_findings_not_a_doctor_crash() {
        let (_g, paths) = managed_workspace();
        std::fs::create_dir_all(paths.spec_file("legacy").parent().unwrap()).unwrap();
        std::fs::write(paths.spec_file("legacy"), [0xa4u8, 0xa4, 0xa4, 0xe5]).unwrap();
        let t = done_verified(&paths, "big5 bundle");
        let dir = paths.task_delta_specs_dir(&t.id).join("billing");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spec.md"), [0xa4u8, 0xa4]).unwrap();

        let report = run_doctor(paths.root()).unwrap();
        let hits = report.findings.iter().filter(|f| f.check == "spec_parse").count();
        assert!(hits >= 2, "one finding per unreadable file: {:?}", report.findings);
    }

    /// Batch ② review: the fold marker is second-truncated while mtimes are
    /// sub-second — a fold in the same wall-clock second as the delta write
    /// must not read as "edited after fold". And a bundle directory whose
    /// task file is gone must surface (task-driven checks cannot see it).
    #[test]
    fn same_second_fold_is_not_stale_and_ownerless_bundles_are_flagged() {
        let (_g, paths) = managed_workspace();
        use crate::workspace::ops;
        const DELTA: &str = "## ADDED Requirements\n\n### Requirement: 匯出\n必須。\n\n#### Scenario: s\n- **WHEN** x\n";
        let t = done_verified(&paths, "fresh fold");
        write_task_delta(&paths, &t.id, "export", DELTA);
        ops::set_task_archived(&paths, "0.0.0-test", &t.id, true).unwrap();
        let report = run_doctor(paths.root()).unwrap();
        assert!(
            report.findings.iter().all(|f| f.check != "spec_delta_stale"),
            "same-second fold is not an edit: {:?}",
            report.findings
        );

        std::fs::create_dir_all(paths.tasks_dir().join("T-9999")).unwrap();
        let report = run_doctor(paths.root()).unwrap();
        let orphan = report
            .findings
            .iter()
            .find(|f| f.check == "spec_delta_orphan" && f.target.contains("T-9999"))
            .expect("ownerless bundle dir flagged");
        assert_eq!(orphan.severity, DoctorSeverity::Warning);
    }
}
