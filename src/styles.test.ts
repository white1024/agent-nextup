import { describe, expect, it } from "vitest";

// Not `./styles.css?raw` — vitest stubs .css imports to "" whatever the query.
// The virtual module is defined in vitest.config.ts; see the note there.
import css from "virtual:styles-source";

/**
 * Token references in `src/styles.css` must resolve.
 *
 * A `var(--typo)` in a `color` declaration does not fall back to anything
 * sensible: the property becomes invalid-at-computed-value-time and inherits,
 * so the text renders at *full* strength instead of the intended grey. Nothing
 * warns — not the browser, not `tsc`, not the build. The 2026-08-01 UI review
 * found two such rules on the specs page (`var(--muted)`, never declared) that
 * had been silently flattening a type hierarchy for as long as they existed.
 *
 * The whole class is mechanically checkable, so it is checked here rather than
 * left to the next reader's eye.
 */

/** Custom properties declared anywhere in the sheet (`:root`, themes, media). */
function declared(sheet: string): Set<string> {
  return new Set([...sheet.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
}

/** Custom properties read anywhere in the sheet.
 *
 *  Deliberately blind to `var(--x, fallback)`: a fallback changes what renders
 *  when `--x` is missing, not whether the reference is a typo. Four rules use
 *  one today (`--accent-line`, `--red-line`, `--red-soft`, `--s-1`, all
 *  declared in `:root`), and they are covered by the same rule as the rest. */
function referenced(sheet: string): string[] {
  return [...sheet.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);
}

describe("styles.css token references", () => {
  it("every var(--x) has a declaration in the sheet", () => {
    const defined = declared(css);
    const missing = [...new Set(referenced(css))].filter((name) => !defined.has(name)).sort();
    expect(missing).toEqual([]);
  });

  // The guard above is only meaningful while the sheet actually declares
  // tokens — a regex that silently stops matching would let everything pass.
  it("finds the token block", () => {
    const defined = declared(css);
    expect(defined.has("--text-1")).toBe(true);
    expect(defined.has("--text-3")).toBe(true);
    expect(defined.size).toBeGreaterThan(20);
    expect(referenced(css).length).toBeGreaterThan(100);
  });
});
