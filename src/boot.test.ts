import { describe, expect, it } from "vitest";

// `?raw` rather than node:fs — vite/client already declares it, so this needs
// no @types/node, which would put node globals into a browser-only app's type
// space to serve one test file.
import html from "../index.html?raw";
import themeSource from "./theme.ts?raw";
import iconSource from "./components/icons.tsx?raw";
// Extensionless subpath: the package's exports map is the wildcard `"./*" ->
// "./*.js"`, so `window.js` would resolve to `window.js.js` and fail.
import tauriWindowSource from "@tauri-apps/api/window?raw";
// Not `./styles.css?raw` — vitest stubs .css imports to "" whatever the query.
// The virtual module is defined in vitest.config.ts; see the note there.
import css from "virtual:styles-source";

/** The boot splash in index.html must be self-contained — styles.css only
 *  arrives with the bundle it exists to cover — so a handful of token values
 *  are written out a second time there. That is a duplication with no
 *  mechanism behind it: recolour the app and the splash keeps the old palette,
 *  silently, on the one screen nobody looks at twice.
 *
 *  So the duplication is annotated instead of forbidden. Every re-stated value
 *  in index.html carries a trailing `/* --token *\/` comment, and this test
 *  holds each one to what src/styles.css declares. Adding another re-stated
 *  value needs no change here — annotate it and it is covered. */
/** `--name: value;` from the token block. */
function tokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    if (!out.has(name)) out.set(name, value.trim());
  }
  return out;
}

/** `prop: value; /* --token *\/` from the inline splash styles. */
function annotated(html: string): { token: string; value: string }[] {
  return [...html.matchAll(/:\s*([^;]+);\s*\/\*\s*(--[a-z0-9-]+)\s*\*\//g)].map((m) => ({
    value: m[1].trim(),
    token: m[2],
  }));
}

describe("boot splash", () => {
  it("re-states token values exactly as styles.css declares them", () => {
    const declared = tokens(css);
    const used = annotated(html);
    // A rename that drops every annotation would otherwise pass an empty loop.
    expect(used.length).toBeGreaterThanOrEqual(4);
    for (const { token, value } of used) {
      expect(declared.get(token), `${token} is not declared in styles.css`).toBeDefined();
      expect(value, `index.html's copy of ${token} drifted`).toBe(declared.get(token));
    }
  });

  it("draws the same brand mark as IconLogo", () => {
    // The splash re-states IconLogo's path data, and the comment beside it
    // claims they are identical — a claim with nothing behind it until now.
    // Recolour or redraw the mark and the boot screen would keep the old one.
    const logo = /export function IconLogo[\s\S]*?\n}/.exec(iconSource)?.[0];
    expect(logo, "IconLogo is gone or was renamed").toBeDefined();
    const paths = [...(logo ?? "").matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(html, "the splash mark drifted from IconLogo").toContain(d);
  });

  it("reads the theme from the same storage key as theme.ts", () => {
    // A dark-mode user gets a white flash if these two ever disagree, and the
    // splash is exactly the window where theme.ts has not run yet.
    const key = /const STORAGE_KEY = "([^"]+)"/.exec(themeSource)?.[1];
    expect(key).toBeDefined();
    expect(html).toContain(`localStorage.getItem("${key}")`);
  });

  it("pins the native title bar through the same command setTheme() uses", () => {
    // The title bar is a second surface with the same problem as the DOM
    // theme, one layer out. theme.ts owns it via getCurrentWindow().setTheme()
    // — but that is in the bundle, so the splash has to reach the underlying
    // command itself. Held to the command name the installed API actually
    // calls: a Tauri upgrade that renames it must not leave a silent no-op.
    const command = /invoke\('(plugin:window\|set_theme)'/.exec(tauriWindowSource)?.[1];
    expect(command, "@tauri-apps/api no longer calls a set_theme command").toBeDefined();
    expect(html).toContain(`"${command}"`);
    // And it must stay best-effort: applyThemeMode() is the authority, this is
    // only earlier. An unguarded call here would take the whole app down on a
    // Tauri internals change.
    expect(html).toContain("window.__TAURI_INTERNALS__");
    expect(html.slice(html.indexOf("__TAURI_INTERNALS__"))).toContain(".catch(");
  });

  it("keeps the splash inside #root so React's first render clears it", () => {
    // The handoff relies on createRoot() replacing the container's children.
    // Move the splash to a sibling and it becomes a permanent overlay with no
    // code anywhere to take it down.
    //
    // Checked as "no `</div>` between the two", not by matching the nesting:
    // the obvious `<div id="root">([\s\S]*?)</div>` is lazy enough to run past
    // a closed #root and still find the splash in the tail — it passed the
    // deliberate break that produced this comment.
    const open = html.indexOf('<div id="root">');
    const splash = html.indexOf('class="boot"');
    expect(open, "#root is gone").toBeGreaterThanOrEqual(0);
    expect(splash, "the boot splash is gone").toBeGreaterThan(open);
    expect(
      html.slice(open, splash),
      "#root closes before the splash — React would never clear it",
    ).not.toContain("</div>");
  });
});
