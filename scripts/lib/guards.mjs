/**
 * Publication guards — the rules that decide what may leave this repo.
 *
 * There are two paths out (D113), and they publish different things from the
 * same working tree:
 *
 *   scripts/publish-oss.mjs   the source mirror  -> white1024/agent-nextup, main
 *   scripts/publish-site.mjs  the built website  -> white1024/agent-nextup, gh-pages
 *
 * Both run the scans below. That is the whole reason this file exists: when
 * site/ left the mirror, the leak and CJK scans stopped covering the website,
 * and a second copy of the patterns in the second script would have been a
 * rule that drifts. One definition, two callers.
 *
 * What is NOT here: the per-publish policy (which files are exempt, what a
 * missing include_str! target means). That differs between a source tree and a
 * build output, so it stays with each script.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Patterns that must never appear in anything published. No exemptions.
 *
 * Deliberately narrow. An early version flagged any `X:\...` string and
 * drowned in false positives: this codebase is full of *fabricated* Windows
 * paths in test fixtures and UI placeholders (`C:\ws\alpha`, `C:\work\legacy-app`,
 * `C:\projects\restored`), which are fine to publish, and the loose pattern
 * even matched escape sequences like `n:\n` inside format strings. What
 * actually needs catching is *this machine's real paths and identities*, so
 * the roots and names are listed explicitly. Adding a new personal root here
 * is cheaper than triaging noise on every publish.
 */
export const LEAK_PATTERNS = [
  { re: /[A-Za-z]:\\+(my-project|my-projects|other-project|downloads)\b/gi, what: "personal path" },
  // Any real home directory, whoever runs this. Narrowing to named roots
  // dropped this shape, and `C:\Users\<user>\AppData\...` — the exact kind of
  // path the first guard run caught — silently passed.
  { re: /[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]+/gi, what: "home directory path" },
  { re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//g, what: "home directory path" },
  { re: /littlewhite\d*|\bryan\b/gi, what: "personal name or account" },
  { re: /[\w.+-]+@gmail\.com/gi, what: "personal email" },
  { re: /llm-performance-test|wallpaper_defense/g, what: "another private project" },
];

/**
 * CJK detection. The ranges matter more than they look:
 *
 *   U+3000-U+30FF  CJK symbols, punctuation and kana
 *   U+3400-U+9FFF  ideographs, including extension A
 *   U+F900-U+FAFF  compatibility ideographs
 *   U+FF01-U+FF60  fullwidth forms
 *
 * The first range was missing originally, and the omission was not
 * theoretical: it let an ideographic full stop survive in the engine's state
 * block and an ideographic comma in the auto-drafted project description,
 * through a run that reported "no unexpected CJK". Punctuation is precisely
 * what a hand-written sweep misses, so if this ever needs narrowing, narrow
 * it here and nowhere else.
 */
export const CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff01-\uff60]/;

/**
 * This file defines the patterns, so scanning it always self-matches. Callers
 * pass it to the scans as a skip; it travels with the patterns rather than
 * being restated in each script, which is how it stayed right when the
 * patterns moved out of publish-oss.mjs.
 */
export const SELF = "scripts/lib/guards.mjs";

/**
 * Extensions that are not text and cannot carry a leak in readable form.
 *
 * This used to be an *allowlist* of text extensions, which had two holes: an
 * extensionless file computed a nonsense extension (`LICENSE` -> `"E"`) and so
 * was never scanned at all, and any new text format silently fell outside
 * coverage. A denylist fails the safe way — an unknown format gets scanned.
 *
 * The `.pf_*` / `.pagefind` entries are Pagefind's compressed search index and
 * its wasm, which only the website publish ever sees. Skipping them is safe
 * for a reason worth stating: every word in that index was extracted from the
 * HTML in the same directory, and the HTML *is* scanned. There is nothing in
 * the index that did not already pass through the scan in readable form.
 */
export const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".icns",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".exe", ".dll", ".dylib", ".so", ".wasm", ".mp4", ".webm",
  ".pf_fragment", ".pf_index", ".pf_meta", ".pagefind",
]);

/** Extension of a path, or "" when the basename carries none. */
export function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

export const isScannable = (rel) => !BINARY_EXT.has(extOf(rel));

/** Does `rel` match an exemption rule — either an exact path or a prefix? */
export function matches(rel, rule) {
  return rule.path ? rel === rule.path : rel.startsWith(rule.prefix);
}

