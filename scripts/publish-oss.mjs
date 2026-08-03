#!/usr/bin/env node
/**
 * Publish the public mirror (D81, design doc nextup_docs/18 §5.3).
 *
 * This repo is the only working directory. The public repo is a *published
 * artifact*: you work here, commit here in whatever language you like, and
 * push the mirror when you decide there is something worth publishing. Each
 * run produces exactly one commit over there, with a message you write.
 *
 * What reaches the mirror is decided entirely by `export-ignore` in
 * .gitattributes — this script never carries a second copy of that list.
 *
 * Usage:
 *   node scripts/publish-oss.mjs --check
 *   node scripts/publish-oss.mjs --target ../agent-nextup-public -m "Message"
 *   node scripts/publish-oss.mjs --target ../agent-nextup-public -m "Message" --push
 *
 * --check   Run every safety check against the exported tree and stop. Never
 *           touches the target. This is the mode to run while iterating.
 * --push    Actually push. Without it the mirror commit is created locally
 *           and left for you to inspect and push by hand.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";

import { matches, scanCjk, scanLeaks, targetProblems, walk } from "./lib/guards.mjs";

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Author identity stamped on mirror commits.
 *
 * The private repo's history carries a personal email on every commit; the
 * mirror starts from an empty history, so this is a free choice.
 *
 * This is GitHub's noreply address for the account, which is the combination
 * that keeps both properties: commits are attributed to the account (they
 * count towards the contribution graph, because GitHub treats the noreply
 * address as belonging to it) while the real email address stays private.
 * The `<id>+<login>@` form works for every account; the bare `<login>@` form
 * only works for accounts created before mid-2017.
 *
 * Any address that is *not* associated with a GitHub account produces commits
 * GitHub cannot link to anyone — which is what an anonymous or tool identity
 * would do here.
 */
const AUTHOR = {
  name: "white1024",
  email: "5207634+white1024@users.noreply.github.com",
};

/**
 * Per-file exemptions from the leak scan. Only ever for *fabricated* strings.
 *
 * Empty on purpose. The one entry that used to live here covered a Windows
 * home-directory placeholder in PathLabel's doc comment; the placeholder was
 * rewritten to the `C:\ws\…` form the fixtures already used, which cost nothing
 * and took a whole product file back out of exemption. Prefer that trade when
 * it is available — a file-level exemption is a standing blank cheque over
 * everything else in the file, and nothing warns you when it starts covering
 * something new.
 *
 * This comment is itself an example: it used to spell that placeholder out, and
 * the spelled-out form went unnoticed only because this file was blanket-skipped
 * by the scan. Moving the patterns to lib/guards.mjs (D113) moved the skip with
 * them, and the very next run caught it.
 */
const LEAK_ALLOWED = [];

/**
 * Files where CJK text is correct and permanent. Everything else containing
 * CJK blocks the publish.
 */
