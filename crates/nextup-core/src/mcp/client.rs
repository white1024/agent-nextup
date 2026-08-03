use std::time::Duration;

use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::{IntoTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde::{Deserialize, Serialize};

use crate::error::{NextUpError, Result};
use crate::mcp::config::{McpServerEntry, McpTransport};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Filled by the ops layer from the registry's allowlist.
    pub allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallOutcome {
    /// Text blocks joined with newlines; non-text blocks become markers
    /// like `[image]` so the transcript stays honest about omissions.
    pub text: String,
    pub is_error: bool,
    pub duration_ms: u64,
}

/// Blocking facade over the async rmcp client. Owns a one-worker tokio
/// runtime so the core's public surface stays synchronous like the rest of
/// the crate (IPC wraps calls in `spawn_blocking`). v1 is
/// connect-per-operation — no long-lived connection registry to manage; a
/// pool can come with Module D orchestration if latency matters.
pub struct McpClient {
    rt: tokio::runtime::Runtime,
    service: Option<RunningService<RoleClient, ()>>,
}

impl McpClient {
    /// Spawn the configured stdio server and run the MCP initialize
    /// handshake.
    pub fn connect(entry: &McpServerEntry) -> Result<Self> {
        let McpTransport::Stdio { command, args, env } = &entry.transport;
        let rt = runtime()?;
        // Spawning a tokio child process needs the runtime's IO driver.
        let proc = {
            let _guard = rt.enter();
            let mut cmd = tokio::process::Command::new(command);
            // Connect-per-operation means this runs on every probe and every
            // tool call, so an unsuppressed console window would flash each
            // time the app talks to a server (crate::process).
            #[cfg(windows)]
            cmd.creation_flags(crate::process::CREATE_NO_WINDOW);
            cmd.args(args);
            for (k, v) in env {
                cmd.env(k, v);
            }
            TokioChildProcess::new(cmd).map_err(|e| {
                NextUpError::Provider(format!("mcp: cannot spawn '{command}': {e}"))
            })?
        };
        Self::finish(rt, proc)
    }

    /// Handshake over an arbitrary transport — used by hermetic tests to
    /// talk to an in-memory server.
    #[cfg(test)]
    fn connect_transport<T, E, A>(transport: T) -> Result<Self>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        Self::finish(runtime()?, transport)
    }

    fn finish<T, E, A>(rt: tokio::runtime::Runtime, transport: T) -> Result<Self>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let service = rt
            .block_on(async { tokio::time::timeout(CONNECT_TIMEOUT, ().serve(transport)).await })
            .map_err(|_| NextUpError::Provider("mcp: initialize handshake timed out".into()))?
            .map_err(|e| NextUpError::Provider(format!("mcp: initialize failed: {e}")))?;
        Ok(Self { rt, service: Some(service) })
    }

    fn service(&self) -> Result<&RunningService<RoleClient, ()>> {
        self.service
            .as_ref()
            .ok_or_else(|| NextUpError::Provider("mcp: connection already shut down".into()))
    }

    pub fn list_tools(&self) -> Result<Vec<McpToolInfo>> {
        let service = self.service()?;
        let tools = self
            .rt
            .block_on(async {
                tokio::time::timeout(LIST_TIMEOUT, service.peer().list_all_tools()).await
            })
            .map_err(|_| NextUpError::Provider("mcp: tools/list timed out".into()))?
            .map_err(|e| NextUpError::Provider(format!("mcp: tools/list failed: {e}")))?;
        Ok(tools
            .into_iter()
            .map(|t| McpToolInfo {
                name: t.name.to_string(),
                title: t.title,
                description: t.description.map(|d| d.to_string()),
                allowed: false,
            })
            .collect())
    }

    /// Call a tool. Tool-level failures come back as a normal outcome with
    /// `is_error: true` (the server answered); transport/protocol failures
    /// are `Err`.
    pub fn call_tool(
        &self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<McpCallOutcome> {
        let args_obj = match arguments {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::Object(map)) => Some(map),
            Some(_) => {
                return Err(NextUpError::InvalidInput(
                    "tool arguments must be a JSON object".into(),
                ))
            }
        };
        let mut params = CallToolRequestParams::new(name.to_string());
        if let Some(args) = args_obj {
            params = params.with_arguments(args);
        }
        let service = self.service()?;
        let started = std::time::Instant::now();
        let result = self
            .rt
            .block_on(async { tokio::time::timeout(CALL_TIMEOUT, service.peer().call_tool(params)).await })
            .map_err(|_| NextUpError::Provider(format!("mcp: tool '{name}' timed out")))?
            .map_err(|e| NextUpError::Provider(format!("mcp: tool '{name}' failed: {e}")))?;
        Ok(McpCallOutcome {
            text: render_content(&result),
            is_error: result.is_error.unwrap_or(false),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Graceful close (cancels the service loop, which reaps a child
    /// process transport). Dropping without calling this does the same.
    pub fn shutdown(mut self) {
        self.close();
    }

    fn close(&mut self) {
        if let Some(service) = self.service.take() {
            let _ = self.rt.block_on(async { service.cancel().await });
        }
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        self.close();
    }
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .map_err(|e| NextUpError::Provider(format!("mcp: cannot start async runtime: {e}")))
}

fn render_content(result: &CallToolResult) -> String {
    let parts: Vec<String> = result
        .content
        .iter()
        .map(|block| match block {
            ContentBlock::Text(t) => t.text.clone(),
            ContentBlock::Image(_) => "[image]".into(),
            ContentBlock::Audio(_) => "[audio]".into(),
            ContentBlock::Resource(_) => "[resource]".into(),
            ContentBlock::ResourceLink(_) => "[resource-link]".into(),
            _ => "[content]".into(),
        })
        .collect();
    if parts.is_empty() {
        if let Some(sc) = &result.structured_content {
            return sc.to_string();
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use rmcp::handler::server::ServerHandler;
    use rmcp::model::{
        ErrorData, ListToolsResult, PaginatedRequestParams, Tool,
    };
    use rmcp::service::{RequestContext, RoleServer};
    use serde_json::json;

    use super::*;

    /// Minimal in-process MCP server: one `echo` tool.
    #[derive(Clone, Default)]
    struct EchoServer;

    impl ServerHandler for EchoServer {
        async fn list_tools(
            &self,
            _request: Option<PaginatedRequestParams>,
            _context: RequestContext<RoleServer>,
        ) -> std::result::Result<ListToolsResult, ErrorData> {
            let schema: rmcp::model::JsonObject = serde_json::from_value(json!({
                "type": "object",
                "properties": { "message": { "type": "string" } }
            }))
            .unwrap();
            let tool = Tool::new("echo", "echoes the message back", schema);
            Ok(ListToolsResult { tools: vec![tool], ..Default::default() })
        }

        async fn call_tool(
            &self,
            request: CallToolRequestParams,
            _context: RequestContext<RoleServer>,
        ) -> std::result::Result<CallToolResult, ErrorData> {
            if request.name.as_ref() == "echo" {
                let msg = request
                    .arguments
                    .as_ref()
                    .and_then(|a| a.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                Ok(CallToolResult::success(vec![ContentBlock::text(format!("echo: {msg}"))]))
            } else {
                Ok(CallToolResult::error(vec![ContentBlock::text("no such tool")]))
            }
        }
    }

    /// Server runs on its own thread + runtime; the two ends of an
    /// in-memory duplex pipe stand in for the child process stdio.
    fn spawn_echo_server() -> (tokio::io::DuplexStream, std::thread::JoinHandle<()>) {
        let (client_io, server_io) = tokio::io::duplex(1 << 16);
        let handle = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                if let Ok(running) = EchoServer.serve(tokio::io::split(server_io)).await {
                    let _ = running.waiting().await;
                }
            });
        });
        (client_io, handle)
    }

    #[test]
    fn lists_and_calls_tools_over_in_memory_transport() {
        let (client_io, server) = spawn_echo_server();
        let client = McpClient::connect_transport(tokio::io::split(client_io)).unwrap();

        let tools = client.list_tools().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert!(!tools[0].allowed, "allowed is the ops layer's call");

        let ok = client.call_tool("echo", Some(json!({ "message": "hi" }))).unwrap();
        assert_eq!(ok.text, "echo: hi");
        assert!(!ok.is_error);

        let missing = client.call_tool("nope", None).unwrap();
        assert!(missing.is_error);
        assert_eq!(missing.text, "no such tool");

        client.shutdown();
        server.join().unwrap();
    }

    #[test]
    fn non_object_arguments_are_rejected_before_the_wire() {
        let (client_io, server) = spawn_echo_server();
        let client = McpClient::connect_transport(tokio::io::split(client_io)).unwrap();
        let err = client.call_tool("echo", Some(json!([1, 2]))).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        client.shutdown();
        server.join().unwrap();
    }

    #[test]
    fn spawn_failure_maps_to_provider_error() {
        let entry = McpServerEntry {
            id: "ghost".into(),
            description: None,
            transport: McpTransport::Stdio {
                command: "nextup-definitely-not-a-real-binary".into(),
                args: vec![],
                env: BTreeMap::new(),
            },
            enabled: true,
            allowed_tools: vec![],
        };
        let err = McpClient::connect(&entry).map(|_| ()).unwrap_err();
        assert_eq!(err.kind(), "provider");
        assert!(err.to_string().contains("cannot spawn"));
    }
}
