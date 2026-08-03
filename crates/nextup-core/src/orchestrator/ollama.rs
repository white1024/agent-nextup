use std::io::{BufRead, BufReader};

use serde_json::{json, Value};

use crate::error::Result;
use crate::orchestrator::provider::{
    bad_payload, default_agent, http_error, CompletionRequest, CompletionResponse, LLMProvider,
    Usage,
};

pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";
const ID: &str = "ollama";

/// Ollama `/api/chat` adapter — local models, no API key, NDJSON streaming.
pub struct OllamaProvider {
    base_url: String,
    agent: ureq::Agent,
}

impl OllamaProvider {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            agent: default_agent(),
        }
    }

    fn post(&self, body: &Value) -> Result<ureq::Response> {
        self.agent
            .post(&format!("{}/api/chat", self.base_url))
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
    let mut body = json!({ "model": req.model, "messages": messages, "stream": stream });
    let mut options = serde_json::Map::new();
    if let Some(n) = req.max_tokens {
        options.insert("num_predict".into(), json!(n));
    }
    if let Some(t) = req.temperature {
        options.insert("temperature".into(), json!(t));
    }
    if !options.is_empty() {
        body["options"] = Value::Object(options);
    }
    body
}

fn usage_from(v: &Value) -> Usage {
    Usage {
        input_tokens: v["prompt_eval_count"].as_u64().unwrap_or(0) as u32,
        output_tokens: v["eval_count"].as_u64().unwrap_or(0) as u32,
    }
}

fn parse_response(v: &Value) -> Result<CompletionResponse> {
    let text = v["message"]["content"]
        .as_str()
        .ok_or_else(|| bad_payload(ID, "missing message.content"))?
        .to_string();
    Ok(CompletionResponse {
        text,
        model: v["model"].as_str().unwrap_or_default().to_string(),
        usage: usage_from(v),
        stop_reason: v["done_reason"].as_str().map(str::to_string),
    })
}

#[derive(Default)]
struct StreamState {
    text: String,
    model: String,
    usage: Usage,
    stop_reason: Option<String>,
}

/// One NDJSON line: content fragments until the `done:true` line, which
/// carries the eval counts and done_reason.
fn absorb_stream_line(
    st: &mut StreamState,
    line: &str,
    on_delta: &mut dyn FnMut(&str),
) -> Result<()> {
    let v: Value =
        serde_json::from_str(line).map_err(|e| bad_payload(ID, &format!("bad stream JSON: {e}")))?;
    if let Some(err) = v["error"].as_str() {
        return Err(crate::error::NextUpError::Provider(format!("{ID}: {err}")));
    }
    if let Some(model) = v["model"].as_str() {
        st.model = model.to_string();
    }
    if let Some(t) = v["message"]["content"].as_str() {
        if !t.is_empty() {
            st.text.push_str(t);
            on_delta(t);
        }
    }
    if v["done"].as_bool() == Some(true) {
        st.usage = usage_from(&v);
        st.stop_reason = v["done_reason"].as_str().map(str::to_string);
    }
    Ok(())
}

impl LLMProvider for OllamaProvider {
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
        let reader = BufReader::new(resp.into_reader());
        let mut st = StreamState::default();
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            absorb_stream_line(&mut st, &line, on_delta)?;
        }
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
            model: "llama3.1".into(),
            system: Some("be brief".into()),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: Some(32),
            temperature: Some(0.1),
        }
    }

    #[test]
    fn body_maps_options_and_system() {
        let b = request_body(&req(), true);
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["options"]["num_predict"], 32);
        let mut r = req();
        r.max_tokens = None;
        r.temperature = None;
        assert!(request_body(&r, false).get("options").is_none());
    }

    #[test]
    fn parses_non_streaming_fixture() {
        let v: Value = serde_json::from_str(
            r#"{"model":"llama3.1","message":{"role":"assistant","content":"Hey"},
                "done":true,"done_reason":"stop","prompt_eval_count":7,"eval_count":4}"#,
        )
        .unwrap();
        let r = parse_response(&v).unwrap();
        assert_eq!(r.text, "Hey");
        assert_eq!(r.usage, Usage { input_tokens: 7, output_tokens: 4 });
        assert_eq!(r.stop_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn stream_lines_accumulate_and_final_line_carries_usage() {
        let lines = [
            r#"{"model":"llama3.1","message":{"role":"assistant","content":"He"},"done":false}"#,
            r#"{"model":"llama3.1","message":{"role":"assistant","content":"y"},"done":false}"#,
            r#"{"model":"llama3.1","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":7,"eval_count":2}"#,
        ];
        let mut st = StreamState::default();
        let mut deltas = Vec::new();
        for l in lines {
            absorb_stream_line(&mut st, l, &mut |d| deltas.push(d.to_string())).unwrap();
        }
        assert_eq!(st.text, "Hey");
        assert_eq!(deltas, vec!["He", "y"]);
        assert_eq!(st.usage, Usage { input_tokens: 7, output_tokens: 2 });
        assert_eq!(st.stop_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn stream_error_line_is_provider_error() {
        let mut st = StreamState::default();
        let err = absorb_stream_line(&mut st, r#"{"error":"model not found"}"#, &mut |_| {})
            .unwrap_err();
        assert!(err.to_string().contains("model not found"));
    }
}
