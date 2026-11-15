import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { build } from "vite";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { launchHarness, projectRoot } from "./browser-test-utils.mjs";

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const connections = arg("connections", "1,8,32").split(",").map(Number);
const repeats = Number(arg("repeats", "3"));
const baseline = arg("baseline", "");
const mib = Number(arg("mib", "128"));
const totalBytes = mib * 1024 * 1024;
const payload = randomBytes(mib <= 128 ? totalBytes : 8 * 1024 * 1024);
const checksum = arg("checksum", "false") === "true";
const expected = createHash("sha256");
for (let at = 0; at < totalBytes; at += payload.length) expected.update(payload.subarray(0, Math.min(payload.length, totalBytes - at)));
const expectedHash = expected.digest("hex");
const rows = [];
let stats = { requests: 0, sentBytes: 0, active: 0, peak: 0 };
const server = createServer(async (req, res) => {
  const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
  const start = range ? Number(range[1]) : 0, end = range ? Math.min(Number(range[2]), totalBytes - 1) : totalBytes - 1;
  const current = stats;
  current.requests++; current.active++; current.peak = Math.max(current.peak, current.active);
  res.once("close", () => { current.active--; });
  res.writeHead(range ? 206 : 200, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${totalBytes}`, "ETag": '"benchmark"', "Content-Type": "application/octet-stream" });
  const throttle = req.url === "/throttled" && req.headers.range !== "bytes=0-0";
  if (throttle) await new Promise(resolve => setTimeout(resolve, 20));
  const chunkSize = throttle ? 65536 : 262144;
  for (let pos = start; pos <= end && !res.destroyed;) {
    if (throttle) await new Promise(resolve => setTimeout(resolve, 4));
    const local = pos % payload.length;
    const count = Math.min(chunkSize, payload.length - local, end + 1 - pos);
    const chunk = payload.subarray(local, local + count);
    pos += count;
    current.sentBytes += chunk.length;
    if (!res.write(chunk)) await new Promise(resolve => {
      const done = () => { res.off("close", done); res.off("drain", done); resolve(); };
      res.once("close", done); res.once("drain", done);
    });
  }
  if (!res.destroyed) res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let harness;
try {
  harness = await launchHarness();
  const page = await harness.openPage();
  if (baseline) {
    const snapshot = path.join(harness.temp, "baseline");
    for (const filename of ["src/engine/http/downloader.ts", "src/engine/storage/part-store.ts", "src/engine/storage/opfs-worker.ts", "src/shared/filename.ts"]) {
      const target = path.join(snapshot, filename);
      await fs.mkdir(path.dirname(target), { recursive: true });
      let source = execFileSync("git", ["show", `${baseline}:${filename}`], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
      if (filename.endsWith("part-store.ts")) source = source.replaceAll("opfs-worker.js", "baseline-opfs-worker.js");
      await fs.writeFile(target, source);
    }
    const entry = path.join(snapshot, "entry.ts");
    await fs.writeFile(entry, 'export {runHttpDownload,computeSha256Hex} from "./src/engine/http/downloader"; export {OpfsPartStorage} from "./src/engine/storage/part-store";');
    for (const [input, filename, formats] of [
      [entry, "baseline-engine.js", ["es"]],
      [path.join(snapshot, "src/engine/storage/opfs-worker.ts"), "baseline-opfs-worker.js", ["iife"]],
    ]) await build({ configFile: false, publicDir: false, logLevel: "error", build: { outDir: harness.extension, emptyOutDir: false,
      lib: { entry: input, name: "Baseline", formats, fileName: () => filename } } });
    await fs.writeFile(path.join(harness.extension, "baseline-setup.js"), 'import * as baseline from "./baseline-engine.js"; window.baseline=baseline;');
    await page.addScriptTag({ url: `${harness.origin}/baseline-setup.js`, type: "module" });
    await page.waitForFunction(() => Boolean(window.baseline));
  }
  for (const endpoint of arg("scenario", "fast,throttled").split(",")) for (let repeat = 0; repeat < repeats; repeat++) for (const count of (repeat % 2 ? [...connections].reverse() : connections)) for (const variant of (baseline ? (repeat % 2 ? ["current", "baseline"] : ["baseline", "current"]) : ["current"])) {
    stats = { requests: 0, sentBytes: 0, active: 0, peak: 0 };
    const value = await page.evaluate(async ({ url, connections, checksum, expectedHash, variant }) => {
      const engine = variant === "baseline" ? window.baseline : window.audit;
      const store = new engine.OpfsPartStorage();
      const start = performance.now();
      const signal = AbortSignal.timeout(90000);
      const result = await engine.runHttpDownload({ url, connections, partStore: store, partKey: "benchmark", carryCookies: false,
        expectedSha256: checksum ? expectedHash : null, signal });
      const ms = performance.now() - start;
      const hash = checksum ? expectedHash : window.baseline
        ? await window.audit.computeSha256Hex(await store.readAll("benchmark"))
        : await window.audit.hashBlobSha256(await store.toBlob("benchmark"), signal);
      await store.remove("benchmark");
      return { ms, metrics: result.metrics, hash, checksumInDownload: checksum };
    }, { url: `${base}/${endpoint}`, connections: count, checksum, expectedHash, variant });
    const row = { engine: "web-opfs", variant, baselineRef: baseline || undefined, profileDrive: path.parse(harness.temp).root,
      endpoint, connections: count, repeat, ...value, hashMatches: value.hash === expectedHash, ...stats, mibps: mib * 1000 / value.ms };
    rows.push(row); console.log(JSON.stringify(row));
    if (!row.hashMatches) throw new Error("Benchmark produced incorrect bytes");
    if (process.env.TUG_NATIVE_BENCHMARK && variant === "current") {
      stats = { requests: 0, sentBytes: 0, active: 0, peak: 0 };
      const native = await new Promise((resolve, reject) => {
        const child = spawn(process.env.TUG_NATIVE_BENCHMARK, [`${base}/${endpoint}`, harness.temp, String(count)], { windowsHide: true });
        let out = "", err = "";
        child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { err += data; });
        child.on("error", reject); child.on("exit", code => code ? reject(new Error(err)) : resolve(JSON.parse(out)));
      });
      const bytes = await fs.readFile(path.join(harness.temp, "native-bench.bin"));
      const valid = createHash("sha256").update(bytes).digest("hex") === expectedHash;
      const row = { engine: "desktop-tug-http", endpoint, connections: count, repeat, ...native, hashMatches: valid, ...stats, mibps: mib * 1000 / native.ms };
      rows.push(row); console.log(JSON.stringify(row));
      if (!valid) throw new Error("Native benchmark produced incorrect bytes");
      await fs.unlink(path.join(harness.temp, "native-bench.bin"));
    }
  }
} finally {
  const results = path.join(projectRoot, "test-results");
  await fs.mkdir(results, { recursive: true });
  await fs.writeFile(path.join(results, `http-benchmark${baseline ? "-ab" : ""}${mib === 128 ? "" : `-${mib}mib`}.json`), JSON.stringify(rows, null, 2));
  if (harness) await harness.close();
  server.closeAllConnections(); server.close();
}
