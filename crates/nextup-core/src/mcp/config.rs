use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::workspace::atomic::atomic_write_json;

pub const MCP_SCHEMA_VERSION: u32 = 1;

/// One external MCP tool server. v1 speaks stdio only (child process); the
/// tagged `transport` leaves room for streamable-HTTP later without a schema
/// break.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    /// Unique registry id, e.g. "filesystem".
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub transport: McpTransport,
    pub enabled: bool,
    /// Explicit tool allowlist — **default deny**: a tool absent from this
    /// list cannot be called, mirroring the harness philosophy that any
    /// bypass must be explicit. Discovery (`list_tools`) is always allowed.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum McpTransport {
    #[serde(rename_all = "camelCase")]
    Stdio {
        /// Executable to spawn. On Windows, scripts need their extension
        /// ("npx.cmd") or a "cmd /c npx" wrapper.
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub schema_version: u32,
    pub servers: Vec<McpServerEntry>,
}

impl Default for McpConfig {
    /// Seed is an empty registry: which servers a workspace may talk to is
    /// an explicit user decision (listed by hand), never a built-in default.
    fn default() -> Self {
        Self { schema_version: MCP_SCHEMA_VERSION, servers: Vec::new() }
    }
}

impl McpConfig {
    pub fn validate(&self) -> Result<()> {
        let mut seen = HashSet::new();
        for s in &self.servers {
            if s.id.trim().is_empty() {
                return Err(NextUpError::InvalidInput("MCP server id cannot be empty".into()));
            }
            if !seen.insert(&s.id) {
                return Err(NextUpError::InvalidInput(format!("duplicate MCP server id: {}", s.id)));
            }
            let McpTransport::Stdio { command, .. } = &s.transport;
            if command.trim().is_empty() {
                return Err(NextUpError::InvalidInput(format!(
                    "MCP server '{}' has an empty command",
                    s.id
                )));
            }
        }
        Ok(())
    }

    pub fn server(&self, id: &str) -> Result<&McpServerEntry> {
        self.servers
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| NextUpError::NotFound(format!("MCP server '{id}' is not configured")))
    }

    /// Upsert by id, replacing an existing entry in place so registry order
    /// (and any hand-arranged priority) survives edits.
    pub fn upsert(&mut self, entry: McpServerEntry) {
        match self.servers.iter_mut().find(|s| s.id == entry.id) {
            Some(slot) => *slot = entry,
            None => self.servers.push(entry),
        }
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.servers.len();
        self.servers.retain(|s| s.id != id);
        self.servers.len() != before
    }
}

impl McpServerEntry {
    pub fn tool_allowed(&self, tool: &str) -> bool {
        self.allowed_tools.iter().any(|t| t == tool)
    }
}

pub fn load_config(path: &Path) -> Result<McpConfig> {
    if !path.is_file() {
        return Ok(McpConfig::default());
    }
    let cfg: McpConfig = crate::workspace::atomic::read_json_file(path)?;
    cfg.validate()?;
    Ok(cfg)
}

pub fn save_config(path: &Path, cfg: &McpConfig) -> Result<()> {
    cfg.validate()?;
    atomic_write_json(path, cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> McpServerEntry {
        McpServerEntry {
            id: id.into(),
            description: None,
            transport: McpTransport::Stdio {
                command: "server.exe".into(),
                args: vec![],
                env: BTreeMap::new(),
            },
            enabled: true,
            allowed_tools: vec![],
        }
    }

    #[test]
    fn missing_file_is_empty_registry() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = load_config(&dir.path().join("mcp.json")).unwrap();
        assert!(cfg.servers.is_empty());
    }

    #[test]
    fn roundtrip_and_tagged_transport_shape() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let mut cfg = McpConfig::default();
        cfg.upsert(entry("fs"));
        save_config(&path, &cfg).unwrap();

        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["schemaVersion"], MCP_SCHEMA_VERSION);
        assert_eq!(raw["servers"][0]["transport"]["kind"], "stdio");
        assert_eq!(raw["servers"][0]["allowedTools"], serde_json::json!([]));

        assert_eq!(load_config(&path).unwrap(), cfg);
    }

    #[test]
    fn upsert_replaces_in_place_and_remove_works() {
        let mut cfg = McpConfig::default();
        cfg.upsert(entry("a"));
        cfg.upsert(entry("b"));
        let mut changed = entry("a");
        changed.enabled = false;
        cfg.upsert(changed);
        assert_eq!(cfg.servers.len(), 2);
        assert_eq!(cfg.servers[0].id, "a");
        assert!(!cfg.servers[0].enabled);

        assert!(cfg.remove("a"));
        assert!(!cfg.remove("a"));
        assert_eq!(cfg.servers.len(), 1);
    }

    #[test]
    fn duplicate_or_empty_ids_rejected() {
        let mut cfg = McpConfig::default();
        cfg.servers.push(entry("x"));
        cfg.servers.push(entry("x"));
        assert_eq!(cfg.validate().unwrap_err().kind(), "invalid_input");

        let mut cfg = McpConfig::default();
        cfg.servers.push(entry(" "));
        assert_eq!(cfg.validate().unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn default_deny_authorization() {
        let mut e = entry("fs");
        assert!(!e.tool_allowed("read_file"));
        e.allowed_tools.push("read_file".into());
        assert!(e.tool_allowed("read_file"));
        assert!(!e.tool_allowed("write_file"));
    }
}
