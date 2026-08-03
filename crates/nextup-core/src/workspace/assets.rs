//! Shipped-asset fingerprints and upgrades (nextup_docs/08, D38).
//!
//! `scaffold` ships the engine curriculum (operating guide + generic skills)
//! with write-if-missing semantics: user edits always win, but content
//! updates never propagate — an old workspace silently teaches agents an
//! outdated contract. This module makes staleness detectable and safely
//! upgradable via the classic three-way config comparison (rpm/deb style):
//! the engine records the sha256 of what it shipped, so "the engine moved
//! on" (disk == shipped, current render differs → safe overwrite) is
//! distinguishable from "the user customized" (disk != shipped → never
//! touched, only listed). No fingerprint and disk != current render means
//! provenance is unknowable — those wait for a per-item human decision.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::{atomic_write, atomic_write_json, read_file, read_json_file};
use crate::workspace::context::{load_context, ProjectContext};
use crate::workspace::layout::{
    WorkspacePaths, NEXTUP_DIR, NEXTUP_DOCS_DIR, NEXTUP_GUIDE_FILE, ASSET_BACKUPS_DIR, PROTOCOL_FILE,
};
use crate::workspace::ledger::{ledger_for, LedgerEvent, LedgerKind};
use crate::workspace::lock::with_mutation_lock;

pub const SHIPPED_ASSETS_SCHEMA_VERSION: u32 = 1;

/// Sentinel fingerprint value: the user clicked "keep" on a manual-review
/// item, claiming the file as their own. Classified as customized forever
/// after (until the file is deleted, or its content becomes byte-identical
/// to the current render — then it *is* engine content and the claim is moot).
pub const USER_OWNED: &str = "user";

/// `.nextup/shipped_assets.json` — what the engine last shipped, by content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShippedAssets {
    pub schema_version: u32,
    /// Workspace-relative path (forward slashes) → sha256 hex of the content
    /// the engine last shipped there, or [`USER_OWNED`].
    #[serde(default)]
    pub assets: BTreeMap<String, String>,
}

impl Default for ShippedAssets {
    /// A missing file means "nothing recorded" — old workspaces need no
    /// migration; their assets classify as manual-review until adopted.
    fn default() -> Self {
        Self { schema_version: SHIPPED_ASSETS_SCHEMA_VERSION, assets: BTreeMap::new() }
    }
}

fn load_shipped(paths: &WorkspacePaths) -> Result<ShippedAssets> {
    let file = paths.shipped_assets_file();
    if !file.is_file() {
        return Ok(ShippedAssets::default());
    }
    read_json_file(&file)
}

