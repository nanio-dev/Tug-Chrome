/// <reference lib="webworker" />

interface WorkerRequestMessage {
  id: number;
  op: "allocate" | "write" | "sync" | "flush" | "remove";
  key: string;
  offset?: number;
  buffer?: ArrayBuffer;
  reset?: boolean;
}

let dirPromise: Promise<FileSystemDirectoryHandle> | null = null;
const handles = new Map<string, FileSystemSyncAccessHandle>();

function getRootDir(): Promise<FileSystemDirectoryHandle> {
  if (!dirPromise) {
    dirPromise = navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle("tug-web-parts", { create: true }));
  }
  return dirPromise;
}

async function getSyncHandle(key: string): Promise<FileSystemSyncAccessHandle> {
  const existing = handles.get(key);
  if (existing) {
    return existing;
  }
  const dir = await getRootDir();
  const fileHandle = await dir.getFileHandle(key, { create: true });
  if (typeof fileHandle.createSyncAccessHandle !== "function") {
    throw new DOMException("SyncAccessHandle unavailable", "NotSupportedError");
  }
  const syncHandle = await fileHandle.createSyncAccessHandle();
  handles.set(key, syncHandle);
  return syncHandle;
}

function closeSyncHandle(key: string): void {
  const syncHandle = handles.get(key);
  if (!syncHandle) return;
  try {
    syncHandle.flush();
  } finally {
    handles.delete(key);
    syncHandle.close();
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequestMessage>) => {
  const { id, op, key, offset, buffer, reset } = event.data;
  try {
    switch (op) {
      case "allocate": {
        const handle = await getSyncHandle(key);
        if (reset) {
          handle.truncate(0);
          handle.flush();
        }
        self.postMessage({ id, ok: true });
        break;
      }
      case "write": {
        const syncHandle = await getSyncHandle(key);
        const view = new Uint8Array(buffer!);
        const startOffset = offset ?? 0;
        let written = 0;
        while (written < view.byteLength) {
          const sub = written === 0 ? view : view.subarray(written);
          const n = syncHandle.write(sub, { at: startOffset + written });
          if (n <= 0) throw new Error("OPFS write returned zero bytes");
          written += n;
        }
        self.postMessage({ id, ok: true });
        break;
      }
      case "sync": {
        handles.get(key)?.flush();
        self.postMessage({ id, ok: true });
        break;
      }
      case "flush": {
        closeSyncHandle(key);
        self.postMessage({ id, ok: true });
        break;
      }
      case "remove": {
        closeSyncHandle(key);
        try {
          const dir = await getRootDir();
          await dir.removeEntry(key);
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
        }
        self.postMessage({ id, ok: true });
        break;
      }
      default:
        throw new Error(`Unsupported OPFS worker op: ${String(op)}`);
    }
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      unsupported: err instanceof DOMException && err.name === "NotSupportedError",
    });
  }
};
