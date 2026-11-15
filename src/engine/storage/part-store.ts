export type AllocationMode = "reset" | "preserve";

export interface PartStorageBackend {
  readonly name: string;
  allocate(key: string, size: number, mode?: AllocationMode): Promise<void>;
  writeAt(key: string, offset: number, chunk: Uint8Array): Promise<void>;
  /** Commit data before persisting resume positions, without releasing the writer. */
  sync?(key: string): Promise<void>;
  flush?(key: string): Promise<void>;
  size(key: string): Promise<number>;
  readAll(key: string): Promise<Uint8Array>;
  readRange(key: string, offset: number, length: number): Promise<Uint8Array>;
  toBlob(key: string, mime?: string): Promise<Blob>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** In-memory backend for tests and environments without OPFS. */
export class MemoryPartStorage implements PartStorageBackend {
  readonly name = "memory";
  private readonly buffers = new Map<string, Uint8Array>();
  private readonly lengths = new Map<string, number>();

  async allocate(key: string, size: number, mode: AllocationMode = "reset"): Promise<void> {
    if (mode === "preserve" && this.buffers.has(key)) return;
    this.buffers.set(key, new Uint8Array(Math.max(0, size)));
    this.lengths.set(key, Math.max(0, size));
  }

  async writeAt(key: string, offset: number, chunk: Uint8Array): Promise<void> {
    const required = offset + chunk.byteLength;
    let buf = this.buffers.get(key);
    if (!buf || required > buf.byteLength) {
      const next = new Uint8Array(Math.max(required, (buf?.byteLength ?? 0) * 2));
      if (buf) next.set(buf);
      buf = next;
      this.buffers.set(key, buf);
    }
    buf.set(chunk, offset);
    this.lengths.set(key, Math.max(this.lengths.get(key) ?? 0, required));
  }

  async sync(_key: string): Promise<void> {}
  async flush(_key: string): Promise<void> {}

  async size(key: string): Promise<number> {
    const size = this.lengths.get(key);
    if (size === undefined) throw new Error(`Part not found: ${key}`);
    return size;
  }

  async readAll(key: string): Promise<Uint8Array> {
    return this.readRange(key, 0, await this.size(key));
  }

  async readRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    const buf = this.buffers.get(key);
    if (!buf) throw new Error(`Part not found: ${key}`);
    return buf.slice(offset, Math.min(offset + length, this.lengths.get(key)!));
  }

  async toBlob(key: string, mime = "application/octet-stream"): Promise<Blob> {
    const buf = await this.readAll(key);
    return new Blob([buf.buffer as ArrayBuffer], { type: mime });
  }

  async remove(key: string): Promise<void> {
    this.buffers.delete(key);
    this.lengths.delete(key);
  }

  async exists(key: string): Promise<boolean> { return this.buffers.has(key); }
}

class WorkerUnavailableError extends Error {}
interface PendingWorkerRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** OPFS random writes, using a dedicated SyncAccessHandle worker when available. */
export class OpfsPartStorage implements PartStorageBackend {
  readonly name = "opfs";
  private dirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly openWritables = new Map<string, FileSystemWritableFileStream>();
  private worker: Worker | null = null;
  private workerBroken = false;
  private workerReady = false;
  private workerFailure: Error | null = null;
  private nextReqId = 1;
  private readonly pendingWorkerReqs = new Map<number, PendingWorkerRequest>();

  private getRootDir(): Promise<FileSystemDirectoryHandle> {
    return this.dirPromise ??= navigator.storage.getDirectory()
      .then((root) => root.getDirectoryHandle("tug-web-parts", { create: true }));
  }

  private failWorker(error: Error): void {
    if (this.workerReady) this.workerFailure = new Error("OPFS Worker failed; reload the extension before resuming", { cause: error });
    this.workerBroken = true;
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pendingWorkerReqs.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pendingWorkerReqs.clear();
  }

