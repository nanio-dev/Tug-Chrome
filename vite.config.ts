import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = import.meta.dirname;

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Marketing screenshots/docs in public must not ship inside the extension.
  publicDir: command === 'serve' ? 'public' : false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(rootDir, "popup.html"),
        manager: resolve(rootDir, "manager.html"),
        options: resolve(rootDir, "options.html"),
        offscreen: resolve(rootDir, "offscreen.html"),
      },
    },
  },
}));
