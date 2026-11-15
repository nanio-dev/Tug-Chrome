/// <reference lib="webworker" />

interface WorkerRequestMessage {
  id: number;
  op: "allocate" | "write" | "flush" | "remove";
  key: string;
  offset?: number;
  buffer?: ArrayBuffer;
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
  const syncHandle = await fileHandle.createSyncAccessHandle();
  handles.set(key, syncHandle);
  return syncHandle;
}

function closeSyncHandle(key: string): void {
  const syncHandle = handles.get(key);
  if (!syncHandle) return;
  handles.delete(key);
  try {
    syncHandle.flush();
  } catch {
    // 忽略 flush 异常
  }
  try {
    syncHandle.close();
  } catch {
    // 忽略 close 异常
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequestMessage>) => {
  const { id, op, key, offset, buffer } = event.data;
  try {
    switch (op) {
      case "allocate": {
        await getSyncHandle(key);
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
          if (n <= 0) break;
          written += n;
        }
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
        } catch {
          // 忽略文件不存在
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
    });
  }
};
