use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::agent::{save_access, save_restored_access, AgentAccess, RestoredAccess};
use crate::error::{NextUpError, Result};
use crate::security::crypto;
use crate::security::keystore::KeyProvider;
use crate::security::secrets::{load_secrets, save_secrets, SecretMap};
use crate::workspace::atomic::atomic_write;
use crate::workspace::context::ProjectContext;
use crate::workspace::init::open_workspace;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{ledger_for, LedgerEvent, LedgerKind};

pub const BACKUP_SCHEMA_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "nextup-backup-manifest.json";
/// Secrets travel inside the archive re-encrypted under a passphrase, because
/// the local envelope is sealed by *this machine's* keystore and would be
/// unreadable anywhere else.
const PORTABLE_SECRETS_NAME: &str = ".nextup/secrets.portable.enc";
/// The agent allowlist travels at the archive root, outside `.nextup/`, so no
/// extraction can ever land it at the live path (D143). Import reads it and
/// parks the grants for a person to accept; only a restriction (agent access
/// switched off) is applied without asking.
const ACCESS_NAME: &str = "nextup-backup-access.json";
const MIN_PASSPHRASE: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub backup_schema_version: u32,
    pub app_version: String,
    pub project_name: String,
    pub exported_at: String,
    pub include_artifacts: bool,
}

/// Export the workspace as a single portable zip:
/// configuration + ledger + snapshots + tasks (+ artifacts, optionally) and
/// the secrets re-encrypted with `passphrase` (Argon2id → AES-256-GCM).
/// The machine-local `secrets.enc` itself is deliberately excluded.
pub fn export_backup(
    paths: &WorkspacePaths,
    keys: &dyn KeyProvider,
    dest_zip: &Path,
    passphrase: &str,
    include_artifacts: bool,
    app_version: &str,
) -> Result<PathBuf> {
    validate_passphrase(passphrase)?;
    if !paths.is_initialized() {
        return Err(NextUpError::Workspace("no initialized workspace to export".into()));
    }
    let context = crate::workspace::context::load_context(&paths.context_file())?;

    let file = File::create(dest_zip)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default();

    let manifest = BackupManifest {
        backup_schema_version: BACKUP_SCHEMA_VERSION,
        app_version: app_version.to_string(),
        project_name: context.name.clone(),
        exported_at: crate::workspace::context::now_rfc3339(),
        include_artifacts,
    };
    zip.start_file(MANIFEST_NAME, options).map_err(zip_err)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;

    // Re-encrypt secrets for portability.
    let secret_map = load_secrets(&paths.secrets_file(), keys)?;
    let portable = crypto::encrypt_with_passphrase(passphrase, &serde_json::to_vec(&secret_map)?)?;
    zip.start_file(PORTABLE_SECRETS_NAME, options).map_err(zip_err)?;
    zip.write_all(&portable)?;

    let access_file = paths.agent_access_file();
    if access_file.is_file() {
        zip.start_file(ACCESS_NAME, options).map_err(zip_err)?;
        zip.write_all(&std::fs::read(&access_file)?)?;
    }

    // Individual config files (+ the AI-session bootstrap entry points).
    for file_path in [
        paths.context_file(),
        paths.rules_file(),
        paths.workflow_file(),
        paths.orchestrator_file(),
        paths.mcp_file(),
        paths.modules_file(),
        // Workspace behavior settings (D78) travel with the workspace, same
        // as the module switchboard.
        paths.settings_file(),
        // Fingerprints travel with the workspace: without them a restored
        // copy could no longer tell customized from outdated (D38). The
        // asset_backups/ directory stays behind — machine-local safety net.
        paths.shipped_assets_file(),
        paths.ledger_file(),
        paths.claude_md_file(),
        paths.agents_md_file(),
        paths.manifest_file(),
    ] {
        if file_path.is_file() {
            add_file(&mut zip, options, paths.root(), &file_path)?;
        }
    }
    // Whole directories.
    let mut dirs = vec![
        paths.snapshots_dir(),
        // Delivery envelopes are workspace state (pending sends, received
        // handoffs) — a restored copy keeps its exchange history (D48).
        paths.exchange_dir(),
        paths.tasks_dir(),
        // The curated spec layer (D79) is workspace content, not derived data.
        // A folded spec exists only here, so leaving it out drops the whole
        // tree — task deltas survive a backup only because they sit under
        // tasks/, which made the gap easy to miss.
        paths.specs_dir(),
        paths.nextup_docs_dir(),
        paths.memory_dir(),
        paths.work_record_dir(),
        // Both skill roots (D82): `.agents/skills/` is the canonical copy and
        // `.claude/skills/` the one Claude Code reads. Only the skills
        // subtrees — the rest of `.claude/` belongs to the agent host
        // (machine-local settings) and must not travel.
        paths.agent_skills_dir(),
        paths.skills_dir(),
    ];
    if include_artifacts {
        dirs.push(paths.artifacts_dir());
    }
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                add_file(&mut zip, options, paths.root(), entry.path())?;
            }
        }
    }

    zip.finish().map_err(zip_err)?;

    ledger_for(paths).append(&LedgerEvent::new(
        LedgerKind::BackupExported,
        format!("backup exported to {}", dest_zip.display()),
        None,
    ))?;
    Ok(dest_zip.to_path_buf())
}