const CJK_ALLOWED = [
  { path: "src/i18n.ts", why: "the zh-TW language resources themselves" },
  { path: "src/views/settings/index.tsx", why: "the language switcher's own zh-TW label" },
  { path: "src-tauri/src/terminal.rs", why: "CJK is the subject of the UTF-8 boundary tests" },
  { path: "crates/nextup-mcp/src/hub.rs", why: "CJK is the subject of the 500-character clamp test" },
  {
    // D82 batch 1 split the specs section out of the main guide into its own
    // module curriculum file, and the exemption has to follow the sentence:
    // the main guide is clean again, so an exemption left on it would be a
    // blank cheque over the largest shipped document.
    path: "crates/nextup-core/guide/modules/specs.md",
    why: "the guide documents that the spec lint accepts the Traditional Chinese modal as SHALL wording",
  },
  {
    path: "crates/nextup-core/src/workspace/specs.rs",
    why: "the spec lint accepts the Traditional Chinese modal as SHALL for localized workspaces (D79); the tests exercise CJK requirements",
  },
  {
    path: "crates/nextup-core/src/workspace/manifest.rs",
    why: "a fullwidth colon is what keeps a colon inside a YAML scalar from breaking the parse",
  },
  { path: "crates/nextup-core/src/workspace/ledger.rs", why: "CJK is the subject of the clamp test" },
  { path: "crates/nextup-core/src/workspace/handoff.rs", why: "CJK is the subject of the clamp test" },
  {
    path: "crates/nextup-core/src/workspace/bootstrap.rs",
    why: "tests that non-ASCII content outside the markers survives untouched, plus the zh-TW template's phase name and the clamp test",
  },
  { path: "crates/nextup-core/src/workspace/workflow.rs", why: "asserts against the zh-TW workflow template, which stays bilingual" },
  { path: "crates/nextup-core/src/orchestrator/provider.rs", why: "CJK is the subject of the token-estimation tests" },
  { path: "crates/nextup-core/src/index/scanner.rs", why: "CJK is the subject of the binary-detection test" },
  { path: "crates/nextup-core/src/index/store.rs", why: "CJK is the subject of the chunking test" },
  { path: "crates/nextup-core/src/index/ops.rs", why: "CJK is the subject of the full-text indexing test" },
  { path: "crates/nextup-core/src/workspace/doctor.rs", why: "CJK spec fixtures exercise the localized spec lint" },
  { path: "crates/nextup-core/src/workspace/ops.rs", why: "CJK spec fixtures exercise the localized spec lint" },
  { path: "crates/nextup-core/src/workspace/templates.rs", why: "asserts that a template id rejects CJK" },
  { prefix: "crates/nextup-core/templates/", why: "built-in templates ship bilingual (D54)" },
];

/**
 * Files still awaiting a later batch of the English migration. These do not
 * block, but every run prints them so the remaining work stays visible.
 */
const CJK_PENDING = [];

/* The scan patterns themselves live in scripts/lib/guards.mjs — one definition
 * shared with the website publish (D113). */

// ── Small helpers ───────────────────────────────────────────────────────────

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");

function git(args, cwd = repoRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`\n  ABORT  ${msg}\n`);
  process.exit(1);
}

// ── Checks over the exported tree ───────────────────────────────────────────

/**
 * Every `include_str!` / `include_bytes!` target must exist inside the
 * exported tree. This is the check that catches the .gitattributes mistake
 * that would otherwise only surface as a broken `cargo build` in the public
 * repo — bootstrap.rs reaches up into `.claude/skills/` for every skill in
 * WORKSPACE_SKILLS, so excluding that directory wholesale silently breaks the
 * build. The check reads the actual `include_str!` targets, so it stays right
 * as that list grows; only this sentence would go stale, never the guard.
 */
function checkIncludes(tree, files) {
  const problems = [];
  for (const rel of files.filter((f) => f.endsWith(".rs"))) {
    const src = readFileSync(join(tree, rel), "utf8");
    for (const m of src.matchAll(/include_(?:str|bytes)!\s*\(\s*"([^"]+)"/g)) {
      const target = resolve(dirname(join(tree, rel)), m[1]);
      if (!existsSync(target)) {
        problems.push(`${rel}: include_str!("${m[1]}") does not resolve inside the export`);
      }
    }
  }
  return problems;
}

/**
 * Every relative Markdown link must resolve inside the exported tree.
 *
 * This is the second class of `.gitattributes` mistake, and it is invisible
 * to the CJK and leak scans: a file that stays can perfectly well link to a
 * file that goes. The README pointing at `CLAUDE.md`, `nextup_docs/` and
 * `memory/` is exactly that shape — fine in the working repo, four dead
 * links in the mirror.
 *
 * Site pages are skipped: their links are Astro routes (`/agent-nextup/gates/`),
 * not filesystem paths, and `astro build` already fails on a broken one.
 */
