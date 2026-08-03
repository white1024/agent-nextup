// One-shot nextup hub tool call over stdio — the same path Claude Code takes
// via a workspace's .mcp.json. Used by the /agent-e2e skill and for manual
// hub-tool smoke tests.
//
// Usage:  node scripts/mcp-call.mjs <workspaceRoot> <tool> [jsonArgs]
// Exit:   0 = tool succeeded · 1 = tool returned isError / RPC error · 2 = bad usage
// Needs:  nextup-mcp on PATH (deployed copy caveat: nextup_docs/02 trap 12)
import { spawn } from "node:child_process";

const [workspace, tool, jsonArgs] = process.argv.slice(2);
if (!workspace || !tool) {
  console.error("usage: node mcp-call.mjs <workspaceRoot> <tool> [jsonArgs]");
  process.exit(2);
}
const args = jsonArgs ? JSON.parse(jsonArgs) : {};

const child = spawn("nextup-mcp", ["--workspace", workspace], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.on("error", (e) => {
  console.error(`failed to spawn nextup-mcp (on PATH?): ${e.message}`);
  process.exit(1);
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", () => {});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mcp-call", version: "0.0.0" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
);

const res = await request("tools/call", { name: tool, arguments: args });
child.kill();

if (res.error) {
  console.error("RPC error:", JSON.stringify(res.error));
  process.exit(1);
}
const text = (res.result?.content ?? []).map((c) => c.text ?? "").join("\n");
console.log(text);
process.exit(res.result?.isError ? 1 : 0);