/// Import a backup archive into `dest_root` (which must not already be an
/// Agent NextUp workspace). Secrets are decrypted with `passphrase` and re-sealed
/// under *this* machine's keystore, completing the cross-machine migration.
pub fn import_backup(
    archive_path: &Path,
    dest_root: &Path,
    keys: &dyn KeyProvider,
    passphrase: &str,
) -> Result<ProjectContext> {
    let dest_paths = WorkspacePaths::new(dest_root);
    if dest_paths.nextup_dir().exists() {
        return Err(NextUpError::Workspace(format!(
            "{} is already an Agent NextUp workspace; refusing to overwrite it",
            dest_root.display()
        )));
    }

    let file = File::open(archive_path)?;
    let mut archive = ZipArchive::new(file).map_err(zip_err)?;

    // Validate the manifest before touching the destination.
    let manifest: BackupManifest = {
        let mut entry = archive
            .by_name(MANIFEST_NAME)
            .map_err(|_| NextUpError::Backup("not an Agent NextUp backup: manifest missing".into()))?;
        let mut raw = Vec::new();
        entry.read_to_end(&mut raw)?;
        serde_json::from_slice(&raw)?
    };
    if manifest.backup_schema_version > BACKUP_SCHEMA_VERSION {
        return Err(NextUpError::Backup(format!(
            "backup schema v{} is newer than this app supports (v{})",
            manifest.backup_schema_version, BACKUP_SCHEMA_VERSION
        )));
    }

    // Decrypt portable secrets up front so a wrong passphrase aborts the
    // import before any files land on disk.
    let secret_map: SecretMap = {
        let mut entry = archive
            .by_name(PORTABLE_SECRETS_NAME)
            .map_err(|_| NextUpError::Backup("backup is missing portable secrets".into()))?;
        let mut sealed = Vec::new();
        entry.read_to_end(&mut sealed)?;
        let plain = crypto::decrypt_with_passphrase(passphrase, &sealed)?;
        serde_json::from_slice(&plain)?
    };

    // Absent in backups made before D143; unreadable is treated the same —
    // a damaged allowlist is no reason to refuse a restore, and the worst it
    // costs is grants nobody re-applies.
    let carried_access: Option<AgentAccess> = match archive.by_name(ACCESS_NAME) {
        Ok(mut entry) => {
            let mut raw = Vec::new();
            entry.read_to_end(&mut raw)?;
            serde_json::from_slice(&raw).ok()
        }
        Err(_) => None,
    };

    std::fs::create_dir_all(dest_root)?;
    let live_access = dest_paths.agent_access_file();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(zip_err)?;
        let name = entry.name().to_string();
        if name == MANIFEST_NAME || name == PORTABLE_SECRETS_NAME || name == ACCESS_NAME {
            continue;
        }
        // Zip-slip guard: only extract paths that stay inside dest_root.
        let Some(relative) = entry.enclosed_name() else {
            return Err(NextUpError::Backup(format!("archive contains unsafe path: {name}")));
        };
        // Grants arrive only through the prompt below. A backup this app wrote
        // never has either file at these paths; one that does was made by hand,
        // and extracting it would hand an agent write access with no one asked.
        if is_grant_file(&relative) {
            continue;
        }
        let target = dest_root.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        let mut content = Vec::new();
        entry.read_to_end(&mut content)?;
        atomic_write(&target, &content)?;
    }

    // Recreate the standard directories even if the archive had no entries
    // for them (e.g. empty artifacts/ exported without artifacts).
    std::fs::create_dir_all(dest_paths.tasks_dir())?;
    std::fs::create_dir_all(dest_paths.artifacts_dir())?;
    std::fs::create_dir_all(dest_paths.snapshots_dir())?;
    // Same three lines init ships (init.rs): the restored workspace re-creates
    // all three machine-local files, so ignoring only secrets.enc would leave
    // index.sqlite and .mutex as untracked noise in a versioned workspace.
    atomic_write(
        &dest_paths.nextup_dir().join(".gitignore"),
        b"secrets.enc\nindex.sqlite\n.mutex\n",
    )?;

    // Seal secrets under this machine's master key.
    save_secrets(&dest_paths.secrets_file(), keys, &secret_map)?;

    // Narrowing applies itself; widening waits for a person (D143). A backup
    // with agent access switched off restores switched off — restoring it on
    // would open the read tier the user had shut.
    if let Some(access) = carried_access {
        if !access.enabled {
            save_access(&live_access, &AgentAccess { allowed_tools: Vec::new(), ..access.clone() })?;
        }
        if !access.allowed_tools.is_empty() {
            save_restored_access(
                &dest_paths,
                &RestoredAccess { allowed_tools: access.allowed_tools, exported_at: manifest.exported_at.clone() },
            )?;
        }
    }

    ledger_for(&dest_paths).append(&LedgerEvent::new(
        LedgerKind::BackupImported,
        format!(
            "backup \"{}\" imported (exported at {})",
            manifest.project_name, manifest.exported_at
        ),
        None,
    ))?;

    open_workspace(dest_root)
}

