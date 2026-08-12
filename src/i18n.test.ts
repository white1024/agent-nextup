import { describe, expect, it } from "vitest";

// Same `?raw` route the other source-scanning guards take — see boot.test.ts
// for why it is not node:fs.
import source from "./i18n.ts?raw";

/**
 * Every `t("…")` in the app must name a key that exists.
 *
 * Half of this is already covered and needs nothing here: `const en: typeof
 * zhTW` holds the two language blocks to the same shape, so a key added to one
 * and forgotten in the other is a compile error. What nothing covers is the
 * *call sites*. i18next is initialised without `saveMissing` or a
 * `parseMissingKeyHandler`, so a key that does not resolve falls back to
 * i18next's default: it renders the key string itself. `t("common.bootSlow")`
 * mistyped ships a screen reading `common.bootSlow` — no exception, no console
 * warning, no failing build.
 *
 * That is survivable on a screen someone opens daily and invisible anywhere
 * else. The slow-boot notice this guard was written alongside renders only
 * after a first IPC call has hung for ten seconds; a typo there would sit in
 * the product indefinitely, and the only reason it did not was that somebody
 * remembered to grep for the key by hand.
 *
 * **Why not type `t()` itself.** Augmenting i18next's `CustomTypeOptions` is
 * the real fix and it does not work here. Two things block it, and the first
 * is silent: `i18n.ts` imports i18next while the augmentation points back at
 * `typeof zhTW`, so TypeScript breaks the cycle by resolving the resources to
 * `any` — the augmentation appears installed and constrains nothing. Move the
 * resources to a module that does not import i18next and the second one
 * arrives: `tsc` crashes outright (`Debug Failure. No error for last overload
 * signature`) on a resource object this size. A one-key resource type works
 * fine, so it is scale, not shape, and the scale only grows. Measured
 * 2026-08-12; the working notes are in nextup_docs/gotchas/G067.md.
 *
 * So this covers what can be covered mechanically today: the static keys,
 * which are the overwhelming majority of call sites.
 */

const raw = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CALLERS = Object.entries(raw).filter(([path]) => !path.endsWith(".test.ts"));

/** Dotted paths of every string leaf in the `zhTW` block.
 *
 *  Indentation-driven rather than a real parse: the block is machine-formatted
 *  at two spaces and three levels deep, and a guard that needs a TypeScript
 *  parser to check one object literal costs more than it saves. The count
 *  assertion below is what keeps that shortcut honest — if the shape ever
 *  changes enough to break this, the key set collapses and the test says so
 *  rather than passing on an empty set. */
function declaredKeys(src: string): Set<string> {
  const start = src.indexOf("const zhTW = {");
  // `\r?\n`, not `\n`: the tree is checked out CRLF, and a trailing `\r` is
  // not matched by `.` and not consumed by an unanchored `$` — so the leaf
  // rule below silently matched nothing at all on every line of the file.
  const lines = src.slice(start).split(/\r?\n/).slice(1);
  const out = new Set<string>();
  const stack: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (/^\};/.test(line)) break; // end of the zhTW literal; `en` follows
    const nested = /^\s*([A-Za-z_$][\w$]*):\s*\{/.exec(line);
    if (nested) {
      stack.push(nested[1]);
      continue;
    }
    // The value may sit on the next line: prettier wraps anything long, and
    // the long ones are the multi-sentence hints — exactly the strings most
    // likely to be reached for from a rarely-opened branch. Requiring the
    // quote on this line silently dropped every one of them.
    const key = /^\s*([A-Za-z_$][\w$]*):\s*(.*)$/.exec(line);
    if (key) {
      const rest = key[2] === "" ? (lines[i + 1] ?? "").trim() : key[2];
      if (/^["'`]/.test(rest)) out.add([...stack, key[1]].join("."));
      continue;
    }
    if (/^\s*\},?\s*$/.test(line)) stack.pop();
  }
  return out;
}

/** Source with comments removed.
 *
 *  `t("…")` appears inside prose more than once in this codebase — a comment
 *  in views/teams/Canvas.tsx describing this very kind of scan was the first
 *  false positive this guard produced. The `(?<!:)` keeps `https://` from
 *  being read as the start of a line comment; a `//` inside some other string
 *  literal would still truncate that line, which costs at most a missed call
 *  site and never a false failure. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

/** Static `t("…")` / `i18n.t("…")` keys in one file, with their line numbers.
 *
 *  Template-literal calls (`t(\`status.${s}\`)`) are deliberately not matched:
 *  their key is not known until it runs, so there is nothing here to check
 *  against. Those are the 26 sites the augmentation above would have covered. */
function referencedKeys(src: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  stripComments(src)
    .split(/\r?\n/)
    .forEach((text, i) => {
      for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) out.push({ key: m[1], line: i + 1 });
    });
  return out;
}

describe("translation keys", () => {
  const declared = declaredKeys(source);

  // The extractor is a set of regexes over formatted source, so it can fail by
  // matching nothing at all — and an empty declared set would make every
  // lookup below fail loudly, while an empty caller set would make the whole
  // suite pass while checking nothing. Both are pinned.
  it("extracts a plausible key set from both sides", () => {
    expect(declared.size, "no keys parsed out of zhTW").toBeGreaterThan(500);
    expect(declared.has("common.loading")).toBe(true);
    expect(declared.has("common.bootSlow")).toBe(true);
    const total = CALLERS.reduce((n, [, src]) => n + referencedKeys(src).length, 0);
    expect(total, "no t() call sites found").toBeGreaterThan(500);
  });

  it("every static t() key is declared", () => {
    const missing: string[] = [];
    for (const [path, src] of CALLERS) {
      for (const { key, line } of referencedKeys(src)) {
        if (!declared.has(key)) missing.push(`${path.replace(/^\.\//, "src/")}:${line} — ${key}`);
      }
    }
    // Listed rather than counted: the point of failing is to say which one.
    expect(missing, `these keys would render as their own name:\n${missing.join("\n")}`).toEqual([]);
  });
});
