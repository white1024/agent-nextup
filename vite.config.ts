import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // `target/` is the cargo output at the *repo root* (not under src-tauri),
      // ~26 GB / 29k files. Chokidar walking it blocks the event loop, so the
      // dev server answers nothing for 30–60s and `tauri dev` shows a white
      // window until it finishes — worse during a Rust rebuild, which writes
      // into that tree while the walk is running. `site/` is the standalone
      // docs site: its own dev server/build, never imported by this frontend.
      ignored: ["**/src-tauri/**", "**/target/**", "**/site/**"],
    },
  },
}));
