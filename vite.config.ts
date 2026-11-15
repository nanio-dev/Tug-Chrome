import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
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
});
