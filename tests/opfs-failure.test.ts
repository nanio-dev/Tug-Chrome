import assert from "node:assert/strict";
import { it } from "node:test";
import { OpfsPartStorage } from "../src/engine/storage/part-store.ts";

it("does not acknowledge a checkpoint or silently switch backends after a live OPFS worker crashes", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  class CrashingWorker {
    onmessage?: (event: { data: { id: number; ok: boolean } }) => void;
    onerror?: () => void;
    terminate() {}
    postMessage(message: { op: string; id: number }) {
      queueMicrotask(() => {
        if (message.op === "allocate") this.onmessage?.({ data: { id: message.id, ok: true } });
        else this.onerror?.();
      });
    }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: CrashingWorker });
  try {
    const store = new OpfsPartStorage();
    await store.allocate("part", 65536);
    await assert.rejects(store.writeAt("part", 0, new Uint8Array(65536)), /Worker/);
    await assert.rejects(store.sync("part"), /reload the extension/);
    await assert.rejects(store.flush("part"), /reload the extension/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
