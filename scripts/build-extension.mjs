import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");
const distExtDir = resolve(distDir, "extension");

async function buildScripts() {
  // 1. Build background service worker as a self-contained ES module
  await build({
    configFile: false,
    root: rootDir,
    publicDir: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, "src/background/index.ts"),
        formats: ["es"],
        fileName: () => "background.js",
      },
      rollupOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
  });

  // 2. Build content script as a self-contained IIFE script (content_scripts do not support ES module imports)
  await build({
    configFile: false,
    root: rootDir,
    publicDir: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, "src/content/index.ts"),
        name: "TugWebContent",
        formats: ["iife"],
        fileName: () => "content.js",
      },
    },
  });

  // 3. Build OPFS SyncAccessHandle Web Worker as a self-contained script
  await build({
    configFile: false,
    root: rootDir,
    publicDir: false,
    build: {
      outDir: distDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(rootDir, "src/engine/storage/opfs-worker.ts"),
        name: "TugWebOpfsWorker",
        formats: ["iife"],
        fileName: () => "opfs-worker.js",
      },
    },
  });

  // Only extension runtime resources belong in the distributable.
  for (const asset of ['manifest.json', 'icons', '_locales', 'tug-icon.png']) {
    cpSync(resolve(rootDir, 'public', asset), resolve(distDir, asset), { recursive: true });
  }

  // Mirror into dist/extension so both directories can be loaded unpacked.
  if (existsSync(distExtDir)) {
    rmSync(distExtDir, { recursive: true, force: true });
  }
  const tempMirror = resolve(rootDir, "node_modules/.cache/tug-web-ext-mirror");
  if (existsSync(tempMirror)) {
    rmSync(tempMirror, { recursive: true, force: true });
  }
  mkdirSync(tempMirror, { recursive: true });
  cpSync(distDir, tempMirror, { recursive: true });
  cpSync(tempMirror, distExtDir, { recursive: true });
  rmSync(tempMirror, { recursive: true, force: true });

  console.log("[tug-web] Extension build completed: dist/ and dist/extension/");
}

buildScripts().catch((err) => {
  console.error("[tug-web] Build failed:", err);
  process.exit(1);
});