/// Whether an archive path names one of the two grant files. Compared the
/// way Windows resolves names — case-insensitively, trailing dots and spaces
/// dropped, an alternate-stream suffix ignored — because a plain equality
/// check would let `.NEXTUP/Agent_Access.json.` through and land on the very
/// file it was meant to keep out.
fn is_grant_file(relative: &Path) -> bool {
    use crate::workspace::layout::{AGENT_ACCESS_FILE, NEXTUP_DIR, RESTORED_ACCESS_FILE};
    let parts: Vec<String> = relative
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(p) => {
                let p = p.to_string_lossy();
                let p = p.split(':').next().unwrap_or_default();
                Some(p.trim_end_matches(['.', ' ']).to_ascii_lowercase())
            }
            _ => None,
        })
        .collect();
    parts.len() == 2 && parts[0] == NEXTUP_DIR && (parts[1] == AGENT_ACCESS_FILE || parts[1] == RESTORED_ACCESS_FILE)
}

fn validate_passphrase(passphrase: &str) -> Result<()> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(NextUpError::InvalidInput(format!(
            "backup passphrase must be at least {MIN_PASSPHRASE} characters"
        )));
    }
    Ok(())
}

fn add_file(
    zip: &mut ZipWriter<File>,
    options: SimpleFileOptions,
    root: &Path,
    file_path: &Path,
) -> Result<()> {
    let relative = file_path.strip_prefix(root).map_err(|_| {
        NextUpError::Backup(format!("file {} escapes workspace root", file_path.display()))
    })?;
    let zip_name = relative.to_string_lossy().replace('\\', "/");
    zip.start_file(zip_name, options).map_err(zip_err)?;
    let content = std::fs::read(file_path)?;
    zip.write_all(&content)?;
    Ok(())
}

