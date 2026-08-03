use crate::error::{NextUpError, Result};
use crate::mcp::client::{McpCallOutcome, McpClient, McpToolInfo};
use crate::mcp::config::{load_config, save_config, McpConfig, McpServerEntry};
use crate::workspace::layout::WorkspacePaths;
use crate::workspace::ledger::{ledger_for, LedgerEvent, LedgerKind};

/// Read the registry (empty when the file does not exist yet).
pub fn list_servers(paths: &WorkspacePaths) -> Result<McpConfig> {
    load_config(&paths.mcp_file())
}

/// Add or replace a server entry.
pub fn set_server(paths: &WorkspacePaths, entry: McpServerEntry) -> Result<McpConfig> {
    let mut cfg = load_config(&paths.mcp_file())?;
    cfg.upsert(entry);
    save_config(&paths.mcp_file(), &cfg)?;
    Ok(cfg)
}

pub fn remove_server(paths: &WorkspacePaths, id: &str) -> Result<McpConfig> {
    let mut cfg = load_config(&paths.mcp_file())?;
    if !cfg.remove(id) {
        return Err(NextUpError::NotFound(format!("MCP server '{id}' is not configured")));
    }
    save_config(&paths.mcp_file(), &cfg)?;
    Ok(cfg)
}

/// Flip one tool on a server's allowlist (default deny — authorizing is
/// always an explicit act, so this is the only way a tool becomes callable).
pub fn set_tool_allowed(
    paths: &WorkspacePaths,
    server_id: &str,
    tool: &str,
    allowed: bool,
) -> Result<McpConfig> {
    let mut cfg = load_config(&paths.mcp_file())?;
    let entry = cfg
        .servers
        .iter_mut()
        .find(|s| s.id == server_id)
        .ok_or_else(|| NextUpError::NotFound(format!("MCP server '{server_id}' is not configured")))?;
    entry.allowed_tools.retain(|t| t != tool);
    if allowed {
        entry.allowed_tools.push(tool.to_string());
    }
    save_config(&paths.mcp_file(), &cfg)?;
    Ok(cfg)
}

/// Connect and list the server's tools, annotated with authorization
/// state. Discovery is allowed even for disabled servers so the catalog
/// can be set up before switching a server on.
pub fn probe_server(paths: &WorkspacePaths, server_id: &str) -> Result<Vec<McpToolInfo>> {
    let cfg = load_config(&paths.mcp_file())?;
    let entry = cfg.server(server_id)?;
    let client = McpClient::connect(entry)?;
    let tools = client.list_tools();
    client.shutdown();
    let mut tools = tools?;
    for t in &mut tools {
        t.allowed = entry.tool_allowed(&t.name);
    }
    Ok(tools)
}

/// Gate a call against the registry: the server must be enabled and the
/// tool explicitly allowed.
fn authorize<'a>(cfg: &'a McpConfig, server_id: &str, tool: &str) -> Result<&'a McpServerEntry> {
    let entry = cfg.server(server_id)?;
    if !entry.enabled {
        return Err(NextUpError::Provider(format!(
            "MCP server '{server_id}' is disabled — enable it before calling tools"
        )));
    }
    if !entry.tool_allowed(tool) {
        return Err(NextUpError::Provider(format!(
            "tool '{tool}' on '{server_id}' is not authorized — allow it in the tool catalog first"
        )));
    }
    Ok(entry)
}

/// Authorized tool call. Every execution attempt that reaches the server —
/// success, tool error, or transport failure — lands in the ledger for
/// traceability.
pub fn call_tool(
    paths: &WorkspacePaths,
    server_id: &str,
    tool: &str,
    arguments: Option<serde_json::Value>,
) -> Result<McpCallOutcome> {
    let cfg = load_config(&paths.mcp_file())?;
    let entry = authorize(&cfg, server_id, tool)?;

    let outcome = McpClient::connect(entry).and_then(|client| {
        let result = client.call_tool(tool, arguments);
        client.shutdown();
        result
    });

    let message = match &outcome {
        Ok(o) if o.is_error => format!("{server_id}:{tool} tool error ({} ms)", o.duration_ms),
        Ok(o) => format!("{server_id}:{tool} ok ({} ms)", o.duration_ms),
        Err(e) => format!("{server_id}:{tool} failed: {e}"),
    };
    ledger_for(paths).append(&LedgerEvent::new(LedgerKind::McpToolCalled, message, None))?;

    outcome
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::mcp::config::McpTransport;

    fn workspace() -> (tempfile::TempDir, WorkspacePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = WorkspacePaths::new(dir.path());
        (dir, paths)
    }

    fn entry(id: &str) -> McpServerEntry {
        McpServerEntry {
            id: id.into(),
            description: None,
            transport: McpTransport::Stdio {
                command: "nextup-test-server".into(),
                args: vec![],
                env: BTreeMap::new(),
            },
            enabled: true,
            allowed_tools: vec![],
        }
    }

    #[test]
    fn registry_crud_roundtrip() {
        let (_g, paths) = workspace();
        assert!(list_servers(&paths).unwrap().servers.is_empty());

        set_server(&paths, entry("fs")).unwrap();
        let cfg = set_server(&paths, entry("web")).unwrap();
        assert_eq!(cfg.servers.len(), 2);

        let cfg = set_tool_allowed(&paths, "fs", "read_file", true).unwrap();
        assert!(cfg.server("fs").unwrap().tool_allowed("read_file"));
        let cfg = set_tool_allowed(&paths, "fs", "read_file", false).unwrap();
        assert!(!cfg.server("fs").unwrap().tool_allowed("read_file"));

        let cfg = remove_server(&paths, "web").unwrap();
        assert_eq!(cfg.servers.len(), 1);
        assert_eq!(remove_server(&paths, "web").unwrap_err().kind(), "not_found");
    }

    #[test]
    fn unauthorized_tool_is_refused_before_any_connection() {
        let (_g, paths) = workspace();
        set_server(&paths, entry("fs")).unwrap();

        // Command doesn't exist, but authorization fails first — proving
        // no process spawn is attempted for unauthorized calls.
        let err = call_tool(&paths, "fs", "read_file", None).unwrap_err();
        assert_eq!(err.kind(), "provider");
        assert!(err.to_string().contains("not authorized"));
    }

    #[test]
    fn disabled_server_is_refused() {
        let (_g, paths) = workspace();
        let mut e = entry("fs");
        e.enabled = false;
        e.allowed_tools.push("read_file".into());
        set_server(&paths, e).unwrap();

        let err = call_tool(&paths, "fs", "read_file", None).unwrap_err();
        assert!(err.to_string().contains("disabled"));
    }

    #[test]
    fn failed_execution_attempts_still_reach_the_ledger() {
        let (_g, paths) = workspace();
        let mut e = entry("fs");
        e.allowed_tools.push("read_file".into());
        set_server(&paths, e).unwrap();

        // Authorized, so the (nonexistent) server is actually attempted.
        let err = call_tool(&paths, "fs", "read_file", None).unwrap_err();
        assert_eq!(err.kind(), "provider");

        let events = ledger_for(&paths).recent_of_kind(LedgerKind::McpToolCalled, 5).unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].message.contains("fs:read_file failed"));
    }

    #[test]
    fn probing_unknown_server_is_not_found() {
        let (_g, paths) = workspace();
        assert_eq!(probe_server(&paths, "ghost").unwrap_err().kind(), "not_found");
    }
}
