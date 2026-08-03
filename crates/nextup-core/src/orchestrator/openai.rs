use std::io::BufReader;

use serde_json::{json, Value};

use crate::error::Result;
use crate::orchestrator::provider::{
    bad_payload, default_agent, http_error, CompletionRequest, CompletionResponse, LLMProvider,
    Usage,
};
use crate::orchestrator::sse::for_each_sse_data;

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com";
const ID: &str = "openai";

/// OpenAI Chat Completions adapter. `base_url` override also covers
/// OpenAI-compatible gateways (Azure-style proxies, llama.cpp server, …).
pub struct OpenAIProvider {
    api_key: String,
    base_url: String,
    agent: ureq::Agent,
}

impl OpenAIProvider {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            agent: default_agent(),
        }
    }

    fn post(&self, body: &Value) -> Result<ureq::Response> {
        self.agent
            .post(&format!("{}/v1/chat/completions", self.base_url))
            .set("authorization", &format!("Bearer {}", self.api_key))
            .set("content-type", "application/json")
            .send_json(body)
            .map_err(|e| http_error(ID, e))
    }
}

fn request_body(req: &CompletionRequest, stream: bool) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = &req.system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for m in &req.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }
    let mut body = json!({ "model": req.model, "messages": messages });
    if let Some(n) = req.max_tokens {
        body["max_tokens"] = json!(n);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if stream {
        body["stream"] = json!(true);
        // Without this the stream never reports token usage.
        body["stream_options"] = json!({ "include_usage": true });
    }
    body
}

fn parse_usage(v: &Value) -> Usage {
    Usage {
        input_tokens: v["prompt_tokens"].as_u64().unwrap_or(0) as u32,
        output_tokens: v["completion_tokens"].as_u64().unwrap_or(0) as u32,
    }
}

fn parse_response(v: &Value) -> Result<CompletionResponse> {
    let choice = v["choices"]
        .as_array()
        .and_then(|c| c.first())
        .ok_or_else(|| bad_payload(ID, "missing choices[0]"))?;
    Ok(CompletionResponse {
        text: choice["message"]["content"].as_str().unwrap_or_default().to_string(),
        model: v["model"].as_str().unwrap_or_default().to_string(),
        usage: parse_usage(&v["usage"]),
        stop_reason: choice["finish_reason"].as_str().map(str::to_string),
    })
}

#[derive(Default)]
struct StreamState {
    text: String,
    model: String,
    usage: Usage,
    stop_reason: Option<String>,
}

/// One SSE `data:` payload. `[DONE]` is the terminator; the usage-only
/// chunk (empty `choices`) arrives just before it when requested.
fn absorb_stream_event(
    st: &mut StreamState,
    data: &str,
    on_delta: &mut dyn FnMut(&str),
) -> Result<()> {
    if data == "[DONE]" {
        return Ok(());
    }
    let v: Value =
        serde_json::from_str(data).map_err(|e| bad_payload(ID, &format!("bad stream JSON: {e}")))?;
    if let Some(model) = v["model"].as_str() {
        st.model = model.to_string();
    }
    if v["usage"].is_object() {
        st.usage = parse_usage(&v["usage"]);
    }
    if let Some(choice) = v["choices"].as_array().and_then(|c| c.first()) {
        if let Some(t) = choice["delta"]["content"].as_str() {
            if !t.is_empty() {
                st.text.push_str(t);
                on_delta(t);
            }
        }
        if let Some(r) = choice["finish_reason"].as_str() {
            st.stop_reason = Some(r.to_string());
        }
    }
    Ok(())
}

impl LLMProvider for OpenAIProvider {
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
            model: "gpt-4o".into(),
            system: Some("be brief".into()),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: Some(64),
            temperature: None,
        }
    }

    #[test]
    fn body_prepends_system_message() {
        let b = request_body(&req(), false);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["role"], "user");
        assert_eq!(b["max_tokens"], 64);
        assert!(b.get("stream").is_none());
    }

    #[test]
    fn streaming_body_requests_usage() {
        let b = request_body(&req(), true);
        assert_eq!(b["stream"], true);
        assert_eq!(b["stream_options"]["include_usage"], true);
    }

    #[test]
    fn parses_response_fixture() {
        let v: Value = serde_json::from_str(
            r#"{"id":"chatcmpl-1","model":"gpt-4o-2024-08-06",
                "choices":[{"index":0,"message":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}"#,
        )
        .unwrap();
        let r = parse_response(&v).unwrap();
        assert_eq!(r.text, "Hi");
        assert_eq!(r.usage, Usage { input_tokens: 9, output_tokens: 3 });
        assert_eq!(r.stop_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn missing_choices_is_provider_error() {
        let v: Value = serde_json::from_str(r#"{"model":"gpt-4o"}"#).unwrap();
        assert_eq!(parse_response(&v).unwrap_err().kind(), "provider");
    }

    #[test]
    fn stream_chunks_accumulate_including_late_usage() {
        let events = [
            r#"{"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"content":"Hel"}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"content":"lo"}}]}"#,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}"#,
            "[DONE]",
        ];
        let mut st = StreamState::default();
        let mut deltas = Vec::new();
        for e in events {
            absorb_stream_event(&mut st, e, &mut |d| deltas.push(d.to_string())).unwrap();
        }
        assert_eq!(st.text, "Hello");
        assert_eq!(deltas, vec!["Hel", "lo"]);
        assert_eq!(st.usage, Usage { input_tokens: 9, output_tokens: 2 });
        assert_eq!(st.stop_reason.as_deref(), Some("stop"));
        assert_eq!(st.model, "gpt-4o");
    }
}
