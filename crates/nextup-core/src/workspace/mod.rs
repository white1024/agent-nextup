//! Workspace Engine: project initialization, task tracking, event ledger,
//! handoff checkpoint serialization and portable backups.
//!
//! Design decisions:
//! - **Files are the source of truth.** Tasks live as one JSON file each under
//!   `tasks/`, configuration under `.nextup/`. Everything is human-readable,
//!   git-friendly and watchable; any index built on top is disposable.
//! - **Atomic writes everywhere.** JSON files are written via temp+rename so
//!   a crash can never leave a half-written config behind.
//! - **Append-only ledger.** `.nextup/ledger.jsonl` records every state change
//!   and feeds the "Context Delta / Recent Ledger" handoff section.
//! - **Execution harness.** `.nextup/workflow.json` is a phase state machine
//!   instantiated from a template (built-in or user JSON): each phase carries
//!   AI directives and enforced exit gates the engine evaluates against the
//!   real workspace state. Sessions are *driven* by the harness, not merely
//!   advised by prose guidelines.

pub mod agent_catalog;
pub mod assets;
pub mod atomic;
pub mod backup;
pub mod bootstrap;
pub mod context;
pub mod doctor;
pub mod exchange;
pub mod flywheel;
pub mod handoff;
pub mod ids;
pub mod init;
pub mod layout;
pub mod ledger;
pub mod lock;
pub mod manifest;
pub mod modules;
pub mod ops;
pub mod prime;
pub mod registry;
pub mod rules;
pub mod settings;
pub mod specs;
pub mod sync;
pub mod tasks;
pub mod teams;
pub mod templates;
pub mod workflow;