fn save_shipped(paths: &WorkspacePaths, shipped: &ShippedAssets) -> Result<()> {
    atomic_write_json(&paths.shipped_assets_file(), shipped)
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(data) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// One upgradable engine-curriculum asset: where it lives and what the
/// running engine would ship there today.
pub(crate) struct CurriculumAsset {
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub current: String,
}

/// The engine-curriculum registry (nextup_docs/08 §1): the operating guide
/// and the generic skills. Everything else `scaffold` ships is a user-data
/// seed or has its own freshness mechanism — never upgraded here.
pub(crate) fn curriculum(
    paths: &WorkspacePaths,
    ctx: &ProjectContext,
) -> Result<Vec<CurriculumAsset>> {
    let mut assets = vec![
        CurriculumAsset {
            rel_path: format!("{NEXTUP_DOCS_DIR}/{PROTOCOL_FILE}"),
            abs_path: paths.protocol_file(),
            current: super::bootstrap::render_protocol(ctx),
        },
        CurriculumAsset {
            rel_path: format!("{NEXTUP_DOCS_DIR}/{NEXTUP_GUIDE_FILE}"),
            abs_path: paths.nextup_guide_file(),
            current: super::bootstrap::render_guide(ctx),
        },
    ];
    // One guide per enabled module (D82). Membership is driven by
    // modules.json, so a module turned on later joins the curriculum then —
    // and a module turned off drops out of it while its file stays on disk
    // (the specs/ "enable scaffolds, disable keeps" precedent). The read is
    // fallible on purpose: a corrupt modules.json must not degrade into
    // "no modules", which would silently drop live guides out of upgrades.
    for module in super::modules::get_modules(paths)?.enabled {
        let Some(current) = super::bootstrap::render_module_guide(&module, ctx) else {
            continue;
        };
        assets.push(CurriculumAsset {
            rel_path: WorkspacePaths::module_guide_rel(&module),
            abs_path: paths.module_guide_file(&module),
            current,
        });
    }
    // Both landing spots per skill (D82). Registering only one would leave the
    // other frozen at whatever the engine shipped first — the mirror would
    // never be upgraded and would drift apart from its twin without a word.
    for (name, content) in super::bootstrap::WORKSPACE_SKILLS {
        for (rel_path, abs_path) in paths.skill_files(name) {
            assets.push(CurriculumAsset { rel_path, abs_path, current: content.to_string() });
        }
    }
    Ok(assets)
}

/// Five-state verdict for one curriculum asset (nextup_docs/08 §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetState {
    /// Disk content equals the current engine render.
    UpToDate,
    /// Disk equals what the engine shipped, and the engine has moved on —
    /// overwriting loses nothing of the user's.
    UpgradeSafe,
    /// Disk differs from what the engine shipped (or the user claimed the
    /// file) — never overwritten automatically.
    Customized,
    /// No fingerprint and disk differs from the current render: provenance
    /// unknowable (workspace predates fingerprinting). Needs a per-item
    /// human decision — keep, or upgrade with backup.
    ManualReview,
    /// File absent — recreating it is the established scaffold-repair
    /// semantic, so an upgrade may safely add it.
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetStatus {
    pub path: String,
    pub state: AssetState,
}

fn classify(asset: &CurriculumAsset, record: Option<&str>) -> Result<AssetState> {
    if !asset.abs_path.is_file() {
        return Ok(AssetState::Missing);
    }
    let disk_hash = sha256_hex(&read_file(&asset.abs_path)?);
    let current_hash = sha256_hex(asset.current.as_bytes());
    if disk_hash == current_hash {
        // Byte-identical to what the engine renders today — engine content
        // by definition, whatever any record claims.
        return Ok(AssetState::UpToDate);
    }
    match record {
        Some(USER_OWNED) => Ok(AssetState::Customized),
        Some(shipped) if disk_hash == shipped => Ok(AssetState::UpgradeSafe),
        Some(_) => Ok(AssetState::Customized),
        None => Ok(AssetState::ManualReview),
    }
}

/// Read-only five-state classification of every curriculum asset. Never
/// writes — the doctor and dry-runs call this; fingerprint backfill lives in
/// [`upgrade_assets`] / [`record_pristine`] only.
pub fn assets_status(paths: &WorkspacePaths) -> Result<Vec<AssetStatus>> {
    let ctx = load_context(&paths.context_file())?;
    assets_status_with(paths, &ctx)
}

/// [`assets_status`] with the context preloaded by the caller.
pub(crate) fn assets_status_with(
    paths: &WorkspacePaths,
    ctx: &ProjectContext,
) -> Result<Vec<AssetStatus>> {
    let shipped = load_shipped(paths)?;
    curriculum(paths, ctx)?
        .into_iter()
        .map(|asset| {
            let record = shipped.assets.get(&asset.rel_path).map(String::as_str);
            Ok(AssetStatus { state: classify(&asset, record)?, path: asset.rel_path })
        })
        .collect()
}

/// Record fingerprints for every curriculum asset whose disk content equals
/// the current render — `scaffold` calls this right after shipping files, so
/// fresh writes get fingerprinted and provably-current files on old
/// workspaces are adopted in passing. Anything that differs stays unrecorded
/// (manual review). Never touches the asset files themselves.
pub(crate) fn record_pristine(paths: &WorkspacePaths, ctx: &ProjectContext) -> Result<()> {
    let mut shipped = load_shipped(paths)?;
    let mut dirty = false;
    for asset in curriculum(paths, ctx)? {
        if !asset.abs_path.is_file() {
            continue;
        }
        let current_hash = sha256_hex(asset.current.as_bytes());
        if sha256_hex(&read_file(&asset.abs_path)?) == current_hash
            && shipped.assets.get(&asset.rel_path) != Some(&current_hash)
        {
            shipped.assets.insert(asset.rel_path, current_hash);
            dirty = true;
        }
    }
    if dirty {
        save_shipped(paths, &shipped)?;
    }
    Ok(())
}

/// Per-item resolutions for manual-review assets. GUI only — the hub tool
/// always passes the empty default (nextup_docs/08 §6 Q3: manual review means
/// a human; agents relay the list, they never decide it).
#[derive(Debug, Clone, Default)]
pub struct AssetDecisions {
    /// Manual-review paths to overwrite with the current render (backed up first).
    pub overwrite: Vec<String>,
    /// Manual-review paths the user claims as their own (recorded as [`USER_OWNED`]).
    pub keep_as_user: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetsUpgradeOutcome {
    /// Rewritten to the current render (upgrade-safe items, plus any
    /// user-decided manual-review overwrites). Originals backed up first.
    pub upgraded: Vec<String>,
    /// Missing assets recreated.
    pub added: Vec<String>,
    /// Manual-review assets the user kept — now recorded as user-owned.
    pub kept_as_user: Vec<String>,
    /// Customized assets left untouched.
    pub skipped_customized: Vec<String>,
    /// Manual-review assets still awaiting a decision (always untouched).
    pub needs_review: Vec<String>,
    /// Workspace-relative directory holding pre-overwrite copies, when any
    /// file was backed up this run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_dir: Option<String>,
}

/// Bring the curriculum up to the running engine's content: overwrite
/// pristine-but-outdated files (backed up first), recreate missing ones,
/// backfill fingerprints for provably-current files, and apply the user's
/// per-item manual-review decisions. Customized files are never touched.
/// Ledgers one `assets_upgraded` line only when something actually changed.
pub fn upgrade_assets(
    paths: &WorkspacePaths,
    app_version: &str,
    decisions: &AssetDecisions,
) -> Result<AssetsUpgradeOutcome> {
    with_mutation_lock(paths, || {
        let ctx = load_context(&paths.context_file())?;
        let mut shipped = load_shipped(paths)?;
        let assets = curriculum(paths, &ctx)?;

        // Reject decisions about unknown or non-manual-review paths up front —
        // a stale panel must fail loudly, never silently overwrite.
        for path in decisions.overwrite.iter().chain(&decisions.keep_as_user) {
            let asset = assets.iter().find(|a| &a.rel_path == path).ok_or_else(|| {
                NextUpError::InvalidInput(format!("'{path}' is not an upgradable shipped asset"))
            })?;
            let state = classify(asset, shipped.assets.get(path).map(String::as_str))?;
            if state != AssetState::ManualReview {
                return Err(NextUpError::InvalidInput(format!(
                    "'{path}' is not awaiting manual review — reload the asset list and retry"
                )));
            }
        }

        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let mut outcome = AssetsUpgradeOutcome {
            upgraded: Vec::new(),
            added: Vec::new(),
            kept_as_user: Vec::new(),
            skipped_customized: Vec::new(),
            needs_review: Vec::new(),
            backup_dir: None,
        };
        let mut dirty = false;

        for asset in &assets {
            let record = shipped.assets.get(&asset.rel_path).map(String::as_str);
            let state = classify(asset, record)?;
            let current_hash = sha256_hex(asset.current.as_bytes());
            match state {
                AssetState::UpToDate => {
                    // The disk provably holds the current render — recording
                    // that is the truth (also corrects a stale USER_OWNED).
                    if record != Some(current_hash.as_str()) {
                        shipped.assets.insert(asset.rel_path.clone(), current_hash);
                        dirty = true;
                    }
                }
                AssetState::UpgradeSafe => {
                    backup_asset(paths, &stamp, asset, &mut outcome)?;
                    atomic_write(&asset.abs_path, asset.current.as_bytes())?;
                    shipped.assets.insert(asset.rel_path.clone(), current_hash);
                    outcome.upgraded.push(asset.rel_path.clone());
                    dirty = true;
                }
                AssetState::Missing => {
                    atomic_write(&asset.abs_path, asset.current.as_bytes())?;
                    shipped.assets.insert(asset.rel_path.clone(), current_hash);
                    outcome.added.push(asset.rel_path.clone());
                    dirty = true;
                }
                AssetState::Customized => {
                    outcome.skipped_customized.push(asset.rel_path.clone());
                }
                AssetState::ManualReview => {
                    if decisions.overwrite.contains(&asset.rel_path) {
                        backup_asset(paths, &stamp, asset, &mut outcome)?;
                        atomic_write(&asset.abs_path, asset.current.as_bytes())?;
                        shipped.assets.insert(asset.rel_path.clone(), current_hash);
                        outcome.upgraded.push(asset.rel_path.clone());
                        dirty = true;
                    } else if decisions.keep_as_user.contains(&asset.rel_path) {
                        shipped.assets.insert(asset.rel_path.clone(), USER_OWNED.to_string());
                        outcome.kept_as_user.push(asset.rel_path.clone());
                        dirty = true;
                    } else {
                        outcome.needs_review.push(asset.rel_path.clone());
                    }
                }
            }
        }

        if dirty {
            save_shipped(paths, &shipped)?;
        }
        let acted = !outcome.upgraded.is_empty()
            || !outcome.added.is_empty()
            || !outcome.kept_as_user.is_empty();
        if acted {
            let mut parts = Vec::new();
            if !outcome.upgraded.is_empty() {
                parts.push(format!("upgraded {}", outcome.upgraded.join(", ")));
            }
            if !outcome.added.is_empty() {
                parts.push(format!("added {}", outcome.added.join(", ")));
            }
            if !outcome.kept_as_user.is_empty() {
                parts.push(format!("kept as user-owned {}", outcome.kept_as_user.join(", ")));
            }
            ledger_for(paths).append(&LedgerEvent::new(
                LedgerKind::AssetsUpgraded,
                format!("shipped assets: {} (engine {app_version})", parts.join("; ")),
                None,
            ))?;
        }
        Ok(outcome)
    })
}

/// Copy the current disk content into `.nextup/asset_backups/<stamp>/<rel>`
/// before an overwrite. The backups root carries its own `*` .gitignore
/// (cargo-target style) so old workspaces need no `.nextup/.gitignore`
/// migration to keep backups out of version control.
fn backup_asset(
    paths: &WorkspacePaths,
    stamp: &str,
    asset: &CurriculumAsset,
    outcome: &mut AssetsUpgradeOutcome,
) -> Result<()> {
    let backups_root = paths.asset_backups_dir();
    let marker = backups_root.join(".gitignore");
    if !marker.is_file() {
        atomic_write(&marker, b"*\n")?;
    }
    let bytes = read_file(&asset.abs_path)?;
    atomic_write(&backups_root.join(stamp).join(&asset.rel_path), &bytes)?;
    if outcome.backup_dir.is_none() {
        outcome.backup_dir = Some(format!("{NEXTUP_DIR}/{ASSET_BACKUPS_DIR}/{stamp}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ledger::Ledger;

    const GUIDE_REL: &str = "nextup_docs/01-nextup-guide.md";
    const WRAP_UP_REL: &str = ".claude/skills/wrap-up/SKILL.md";

    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        initialize_project(
            &InitProjectParams {
                root: dir.path().to_string_lossy().into_owned(),
                name: "Asset upgrade test".into(),
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

    fn state_of(paths: &WorkspacePaths, rel: &str) -> AssetState {
        assets_status(paths)
            .unwrap()
            .into_iter()
            .find(|s| s.path == rel)
            .unwrap_or_else(|| panic!("asset '{rel}' not in status"))
            .state
    }

    /// Simulate "an older engine shipped this": write different content and
    /// record its hash as the shipped fingerprint.
    fn ship_old_version(paths: &WorkspacePaths, rel: &str, content: &str) {
        let abs = paths.root().join(rel);
        std::fs::write(&abs, content).unwrap();
        let mut shipped = load_shipped(paths).unwrap();
        shipped.assets.insert(rel.to_string(), sha256_hex(content.as_bytes()));
        save_shipped(paths, &shipped).unwrap();
    }

    #[test]
    fn init_fingerprints_every_curriculum_asset_as_up_to_date() {
        let (_g, paths) = workspace();
        assert!(paths.shipped_assets_file().is_file(), "init records fingerprints");
        let statuses = assets_status(&paths).unwrap();
        // Derived from the registry, not a hand-kept number — the count moves
        // whenever the curriculum does (D82 added the protocol and, for
        // workspaces with modules on, one guide per enabled module).
        let ctx = load_context(&paths.context_file()).unwrap();
        assert_eq!(statuses.len(), curriculum(&paths, &ctx).unwrap().len());
        assert!(statuses.iter().any(|s| s.path.ends_with(PROTOCOL_FILE)), "protocol is curriculum");
        for status in &statuses {
            assert_eq!(status.state, AssetState::UpToDate, "{} fresh at init", status.path);
            assert!(!status.path.contains('\\'), "rel paths use forward slashes");
        }
        // Fingerprints are the sha256 of the shipped bytes.
        let shipped = load_shipped(&paths).unwrap();
        let guide = std::fs::read(paths.nextup_guide_file()).unwrap();
        assert_eq!(shipped.assets[GUIDE_REL], sha256_hex(&guide));
        assert_eq!(shipped.schema_version, SHIPPED_ASSETS_SCHEMA_VERSION);
    }

    /// D82 red line: the entry files carry engine-maintained content of their
    /// own (the state block is rewritten in place on every mutation), so they
    /// can never be curriculum assets. If they were, the disk copy would never
    /// again equal the initialisation-time render, every run would classify
    /// them `ManualReview`, and the upgrade panel would grow a button that
    /// overwrites a live state block with a placeholder.
    #[test]
    fn entry_files_are_never_curriculum_assets() {
        let (_g, paths) = workspace();
        let ctx = load_context(&paths.context_file()).unwrap();
        for asset in curriculum(&paths, &ctx).unwrap() {
            assert!(
                asset.rel_path != "AGENTS.md" && asset.rel_path != "CLAUDE.md",
                "{} must not be fingerprinted — it has its own freshness mechanism",
                asset.rel_path
            );
        }
    }

    /// Both skill copies are registered, so an upgrade moves the pair together.
    /// Registering one would freeze the other at whatever shipped first.
    #[test]
    fn both_skill_copies_are_curriculum_assets() {
        let (_g, paths) = workspace();
        let ctx = load_context(&paths.context_file()).unwrap();
        let rels: Vec<String> =
            curriculum(&paths, &ctx).unwrap().into_iter().map(|a| a.rel_path).collect();
        for (name, _) in super::super::bootstrap::WORKSPACE_SKILLS {
            for (rel, _) in paths.skill_files(name) {
                assert!(rels.contains(&rel), "{rel} is registered for upgrades");
            }
        }
    }

    #[test]
    fn customized_asset_is_never_touched() {
        let (_g, paths) = workspace();
        let custom = "my own guide\n";
        std::fs::write(paths.nextup_guide_file(), custom).unwrap();
        assert_eq!(state_of(&paths, GUIDE_REL), AssetState::Customized);

        let outcome = upgrade_assets(&paths, "0.0.0-test", &AssetDecisions::default()).unwrap();
        assert_eq!(outcome.skipped_customized, vec![GUIDE_REL.to_string()]);
        assert!(outcome.upgraded.is_empty());
        assert_eq!(std::fs::read_to_string(paths.nextup_guide_file()).unwrap(), custom);
    }

    #[test]
    fn outdated_pristine_asset_upgrades_with_backup_and_ledger() {
        let (_g, paths) = workspace();
        ship_old_version(&paths, GUIDE_REL, "old engine guide v1\n");
        assert_eq!(state_of(&paths, GUIDE_REL), AssetState::UpgradeSafe);

        let outcome = upgrade_assets(&paths, "0.0.0-test", &AssetDecisions::default()).unwrap();
        assert_eq!(outcome.upgraded, vec![GUIDE_REL.to_string()]);
        assert_eq!(state_of(&paths, GUIDE_REL), AssetState::UpToDate);
        let guide = std::fs::read_to_string(paths.nextup_guide_file()).unwrap();
        assert!(guide.contains("Hub tools"), "disk now holds the current render");

        // The old content survives under the returned backup dir.
        let backup_dir = outcome.backup_dir.expect("a backup was taken");
        let backed = paths.root().join(&backup_dir).join(GUIDE_REL);
        assert_eq!(std::fs::read_to_string(backed).unwrap(), "old engine guide v1\n");
        // Backups exclude themselves from version control.
        assert_eq!(
            std::fs::read_to_string(paths.asset_backups_dir().join(".gitignore")).unwrap(),
            "*\n"
        );

        // Exactly one audit line, naming the asset and the engine version.
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::AssetsUpgraded, 10)
            .unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].message.contains(GUIDE_REL));
        assert!(events[0].message.contains("0.0.0-test"));
    }

    #[test]
    fn missing_asset_is_recreated_and_fingerprinted() {
        let (_g, paths) = workspace();
        std::fs::remove_file(paths.skill_file("wrap-up")).unwrap();
        assert_eq!(state_of(&paths, WRAP_UP_REL), AssetState::Missing);

        let outcome = upgrade_assets(&paths, "0.0.0-test", &AssetDecisions::default()).unwrap();
        assert_eq!(outcome.added, vec![WRAP_UP_REL.to_string()]);
        assert!(outcome.backup_dir.is_none(), "nothing to back up for a missing file");
        assert_eq!(state_of(&paths, WRAP_UP_REL), AssetState::UpToDate);
    }

    #[test]
    fn unfingerprinted_workspace_needs_manual_review_and_decisions_resolve_it() {
        let (_g, paths) = workspace();
        // A workspace that predates fingerprinting, with one drifted asset.
        std::fs::remove_file(paths.shipped_assets_file()).unwrap();
        std::fs::write(paths.nextup_guide_file(), "pre-D38 engine guide\n").unwrap();
        assert_eq!(state_of(&paths, GUIDE_REL), AssetState::ManualReview);
        // Assets matching the current render are provably current, not review.
        assert_eq!(state_of(&paths, WRAP_UP_REL), AssetState::UpToDate);

        // The agent path (no decisions) lists it and must not touch it.
        let outcome = upgrade_assets(&paths, "0.0.0-test", &AssetDecisions::default()).unwrap();
        assert_eq!(outcome.needs_review, vec![GUIDE_REL.to_string()]);
        assert_eq!(
            std::fs::read_to_string(paths.nextup_guide_file()).unwrap(),
            "pre-D38 engine guide\n"
        );
        // …while pristine assets got their fingerprints backfilled.
        assert_eq!(state_of(&paths, WRAP_UP_REL), AssetState::UpToDate);
        assert!(load_shipped(&paths).unwrap().assets.contains_key(WRAP_UP_REL));

        // "Keep" records the user claim; the asset stops asking forever.
        let outcome = upgrade_assets(
            &paths,
            "0.0.0-test",
            &AssetDecisions { keep_as_user: vec![GUIDE_REL.into()], ..Default::default() },
        )
        .unwrap();
        assert_eq!(outcome.kept_as_user, vec![GUIDE_REL.to_string()]);
        assert_eq!(load_shipped(&paths).unwrap().assets[GUIDE_REL], USER_OWNED);
        assert_eq!(state_of(&paths, GUIDE_REL), AssetState::Customized);

        // A later "overwrite" decision is refused — no longer manual-review.
        let err = upgrade_assets(
            &paths,
            "0.0.0-test",
            &AssetDecisions { overwrite: vec![GUIDE_REL.into()], ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn overwrite_decision_backs_up_then_adopts_the_current_render() {
        let (_g, paths) = workspace();
        std::fs::remove_file(paths.shipped_assets_file()).unwrap();
        std::fs::write(paths.nextup_guide_file(), "pre-D38 engine guide\n").unwrap();

        let outcome = upgrade_assets(
            &paths,
            "0.0.0-test",
            &AssetDecisions { overwrite: vec![GUIDE_REL.into()], ..Default::default() },
        )
        .unwrap();
        assert_eq!(outcome.upgraded, vec![GUIDE_REL.to_string()]);
        assert_eq!(state_of(&paths, GUIDE_REL), AssetState::UpToDate);
        let backed = paths.root().join(outcome.backup_dir.unwrap()).join(GUIDE_REL);
        assert_eq!(std::fs::read_to_string(backed).unwrap(), "pre-D38 engine guide\n");
    }

    #[test]
    fn decisions_for_unknown_or_settled_assets_are_rejected() {
        let (_g, paths) = workspace();
        let err = upgrade_assets(
            &paths,
            "0.0.0-test",
            &AssetDecisions { overwrite: vec!["nope.md".into()], ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");

        // Everything is up to date — an overwrite decision is stale.
        let err = upgrade_assets(
            &paths,
            "0.0.0-test",
            &AssetDecisions { overwrite: vec![GUIDE_REL.into()], ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn upgrade_is_idempotent_and_silent_when_fresh() {
        let (_g, paths) = workspace();
        let outcome = upgrade_assets(&paths, "0.0.0-test", &AssetDecisions::default()).unwrap();
        assert!(outcome.upgraded.is_empty() && outcome.added.is_empty());
        assert!(outcome.backup_dir.is_none());
        let events = Ledger::new(paths.ledger_file())
            .recent_of_kind(LedgerKind::AssetsUpgraded, 10)
            .unwrap();
        assert!(events.is_empty(), "no-op upgrades stay out of the ledger");
    }

    /// Renaming the project changes the guide's render inputs — the guide
    /// correctly reads as outdated and an upgrade re-renders it for the new
    /// context (curriculum follows ctx).
    #[test]
    fn context_change_makes_the_guide_upgrade_safe() {
        let (_g, paths) = workspace();
        let mut ctx = load_context(&paths.context_file()).unwrap();
        ctx.name = "Renamed project".into();
        crate::workspace::context::save_context(&paths.context_file(), &ctx).unwrap();

        assert_eq!(state_of(&paths, GUIDE_REL), AssetState::UpgradeSafe);
        upgrade_assets(&paths, "0.0.0-test", &AssetDecisions::default()).unwrap();
        let guide = std::fs::read_to_string(paths.nextup_guide_file()).unwrap();
        assert!(guide.contains("Renamed project"), "guide re-rendered for the new ctx");
    }
}
