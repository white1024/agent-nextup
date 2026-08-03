/// <reference types="vite/client" />

/** src/styles.css as text, for the boot-splash token guard (src/boot.test.ts).
 *  Served by a plugin in vitest.config.ts — see the note there for why `?raw`
 *  cannot reach this one file. It does not exist in an app build, and nothing
 *  outside that test imports it. */
declare module "virtual:styles-source" {
  const source: string;
  export default source;
}
