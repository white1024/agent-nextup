// Build the nextup-mcp hub binary and stage it as a Tauri external binary so it
// ships *inside* the installer, landing next to the app executable. That is the
// exact spot resolve_hub_binary() (src-tauri/src/mcp_deploy.rs) looks first, so
// a bundled release finds the hub with zero PATH setup (D25 sidecar bundling, B11).
//
// Tauri's `bundle.externalBin` wants the file named `<name>-<target-triple><ext>`;
// at bundle/dev time Tauri strips the triple and drops `nextup-mcp<ext>` beside
// the main binary. We ALWAYS build with an explicit --target so the cargo output
// dir is deterministic (target/<triple>/<profile>/), independent of whether the
// app itself was built with --target.
//
// Wired into BOTH beforeBuildCommand and beforeDevCommand (tauri.conf.json):
// dev also needs the staged binary present or Tauri errors before launch.
// Tauri exports TAURI_ENV_TARGET_TRIPLE / TAURI_ENV_DEBUG to these hooks; when
// run standalone we fall back to the host triple and a release build.
//
// Usage:  node scripts/prepare-sidecar.mjs
// Exit:   0 = staged ok · non-zero = cargo build or copy failed (fail fast)
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) throw new Error("cannot read host triple from `rustc -vV`");
  return m[1].trim();
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const debug = process.env.TAURI_ENV_DEBUG === "true";
const profile = debug ? "debug" : "release";
const exe = triple.includes("windows") ? ".exe" : "";

const cargoArgs = ["build", "-p", "nextup-mcp", "--target", triple];
if (!debug) cargoArgs.push("--release");

console.log(`[sidecar] building nextup-mcp (${profile}) for ${triple}`);
execFileSync("cargo", cargoArgs, { cwd: repoRoot, stdio: "inherit" });

const src = join(repoRoot, "target", triple, profile, `nextup-mcp${exe}`);
const destDir = join(repoRoot, "src-tauri", "binaries");
const dest = join(destDir, `nextup-mcp-${triple}${exe}`);

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
if (!exe) chmodSync(dest, 0o755);

console.log(`[sidecar] staged ${dest}`);
