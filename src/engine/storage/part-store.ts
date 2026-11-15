export interface PartStorageBackend {
  readonly name: string;
  allocate(key: string, size: number): Promise<void>;
  writeAt(key: string, offset: number, chunk: Uint8Array): Promise<void>;
  flush?(key: string): Promise<void>;
  readAll(key: string): Promise<Uint8Array>;
  readRange(key: string, offset: number, length: number): Promise<Uint8Array>;
  toBlob(key: string, mime?: string): Promise<Blob>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/**
 * 内存模拟的随机读写存储（用于 Node 自动化测试及不支持 OPFS 的环境回退）。
 */
export class MemoryPartStorage implements PartStorageBackend {
  readonly name = "memory";
  private readonly buffers = new Map<string, Uint8Array>();

  async allocate(key: string, size: number): Promise<void> {
    const existing = this.buffers.get(key);
    if (existing) {
      if (size > existing.byteLength) {
        const next = new Uint8Array(size);
        next.set(existing);
        this.buffers.set(key, next);
      }
      return;
    }
    this.buffers.set(key, new Uint8Array(Math.max(0, size)));
  }

  async writeAt(key: string, offset: number, chunk: Uint8Array): Promise<void> {
    const required = offset + chunk.byteLength;
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = new Uint8Array(required);
      this.buffers.set(key, buf);
    } else if (required > buf.byteLength) {
      const next = new Uint8Array(Math.max(required, buf.byteLength * 2));
      next.set(buf);
      buf = next;
      this.buffers.set(key, buf);
    }
    buf.set(chunk, offset);
  }

  async flush(_key: string): Promise<void> {
    // 内存无需 flush
  }

  async readAll(key: string): Promise<Uint8Array> {
    const buf = this.buffers.get(key);
    if (!buf) {
      throw new Error(`Part not found: ${key}`);
    }
    return buf.slice();
  }

  async readRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    const buf = this.buffers.get(key);
    if (!buf) {
      throw new Error(`Part not found: ${key}`);
    }
    return buf.slice(offset, offset + length);
  }

  async toBlob(key: string, mime = "application/octet-stream"): Promise<Blob> {
    const buf = await this.readAll(key);
    return new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer], {
      type: mime,
    });
  }

  async remove(key: string): Promise<void> {
    this.buffers.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.buffers.has(key);
  }
}

interface PendingWorkerRequest {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * 基于 Chromium Origin Private File System (OPFS) 的高性能磁盘随机偏移存储。
 * - 优先使用专用 Worker (`opfs-worker.js`) + `FileSystemSyncAccessHandle` (`createSyncAccessHandle`)
 *   直接对底层 OS 文件描述符执行原地 `write(buf, { at: offset })`，零 `.crswap` 临时文件拷贝；
 * - 若当前环境不支持 Worker / SyncAccessHandle，则复用长连接打开的 `FileSystemWritableFileStream`，
 *   仅在任务导出或关闭时调用一次 `close()`。
 */
export class OpfsPartStorage implements PartStorageBackend {
  readonly name = "opfs";
  private dirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly openWritables = new Map<string, FileSystemWritableFileStream>();

  private worker: Worker | null = null;
  private workerBroken = false;
  private nextReqId = 1;
  private readonly pendingWorkerReqs = new Map<number, PendingWorkerRequest>();

