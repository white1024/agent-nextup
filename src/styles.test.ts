import { describe, expect, it } from "vitest";

// Not `./styles.css?raw` — vitest stubs .css imports to "" whatever the query.
// The virtual module is defined in vitest.config.ts; see the note there.
import css from "virtual:styles-source";
// Same `?raw` route boot.test.ts uses to hold index.html's re-stated tokens to
// the sheet — see the note there for why it is not node:fs.
import terminalSource from "./views/Terminal.tsx?raw";

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

/** The body of one rule, selected by an exact selector (`.term-pane` does not
 *  match `.term-pane-host` or `.term-pane .xterm` — the brace has to follow). */
function ruleBody(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(sheet);
  return m ? m[1] : "";
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

/**
 * The element handed to `term.open()` must carry no padding of its own.
 *
 * FitAddon sizes the terminal from `getComputedStyle(parentElement).height`,
 * and under `box-sizing: border-box` that is the *border box* — padding
 * included. It then subtracts the padding of the terminal element itself and
 * never the parent's, so every pixel of padding on `.term-pane` was counted as
 * room for rows. 16px of it bought one row too many, which `.term-pane-host`'s
 * `overflow: hidden` sliced through the middle (reported 2026-08-05, G060).
 *
 * What let it survive is that it only *showed* intermittently: the surplus
 * lands somewhere in (0, one row] depending on the window height, and only the
 * part beyond the host's own slack is visible, so about half of all heights hid
 * it completely. Nothing about the rule looks wrong when read, which is exactly
 * why it is checked mechanically instead.
 */
describe("terminal pane geometry", () => {
  it("finds the rule", () => {
    expect(ruleBody(css, ".term-pane")).toMatch(/position:\s*absolute/);
    expect(ruleBody(css, ".term-pane-host")).toMatch(/overflow:\s*hidden/);
  });

  it("insets the terminal with `inset`, never `padding`", () => {
    const body = ruleBody(css, ".term-pane");
    expect(body).not.toMatch(/(?:^|;)\s*padding(?:-[a-z]+)?\s*:/);
    expect(body).toMatch(/(?:^|;)\s*inset\s*:/);
  });

  /* A whole number of rows rarely fills the pane exactly, and xterm.css paints
   * `.xterm-viewport` — which spans the whole box — a hardcoded #000 that
   * xterm 6 never themes. Without an override the remainder shows as a band in
   * the wrong colour (G060). */
  it("repaints .xterm-viewport, which xterm hardcodes to #000", () => {
    expect(ruleBody(css, ".term-pane .xterm-viewport")).toMatch(
      /background-color:\s*var\(--term-bg\)/,
    );
  });

  /* TERM_THEME is xterm's own options object and cannot read CSS, so the
   * surface colours exist twice. Nothing renders wrong if they drift — the two
   * halves of the same dark surface just stop matching, which reads as a
   * rendering artefact rather than as a stale constant. */
  it("TERM_THEME agrees with the CSS tokens", () => {
    const token = (name: string) =>
      new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`).exec(css)?.[1];
    const themeValue = (key: string) =>
      new RegExp(`${key}:\\s*"(#[0-9a-f]{3,8})"`).exec(terminalSource)?.[1];
    expect(themeValue("background")).toBe(token("--term-bg"));
    expect(themeValue("foreground")).toBe(token("--term-fg"));
    // Both regexes matching nothing would compare undefined to undefined.
    expect(token("--term-bg")).toMatch(/^#/);
    expect(themeValue("foreground")).toMatch(/^#/);
  });
});
