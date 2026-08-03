//! Workspace behavior settings (D78): per-workspace knobs the engine reads,
//! at `.nextup/settings.json`. A missing file means the defaults, so existing
//! workspaces need no migration (the modules.json contract).
//!
//! First tenant: auto-archive — done-and-verified tasks older than a
//! threshold are swept out of default listings on workspace open. Defaults
//! ON: the whole point is that housekeeping must not depend on someone
//! remembering a button (that was D40's gap); the user can tune the window
//! or turn it off per workspace, and un-archive is always one click.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::workspace::atomic::atomic_write_json;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::lock::with_mutation_lock;

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// Default auto-archive age gate: verified a week ago is old enough to shelve
/// — fresh completions stay in takeover view while they still matter.
pub const AUTO_ARCHIVE_DEFAULT_DAYS: u32 = 7;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceSettings {
    pub schema_version: u32,
    pub auto_archive: AutoArchive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoArchive {
    /// Sweep verified-done tasks into the archive on workspace open.
    pub enabled: bool,
    /// Only tasks whose verification is at least this many days old are
    /// swept (0 = sweep immediately).
    pub days: u32,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self { schema_version: SETTINGS_SCHEMA_VERSION, auto_archive: AutoArchive::default() }
    }
}

impl Default for AutoArchive {
    fn default() -> Self {
        Self { enabled: true, days: AUTO_ARCHIVE_DEFAULT_DAYS }
    }
}

pub fn load_settings(path: &Path) -> Result<WorkspaceSettings> {
    if !path.is_file() {
        return Ok(WorkspaceSettings::default());
    }
    crate::workspace::atomic::read_json_file(path)
}

pub fn get_settings(paths: &WorkspacePaths) -> Result<WorkspaceSettings> {
    load_settings(&paths.settings_file())
}

/// Persist the whole settings document (GUI sends the full value). Under the
/// mutation lock like every other workspace write; not ledgered — a knob is
/// configuration, not project history.
pub fn save_settings(paths: &WorkspacePaths, settings: &WorkspaceSettings) -> Result<WorkspaceSettings> {
    with_mutation_lock(paths, || {
        let normalized = WorkspaceSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            auto_archive: settings.auto_archive.clone(),
        };
        atomic_write_json(&paths.settings_file(), &normalized)?;
        Ok(normalized)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_means_defaults_on() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        let s = get_settings(&paths).unwrap();
        assert!(s.auto_archive.enabled, "auto-archive defaults ON (D78)");
        assert_eq!(s.auto_archive.days, AUTO_ARCHIVE_DEFAULT_DAYS);
    }

    #[test]
    fn save_and_reload_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.nextup_dir()).unwrap();
        let s = WorkspaceSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            auto_archive: AutoArchive { enabled: false, days: 30 },
        };
        save_settings(&paths, &s).unwrap();
        let loaded = get_settings(&paths).unwrap();
        assert!(!loaded.auto_archive.enabled);
        assert_eq!(loaded.auto_archive.days, 30);
    }

    /// Unknown future fields must not break older engines: serde(default)
    /// on the container plus per-field defaults means a partial file loads.
    #[test]
    fn partial_file_fills_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        std::fs::create_dir_all(paths.nextup_dir()).unwrap();
        std::fs::write(paths.settings_file(), b"{\"schemaVersion\":1}").unwrap();
        let s = get_settings(&paths).unwrap();
        assert!(s.auto_archive.enabled);
        assert_eq!(s.auto_archive.days, AUTO_ARCHIVE_DEFAULT_DAYS);
    }
}