function checkLinks(tree, files) {
  const present = new Set(files);
  // Every ancestor, not just each file's immediate parent — a link to
  // `crates/` would otherwise be reported as dangling.
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  const problems = [];
  for (const rel of files.filter((f) => f.endsWith(".md"))) {
    if (rel.startsWith("site/")) continue;
    const lines = readFileSync(join(tree, rel), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\]\(([^)#:\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1].replace(/\/$/, "");
        if (/^(https?:|mailto:|\/)/.test(target)) continue;
        const base = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const abs = (base ? `${base}/${target}` : target)
          .split("/")
          .reduce((acc, seg) => {
            if (seg === "." || seg === "") return acc;
            if (seg === "..") return acc.slice(0, -1);
            return [...acc, seg];
          }, [])
          .join("/");
        if (!present.has(abs) && !dirs.has(abs)) {
          problems.push(`${rel}:${i + 1}: link to '${target}' does not exist in the export`);
        }
      }
    });
  }
  return problems;
}

/**
 * Every waiver must still point at a file that exists in the export.
 *
 * A waiver whose path went stale is not merely useless — it is invisible. The
 * CJK scan fails loudly when a *moved* file's new path is not covered (that is
 * how the D112 rename of `src/views/Settings.tsx` was caught), but the orphaned
 * entry it leaves behind never says anything, and the next person reads it as
 * evidence that something is still exempt. This is the same shape as D109 ⑤ and
 * D110 ⑦: a rule that was true when written, quietly false after a move.
 *
 * ⚠️ Only `path` waivers are checked. A `prefix` waiver matches a directory
 * that may legitimately be empty at any moment, so "matches nothing" is not
 * evidence of staleness there — that one is still on the reader.
 */
function checkWaivers(files) {
  const present = new Set(files);
  return [...CJK_ALLOWED, ...CJK_PENDING, ...LEAK_ALLOWED]
    .filter((r) => r.path && !present.has(r.path))
    .map((r) => `waiver for '${r.path}' matches nothing in the export — moved or deleted?`);
}

// ── Main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const doPush = argv.includes("--push");

/**
 * `argv[argv.indexOf(flag) + 1]` is a trap: a missing flag gives -1, so the
 * expression silently returns argv[0]. Running `--target ../pub --push` with
 * no -m produced `message = "--target"` and would have committed *and pushed*
 * a commit titled `--target`.
 */
function flagValue(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) fail(`${flag} needs a value`);
  return v;
}
const target = flagValue("--target");
const message = flagValue("-m");

if (git(["status", "--porcelain"])) fail("working tree is dirty — commit or stash first");
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`on branch '${branch}' — publish from main`);

const head = git(["rev-parse", "--short", "HEAD"]);
const tree = mkdtempSync(join(tmpdir(), "nextup-oss-"));

