import { describe, expect, it } from "vitest";

/**
 * The folder layout under `src/` is a rule, not a filing preference.
 *
 * `nextup_docs/` — the tree that tells a human which module does what — is
 * `export-ignore`d out of the public mirror. In that repo the folder names are
 * the *only* map of this frontend a contributor gets, so they have to mean
 * something, and what they mean has to stay true without anyone remembering to
 * check. Hence this file: the layering is stated once, here, and enforced.
 *
 *   lib/         no React, no direct IPC, no UI imports — plain modules that a
 *                unit test can call in the node environment
 *   hooks/       React hooks; may use lib/, never a component or a screen
 *   components/  pieces shared by more than one screen
 *   shell/       the parts of the persistent app shell; App.tsx owns them
 *   views/<x>/   one screen and the pieces only that screen uses
 *   src/*        entry points (main.tsx, App.tsx) and the platform boundary
 *                (api.ts, types.ts, i18n.ts, theme.ts, styles.css)
 *
 * Dependencies run downward through that list. Two rules do most of the work:
 *
 * - **An import of `react` inside lib/** turns a module that used to be
 *   testable into one that needs a renderer. The cost shows up as "we stopped
 *   writing tests for that file", months later, with no commit to blame.
 * - **A screen's parts stay inside the screen.** A file in components/ claims
 *   to be shared; if exactly one screen uses it, that claim is false and it
 *   misleads the next person editing it into thinking ten screens are at risk.
 *   The moment a second screen wants it, the guard below is what tells you to
 *   promote it to components/ rather than reach across.
 *
 * Note what this does *not* claim: that every tested module is in lib/. Two
 * pure helpers are deliberately tested where they are used — `elidePath` in
 * components/PathLabel.tsx and views/teams/layout.ts — because a helper with
 * one caller belongs next to its caller. The rule is about what a folder may
 * depend on and who may reach into it, not about where tests live.
 */

const raw = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** "./lib/ledger.ts" -> "lib/ledger.ts" */
const ALL = Object.entries(raw).map(([p, source]) => [p.replace(/^\.\//, ""), source] as const);
const MODULES = ALL.filter(([path]) => !path.endsWith(".test.ts"));

/** Bare module specifiers a file imports (relative paths excluded). */
function packagesOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s+["']([^."'][^"']*)["']/g)].map((m) => m[1]);
}

/** Relative import specifiers, as written. */
function relativesOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s+["'](\.[^"']*)["']/g)].map((m) => m[1]);
}

/** Folders that resolve through an index file, so `../hooks` and
 *  `../hooks/index` can be recognised as the same edge. */
const FOLDER_INDEX = new Set(
  ALL.map(([path]) => path).flatMap((p) => {
    const m = /^(.+)\/index\.tsx?$/.exec(p);
    return m ? [m[1]] : [];
  })
);

/** Resolve a relative specifier against the importing file: "src/"-relative,
 *  extension and any `?raw` query dropped.
 *
 *  A folder import is normalised to its index — `../hooks` becomes
 *  `hooks/index`. Without that step every rule below silently stopped at the
 *  folder boundary: `import … from "../hooks"` inside lib/ produced the bare
 *  target `hooks`, which matched no `^hooks/` rule and passed green. That is
 *  the *most common* way to write these imports (21 call sites use it), so the
 *  guard was blind to the case it most needed to catch — found by the D112
 *  adversarial review, not by the tests. */
function resolveFrom(importer: string, spec: string): string {
  const out: string[] = importer.split("/").slice(0, -1);
  for (const part of spec.split("?")[0].split("/")) {
    if (part === "." || part === "") continue;
    else if (part === "..") out.pop();
    else out.push(part);
  }
  const target = out.join("/").replace(/\.(tsx?|css|html)$/, "");
  return FOLDER_INDEX.has(target) ? `${target}/index` : target;
}

/** Every (importer, resolved target) pair in the tree. */
const EDGES = ALL.flatMap(([path, source]) =>
  relativesOf(source).map((spec) => ({ from: path, to: resolveFrom(path, spec) }))
);

describe("src/lib stays plain", () => {
  const lib = MODULES.filter(([path]) => path.startsWith("lib/"));

  it.each(lib)("%s imports no React", (_path, source) => {
    expect(packagesOf(source).filter((p) => /^react(-dom|-i18next)?$/.test(p))).toEqual([]);
  });

  // api.ts is the one place `invoke` is called. A lib module that reaches for
  // @tauri-apps directly is unmockable in tests (teamAutoRoute.test.ts mocks
  // `../api`) and silently ties a plain module to the desktop shell.
  it.each(lib)("%s reaches the backend only through api.ts", (_path, source) => {
    expect(packagesOf(source).filter((p) => p.startsWith("@tauri-apps/"))).toEqual([]);
  });
});

describe("dependencies run downward", () => {
  // `(\/|$)` as well as the index normalisation above: either alone closes the
  // folder-import hole, and this rule is not one to leave a second way through.
  const cases: [string, RegExp][] = [
    ["lib/", /^(hooks|components|shell|views)(\/|$)/],
    ["hooks/", /^(components|shell|views)(\/|$)/],
    ["components/", /^(shell|views)(\/|$)/],
    ["shell/", /^views(\/|$)/],
  ];

  it.each(cases)("nothing in %s imports a layer above it", (folder, forbidden) => {
    const violations = EDGES.filter((e) => e.from.startsWith(folder) && forbidden.test(e.to)).map(
      (e) => `${e.from} -> ${e.to}`
    );
    expect(violations).toEqual([]);
  });
});

describe("a screen owns its parts", () => {
  // views/<screen>/index is the screen itself and is meant to be imported.
  // Anything else under that folder is internal to it.
  it("nothing reaches into another screen's folder", () => {
    const violations = EDGES.filter(({ from, to }) => {
      const target = /^views\/([^/]+)\/(.+)$/.exec(to);
      if (!target || target[2] === "index") return false;
      return !from.startsWith(`views/${target[1]}/`);
    }).map((e) => `${e.from} -> ${e.to}`);
    expect(violations).toEqual([]);
  });

  // shell/ is App.tsx's furniture, and saying so is what keeps it from
  // drifting back into being a second components/.
  it("only App.tsx reaches into shell/", () => {
    const violations = EDGES.filter(
      ({ from, to }) =>
        (to === "shell" || to.startsWith("shell/")) &&
        from !== "App.tsx" &&
        !from.startsWith("shell/")
    ).map((e) => `${e.from} -> ${e.to}`);
    expect(violations).toEqual([]);
  });
});

// A glob that stops matching would let every rule above pass while checking
// nothing, and it would do it quietly — the same failure shape the rules exist
// to prevent.
describe("the guard is looking at something", () => {
  it("sees every layer and the edges between them", () => {
    for (const folder of ["lib/", "hooks/", "components/", "shell/", "views/"]) {
      expect(MODULES.filter(([p]) => p.startsWith(folder)).length).toBeGreaterThan(2);
    }
    expect(EDGES.length).toBeGreaterThan(200);
    expect(EDGES).toContainEqual({ from: "App.tsx", to: "shell/ToastStack" });
    // Folder imports must arrive here normalised; `App.tsx` writes `./hooks`.
    // Without this the rules above go quiet on the most common import form.
    expect(EDGES).toContainEqual({ from: "App.tsx", to: "hooks/index" });
    expect(EDGES).toContainEqual({
      from: "views/dashboard/index.tsx",
      to: "views/dashboard/StatTile",
    });
  });
});