  private getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.dirPromise) {
      this.dirPromise = navigator.storage
        .getDirectory()
        .then((root) => root.getDirectoryHandle("tug-web-parts", { create: true }));
    }
    return this.dirPromise;
  }

  private getOrCreateWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") {
      this.workerBroken = true;
      return null;
    }
    try {
      const workerUrl =
        typeof chrome !== "undefined" && chrome.runtime?.getURL
          ? chrome.runtime.getURL("opfs-worker.js")
          : "/opfs-worker.js";
      const worker = new Worker(workerUrl);
      worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
        const { id, ok, error } = event.data;
        const pending = this.pendingWorkerReqs.get(id);
        if (!pending) return;
        this.pendingWorkerReqs.delete(id);
        if (ok) {
          pending.resolve();
        } else {
          pending.reject(new Error(error || "OPFS Worker operation failed"));
        }
      };
      worker.onerror = () => {
        this.workerBroken = true;
        for (const [, p] of this.pendingWorkerReqs) {
          p.reject(new Error("OPFS Worker failed to initialize"));
        }
        this.pendingWorkerReqs.clear();
      };
      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private callWorker(
    op: "allocate" | "write" | "flush" | "remove",
    key: string,
    offset?: number,
    buffer?: ArrayBuffer,
  ): Promise<void> {
    const worker = this.getOrCreateWorker();
    if (!worker) {
      return Promise.reject(new Error("OPFS Worker unavailable"));
    }
    const id = this.nextReqId++;
    return new Promise<void>((resolve, reject) => {
      this.pendingWorkerReqs.set(id, { resolve, reject });
      if (buffer) {
        worker.postMessage({ id, op, key, offset, buffer }, [buffer]);
      } else {
        worker.postMessage({ id, op, key, offset });
      }
    });
  }

  private enqueue(key: string, op: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(op);
    this.writeQueues.set(
      key,
      next.finally(() => {
        if (this.writeQueues.get(key) === next) {
          this.writeQueues.delete(key);
        }
      }),
    );
    return next;
  }

  private async getPersistentWritable(key: string): Promise<FileSystemWritableFileStream> {
    const existing = this.openWritables.get(key);
    if (existing) return existing;
    const dir = await this.getRootDir();
    const handle = await dir.getFileHandle(key, { create: true });
    const file = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: file.size > 0 });
    this.openWritables.set(key, writable);
    return writable;
  }

  private async closePersistentWritable(key: string): Promise<void> {
    const writable = this.openWritables.get(key);
    if (!writable) return;
    this.openWritables.delete(key);
    await writable.close();
  }

  async allocate(key: string, _size: number): Promise<void> {
    await this.enqueue(key, async () => {
      if (!this.workerBroken) {
        try {
          await this.callWorker("allocate", key);
          return;
        } catch {
          this.workerBroken = true;
        }
      }
      // Fallback: 仅确保文件存在，不预先 truncate 巨型文件以免触发整文件 swap 拷贝
      const dir = await this.getRootDir();
      await dir.getFileHandle(key, { create: true });
    });
  }

  async writeAt(key: string, offset: number, chunk: Uint8Array): Promise<void> {
    await this.enqueue(key, async () => {
      if (!this.workerBroken) {
        try {
          const transferBuf =
            chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
              ? (chunk.buffer.slice(0) as ArrayBuffer)
              : (chunk.buffer.slice(
                  chunk.byteOffset,
                  chunk.byteOffset + chunk.byteLength,
                ) as ArrayBuffer);
          await this.callWorker("write", key, offset, transferBuf);
          return;
        } catch {
          this.workerBroken = true;
        }
      }
      // Fallback: 复用长连接打开的 FileSystemWritableFileStream
      const writable = await this.getPersistentWritable(key);
      await writable.seek(offset);
      await writable.write(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
      );
    });
  }

  async flush(key: string): Promise<void> {
    await this.enqueue(key, async () => {
      if (!this.workerBroken && this.worker) {
        await this.callWorker("flush", key).catch(() => {});
      }
      await this.closePersistentWritable(key).catch(() => {});
    });
  }

  async readAll(key: string): Promise<Uint8Array> {
    await this.flush(key);
    const dir = await this.getRootDir();
    const handle = await dir.getFileHandle(key, { create: false });
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    await this.flush(key);
    const dir = await this.getRootDir();
    const handle = await dir.getFileHandle(key, { create: false });
    const file = await handle.getFile();
    const slice = file.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }

  async toBlob(key: string, mime = "application/octet-stream"): Promise<Blob> {
    await this.flush(key);
    const dir = await this.getRootDir();
    const handle = await dir.getFileHandle(key, { create: false });
    const file = await handle.getFile();
    // File 继承自 Blob；slice 指定 MIME 后仍保持磁盘零拷贝引用，且避免 Chromium 将无扩展名 OPFS 键嗅探为 text/plain
    const safeMime = mime || "application/octet-stream";
    return file.slice(0, file.size, safeMime);
  }

  async remove(key: string): Promise<void> {
    await this.enqueue(key, async () => {
      await this.closePersistentWritable(key).catch(() => {});
      if (!this.workerBroken && this.worker) {
        try {
          await this.callWorker("remove", key);
          return;
        } catch {
          // 继续走主线程删除
        }
      }
      try {
        const dir = await this.getRootDir();
        await dir.removeEntry(key);
      } catch {
        // 忽略不存在的文件
      }
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const dir = await this.getRootDir();
      await dir.getFileHandle(key, { create: false });
      return true;
    } catch {
      return false;
    }
  }
}

export function createDefaultPartStorage(): PartStorageBackend {
  if (
    typeof navigator !== "undefined" &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  ) {
    return new OpfsPartStorage();
  }
  return new MemoryPartStorage();
}
