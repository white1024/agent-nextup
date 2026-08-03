use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::orchestrator::provider::Usage;
use crate::workspace::atomic::atomic_write_json;

pub const ORCHESTRATOR_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Anthropic,
    OpenAI,
    Ollama,
}

impl ProviderKind {
    /// Cloud providers authenticate via a secret from the encrypted store;
    /// local Ollama does not.
    pub fn needs_secret(&self) -> bool {
        !matches!(self, ProviderKind::Ollama)
    }
}

/// One routable model in the registry. Costs are USD per million tokens so
/// entries read like provider pricing pages; all fields are user-editable
/// in `.nextup/orchestrator.json` (files-as-truth).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// Unique registry id, conventionally "provider:model".
    pub id: String,
    pub provider: ProviderKind,
    /// Provider-native model name sent on the wire.
    pub model: String,
    /// Name of the API key in the secrets store (cloud providers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_name: Option<String>,
    /// Override for self-hosted gateways / non-default Ollama hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Free-form capability tags the router matches against
    /// ("chat", "tools", "vision", "long-context", "local", …).
    pub capabilities: Vec<String>,
    pub input_cost_per_mtok: f64,
    pub output_cost_per_mtok: f64,
    pub context_window: u32,
    pub enabled: bool,
}

impl ModelEntry {
    /// Blended per-Mtok cost used for "cheapest" ordering. Weights output
    /// 3:1 like typical chat workloads (short prompt, longer answer).
    pub fn blended_cost(&self) -> f64 {
        (self.input_cost_per_mtok + 3.0 * self.output_cost_per_mtok) / 4.0
    }

    pub fn estimate_cost_usd(&self, usage: &Usage) -> f64 {
        f64::from(usage.input_tokens) * self.input_cost_per_mtok / 1_000_000.0
            + f64::from(usage.output_tokens) * self.output_cost_per_mtok / 1_000_000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutePreference {
    /// Registry order — quality-first, predictable.
    First,
    /// Lowest blended cost among the candidates.
    Cheapest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingPolicy {
    pub prefer: RoutePreference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorConfig {
    pub schema_version: u32,
    pub models: Vec<ModelEntry>,
    pub routing: RoutingPolicy,
}

impl Default for OrchestratorConfig {
    /// Seed registry: one entry per adapter, quality-first order. Prices
    /// are indicative and meant to be edited alongside provider changes.
    fn default() -> Self {
        Self {
            schema_version: ORCHESTRATOR_SCHEMA_VERSION,
            models: vec![
                ModelEntry {
                    id: "anthropic:claude-sonnet-5".into(),
                    provider: ProviderKind::Anthropic,
                    model: "claude-sonnet-5".into(),
                    secret_name: Some("ANTHROPIC_API_KEY".into()),
                    base_url: None,
                    capabilities: strings(&["chat", "tools", "vision", "long-context"]),
                    input_cost_per_mtok: 3.0,
                    output_cost_per_mtok: 15.0,
                    context_window: 200_000,
                    enabled: true,
                },
                ModelEntry {
                    id: "openai:gpt-4o".into(),
                    provider: ProviderKind::OpenAI,
                    model: "gpt-4o".into(),
                    secret_name: Some("OPENAI_API_KEY".into()),
                    base_url: None,
                    capabilities: strings(&["chat", "tools", "vision"]),
                    input_cost_per_mtok: 2.5,
                    output_cost_per_mtok: 10.0,
                    context_window: 128_000,
                    enabled: true,
                },
                ModelEntry {
                    id: "ollama:llama3.1".into(),
                    provider: ProviderKind::Ollama,
                    model: "llama3.1".into(),
                    secret_name: None,
                    base_url: None,
                    capabilities: strings(&["chat", "local"]),
                    input_cost_per_mtok: 0.0,
                    output_cost_per_mtok: 0.0,
                    context_window: 8_192,
                    enabled: true,
                },
            ],
            routing: RoutingPolicy { prefer: RoutePreference::First },
        }
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

impl OrchestratorConfig {
    pub fn validate(&self) -> Result<()> {
        let mut seen = HashSet::new();
        for m in &self.models {
            if m.id.trim().is_empty() || m.model.trim().is_empty() {
                return Err(NextUpError::InvalidInput(
                    "orchestrator model entries need non-empty id and model".into(),
                ));
            }
            if !seen.insert(&m.id) {
                return Err(NextUpError::InvalidInput(format!(
                    "duplicate orchestrator model id: {}",
                    m.id
                )));
            }
            if m.input_cost_per_mtok < 0.0 || m.output_cost_per_mtok < 0.0 {
                return Err(NextUpError::InvalidInput(format!(
                    "negative cost on orchestrator model: {}",
                    m.id
                )));
            }
            if m.provider.needs_secret() && m.secret_name.is_none() {
                return Err(NextUpError::InvalidInput(format!(
                    "model '{}' needs a secretName (its provider requires an API key)",
                    m.id
                )));
            }
        }
        Ok(())
    }
}

pub fn load_config(path: &Path) -> Result<OrchestratorConfig> {
    let cfg: OrchestratorConfig = crate::workspace::atomic::read_json_file(path)?;
    cfg.validate()?;
    Ok(cfg)
}

pub fn save_config(path: &Path, cfg: &OrchestratorConfig) -> Result<()> {
    cfg.validate()?;
    atomic_write_json(path, cfg)
}

/// Read the registry, seeding the default one on first use so the file is
/// there for the user to edit (files-as-truth).
pub fn load_or_init(path: &Path) -> Result<OrchestratorConfig> {
    if path.is_file() {
        return load_config(path);
    }
    let cfg = OrchestratorConfig::default();
    save_config(path, &cfg)?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_seed_is_valid_and_quality_first() {
        let cfg = OrchestratorConfig::default();
        cfg.validate().unwrap();
        assert_eq!(cfg.models[0].provider, ProviderKind::Anthropic);
        assert_eq!(cfg.routing.prefer, RoutePreference::First);
    }

    #[test]
    fn load_or_init_seeds_then_reloads_same_registry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orchestrator.json");
        let first = load_or_init(&path).unwrap();
        assert!(path.is_file());
        let second = load_or_init(&path).unwrap();
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap()
        );
    }

    #[test]
    fn config_serializes_camel_case() {
        let v = serde_json::to_value(OrchestratorConfig::default()).unwrap();
        assert_eq!(v["schemaVersion"], ORCHESTRATOR_SCHEMA_VERSION);
        assert!(v["models"][0]["inputCostPerMtok"].is_number());
        assert_eq!(v["models"][0]["secretName"], "ANTHROPIC_API_KEY");
    }

    #[test]
    fn duplicate_ids_rejected() {
        let mut cfg = OrchestratorConfig::default();
        let dup = cfg.models[0].clone();
        cfg.models.push(dup);
        assert_eq!(cfg.validate().unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn cloud_entry_without_secret_name_rejected() {
        let mut cfg = OrchestratorConfig::default();
        cfg.models[0].secret_name = None;
        assert_eq!(cfg.validate().unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn cost_estimate_math() {
        let entry = &OrchestratorConfig::default().models[0]; // 3 / 15 per Mtok
        let usage = Usage { input_tokens: 1_000_000, output_tokens: 200_000 };
        let cost = entry.estimate_cost_usd(&usage);
        assert!((cost - (3.0 + 3.0)).abs() < 1e-9);
    }
}
