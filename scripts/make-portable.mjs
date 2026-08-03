// Assemble the Windows portable build: the app and the hub in one zip, no
// installer (B11, answering the "the work machine blocks installers" report).
//
// Windows only, on purpose. Linux already ships a no-install format — the
// AppImage the release workflow uploads. macOS is left out because an unsigned
// .app served from a zip carries the quarantine attribute and hits Gatekeeper
// harder than the dmg does, so a "portable" mac build would be worse than the
// one already on offer, not better.
//
// ⚠️ The sidecar is taken from src-tauri/binaries/, NOT target/release/.
// prepare-sidecar.mjs always builds with an explicit --target, so cargo writes
// nextup-mcp to target/<triple>/release/. A plain `cargo build --release` on a
// dev machine also leaves one at target/release/nextup-mcp.exe — which is why
// the first hand-rolled zip (2026-07-26) could pick it up from there and still
// work. In CI that file does not exist, and reading from there would produce a
// zip containing only the app: a portable build with no hub, which fails when
// an agent tries to connect rather than when it is built.
//
// Usage:  node scripts/make-portable.mjs
// Out:    target/portable/Agent NextUp_<version>_<arch>_portable.zip
// Exit:   0 = zip written · non-zero = an input was missing (fail loudly; a
//         silently incomplete portable build is the failure mode worth avoiding)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`\n  ABORT  ${msg}\n`);
  process.exit(1);
}

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) fail("cannot read host triple from `rustc -vV`");
  return m[1].trim();
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
if (!triple.includes("windows")) {
  fail(`portable builds are Windows-only; this is ${triple} (see the header comment)`);
}

// tauri.conf.json is what names the installers, so the zip follows the same
// version. The two declarations can no longer drift apart unnoticed: the
// version_mirror_tests module in src-tauri/src/lib.rs pins this file, the
// workspace Cargo.toml and package.json to one number, so a half-finished bump
// fails cargo test instead of producing a zip named after the old version.
const version = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8")).version;
const arch = triple.startsWith("x86_64") ? "x64" : triple.startsWith("aarch64") ? "arm64" : triple;

const app = join(repoRoot, "target", "release", "agent-nextup.exe");
const hub = join(repoRoot, "src-tauri", "binaries", `nextup-mcp-${triple}.exe`);
if (!existsSync(app)) fail(`${app} not found — run \`pnpm tauri build\` first`);
if (!existsSync(hub)) fail(`${hub} not found — beforeBuildCommand stages it; run \`pnpm tauri build\` first`);

const outDir = join(repoRoot, "target", "portable");
const stage = join(outDir, `Agent NextUp_${version}_${arch}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyFileSync(app, join(stage, "agent-nextup.exe"));
// Tauri strips the triple when it bundles; the portable layout has to match,
// because resolve_hub_binary() looks for exactly `nextup-mcp.exe` beside the app.
copyFileSync(hub, join(stage, "nextup-mcp.exe"));

writeFileSync(
  join(stage, "README.txt"),
  `Agent NextUp ${version} — portable build for Windows (${arch})

No installation. Unzip anywhere you can write to and run agent-nextup.exe.

What is in here
  agent-nextup.exe      the app
  nextup-mcp.exe   the hub an AI agent connects to. Keep it in the same folder
                  as agent-nextup.exe — the app looks for it right next to itself
                  before falling back to PATH.

Requirements
  Microsoft Edge WebView2 runtime. Windows 11 and an up-to-date Windows 10
  already have it. If the window opens blank or the app will not start,
  install the Evergreen WebView2 Runtime from Microsoft and try again. The
  installer build can fetch this for you; this portable build cannot.

First launch
  The build is not code-signed, so SmartScreen shows an unknown-publisher
  warning. Choose "More info", then "Run anyway".

If it still will not run
  AppLocker and WDAC block by execution policy rather than by installation,
  so a portable build does not get past them either. That one needs your IT
  administrator.
`.replace(/\n/g, "\r\n"),
);

const zip = join(outDir, `Agent NextUp_${version}_${arch}_portable.zip`);
rmSync(zip, { force: true });
// No zip writer in the Node standard library (zlib is raw deflate, not the
// container), and this script is Windows-only anyway.
execFileSync(
  "powershell",
  ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`],
  { stdio: "inherit" },
);
rmSync(stage, { recursive: true, force: true });

console.log(`[portable] ${zip}`);
