use std::io::BufReader;

use serde_json::{json, Value};

use crate::error::Result;
use crate::orchestrator::provider::{
    bad_payload, default_agent, http_error, CompletionRequest, CompletionResponse, LLMProvider,
    Usage,
};
use crate::orchestrator::sse::for_each_sse_data;

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
const ID: &str = "anthropic";

/// Anthropic Messages API adapter.
pub struct AnthropicProvider {
    api_key: String,
    base_url: String,
    agent: ureq::Agent,
}

impl AnthropicProvider {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            agent: default_agent(),
        }
    }

    fn post(&self, body: &Value) -> Result<ureq::Response> {
        self.agent
            .post(&format!("{}/v1/messages", self.base_url))
            .set("x-api-key", &self.api_key)
            .set("anthropic-version", API_VERSION)
            .set("content-type", "application/json")
            .send_json(body)
            .map_err(|e| http_error(ID, e))
    }
}

/// The Messages API requires `max_tokens`; default generously when unset.
const DEFAULT_MAX_TOKENS: u32 = 4096;

fn request_body(req: &CompletionRequest, stream: bool) -> Value {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": req.messages.iter().map(|m| {
            json!({ "role": m.role, "content": m.content })
        }).collect::<Vec<_>>(),
    });
    if let Some(system) = &req.system {
        body["system"] = json!(system);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if stream {
        body["stream"] = json!(true);
    }
    body
}

fn parse_response(v: &Value) -> Result<CompletionResponse> {
    let content = v["content"].as_array().ok_or_else(|| bad_payload(ID, "missing content[]"))?;
    let text: String = content
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect();
    Ok(CompletionResponse {
        text,
        model: v["model"].as_str().unwrap_or_default().to_string(),
        usage: Usage {
            input_tokens: v["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32,
            output_tokens: v["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32,
        },
        stop_reason: v["stop_reason"].as_str().map(str::to_string),
    })
}

#[derive(Default)]
struct StreamState {
    text: String,
    model: String,
    usage: Usage,
    stop_reason: Option<String>,
}

/// Dispatch one SSE `data:` payload. Event kinds we don't consume
/// (`content_block_start/stop`, `ping`, `message_stop`) are ignored.
fn absorb_stream_event(
    st: &mut StreamState,
    data: &str,
    on_delta: &mut dyn FnMut(&str),
) -> Result<()> {
    let v: Value =
        serde_json::from_str(data).map_err(|e| bad_payload(ID, &format!("bad stream JSON: {e}")))?;
    match v["type"].as_str().unwrap_or("") {
        "message_start" => {
            st.model = v["message"]["model"].as_str().unwrap_or_default().to_string();
            st.usage.input_tokens =
                v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32;
        }
        "content_block_delta" => {
            if let Some(t) = v["delta"]["text"].as_str() {
                st.text.push_str(t);
                on_delta(t);
            }
        }
        "message_delta" => {
            if let Some(r) = v["delta"]["stop_reason"].as_str() {
                st.stop_reason = Some(r.to_string());
            }
            if let Some(out) = v["usage"]["output_tokens"].as_u64() {
                st.usage.output_tokens = out as u32;
            }
        }
        "error" => {
            let msg = v["error"]["message"].as_str().unwrap_or("unknown stream error");
            return Err(crate::error::NextUpError::Provider(format!("{ID}: {msg}")));
        }
        _ => {}
    }
    Ok(())
}

impl LLMProvider for AnthropicProvider {
    fn id(&self) -> &'static str {
        ID
    }

    fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse> {
        let resp = self.post(&request_body(req, false))?;
        let v: Value = resp.into_json()?;
        parse_response(&v)
    }

    fn complete_streaming(
        &self,
        req: &CompletionRequest,
        on_delta: &mut dyn FnMut(&str),
    ) -> Result<CompletionResponse> {
        let resp = self.post(&request_body(req, true))?;
        let mut st = StreamState::default();
        for_each_sse_data(BufReader::new(resp.into_reader()), &mut |data| {
            absorb_stream_event(&mut st, data, on_delta)
        })?;
        Ok(CompletionResponse {
            text: st.text,
            model: st.model,
            usage: st.usage,
            stop_reason: st.stop_reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::provider::ChatMessage;

    fn req() -> CompletionRequest {
        CompletionRequest {
            model: "claude-sonnet-5".into(),
            system: Some("be brief".into()),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: Some(64),
            temperature: Some(0.2),
        }
    }

    #[test]
    fn body_maps_system_and_messages() {
        let b = request_body(&req(), false);
        assert_eq!(b["model"], "claude-sonnet-5");
        assert_eq!(b["system"], "be brief");
        assert_eq!(b["max_tokens"], 64);
        assert_eq!(b["messages"][0]["role"], "user");
        assert!(b.get("stream").is_none());
        assert_eq!(request_body(&req(), true)["stream"], true);
    }

    #[test]
    fn body_defaults_required_max_tokens() {
        let mut r = req();
        r.max_tokens = None;
        assert_eq!(request_body(&r, false)["max_tokens"], DEFAULT_MAX_TOKENS);
    }

    #[test]
    fn parses_response_fixture() {
        let v: Value = serde_json::from_str(
            r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5",
                "content":[{"type":"text","text":"Hel"},{"type":"text","text":"lo"}],
                "stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":25}}"#,
        )
        .unwrap();
        let r = parse_response(&v).unwrap();
        assert_eq!(r.text, "Hello");
        assert_eq!(r.usage, Usage { input_tokens: 10, output_tokens: 25 });
        assert_eq!(r.stop_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn response_without_content_is_provider_error() {
        let v: Value = serde_json::from_str(r#"{"type":"message"}"#).unwrap();
        assert_eq!(parse_response(&v).unwrap_err().kind(), "provider");
    }

    #[test]
    fn stream_events_accumulate_text_usage_and_stop() {
        let events = [
            r#"{"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":12,"output_tokens":1}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}"#,
            r#"{"type":"message_stop"}"#,
        ];
        let mut st = StreamState::default();
        let mut deltas = Vec::new();
        for e in events {
            absorb_stream_event(&mut st, e, &mut |d| deltas.push(d.to_string())).unwrap();
        }
        assert_eq!(st.text, "Hello");
        assert_eq!(deltas, vec!["Hel", "lo"]);
        assert_eq!(st.usage, Usage { input_tokens: 12, output_tokens: 2 });
        assert_eq!(st.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(st.model, "claude-sonnet-5");
    }

    #[test]
    fn stream_error_event_surfaces_as_provider_error() {
        let mut st = StreamState::default();
        let err = absorb_stream_event(
            &mut st,
            r#"{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}"#,
            &mut |_| {},
        )
        .unwrap_err();
        assert!(err.to_string().contains("overloaded"));
    }
}