/** Every file under `dir`, as paths relative to `base`, with `/` separators. */
export function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/**
 * Reasons `dest` is not a safe thing to publish into. Empty means safe.
 *
 * Both publish scripts delete everything in the target except `.git` before
 * laying down the new tree. Tracked files come back from git; untracked ones
 * (build output, anything not yet committed) do not. So the target has to be
 * proven, not assumed:
 *
 *   - Inside this repo — `--target .`, or another clone of the working repo —
 *     wipes the working tree. "Has a `.git`" is not the guard: this repo has
 *     one too, which is exactly why it passes.
 *   - Same owner/name as this repo's origin. Compared as owner/name rather
 *     than whole URL, so https and ssh forms of one repo read as one repo and
 *     a bare name cannot collide across owners.
 *   - Wrong branch. This one only matters since the website publish (D113):
 *     the source mirror and the website live in the *same* GitHub repo on two
 *     branches, so two clones that both pass every check above can still be
 *     the wrong one. Aiming the website publish at the mirror clone would
 *     replace the entire published source tree with built HTML, and the push
 *     would succeed.
 */
export function targetProblems(dest, { repoRoot, requireBranch } = {}) {
  const problems = [];
  if (!existsSync(join(dest, ".git"))) return [`${dest} is not a git repository`];
  if (dest === repoRoot || dest.startsWith(repoRoot + sep)) {
    problems.push(`${dest} is inside this repo — the publish target is a separate clone`);
  }
  const originOf = (cwd) => {
    try {
      return execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim();
    } catch {
      return ""; // no origin configured — nothing to compare against
    }
  };
  const repoId = (url) => url.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/").toLowerCase();
  const destOrigin = originOf(dest);
  const selfOrigin = originOf(repoRoot);
  if (destOrigin && selfOrigin && repoId(destOrigin) === repoId(selfOrigin)) {
    problems.push(`${dest} tracks ${destOrigin} — that is this repo, not the publish target`);
  }
  if (requireBranch) {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: dest, encoding: "utf8" }).trim();
    if (branch !== requireBranch) {
      problems.push(`${dest} is on branch '${branch}', not '${requireBranch}'`);
    }
  }
  return problems;
}

/**
 * Personal paths, names, emails and private project names.
 *
 * `allowed` is only ever for *fabricated* strings that happen to match a real-
 * path pattern; nothing that came off this machine belongs there. Each entry
 * carries a stated reason, and a file-level exemption is a standing blank
 * cheque over everything else in that file — prefer rewriting the string.
 */
export function scanLeaks(root, files, { allowed = [], skip = [] } = {}) {
  const problems = [];
  for (const rel of files) {
    if (!isScannable(rel)) continue;
    if (rel === SELF || skip.includes(rel)) continue;
    if (allowed.some((r) => matches(rel, r))) continue;
    const lines = readFileSync(join(root, rel), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { re, what } of LEAK_PATTERNS) {
        re.lastIndex = 0;
        const hit = re.exec(line);
        if (hit) problems.push(`${rel}:${i + 1}: ${what} — ${hit[0]}`);
      }
    });
  }
  return problems;
}

/**
 * Traditional Chinese anywhere it is not expected.
 *
 * `allowed` exempts a whole file (language resources, tests whose subject is
 * CJK); `pending` is the same shape but reported instead of blocking, for work
 * a migration has not reached yet.
 */
export function scanCjk(root, files, { allowed = [], pending = [], skip = [] } = {}) {
  const blocking = [];
  const stillPending = new Map();
  for (const rel of files) {
    if (!isScannable(rel)) continue;
    if (rel === SELF || skip.includes(rel)) continue;
    if (allowed.some((r) => matches(rel, r))) continue;

    const lines = readFileSync(join(root, rel), "utf8").split(/\r?\n/);
    const hits = lines.map((l, i) => (CJK.test(l) ? i + 1 : 0)).filter(Boolean);
    if (!hits.length) continue;

    const p = pending.find((r) => matches(rel, r));
    if (p) stillPending.set(rel, { count: hits.length, batch: p.batch, what: p.what });
    else blocking.push(`${rel}: ${hits.length} line(s) with CJK, first at :${hits[0]}`);
  }
  return { blocking, pending: stillPending };
}