  private getOrCreateWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    try {
      const url = typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL("opfs-worker.js") : "/opfs-worker.js";
      const worker = new Worker(url);
      worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; error?: string; unsupported?: boolean }>) => {
        const { id, ok, error, unsupported } = event.data;
        const pending = this.pendingWorkerReqs.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingWorkerReqs.delete(id);
        if (ok) {
          this.workerReady = true;
          pending.resolve();
        } else {
          pending.reject(unsupported ? new WorkerUnavailableError(error) : new Error(error || "OPFS operation failed"));
        }
      };
      worker.onerror = () => this.failWorker(this.workerReady
        ? new Error("OPFS Worker stopped while writing")
        : new WorkerUnavailableError("OPFS Worker unavailable"));
      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private callWorker(op: "allocate" | "write" | "sync" | "flush" | "remove", key: string,
    extra: { offset?: number; buffer?: ArrayBuffer; reset?: boolean } = {}): Promise<void> {
    const worker = this.getOrCreateWorker();
    if (!worker) return Promise.reject(new WorkerUnavailableError("OPFS Worker unavailable"));
    const id = this.nextReqId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failWorker(new Error("OPFS operation timed out")), 30000);
      this.pendingWorkerReqs.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, op, key, ...extra }, extra.buffer ? [extra.buffer] : []);
      } catch (err) {
        clearTimeout(timer);
        this.pendingWorkerReqs.delete(id);
        reject(err);
      }
    });
  }

  private enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
    const next = (this.writeQueues.get(key) ?? Promise.resolve()).then(op);
    // A non-rejecting tail avoids unhandled cleanup rejections and stale map entries.
    const settled = next.then(() => {}, () => {});
    this.writeQueues.set(key, settled);
    void settled.then(() => {
      if (this.writeQueues.get(key) === settled) this.writeQueues.delete(key);
    });
    return next;
  }

  private async getPersistentWritable(key: string): Promise<FileSystemWritableFileStream> {
    const existing = this.openWritables.get(key);
    if (existing) return existing;
    const handle = await (await this.getRootDir()).getFileHandle(key, { create: true });
    const writable = await handle.createWritable({ keepExistingData: true });
    this.openWritables.set(key, writable);
    return writable;
  }

  private async closePersistentWritable(key: string): Promise<void> {
    const writable = this.openWritables.get(key);
    if (!writable) return;
    try { await writable.close(); }
    finally { this.openWritables.delete(key); }
  }

  async allocate(key: string, _size: number, mode: AllocationMode = "reset"): Promise<void> {
    await this.enqueue(key, async () => {
      if (this.workerFailure) throw this.workerFailure;
      if (!this.workerBroken) {
        try {
          await this.callWorker("allocate", key, { reset: mode === "reset" });
          return;
        } catch (err) {
          // Unsupported APIs can fall back; disk/quota/permission errors must propagate.
          if (!(err instanceof WorkerUnavailableError)) throw err;
          this.failWorker(err);
        }
      }
      await this.closePersistentWritable(key);
      const handle = await (await this.getRootDir()).getFileHandle(key, { create: true });
      if (mode === "reset") {
        const writable = await handle.createWritable();
        await writable.close();
      }
    });
  }

  async writeAt(key: string, offset: number, chunk: Uint8Array): Promise<void> {
    await this.enqueue(key, async () => {
      if (this.workerFailure) throw this.workerFailure;
      const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      if (!this.workerBroken) await this.callWorker("write", key, { offset, buffer });
      else {
        const writable = await this.getPersistentWritable(key);
        await writable.write({ type: "write", position: offset, data: buffer });
      }
    });
  }

  async sync(key: string): Promise<void> {
    await this.enqueue(key, async () => {
      if (this.workerFailure) throw this.workerFailure;
      if (!this.workerBroken && this.worker) await this.callWorker("sync", key);
      await this.closePersistentWritable(key);
    });
  }

  async flush(key: string): Promise<void> {
    await this.enqueue(key, async () => {
      if (this.workerFailure) throw this.workerFailure;
      if (!this.workerBroken && this.worker) await this.callWorker("flush", key);
      await this.closePersistentWritable(key);
    });
  }

  async size(key: string): Promise<number> {
    await this.writeQueues.get(key);
    return (await (await (await this.getRootDir()).getFileHandle(key)).getFile()).size;
  }

  async readAll(key: string): Promise<Uint8Array> {
    return this.readRange(key, 0, await this.size(key));
  }

  async readRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    await this.flush(key);
    const handle = await (await this.getRootDir()).getFileHandle(key);
    return new Uint8Array(await (await handle.getFile()).slice(offset, offset + length).arrayBuffer());
  }

  async toBlob(key: string, mime = "application/octet-stream"): Promise<Blob> {
    await this.flush(key);
    const handle = await (await this.getRootDir()).getFileHandle(key);
    const file = await handle.getFile();
    return file.slice(0, file.size, mime || "application/octet-stream");
  }

  async remove(key: string): Promise<void> {
    await this.enqueue(key, async () => {
      await this.closePersistentWritable(key);
      if (!this.workerBroken && this.worker) await this.callWorker("remove", key);
      else {
        try { await (await this.getRootDir()).removeEntry(key); }
        catch (err) {
          if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
        }
      }
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await (await this.getRootDir()).getFileHandle(key);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") return false;
      throw err;
    }
  }
}

export function createDefaultPartStorage(): PartStorageBackend {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function"
    ? new OpfsPartStorage() : new MemoryPartStorage();
}
