//! Agent NextUp domain core.
//!
//! Hexagonal architecture: this crate contains all business logic (workspace
//! engine, security, tasks, ledger, handoff serialization, backup) and knows
//! nothing about Tauri or IPC. The `src-tauri` crate is a thin delivery
//! adapter over these services.

pub mod agent;
pub mod error;
pub mod index;
pub mod mcp;
pub mod orchestrator;
pub mod process;
pub mod security;
pub mod state;
pub mod workspace;

pub use error::{NextUpError, Result, UnmetDependency};
