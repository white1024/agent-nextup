//! Module D foundation (Phase 3a): provider-agnostic LLM port, HTTP
//! adapters (Anthropic / OpenAI / Ollama), and a registry-driven router.
//!
//! Everything here is blocking on purpose — the IPC layer wraps core calls
//! in `spawn_blocking`, and streamed deltas flow through a callback that the
//! delivery layer can forward over a Tauri event channel.

pub mod anthropic;
pub mod config;
pub mod ollama;
pub mod openai;
pub mod provider;
pub mod router;
pub mod sse;

pub use config::{
    load_or_init, ModelEntry, OrchestratorConfig, ProviderKind, RoutePreference, RoutingPolicy,
};
pub use provider::{
    estimate_tokens, ChatMessage, CompletionRequest, CompletionResponse, LLMProvider, Role, Usage,
};
pub use router::{build_provider, select_model, RouteQuery};
