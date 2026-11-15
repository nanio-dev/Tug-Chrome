import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { after, before, it } from "node:test";
import { launchHarness, rpc, waitUntil, projectRoot } from "../../scripts/browser-test-utils.mjs";

const payload = randomBytes(1024 * 1024);
const expected = createHash("sha256").update(payload).digest("hex");
const parallelPayload = randomBytes(8 * 1024 * 1024);
const parallelExpected = createHash("sha256").update(parallelPayload).digest("hex");
let server, base, harness;
before(async () => {
  server = createServer(async (req, res) => {
    const data = req.url.startsWith("/parallel") ? parallelPayload : payload;
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0, end = range ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    res.writeHead(range ? 206 : 200, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${data.length}`, "ETag": '"browser-fixture"' });
    if (req.headers.range === "bytes=0-0") { res.end(data.subarray(0, 1)); return; }
    for (let pos = start; pos <= end && !res.destroyed; pos += 65536) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!res.destroyed) res.write(data.subarray(pos, Math.min(pos + 65536, end + 1)));
    }
    if (!res.destroyed) res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  harness = await launchHarness();
  const page = await harness.openPage();
  await rpc(page, "update_settings", { standaloneMode: true, autoInterceptDownloads: false, notifyOnComplete: false, locale: "zh-CN", theme: "light" });
  await page.close();
});
after(async () => {
  await harness?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
});

it("resets OPFS files to the new length and retains explicit preserve writes", async () => {
  const page = await harness.openPage();
  const value = await page.evaluate(async () => {
    const store = new window.audit.OpfsPartStorage();
    await store.allocate("reset-test", 1048576);
    await store.writeAt("reset-test", 0, new Uint8Array(1048576).fill(77));
    await store.flush("reset-test");
    await store.allocate("reset-test", 65536, "reset");
    await store.writeAt("reset-test", 0, new Uint8Array(65536).fill(12));
    await store.sync("reset-test");
    const size = await store.size("reset-test");
    await store.allocate("reset-test", 65536, "preserve");
    const bytes = await store.readAll("reset-test");
    await store.remove("reset-test");
    return { size, valid: bytes.length === 65536 && bytes.every(b => b === 12) };
  });
  assert.deepEqual(value, { size: 65536, valid: true });
  await page.close();
});

it("survives engine context destruction with only durable offsets in IndexedDB", async () => {
  for (const { afterCheckpoint, connections } of [
    { afterCheckpoint: false, connections: 1 }, { afterCheckpoint: true, connections: 1 }, { afterCheckpoint: true, connections: 4 },
  ]) {
    let page = await harness.openPage();
    const id = await page.evaluate(async ({ url, connections }) => {
      window.manager = new window.audit.TaskManager({ hooks: { onExportFile: async () => 1 } });
      const task = await window.manager.addTask({ url, connections });
      return task.id;
    }, { url: `${base}/${connections > 1 ? "parallel" : "crash"}-${afterCheckpoint}.bin`, connections });
    await waitUntil(async () => page.evaluate(async ({ id, afterCheckpoint }) => {
      const record = await new window.audit.IndexedDbTaskStore().get(id);
      const live = await window.manager.getTaskView(id);
      return afterCheckpoint ? record.downloaded > 0 : live.downloaded > 0;
    }, { id, afterCheckpoint }));
    const checkpoint = await page.evaluate(async id => {
      const record = await new window.audit.IndexedDbTaskStore().get(id);
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("tug-web-parts");
      const file = await (await root.getFileHandle(`task-${id}.part`)).getFile();
      return { committed: record.downloaded, size: file.size };
    }, id);
    assert.ok(checkpoint.committed <= checkpoint.size);
    if (afterCheckpoint) assert.ok(checkpoint.committed > 0);
    await page.close(); // destroys the task's buffers and dedicated OPFS worker
    page = await harness.openPage();
    await page.evaluate(async id => {
      window.output = null;
      window.manager = new window.audit.TaskManager({ hooks: { onExportFile: async ({ blob }) => {
        window.output = await window.audit.computeSha256Hex(new Uint8Array(await blob.arrayBuffer()));
        return 1;
      } } });
      await window.manager.ensureInitialized();
      await window.manager.resumeTask(id);
    }, id);
    const hash = await waitUntil(() => page.evaluate(() => window.output));
    assert.equal(hash, connections > 1 ? parallelExpected : expected);
    await page.close();
  }
});

it("runs the real extension pause/resume and system-download export pipeline", async () => {
  const page = await harness.openPage();
  const downloads = path.join(harness.temp, "downloads");
  await fs.mkdir(downloads);
  const cdp = await harness.context.newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const task = await rpc(page, "add_task", { url: `${base}/pipeline.bin`, connections: 1 });
  await waitUntil(async () => (await rpc(page, "list_tasks")).find(t => t.id === task.id)?.downloaded > 0);
  assert.equal((await rpc(page, "pause_task", { id: task.id })).state, "paused");
  await rpc(page, "resume_task", { id: task.id });
  const final = await waitUntil(async () => {
    const t = (await rpc(page, "list_tasks")).find(t => t.id === task.id);
    if (t?.state === "failed") throw new Error(t.error);
    return t?.state === "completed" ? t : null;
  });
  assert.ok(path.resolve(final.path).startsWith(path.resolve(downloads) + path.sep));
  const data = await fs.readFile(final.path);
  assert.equal(createHash("sha256").update(data).digest("hex"), expected);
  await rpc(page, "remove_task", { id: task.id, deleteFiles: false });
  await page.close();
});

it("keeps the manager toolbar and main content accessible at narrow widths", async () => {
  const page = await harness.context.newPage();
  await page.goto(`${harness.origin}/manager.html`);
  await page.getByRole("button", { name: "新建下载", exact: true }).waitFor();
  for (const width of [760, 420]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".topbar");
      const content = document.querySelector(".content");
      const button = [...header.querySelectorAll("button")].find(b => b.textContent.includes("新建下载"));
      const rect = button.getBoundingClientRect();
      return { headerOverflow: header.scrollWidth - header.clientWidth, contentOverflow: content.scrollWidth - content.clientWidth,
        buttonLeft: rect.left, buttonRight: rect.right, viewport: innerWidth };
    });
    assert.ok(layout.headerOverflow <= 1, JSON.stringify(layout));
    assert.ok(layout.contentOverflow <= 1, JSON.stringify(layout));
    assert.ok(layout.buttonLeft >= 0 && layout.buttonRight <= width, JSON.stringify(layout));
    const results = path.join(projectRoot, "test-results/browser");
    await fs.mkdir(results, { recursive: true });
    await page.screenshot({ path: path.join(results, `manager-${width}.png`), fullPage: true });
  }
  await page.close();
});

const openssl = [process.env.TUG_TEST_OPENSSL, "openssl", "C:/Program Files/Git/usr/bin/openssl.exe"]
  .filter(Boolean).find(exe => spawnSync(exe, ["version"], { windowsHide: true }).status === 0);
it("preserves HTTP/2 multiplexing over HTTPS with 32 configured workers", { skip: !openssl && "OpenSSL unavailable" }, async () => {
  const tlsHarness = await launchHarness({ ignoreHTTPSErrors: true });
  const sessions = new Set();
  let tlsServer;
  try {
    const key = path.join(tlsHarness.temp, "key.pem"), cert = path.join(tlsHarness.temp, "cert.pem");
    const generated = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { windowsHide: true, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const versions = new Set();
    let active = 0, peak = 0;
    tlsServer = createSecureServer({ key: await fs.readFile(key), cert: await fs.readFile(cert), allowHTTP1: true }, async (req, res) => {
      versions.add(req.httpVersion);
      active++; peak = Math.max(peak, active);
      res.once("close", () => { active--; });
      res.on("error", () => {});
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
      const start = Number(m[1]), end = Number(m[2]);
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${parallelPayload.length}`, "Content-Length": end - start + 1, "ETag": '"h2-fixture"' });
      for (let at = start; at <= end && !res.destroyed; at += 65536) {
        await new Promise(resolve => setTimeout(resolve, 4));
        if (!res.destroyed) res.write(parallelPayload.subarray(at, Math.min(at + 65536, end + 1)));
      }
      if (!res.destroyed) res.end();
    });
    tlsServer.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise(resolve => tlsServer.listen(0, "127.0.0.1", resolve));
    const page = await tlsHarness.openPage();
    const result = await page.evaluate(async ({ url, expected }) => {
      const store = new window.audit.OpfsPartStorage();
      const result = await window.audit.runHttpDownload({ url, connections: 32, partKey: "h2", partStore: store,
        carryCookies: false, expectedSha256: expected, signal: AbortSignal.timeout(15000) });
      await store.remove("h2");
      return result.metrics;
    }, { url: `https://127.0.0.1:${tlsServer.address().port}/file.bin`, expected: parallelExpected });
    assert.deepEqual([...versions], ["2.0"]);
    assert.equal(result.effectiveConnections, 32);
    assert.ok(peak > 6, `HTTP/2 was unnecessarily serialized: peak=${peak}`);
  } finally {
    await tlsHarness.close();
    for (const session of sessions) session.destroy();
    if (tlsServer) await new Promise(resolve => tlsServer.close(resolve));
  }
});