try {
  execFileSync("git", ["archive", "--format=tar", "HEAD", "-o", join(tree, "x.tar")], {
    cwd: repoRoot,
  });
  execFileSync("tar", ["-xf", "x.tar"], { cwd: tree });
  rmSync(join(tree, "x.tar"));

  const files = walk(tree);
  console.log(`\n  export of ${head}: ${files.length} files\n`);

  // Dev-only helper scripts are export-ignored (.gitattributes), but the
  // package.json "scripts" entries that invoke them are not — git archive
  // ships that file verbatim. Left alone, the mirror's first `pnpm run
  // check:docs` dies with "Cannot find module": a poor first handshake for a
  // repo that leads with its guards. So: drop every script whose
  // `scripts/...` reference is missing from the export, and say which — a
  // silent rewrite would also hide a real packaging mistake.
  {
    const pkgPath = join(tree, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const dropped = [];
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      const refs = [...String(cmd).matchAll(/(?:^|[\s"'])(scripts\/[\w./-]+)/g)].map((m) => m[1]);
      if (refs.some((rel) => !existsSync(join(tree, rel)))) {
        delete pkg.scripts[name];
        dropped.push(name);
      }
    }
    if (dropped.length) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`  [ok]   package.json: dropped script(s) with no exported target: ${dropped.join(", ")}`);
    }
  }

  const excluded = ["nextup_docs", "memory", "CLAUDE.md", "handoff.md", ".claude/hooks"];
  for (const e of excluded) {
    if (existsSync(join(tree, e))) fail(`.gitattributes did not exclude ${e}`);
  }
  console.log("  [ok]   internal record excluded");

  const includeProblems = checkIncludes(tree, files);
  if (includeProblems.length) {
    includeProblems.forEach((p) => console.error(`         ${p}`));
    fail("include_str! targets missing from the export — the public build would not compile");
  }
  console.log("  [ok]   every include_str!/include_bytes! target present");

  const linkProblems = checkLinks(tree, files);
  if (linkProblems.length) {
    linkProblems.forEach((p) => console.error(`         ${p}`));
    fail(`${linkProblems.length} relative link(s) point outside the export`);
  }
  console.log("  [ok]   every relative Markdown link resolves");

  const leaks = scanLeaks(tree, files, { allowed: LEAK_ALLOWED });
  if (leaks.length) {
    leaks.slice(0, 40).forEach((l) => console.error(`         ${l}`));
    if (leaks.length > 40) console.error(`         … and ${leaks.length - 40} more`);
    fail(`${leaks.length} leak(s) found`);
  }
  console.log("  [ok]   no personal paths, emails or private project names");

  const { blocking, pending } = scanCjk(tree, files, {
    allowed: CJK_ALLOWED,
    pending: CJK_PENDING,
  });
  if (blocking.length) {
    blocking.forEach((b) => console.error(`         ${b}`));
    fail(`${blocking.length} file(s) contain unexpected CJK`);
  }
  console.log("  [ok]   no unexpected CJK");

  const staleWaivers = checkWaivers(files);
  if (staleWaivers.length) {
    staleWaivers.forEach((w) => console.error(`         ${w}`));
    fail(`${staleWaivers.length} stale waiver(s)`);
  }
  console.log("  [ok]   every waiver still points at a real file");

  if (pending.size) {
    const total = [...pending.values()].reduce((s, v) => s + v.count, 0);
    console.log(`\n  pending English migration — ${total} CJK line(s) still expected:`);
    for (const [rel, v] of pending) {
      console.log(`         ${rel}  (${v.count}, ${v.batch}: ${v.what})`);
    }
  }

  if (checkOnly) {
    console.log("\n  --check only; target untouched.\n");
    process.exit(0);
  }

  if (!target) fail("--target <dir> is required (a clone of the public repo)");
  if (!message) fail('-m "message" is required — the mirror commit message');
  const dest = resolve(repoRoot, target);
  // `main` is required, not merely expected: the website publish (D113) writes
  // built HTML to `gh-pages` of this same repo, so a mistyped target is a clone
  // of the right repo on the wrong branch — see targetProblems().
  const bad = targetProblems(dest, { repoRoot, requireBranch: "main" });
  if (bad.length) fail(`--target ${bad[0]}`);

  for (const entry of readdirSync(dest)) {
    if (entry !== ".git") rmSync(join(dest, entry), { recursive: true, force: true });
  }
  for (const rel of files) {
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(tree, rel), to);
  }

  git(["add", "-A"], dest);
  if (!git(["status", "--porcelain"], dest)) {
    console.log("\n  nothing changed since the last publish.\n");
    process.exit(0);
  }
  git(["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, "commit", "-m", message], dest);
  console.log(`\n  committed to ${dest} as ${AUTHOR.name} <${AUTHOR.email}>`);

  if (doPush) {
    git(["push"], dest);
    console.log("  pushed.\n");
  } else {
    console.log("  not pushed — inspect it, then `git push` from there (or re-run with --push).\n");
  }
} finally {
  rmSync(tree, { recursive: true, force: true });
}
