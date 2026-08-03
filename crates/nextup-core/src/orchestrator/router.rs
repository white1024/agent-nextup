use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::orchestrator::anthropic::AnthropicProvider;
use crate::orchestrator::config::{ModelEntry, OrchestratorConfig, ProviderKind, RoutePreference};
use crate::orchestrator::ollama::OllamaProvider;
use crate::orchestrator::openai::OpenAIProvider;
use crate::orchestrator::provider::LLMProvider;
use crate::security::keystore::KeyProvider;
use crate::security::secrets::load_secrets;

/// What a caller needs from a model; the router matches it against the
/// registry. Empty requirements = "any enabled model".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteQuery {
    /// Capability tags the model must all carry.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Minimum context window in tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_context: Option<u32>,
}

/// Pick the model for a query: filter enabled entries by capabilities and
/// context window, then order by the config's routing preference.
pub fn select_model<'a>(cfg: &'a OrchestratorConfig, query: &RouteQuery) -> Result<&'a ModelEntry> {
    let candidates: Vec<&ModelEntry> = cfg
        .models
        .iter()
        .filter(|m| m.enabled)
        .filter(|m| query.capabilities.iter().all(|c| m.capabilities.contains(c)))
        .filter(|m| query.min_context.is_none_or(|n| m.context_window >= n))
        .collect();

    match cfg.routing.prefer {
        RoutePreference::First => candidates.first().copied(),
        RoutePreference::Cheapest => candidates
            .into_iter()
            .min_by(|a, b| a.blended_cost().total_cmp(&b.blended_cost())),
    }
    .ok_or_else(|| {
        NextUpError::Provider(format!(
            "no enabled model satisfies requirements (capabilities: [{}]{})",
            query.capabilities.join(", "),
            query
                .min_context
                .map(|n| format!(", minContext: {n}"))
                .unwrap_or_default()
        ))
    })
}

/// Instantiate the adapter for a registry entry, pulling the API key from
/// the encrypted secrets store when the provider needs one.
pub fn build_provider(
    entry: &ModelEntry,
    secrets_path: &Path,
    keys: &dyn KeyProvider,
) -> Result<Box<dyn LLMProvider>> {
    match entry.provider {
        ProviderKind::Ollama => Ok(Box::new(OllamaProvider::new(entry.base_url.clone()))),
        ProviderKind::Anthropic => {
            let key = required_secret(entry, secrets_path, keys)?;
            Ok(Box::new(AnthropicProvider::new(key, entry.base_url.clone())))
        }
        ProviderKind::OpenAI => {
            let key = required_secret(entry, secrets_path, keys)?;
            Ok(Box::new(OpenAIProvider::new(key, entry.base_url.clone())))
        }
    }
}

fn required_secret(
    entry: &ModelEntry,
    secrets_path: &Path,
    keys: &dyn KeyProvider,
) -> Result<String> {
    let name = entry.secret_name.as_deref().ok_or_else(|| {
        NextUpError::Provider(format!("model '{}' has no secretName configured", entry.id))
    })?;
    load_secrets(secrets_path, keys)?
        .remove(name)
        .ok_or_else(|| {
            NextUpError::Provider(format!(
                "model '{}' needs secret '{name}' — store it under Settings first",
                entry.id
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::config::RoutingPolicy;
    use crate::security::keystore::StaticKeyProvider;
    use crate::security::secrets::set_secret;

    fn caps(query: &[&str]) -> RouteQuery {
        RouteQuery {
            capabilities: query.iter().map(|s| s.to_string()).collect(),
            min_context: None,
        }
    }

    #[test]
    fn first_preference_follows_registry_order() {
        let cfg = OrchestratorConfig::default();
        assert_eq!(select_model(&cfg, &RouteQuery::default()).unwrap().id, "anthropic:claude-sonnet-5");
    }

    #[test]
    fn cheapest_preference_picks_lowest_blended_cost() {
        let mut cfg = OrchestratorConfig::default();
        cfg.routing = RoutingPolicy { prefer: RoutePreference::Cheapest };
        // Local model is free, so plain chat routes there.
        assert_eq!(select_model(&cfg, &caps(&["chat"])).unwrap().id, "ollama:llama3.1");
        // But requiring tools excludes it.
        assert_eq!(select_model(&cfg, &caps(&["chat", "tools"])).unwrap().id, "openai:gpt-4o");
    }

    #[test]
    fn capability_and_context_filters_apply() {
        let cfg = OrchestratorConfig::default();
        let q = RouteQuery {
            capabilities: vec!["chat".into()],
            min_context: Some(150_000),
        };
        assert_eq!(select_model(&cfg, &q).unwrap().id, "anthropic:claude-sonnet-5");
    }

    #[test]
    fn disabled_models_are_skipped() {
        let mut cfg = OrchestratorConfig::default();
        cfg.models[0].enabled = false;
        assert_eq!(select_model(&cfg, &RouteQuery::default()).unwrap().id, "openai:gpt-4o");
    }

    #[test]
    fn impossible_query_is_a_provider_error_naming_the_gap() {
        let cfg = OrchestratorConfig::default();
        let err = select_model(&cfg, &caps(&["quantum"])).unwrap_err();
        assert_eq!(err.kind(), "provider");
        assert!(err.to_string().contains("quantum"));
    }

    #[test]
    fn build_ollama_needs_no_secret() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = OrchestratorConfig::default();
        let entry = cfg.models.iter().find(|m| m.provider == ProviderKind::Ollama).unwrap();
        let p = build_provider(entry, &dir.path().join("secrets.enc"), &StaticKeyProvider([1; 32]))
            .unwrap();
        assert_eq!(p.id(), "ollama");
    }

    #[test]
    fn build_cloud_provider_reads_secret_or_fails_clearly() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = dir.path().join("secrets.enc");
        let kp = StaticKeyProvider([1; 32]);
        let cfg = OrchestratorConfig::default();
        let entry = &cfg.models[0]; // anthropic

        let err = build_provider(entry, &secrets, &kp).map(|p| p.id()).unwrap_err();
        assert_eq!(err.kind(), "provider");
        assert!(err.to_string().contains("ANTHROPIC_API_KEY"));

        set_secret(&secrets, &kp, "ANTHROPIC_API_KEY", "sk-ant-test").unwrap();
        assert_eq!(build_provider(entry, &secrets, &kp).unwrap().id(), "anthropic");
    }
}
