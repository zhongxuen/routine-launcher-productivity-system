import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    rollupOptions: {
      // Four HTML entries, one per Tauri window. The compact popup
      // (development-plan.md section 25), the quick launcher (section 28) and
      // the desktop widget (sections 26, 83) are real second, third and fourth
      // windows, so each gets its own document and its own bundle rather than
      // a route inside the main one — none of the app shell's router, sidebar
      // or focus-session lifecycle belongs in a 340px checklist, a search box
      // or a 300px widget. The dev server serves all four from the project
      // root without any of this; it is only the production build that has to
      // be told there is more than `index.html`.
      input: {
        main: path.resolve(__dirname, "index.html"),
        popup: path.resolve(__dirname, "popup.html"),
        launcher: path.resolve(__dirname, "launcher.html"),
        widget: path.resolve(__dirname, "widget.html"),
      },
    },
  },

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
      ignored: ["**/src-tauri/**"],
    },
  },
}));
