import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { TaskManager } from "../src/engine/core/manager.ts";
import { MemoryPartStorage } from "../src/engine/storage/part-store.ts";
import { MemoryTaskStore } from "../src/engine/storage/task-store.ts";
import { encodeBencode, utf8ToBytes } from "../src/engine/torrent/bencode.ts";
import { uint8ArrayToBase64 } from "../src/engine/torrent/parser.ts";
import { runTorrentDownload } from "../src/engine/torrent/session.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const files = [randomBytes(16384), randomBytes(16384), randomBytes(65536)];
const all = Buffer.concat(files);
const pieces = [];
for (let i = 0; i < all.length; i += 32768) pieces.push(createHash("sha1").update(all.subarray(i, i + 32768)).digest());
const torrent = uint8ArrayToBase64(encodeBencode({ "url-list": ["https://seed.test/"], info: {
  name: utf8ToBytes("bundle"), "piece length": 32768, pieces: Buffer.concat(pieces),
  files: files.map((b, i) => ({ length: b.length, path: [utf8ToBytes(`${i}.bin`)] })),
} }));
function seedFetch(blockC = false, delay = 0): typeof fetch {
  return (async (url, init) => {
    init?.signal?.throwIfAborted();
    const file = Number(new URL(String(url)).pathname.match(/(\d)\.bin/)![1]);
    if (blockC && file === 2) return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    if (delay) await sleep(delay);
    init?.signal?.throwIfAborted();
    const range = new Headers(init?.headers).get("range")!.match(/bytes=(\d+)-(\d+)/)!;
    const start = Number(range[1]), end = Number(range[2]);
    return new Response(files[file].subarray(start, end + 1), { status: 206, headers: {
      "Content-Range": `bytes ${start}-${end}/${files[file].length}`,
    } });
  }) as typeof fetch;
}
async function settled(manager: TaskManager, id: number) {
  for (let i = 0; i < 150; i++) {
    const task = await manager.getTaskView(id);
    if (task && ["completed", "failed", "paused"].includes(task.state)) return task;
    await sleep(20);
  }
  throw new Error("task did not settle");
}

describe("Torrent file selection and export recovery", () => {
  it("invalidates a completed cross-file piece when a previously absent file is selected", async () => {
    const store = new MemoryPartStorage();
    const abort = new AbortController();
    let completed: number[] = [];
    const options = { sourceUrl: "", torrentBytesBase64: torrent, partKeyPrefix: "bt", partStore: store,
      connections: 1, webRtcEnabled: false, webSeedEnabled: true, useNativeHelper: false, customTrackers: [], fetchImpl: seedFetch(true, 140) };
    await assert.rejects(runTorrentDownload({ ...options, onlyFiles: [0, 2], signal: abort.signal, onProgress: p => {
      completed = p.completedPieces;
      if (p.segments.some(s => s.state === "completed")) abort.abort();
    } }), { name: "AbortError" });
    assert.deepEqual(completed, [0]);
    assert.equal(await store.exists("bt-file-1"), false);
    await runTorrentDownload({ ...options, fetchImpl: seedFetch(), onlyFiles: [1], completedPieces: completed, signal: new AbortController().signal });
    assert.equal(hash(await store.readAll("bt-file-1")), hash(files[1]));
  });

  it("persists selection changes through pause/resume and downloads the missing overlap", async () => {
    const taskStore = new MemoryTaskStore();
    let sawData!: () => void;
    const dataReceived = new Promise<void>(resolve => { sawData = resolve; });
    const exported: string[] = [];
    const manager = new TaskManager({ store: taskStore, partStore: new MemoryPartStorage(), hooks: {
      fetchImpl: seedFetch(true, 140),
      onEvent: e => { if (e.type === "updated" && e.task.segments.some(s => s.state === "completed")) sawData(); },
      onExportFile: async ({ blob, relativePath }) => {
        exported.push(relativePath);
        assert.equal(hash(new Uint8Array(await blob.arrayBuffer())), hash(files[1]));
        return 1;
      },
    } });
    await manager.updateSettings({ standaloneMode: true, btWebRtcEnabled: false, btCustomTrackers: [] });
    const task = await manager.addTask({ url: "", torrentBytesBase64: torrent, onlyFiles: [0, 2] });
    await dataReceived;
    await manager.pauseTask(task.id);
    assert.deepEqual((await taskStore.get(task.id))!.btCompletedPieces, [0]);
    await manager.setTorrentFiles(task.id, [1]);
    assert.deepEqual((await taskStore.get(task.id))!.btCompletedPieces, []);
    await manager.resumeTask(task.id);
    assert.equal((await settled(manager, task.id)).state, "completed");
    assert.deepEqual(exported, ["bundle/1.bin"]);
  });

  it("retries only unfinished file exports and never recreates zero-filled output", async () => {
    let fetches = 0, exports = 0;
    const saved: number[] = [];
    const fetchImpl = seedFetch();
    const taskStore = new MemoryTaskStore();
    const manager = new TaskManager({ store: taskStore, partStore: new MemoryPartStorage(), hooks: {
      fetchImpl: (async (...args) => { fetches++; return fetchImpl(...args); }) as typeof fetch,
      onExportFile: async ({ blob, relativePath }) => {
        exports++;
        if (exports === 2) throw new Error("user canceled second export");
        const file = Number(relativePath.match(/(\d)\.bin/)![1]);
        assert.equal(hash(new Uint8Array(await blob.arrayBuffer())), hash(files[file]));
        saved.push(file);
        return { downloadId: 100 + file, savedPath: `/downloads/${relativePath}` };
      },
    } });
    await manager.updateSettings({ standaloneMode: true, btWebRtcEnabled: false, btCustomTrackers: [] });
    const task = await manager.addTask({ url: "", torrentBytesBase64: torrent });
    assert.equal((await settled(manager, task.id)).state, "failed");
    assert.equal((await taskStore.get(task.id))!.btExports![0].downloadId, 100);
    const requestsAtFailure = fetches;
    await manager.resumeTask(task.id);
    assert.equal((await settled(manager, task.id)).state, "completed");
    assert.equal(fetches, requestsAtFailure);
    assert.deepEqual(saved, [0, 1, 2]);
  });
});
