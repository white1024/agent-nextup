use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};

/// Conversation roles. `system` is carried separately on the request because
/// providers disagree on whether it is a message (OpenAI/Ollama) or a
/// top-level field (Anthropic); adapters map it where their API wants it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: Role::User, content: content.into() }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: Role::Assistant, content: content.into() }
    }
}

/// Provider-agnostic completion request. `model` is the provider-native
/// model name (the router copies it from the selected registry entry).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

/// Token counts as reported by the provider (authoritative, unlike
/// [`estimate_tokens`] which is a local pre-flight guess).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    pub text: String,
    /// Model name echoed by the provider (may include a version suffix).
    pub model: String,
    pub usage: Usage,
    /// Provider-native stop reason ("end_turn", "stop", "length", …);
    /// not normalized in v1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

/// Port for LLM backends (Module D foundation). Implementations are
/// blocking — the IPC layer already wraps core calls in `spawn_blocking`,
/// and streaming hands text fragments to `on_delta` as they arrive so the
/// caller can forward them over an event channel.
pub trait LLMProvider: Send + Sync {
    /// Stable adapter id ("anthropic" | "openai" | "ollama").
    fn id(&self) -> &'static str;

    fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse>;

    /// Streamed completion. Returns the assembled final response; usage is
    /// filled from the stream's terminal events when the API reports it.
    fn complete_streaming(
        &self,
        req: &CompletionRequest,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<CompletionResponse>;

    /// Cheap local token estimate for pre-flight budgeting.
    fn estimate_tokens(&self, text: &str) -> u32 {
        estimate_tokens(text)
    }
}

/// Heuristic token estimate: CJK scripts run ~1 token per character, the
/// rest ~4 characters per token. Good enough for routing/cost preview;
/// billing always uses provider-reported [`Usage`].
pub fn estimate_tokens(text: &str) -> u32 {
    let mut cjk: u32 = 0;
    let mut other: u32 = 0;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else if !c.is_whitespace() {
            other += 1;
        }
    }
    cjk + other.div_ceil(4)
}

fn is_cjk(c: char) -> bool {
    matches!(u32::from(c),
        0x3400..=0x4DBF      // CJK ext A
        | 0x4E00..=0x9FFF    // CJK unified
        | 0xF900..=0xFAFF    // CJK compat
        | 0x3040..=0x30FF    // kana
        | 0xAC00..=0xD7AF    // hangul
    )
}

/// Shared HTTP agent: generous read timeout because long generations
/// stream slowly; no overall timeout so streams are never cut mid-flight.
pub(crate) fn default_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(300))
        .build()
}

/// Map a ureq error into a Provider error with a readable body snippet.
pub(crate) fn http_error(provider: &str, err: ureq::Error) -> NextUpError {
    match err {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let snippet: String = body.chars().take(300).collect();
            NextUpError::Provider(format!("{provider}: HTTP {code}: {snippet}"))
        }
        other => NextUpError::Provider(format!("{provider}: {other}")),
    }
}

pub(crate) fn bad_payload(provider: &str, what: &str) -> NextUpError {
    NextUpError::Provider(format!("{provider}: unexpected response shape: {what}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_counts_ascii_at_four_chars_per_token() {
        // 12 non-whitespace chars -> 3 tokens.
        assert_eq!(estimate_tokens("hello world."), 3);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn estimate_counts_cjk_at_one_char_per_token() {
        assert_eq!(estimate_tokens("繁體中文測試"), 6);
    }

    #[test]
    fn estimate_mixes_scripts() {
        // "測試" = 2 CJK + "abcd" = 1 -> 3; whitespace ignored.
        assert_eq!(estimate_tokens("測試 abcd"), 3);
    }

    #[test]
    fn roles_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&Role::User).unwrap(), "\"user\"");
        assert_eq!(serde_json::to_string(&Role::Assistant).unwrap(), "\"assistant\"");
    }

    #[test]
    fn request_roundtrips_camel_case() {
        let req = CompletionRequest {
            model: "m".into(),
            system: Some("s".into()),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: Some(128),
            temperature: None,
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["maxTokens"], 128);
        assert!(v.get("temperature").is_none());
        let back: CompletionRequest = serde_json::from_value(v).unwrap();
        assert_eq!(back.messages[0].content, "hi");
    }
}
