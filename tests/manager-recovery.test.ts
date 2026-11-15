import assert from "node:assert/strict";
import { it } from "node:test";
import { TaskManager } from "../src/engine/core/manager.ts";
import { MemoryPartStorage } from "../src/engine/storage/part-store.ts";
import { MemoryTaskStore } from "../src/engine/storage/task-store.ts";
import type { TaskRecord } from "../src/engine/storage/task-store.ts";

const payload = new Uint8Array(256 * 1024).fill(23);
const source: typeof fetch = (async (_input, init) => {
  init?.signal?.throwIfAborted();
  const match = new Headers(init?.headers).get("range")!.match(/bytes=(\d+)-(\d+)/)!;
  const start = Number(match[1]), end = Number(match[2]);
  return new Response(payload.subarray(start, end + 1), { status: 206, headers: {
    "Content-Range": `bytes ${start}-${end}/${payload.length}`, "ETag": '"manager-fixture"',
    "Content-Disposition": "attachment; filename*=UTF-8''real-name.zip",
  } });
}) as typeof fetch;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function finished(manager: TaskManager, id: number) {
  for (let i = 0; i < 100; i++) {
    const view = await manager.getTaskView(id);
    if (view && ["completed", "failed"].includes(view.state)) return view;
    await sleep(10);
  }
  throw new Error("Task did not finish");
}

it("uses server names unless the user supplied a name", async () => {
  for (const explicit of [null, "my-file.bin"]) {
    let exported = "";
    const manager = new TaskManager({ store: new MemoryTaskStore(), partStore: new MemoryPartStorage(), hooks: {
      fetchImpl: source, onExportFile: async ({ relativePath }) => { exported = relativePath; return 1; },
    } });
    const task = await manager.addTask({ url: "https://source.test/download?id=42", fileName: explicit });
    assert.equal((await finished(manager, task.id)).state, "completed");
    assert.equal(exported, explicit ?? "real-name.zip");
  }
});

it("cancels a saving task and resumes its export without another HTTP request", async () => {
  const store = new MemoryTaskStore();
  let calls = 0, exports = 0, saving!: () => void;
  const startedSaving = new Promise<void>(resolve => { saving = resolve; });
  const phases: string[] = [];
  const manager = new TaskManager({ store, partStore: new MemoryPartStorage(), hooks: {
    fetchImpl: (async (...args) => { calls++; return source(...args); }) as typeof fetch,
    onEvent: e => { if (e.type === "updated") phases.push(e.task.state); },
    onExportFile: async ({ signal, blob }) => {
      exports++;
      if (exports === 1) {
        saving();
        return new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      }
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), payload);
      return 1;
    },
  } });
  const task = await manager.addTask({ url: "https://source.test/file.bin" });
  await startedSaving;
  assert.equal((await manager.getTaskView(task.id))!.state, "exporting");
  assert.equal((await manager.pauseTask(task.id)).state, "paused");
  assert.equal((await store.get(task.id))!.httpDownloadComplete, true);
  const before = calls;
  await manager.resumeTask(task.id);
  assert.equal((await finished(manager, task.id)).state, "completed");
  assert.equal(calls, before);
  assert.ok(phases.includes("exporting"));
});

it("does not trust pre-migration HTTP completion markers for partially buffered data", async () => {
  const store = new MemoryTaskStore();
  const parts = new MemoryPartStorage();
  const manager = new TaskManager({ store, partStore: parts, hooks: {
    fetchImpl: source, onExportFile: async ({ blob }) => {
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), payload);
      return 1;
    },
  } });
  // First obtain a real task record, then model an older browser's corrupt checkpoint.
  const task = await manager.addTask({ url: "https://source.test/file.bin" });
  await finished(manager, task.id);
  const record = (await store.get(task.id))!;
  record.state = "paused";
  record.httpCheckpointVersion = undefined;
  record.httpDownloadComplete = undefined;
  record.segments = [{ index: 0, start: 0, current: payload.length, end: payload.length, state: "completed" }];
  await store.put(record);
  await parts.allocate(`task-${task.id}.part`, payload.length); // zeros, no actual downloaded data
  await manager.resumeTask(task.id);
  assert.equal((await finished(manager, task.id)).state, "completed");
});

it("pauses queued tasks without starting them while pausing active work", async () => {
  let requests = 0;
  const manager = new TaskManager({ store: new MemoryTaskStore(), partStore: new MemoryPartStorage(), hooks: {
    fetchImpl: (async (_input, init) => {
      requests++;
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    }) as typeof fetch,
  } });
  await manager.updateSettings({ maxConcurrentTasks: 1 });
  for (let i = 0; i < 3; i++) await manager.addTask({ url: `https://source.test/${i}` });
  const paused = await manager.pauseAll();
  assert.ok(paused.every(t => t.state === "paused"));
  assert.equal(requests, 1);
});

it("reports IndexedDB checkpoint failures without silently restarting the queued record", async () => {
  class FullDatabase extends MemoryTaskStore {
    async put(record: TaskRecord): Promise<TaskRecord> {
      if (record.state !== "queued") throw new Error("IndexedDB quota exceeded");
      return super.put(record);
    }
  }
  let requests = 0;
  const manager = new TaskManager({ store: new FullDatabase(), partStore: new MemoryPartStorage(), hooks: {
    fetchImpl: (async (...args) => { requests++; return source(...args); }) as typeof fetch,
  } });
  const task = await manager.addTask({ url: "https://source.test/file.bin" });
  const final = await finished(manager, task.id);
  assert.equal(final.state, "failed");
  assert.match(final.error!, /quota exceeded/);
  const count = requests;
  await sleep(50);
  assert.equal(requests, count);
  assert.equal((await manager.listTasks())[0].state, "failed");
});
