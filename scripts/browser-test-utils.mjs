import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "vite";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function findBrowser() {
  if (process.env.TUG_TEST_BROWSER) return process.env.TUG_TEST_BROWSER;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : path.join(os.homedir(), ".cache/ms-playwright"));
  const dirs = await fs.readdir(cache).catch(() => []);
  for (const name of dirs.filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    const executable = process.platform === "win32" ? "chrome-win64/chrome.exe"
      : process.platform === "darwin" ? "chrome-mac/Chromium.app/Contents/MacOS/Chromium" : "chrome-linux/chrome";
    const filename = path.join(cache, name, executable);
    if (await fs.stat(filename).then(() => true, () => false)) return filename;
  }
  throw new Error("Set TUG_TEST_BROWSER to an installed Chromium executable, or install Chromium using Playwright.");
}

export async function launchHarness({ ignoreHTTPSErrors = false, agentPort } = {}) {
  const tempRoot = process.env.TUG_TEST_TMPDIR || os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true });
  const temp = await fs.mkdtemp(path.join(tempRoot, "tug-web-browser-"));
  const extension = path.join(temp, "extension");
  await fs.cp(path.join(projectRoot, "dist"), extension, { recursive: true });
  const entry = path.join(temp, "entry.ts");
  const modulePath = filename => JSON.stringify(path.join(projectRoot, filename).replaceAll("\\", "/"));
  await fs.writeFile(entry, [
    `export {TaskManager} from ${modulePath("src/engine/core/manager.ts")};`,
    `export {IndexedDbTaskStore} from ${modulePath("src/engine/storage/task-store.ts")};`,
    `export {OpfsPartStorage} from ${modulePath("src/engine/storage/part-store.ts")};`,
    `export {runHttpDownload,computeSha256Hex} from ${modulePath("src/engine/http/downloader.ts")};`,
    `export {hashBlobSha256} from ${modulePath("src/engine/http/sha256.ts")};`,
  ].join("\n"));
  await build({ configFile: false, publicDir: false, logLevel: "error", build: { outDir: extension, emptyOutDir: false,
    lib: { entry, formats: ["es"], fileName: () => "test-lib.js" } } });
  await fs.writeFile(path.join(extension, "test.html"), '<!doctype html><title>Tug test harness</title><script type="module" src="test.js"></script>');
  await fs.writeFile(path.join(extension, "test.js"), 'import * as audit from "./test-lib.js"; window.audit=audit;');
  if (agentPort !== undefined) {
    if (!Number.isInteger(agentPort) || agentPort < 1 || agentPort > 65535) throw new Error("Invalid isolated Agent port");
    const files = ["background.js", "test-lib.js", ...(await fs.readdir(path.join(extension, "assets"))).filter(n => n.endsWith(".js")).map(n => "assets/" + n)];
    for (const name of files) {
      const filename = path.join(extension, name);
      await fs.writeFile(filename, (await fs.readFile(filename, "utf8")).replaceAll("16899", String(agentPort)));
    }
  }
  const context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    executablePath: await findBrowser(), headless: true, viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  return { context, origin, temp, extension, async openPage() {
    const page = await context.newPage();
    await page.goto(`${origin}/test.html`);
    await page.waitForFunction(() => Boolean(window.audit));
    return page;
  }, async close() {
    await context.close();
    if (path.dirname(path.resolve(temp)) !== path.resolve(tempRoot) || !path.basename(temp).startsWith("tug-web-browser-")) throw new Error("Unexpected test directory");
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
  } };
}

export async function rpc(page, type, payload = {}) {
  return page.evaluate(async ({ type, payload }) => {
    const response = await chrome.runtime.sendMessage({ channel: "tug-web-rpc", target: "background", type,
      requestId: crypto.randomUUID(), payload });
    if (!response?.ok) throw new Error(response?.error?.message || "No extension response");
    return response.data;
  }, { type, payload });
}
export async function waitUntil(callback, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for browser state");
}
