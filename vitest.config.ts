import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vitest/config";

/**
 * `src/styles.css` as text, for the boot-splash token guard (src/boot.test.ts).
 *
 * `?raw` reaches every other source the guard reads — including package
 * subpaths, `@tauri-apps/api/window?raw` included — but not this one: vitest
 * stubs every `.css` request to "" unless `test.css` is on, and the query does
 * not exempt it (measured, and `css: { include: [] }` does not help either).
 *
 * node builtins are fine in this file: `tsc` checks `src` and (via the project
 * reference) `vite.config.ts`, and this config is in neither — so reading a
 * file here costs no @types/node in a browser-only app's type space.
 */
function styleSource(): Plugin {
  const id = "virtual:styles-source";
  return {
    name: "nextup-style-source",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(loaded) {
      if (loaded !== `\0${id}`) return undefined;
      const file = fileURLToPath(new URL("src/styles.css", import.meta.url));
      return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
    },
  };
}

/**
 * Unit tests for the pure logic modules under `src/` (16 batch 12).
 *
 * Separate from `vite.config.ts` on purpose: that file configures the Tauri
 * dev server and the React plugin, none of which a node-side test run needs.
 * Vitest loads this file instead of it, so the test run stays plain node.
 *
 * **No DOM environment, deliberately.** Every module tested here runs without
 * one, and that is what keeps this toolchain a single devDependency. `notify.ts`
 * reads and writes localStorage and would drag jsdom in for one module — it is
 * out of scope until someone decides that trade is worth it (16 batch 12).
 */
export default defineConfig({
  plugins: [styleSource()],
  test: {
    // `src/` only. This is a pnpm workspace root: the default glob would also
    // walk `site/`, which is a separate package with its own build.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
