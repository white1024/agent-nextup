use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;

use crate::error::{NextUpError, Result};
use crate::security::keystore::KeyProvider;
use crate::workspace::context::ProjectContext;
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::tasks::{counts_for_dir, TaskCounts};

/// Thread-safe application state shared by all IPC handlers and background
/// tasks. Clone is cheap (Arc), lock scopes stay tight, and no lock is ever
/// held across I/O — callers snapshot what they need and release.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<RwLock<Option<LoadedWorkspace>>>,
    keys: Arc<dyn KeyProvider>,
}

#[derive(Debug, Clone)]
pub struct LoadedWorkspace {
    pub root: PathBuf,
    pub context: ProjectContext,
}

impl LoadedWorkspace {
    pub fn paths(&self) -> WorkspacePaths {
        WorkspacePaths::new(&self.root)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
    pub domain: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub app_version: String,
    pub keystore_ok: bool,
    pub keystore_description: String,
    pub workspace: Option<WorkspaceInfo>,
    pub task_counts: Option<TaskCounts>,
}

impl AppState {
    pub fn new(keys: Arc<dyn KeyProvider>) -> Self {
        Self { inner: Arc::new(RwLock::new(None)), keys }
    }

    pub fn key_provider(&self) -> Arc<dyn KeyProvider> {
        Arc::clone(&self.keys)
    }

    pub fn set_workspace(&self, root: PathBuf, context: ProjectContext) {
        *self.inner.write() = Some(LoadedWorkspace { root, context });
    }

    pub fn clear_workspace(&self) {
        *self.inner.write() = None;
    }

    /// Snapshot of the currently loaded workspace (if any).
    pub fn workspace(&self) -> Option<LoadedWorkspace> {
        self.inner.read().clone()
    }

    pub fn require_workspace(&self) -> Result<LoadedWorkspace> {
        self.workspace()
            .ok_or_else(|| NextUpError::Workspace("no workspace is currently loaded".into()))
    }

    /// Lightweight status DTO for the dashboard. Task counts are read from
    /// disk on demand — files are the source of truth, not this struct.
    pub fn status(&self, app_version: &str) -> SystemStatus {
        let workspace = self.workspace();
        let (info, counts) = match &workspace {
            Some(ws) => {
                let counts = counts_for_dir(&ws.paths().tasks_dir()).ok();
                (
                    Some(WorkspaceInfo {
                        root: ws.root.to_string_lossy().into_owned(),
                        name: ws.context.name.clone(),
                        domain: ws.context.domain.clone(),
                        description: ws.context.description.clone(),
                    }),
                    counts,
                )
            }
            None => (None, None),
        };
        SystemStatus {
            app_version: app_version.to_string(),
            // Read-only on purpose (D103): status refreshes on every dashboard
            // render, and `master_key()` would create the key as a side effect.
            keystore_ok: self.keys.master_key_exists(),
            keystore_description: self.keys.describe(),
            workspace: info,
            task_counts: counts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::crypto::KEY_LEN;
    use crate::security::keystore::StaticKeyProvider;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn state() -> AppState {
        AppState::new(Arc::new(StaticKeyProvider([5u8; 32])))
    }

    /// Records whether anything asked for the key material itself, so a status
    /// read can be told apart from a real use of the key (D103).
    struct SpyProvider(AtomicBool);

    impl KeyProvider for SpyProvider {
        fn master_key(&self) -> Result<[u8; KEY_LEN]> {
            self.0.store(true, Ordering::SeqCst);
            Ok([9u8; KEY_LEN])
        }

        fn master_key_exists(&self) -> bool {
            false
        }

        fn describe(&self) -> String {
            "spy".into()
        }
    }

    #[test]
    fn status_never_creates_the_master_key() {
        let spy = Arc::new(SpyProvider(AtomicBool::new(false)));
        let s = AppState::new(spy.clone());

        let status = s.status("0.1.0");

        assert!(!status.keystore_ok, "no key exists, so status reports none");
        assert!(
            !spy.0.load(Ordering::SeqCst),
            "status asked for the key itself — on the real provider that writes \
             a credential into the user's OS store just to render a dashboard"
        );
    }

    #[test]
    fn starts_without_workspace() {
        let s = state();
        assert!(s.workspace().is_none());
        assert_eq!(s.require_workspace().unwrap_err().kind(), "workspace");
        let status = s.status("0.1.0");
        assert!(status.keystore_ok);
        assert!(status.workspace.is_none());
    }

    #[test]
    fn set_and_clear_workspace() {
        let s = state();
        let ctx = ProjectContext::new("x", "coding", "", vec![], vec![]);
        s.set_workspace(PathBuf::from("C:/tmp/x"), ctx);
        assert_eq!(s.require_workspace().unwrap().context.name, "x");

        let status = s.status("0.1.0");
        assert_eq!(status.workspace.unwrap().name, "x");

        s.clear_workspace();
        assert!(s.workspace().is_none());
    }

    #[test]
    fn state_is_shareable_across_threads() {
        let s = state();
        let s2 = s.clone();
        let handle = std::thread::spawn(move || {
            let ctx = ProjectContext::new("threaded", "coding", "", vec![], vec![]);
            s2.set_workspace(PathBuf::from("C:/tmp/threaded"), ctx);
        });
        handle.join().unwrap();
        assert_eq!(s.require_workspace().unwrap().context.name, "threaded");
    }
}
