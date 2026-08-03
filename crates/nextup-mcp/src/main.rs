//! nextup-mcp — the Agent NextUp hub MCP server (stdio).
//!
//! Spawned by an agent host (Claude Code etc.) via the workspace's
//! `.mcp.json`; stdout speaks MCP, stderr is free for diagnostics.

mod hub;

use nextup_core::workspace::layout::WorkspacePaths;
use rmcp::ServiceExt;

fn parse_args() -> Result<(std::path::PathBuf, Option<String>), String> {
    let mut args = std::env::args().skip(1);
    let mut root = std::path::PathBuf::from(".");
    // Self-declared collaboration identity (D31): --agent wins over the
    // NEXTUP_AGENT env var (the env var is how per-worktree sessions differ
    // while sharing one committed .mcp.json). Absent = anonymous.
    let mut agent = std::env::var("NEXTUP_AGENT").ok();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workspace" => {
                root = args
                    .next()
                    .map(std::path::PathBuf::from)
                    .ok_or("--workspace requires a path")?;
            }
            "--agent" => {
                agent = Some(args.next().ok_or("--agent requires a name")?);
            }
            "--version" => {
                println!("nextup-mcp {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => return Err(format!(
                "unknown argument '{other}' (usage: nextup-mcp --workspace <root> [--agent <name>])"
            )),
        }
    }
    Ok((root, agent))
}

#[tokio::main]
async fn main() {
    let (root, agent) = match parse_args().and_then(|(r, agent)| {
        std::fs::canonicalize(&r)
            .map(|root| (root, agent))
            .map_err(|e| format!("cannot resolve '{}': {e}", r.display()))
    }) {
        Ok(resolved) => resolved,
        Err(msg) => {
            eprintln!("nextup-mcp: {msg}");
            std::process::exit(2);
        }
    };

    if !WorkspacePaths::new(&root).is_initialized() {
        eprintln!(
            "nextup-mcp: '{}' is not an initialized Agent NextUp workspace (.nextup/context.json missing)",
            root.display()
        );
        std::process::exit(2);
    }

    let hub = hub::Hub::new(root, agent);
    match hub.serve(rmcp::transport::stdio()).await {
        Ok(running) => {
            if let Err(e) = running.waiting().await {
                eprintln!("nextup-mcp: server stopped: {e}");
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("nextup-mcp: handshake failed: {e}");
            std::process::exit(1);
        }
    }
}
