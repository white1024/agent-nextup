//! Locating the `nextup-mcp` hub binary so users never have to build it and
//! add it to PATH by hand.
//!
//! The workspace's root `.mcp.json` tells the agent host how to spawn the hub
//! server. Shipped with a bare `nextup-mcp` command it only works if that name
//! is on PATH — the historical papercut. Instead the app resolves the binary
//! next to its own executable (bundled sidecar in a release, the shared
//! `target/<profile>/` dir in dev) or on PATH, and rewrites `.mcp.json` to the
//! resolved *absolute* path at init time (and on demand via the repair button).

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Bare binary name (no extension) of the hub server.
const HUB_BIN: &str = "nextup-mcp";

fn hub_file_name() -> String {
    format!("{HUB_BIN}{}", std::env::consts::EXE_SUFFIX)
}

/// Where the app found the hub binary, plus whether the workspace's current
/// `.mcp.json` command will actually launch. Serialized to the Tools panel.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpStatus {
    /// Absolute path the app resolved the hub binary to, or `null` if it is
    /// nowhere to be found (user must build it first).
    pub resolved_path: Option<String>,
    /// The `command` currently wired into the workspace `.mcp.json` `nextup`
    /// server, or `null` if the file/entry is missing.
    pub discovery_command: Option<String>,
    /// True when `discovery_command` will actually spawn: an absolute path that
    /// exists, or a bare name resolvable on PATH.
    pub healthy: bool,
}

/// Resolve the hub binary: sibling of our own executable first (covers both a
/// bundled sidecar and dev's shared target dir), then PATH.
pub fn resolve_hub_binary() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join(hub_file_name());
            if sibling.is_file() {
                return Some(sibling);
            }
        }
    }
    find_on_path(&hub_file_name())
}

/// Would `command` (as written in `.mcp.json`) actually launch a binary?
fn command_resolves(command: &str) -> bool {
    let looks_like_path =
        command.contains('/') || command.contains('\\') || Path::new(command).is_absolute();
    if looks_like_path {
        Path::new(command).is_file()
    } else {
        // Bare name: try the exact name and the platform-suffixed variant.
        find_on_path(command).is_some()
            || find_on_path(&format!("{command}{}", std::env::consts::EXE_SUFFIX)).is_some()
    }
}

fn find_on_path(file_name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(file_name))
        .find(|candidate| candidate.is_file())
}

/// Read the `nextup` server's `command` from a workspace `.mcp.json`.
fn read_discovery_command(mcp_json: &Path) -> Option<String> {
    let raw = std::fs::read(mcp_json).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    value
        .get("mcpServers")?
        .get("nextup")?
        .get("command")?
        .as_str()
        .map(|s| s.to_string())
}

/// Post-entry wiring shared by every workspace entrance (initialize, legacy
/// adoption, backup import): point the workspace `.mcp.json` at the resolved
/// absolute hub path. Best-effort — a missing binary or an unparseable
/// `.mcp.json` just leaves the current command in place, which the Tools
/// panel then flags for one-click repair.
pub fn wire_hub_discovery(root: &Path) {
    if let Some(hub) = resolve_hub_binary() {
        let paths = nextup_core::workspace::layout::WorkspacePaths::new(root);
        let _ = nextup_core::workspace::bootstrap::set_mcp_discovery_command(
            &paths,
            &hub.to_string_lossy(),
        );
    }
}

/// Assemble the panel status for a workspace root.
pub fn status_for(root: &Path) -> AgentMcpStatus {
    let mcp_json = root.join(nextup_core::workspace::layout::MCP_DISCOVERY_FILE);
    let discovery_command = read_discovery_command(&mcp_json);
    let healthy = discovery_command
        .as_deref()
        .map(command_resolves)
        .unwrap_or(false);
    AgentMcpStatus {
        resolved_path: resolve_hub_binary().map(|p| p.to_string_lossy().into_owned()),
        discovery_command,
        healthy,
    }
}