fn zip_err(e: zip::result::ZipError) -> NextUpError {
    NextUpError::Backup(format!("archive error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;
    use crate::security::secrets::set_secret;
    use crate::workspace::init::{initialize_project, InitProjectParams};
    use crate::workspace::ops::create_task;
    use crate::workspace::tasks::{NewTask, TaskStore};

    const PASS: &str = "travel-safe-passphrase";

    /// Machine A and machine B intentionally hold different master keys.
    fn machine_a() -> StaticKeyProvider {
        StaticKeyProvider([0xAA; 32])
    }
    fn machine_b() -> StaticKeyProvider {
        StaticKeyProvider([0xBB; 32])
    }

    fn make_workspace(root: &Path) -> WorkspacePaths {
        initialize_project(
            &InitProjectParams {
                root: root.to_string_lossy().into_owned(),
                name: "portable".into(),
                domain: "coding".into(),
                description: "backup test".into(),
                goals: vec!["migrate cleanly".into()],
                boundaries: vec![],
                ..Default::default()
            },
            &machine_a(),
            "0.1.0",
        )
        .unwrap();
        WorkspacePaths::new(root)
    }

    #[test]
    fn cross_machine_roundtrip_reseals_secrets() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        set_secret(&paths.secrets_file(), &machine_a(), "API_KEY", "sk-123").unwrap();
        create_task(&paths, "0.1.0", NewTask { title: "carry me over".into(), priority: 1, ..Default::default() },
        )
        .unwrap();
        // A folded spec lives only in specs/ — nothing else carries it, so a
        // backup that skips that directory loses it without a word (D103).
        std::fs::create_dir_all(paths.specs_dir()).unwrap();
        std::fs::write(paths.specs_dir().join("auth.md"), "# Auth\nfolded truth\n").unwrap();

        let zip_dir = tempfile::tempdir().unwrap();
        let zip_path = zip_dir.path().join("backup.zip");
        export_backup(&paths, &machine_a(), &zip_path, PASS, false, "0.1.0").unwrap();

        // Import on "machine B" with a different master key.
        let dst = tempfile::tempdir().unwrap();
        let ctx = import_backup(&zip_path, dst.path(), &machine_b(), PASS).unwrap();
        assert_eq!(ctx.name, "portable");

        let dst_paths = WorkspacePaths::new(dst.path());
        let tasks = TaskStore::new(dst_paths.tasks_dir()).list().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "carry me over");

        // The workflow harness (position included) travels with the backup.
        let workflow =
            crate::workspace::workflow::load_workflow(&dst_paths.workflow_file()).unwrap();
        assert_eq!(workflow.template_id, "generic-v1");

        // The spec layer migrates with its content intact (D103).
        assert_eq!(
            std::fs::read_to_string(dst_paths.specs_dir().join("auth.md")).unwrap(),
            "# Auth\nfolded truth\n"
        );

        // The AI-session bootstrap layer migrates too.
        assert!(dst_paths.claude_md_file().is_file());
        assert!(dst_paths.nextup_guide_file().is_file());
        assert!(dst_paths.memory_index_file().is_file());
        assert!(dst_paths.manifest_file().is_file());

        // The secret is readable under machine B's key — and *only* B's.
        let secrets = load_secrets(&dst_paths.secrets_file(), &machine_b()).unwrap();
        assert_eq!(secrets.get("API_KEY").unwrap(), "sk-123");
        assert!(load_secrets(&dst_paths.secrets_file(), &machine_a()).is_err());

        // The rebuilt .gitignore matches what init ships — a restored
        // workspace re-creates all three machine-local files, so a shorter
        // list would leave index.sqlite and .mutex as untracked git noise.
        assert_eq!(
            std::fs::read_to_string(dst_paths.nextup_dir().join(".gitignore")).unwrap(),
            "secrets.enc\nindex.sqlite\n.mutex\n"
        );
    }

    #[test]
    fn wrong_passphrase_aborts_before_writing() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        let zip_dir = tempfile::tempdir().unwrap();
        let zip_path = zip_dir.path().join("backup.zip");
        export_backup(&paths, &machine_a(), &zip_path, PASS, false, "0.1.0").unwrap();

        let dst = tempfile::tempdir().unwrap();
        let err = import_backup(&zip_path, dst.path(), &machine_b(), "wrong-passphrase").unwrap_err();
        assert_eq!(err.kind(), "crypto");
        assert!(
            !WorkspacePaths::new(dst.path()).nextup_dir().exists(),
            "failed import must not leave a partial workspace behind"
        );
    }

    #[test]
    fn short_passphrase_rejected() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        let err = export_backup(&paths, &machine_a(), &src.path().join("b.zip"), "short", false, "0.1.0")
            .unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }

    #[test]
    fn import_refuses_existing_workspace() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        let zip_dir = tempfile::tempdir().unwrap();
        let zip_path = zip_dir.path().join("backup.zip");
        export_backup(&paths, &machine_a(), &zip_path, PASS, false, "0.1.0").unwrap();

        // Destination already initialized.
        let dst = tempfile::tempdir().unwrap();
        make_workspace(dst.path());
        let err = import_backup(&zip_path, dst.path(), &machine_b(), PASS).unwrap_err();
        assert_eq!(err.kind(), "workspace");
    }

    fn export_to(paths: &WorkspacePaths, dir: &Path) -> PathBuf {
        let zip_path = dir.join("backup.zip");
        export_backup(paths, &machine_a(), &zip_path, PASS, false, "0.1.0").unwrap();
        zip_path
    }

    #[test]
    fn grants_travel_but_wait_for_a_person() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        let granted = crate::agent::get_access(&paths).unwrap().allowed_tools;
        assert!(!granted.is_empty(), "init grants the day-one set (D63), so there is something to carry");

        let zip_dir = tempfile::tempdir().unwrap();
        let zip_path = export_to(&paths, zip_dir.path());
        let dst = tempfile::tempdir().unwrap();
        import_backup(&zip_path, dst.path(), &machine_b(), PASS).unwrap();
        let dst_paths = WorkspacePaths::new(dst.path());

        // Nothing applied: the live allowlist is the no-file default.
        assert!(!dst_paths.agent_access_file().exists());
        assert!(crate::agent::get_access(&dst_paths).unwrap().allowed_tools.is_empty());
        // ...but nothing lost either: the grants are parked for the prompt.
        let parked = crate::agent::restored_access(&dst_paths).unwrap().expect("parked");
        assert_eq!(parked.allowed_tools, granted);

        // Accepting applies them and clears the prompt.
        let access = crate::agent::resolve_restored_access(&dst_paths, true).unwrap();
        let mut got = access.allowed_tools.clone();
        let mut want = granted.clone();
        got.sort();
        want.sort();
        assert_eq!(got, want);
        assert!(crate::agent::restored_access(&dst_paths).unwrap().is_none());
    }

    #[test]
    fn dropping_parked_grants_grants_nothing() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        let zip_dir = tempfile::tempdir().unwrap();
        let zip_path = export_to(&paths, zip_dir.path());
        let dst = tempfile::tempdir().unwrap();
        import_backup(&zip_path, dst.path(), &machine_b(), PASS).unwrap();
        let dst_paths = WorkspacePaths::new(dst.path());

        let access = crate::agent::resolve_restored_access(&dst_paths, false).unwrap();
        assert!(access.allowed_tools.is_empty());
        assert!(crate::agent::restored_access(&dst_paths).unwrap().is_none());
    }

    #[test]
    fn a_switched_off_hub_restores_switched_off() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        crate::agent::set_enabled(&paths, false).unwrap();
        let zip_dir = tempfile::tempdir().unwrap();
        let zip_path = export_to(&paths, zip_dir.path());
        let dst = tempfile::tempdir().unwrap();
        import_backup(&zip_path, dst.path(), &machine_b(), PASS).unwrap();
        let dst_paths = WorkspacePaths::new(dst.path());

        // Narrowing applies itself — restoring it on would reopen the read tier.
        let access = crate::agent::get_access(&dst_paths).unwrap();
        assert!(!access.enabled);
        assert!(access.allowed_tools.is_empty(), "the grants still wait for a person");
    }

    #[test]
    fn a_hand_made_archive_cannot_plant_grants() {
        let src = tempfile::tempdir().unwrap();
        let paths = make_workspace(src.path());
        let zip_dir = tempfile::tempdir().unwrap();
        let real = export_to(&paths, zip_dir.path());

        // Copy the real backup and add allowlists at the live paths, in the
        // spellings Windows would resolve to the same file.
        let crafted = zip_dir.path().join("crafted.zip");
        {
            let mut src_zip = ZipArchive::new(File::open(&real).unwrap()).unwrap();
            let mut out = ZipWriter::new(File::create(&crafted).unwrap());
            let options = SimpleFileOptions::default();
            for i in 0..src_zip.len() {
                let entry = src_zip.by_index(i).unwrap();
                out.raw_copy_file(entry).unwrap();
            }
            let planted = br#"{"schemaVersion":1,"enabled":true,"allowedTools":["create_task"]}"#;
            for name in [".nextup/agent_access.json", ".NEXTUP/Agent_Access.json.", ".nextup/agent_access.restored.json"] {
                out.start_file(name, options).unwrap();
                out.write_all(planted).unwrap();
            }
            out.finish().unwrap();
        }

        let dst = tempfile::tempdir().unwrap();
        import_backup(&crafted, dst.path(), &machine_b(), PASS).unwrap();
        let dst_paths = WorkspacePaths::new(dst.path());
        assert!(!dst_paths.agent_access_file().exists());
        // The parked list is the one export wrote, not the planted one.
        let parked = crate::agent::restored_access(&dst_paths).unwrap().expect("parked");
        assert_eq!(parked.allowed_tools, crate::agent::get_access(&paths).unwrap().allowed_tools);
    }

    #[test]
    fn grant_file_check_matches_the_way_windows_resolves_names() {
        for hit in [
            ".nextup/agent_access.json",
            ".NEXTUP/AGENT_ACCESS.JSON",
            ".nextup/agent_access.json. ",
            ".nextup/agent_access.json::$DATA",
            "./.nextup/agent_access.restored.json",
        ] {
            assert!(is_grant_file(Path::new(hit)), "{hit} lands on a grant file");
        }
        for miss in ["agent_access.json", ".nextup/tasks/agent_access.json", ".nextup/context.json"] {
            assert!(!is_grant_file(Path::new(miss)), "{miss} is not a grant file");
        }
    }
}
