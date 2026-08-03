//! MCP integration (Phase 3b, D8: official rmcp SDK). Agent NextUp is an MCP
//! *client*: external stdio tool servers are registered per workspace in
//! `.nextup/mcp.json`, tools are callable only after explicit authorization
//! (default deny), and every execution attempt is written to the ledger.
//!
//! ⚠️ Dormant since D15 (2026-07-07): the IPC/UI surface was retired — agents
//! bring their own MCP clients (D14), so nothing consumes this module today.
//! Kept compiled+tested as groundwork for a possible future tool *gateway*
//! (hub proxies external servers under one allowlist and audit trail).

pub mod client;
pub mod config;
pub mod ops;

pub use client::{McpCallOutcome, McpClient, McpToolInfo};
pub use config::{McpConfig, McpServerEntry, McpTransport};
