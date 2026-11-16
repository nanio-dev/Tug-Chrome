import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("authorizes the real Agent over native stdio and publishes complete exports atomically", { timeout: 20000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tug-agent-integration-"));
  for (const sub of ["Downloads", "AppData", "Tmp"]) await fs.mkdir(path.join(temp, sub));
  const exe = process.env.TUG_TEST_AGENT || path.join(root, "agent/target/debug", process.platform === "win32" ? "tug-agent.exe" : "tug-agent");
  const child = spawn(exe, ["--serve-only", "--native-stdio", "--port=0"], {
    windowsHide: true, env: { ...process.env, USERPROFILE: temp, HOME: temp, XDG_DATA_HOME: path.join(temp,"Data"), XDG_CONFIG_HOME: path.join(temp,"Config"), LOCALAPPDATA: path.join(temp, "AppData"), TEMP: path.join(temp, "Tmp"), TMP: path.join(temp, "Tmp") },
  });
  let frames = Buffer.alloc(0), stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Agent startup timed out: ${stderr}`)), 12000);
      child.on("error", err => { clearTimeout(timer); reject(err); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Agent exited ${code}: ${stderr}`)); });
      child.stdout.on("data", data => {
        frames = Buffer.concat([frames, data]);
        if (frames.length >= 4 && frames.length >= 4 + frames.readUInt32LE(0)) {
          clearTimeout(timer);
          resolve(JSON.parse(frames.subarray(4, 4 + frames.readUInt32LE(0)).toString()));
        }
      });
    });
    assert.equal(ready.protocolVersion, 2);
    assert.match(ready.token, /^[a-f0-9]{64}$/);
    const base = ready.baseUrl;
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.authRequired, true);
    assert.equal(health.btInitialized, false, "BT must not delay startup or file export");
    assert.deepEqual(health.capabilities, ["torrent", "file_export", "file_operations"]);
    assert.equal("token" in health, false);
    const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headers = { "Origin": origin, "X-Tug-Agent-Token": ready.token, "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/fs/delete`, { method: "POST", body: JSON.stringify({ path: "file" }), headers: { "Content-Type": "application/json" } })).status, 401);
    assert.equal((await fetch(`${base}/fs/delete`, { method: "POST", body: "{}", headers: { ...headers, Origin: "https://evil.test" } })).status, 403);
    const sentinel = path.join(temp, "outside.txt");
    await fs.writeFile(sentinel, "owned sentinel");
    const attempted = path.join(temp, "Downloads") + path.sep + ".." + path.sep + "outside.txt";
    const deleted = await (await fetch(`${base}/fs/delete`, { method: "POST", headers, body: JSON.stringify({ path: attempted }) })).json();
    assert.equal(deleted.deleted, false);
    assert.equal(await fs.readFile(sentinel, "utf8"), "owned sentinel");
    const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 93);
    const exportHeaders = { ...headers, "Content-Type": "application/octet-stream", "X-Relative-Path": "Tug/file.bin" };
    const exports = await Promise.all([1, 2].map(async () => {
      const res = await fetch(`${base}/fs/export`, { method: "POST", headers: exportHeaders, body: payload });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
      return (await res.json()).savedPath;
    }));
    assert.notEqual(exports[0], exports[1]);
    for (const filename of exports) assert.deepEqual(await fs.readFile(filename), payload);
    // Invalid paths are rejected before reading the body. A large upload can race
    // that early response and surface EPIPE instead of HTTP 400 on Unix clients.
    assert.equal((await fetch(`${base}/fs/export`, { method: "POST", headers: { ...exportHeaders, "X-Relative-Path": "../escape.bin" }, body: "must-not-be-written" })).status, 400);
    assert.equal(await fs.stat(path.join(temp,"escape.bin")).then(()=>true,()=>false),false);
    // Abort a streaming upload; its final filename must never become visible.
    const abort = new AbortController();
    let sent = false;
    const stream = new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new Uint8Array(65536)); setTimeout(() => abort.abort(), 50); }
    } });
    await assert.rejects(fetch(`${base}/fs/export`, { method: "POST", duplex: "half", signal: abort.signal,
      headers: { ...exportHeaders, "X-Relative-Path": "Tug/aborted.bin" }, body: stream }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const names = await fs.readdir(path.join(temp, "Downloads/Tug"));
    assert.equal(names.some(n => n.includes("aborted") || n.startsWith(".tmp")), false);
  } catch (error) {
    throw new Error(`Agent integration failed: ${error.message}; cause=${error.cause?.message ?? ''}; exit=${child.exitCode}; signal=${child.signalCode}; stderr=${stderr}`, {cause:error});
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("tug-agent-integration-"));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
});
