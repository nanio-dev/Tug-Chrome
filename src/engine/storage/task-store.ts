import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type SegmentView,
  type Settings,
  type TaskKind,
  type TaskState,
  type TaskView,
  type TorrentFileInfo,
} from "../../shared/types";

export interface TaskRecord {
  id: number;
  kind: TaskKind;
  name: string;
  url: string;
  finalUrl: string | null;
  saveDir: string;
  fileName: string | null;
  state: TaskState;
  total: number | null;
  downloaded: number;
  uploaded: number;
  error: string | null;
  connections: number;
  rangeSupported: boolean;
  etag: string | null;
  lastModified: string | null;
  referrer: string | null;
  headers: Array<[string, string]>;
  checksumSha256: string | null;
  segments: SegmentView[];
  chromeDownloadId: number | null;
  exportedPath?: string | null;
  createdAt: number;
  updatedAt: number;
  // BT 相关持久化字段
  infoHash: string | null;
  torrentBytesBase64: string | null;
  onlyFiles: number[] | null;
  btFiles: TorrentFileInfo[];
  btCompletedPieces: number[];
  btPieceLength: number;
  btPieceCount: number;
  btTrackers: string[];
  btWebSeeds: string[];
}

export function recordToView(
  record: TaskRecord,
  live?: {
    speedBps?: number;
    uploadSpeedBps?: number;
    peers?: number;
    etaSecs?: number | null;
    segments?: SegmentView[];
  },
): TaskView {
  const displayFile = record.fileName || record.name;
  const path =
    record.exportedPath ||
    (record.saveDir ? `${record.saveDir}/${displayFile}` : displayFile);
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    url: record.url,
    state: record.state,
    total: record.total,
    downloaded: record.downloaded,
    uploaded: record.uploaded,
    speedBps: live?.speedBps ?? 0,
    uploadSpeedBps: live?.uploadSpeedBps ?? 0,
    peers: live?.peers ?? 0,
    etaSecs: live?.etaSecs ?? null,
    error: record.error,
    saveDir: record.saveDir,
    fileName: record.fileName,
    path,
    createdAt: record.createdAt,
    connections: record.connections,
    rangeSupported: record.rangeSupported,
    segments: live?.segments ?? record.segments,
    chromeDownloadId: record.chromeDownloadId,
    referrer: record.referrer,
    infoHash: record.infoHash,
  };
}

export interface TaskStoreBackend {
  nextId(): Promise<number>;
  list(): Promise<TaskRecord[]>;
  get(id: number): Promise<TaskRecord | null>;
  put(record: TaskRecord): Promise<TaskRecord>;
  delete(id: number): Promise<void>;
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
}

/**
 * 内存任务存储（用于测试和无 IndexedDB 环境）。
 */
export class MemoryTaskStore implements TaskStoreBackend {
  private counter = 0;
  private readonly records = new Map<number, TaskRecord>();
  private settings: Settings = { ...DEFAULT_SETTINGS };

  async nextId(): Promise<number> {
    this.counter += 1;
    return this.counter;
  }

  async list(): Promise<TaskRecord[]> {
    return Array.from(this.records.values()).sort(
      (a, b) => b.createdAt - a.createdAt || b.id - a.id,
    );
  }

  async get(id: number): Promise<TaskRecord | null> {
    const r = this.records.get(id);
    return r ? structuredClone(r) : null;
  }

  async put(record: TaskRecord): Promise<TaskRecord> {
    if (record.id > this.counter) {
      this.counter = record.id;
    }
    const copy = structuredClone(record);
    this.records.set(copy.id, copy);
    return structuredClone(copy);
  }

  async delete(id: number): Promise<void> {
    this.records.delete(id);
  }

  async loadSettings(): Promise<Settings> {
    return structuredClone(this.settings);
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    this.settings = normalizeSettings(settings);
    return structuredClone(this.settings);
  }
}

/**
 * 基于浏览器 IndexedDB 的持久化存储，并同步设置到 chrome.storage.local。
 */
export class IndexedDbTaskStore implements TaskStoreBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("tug_web_db", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("tasks")) {
            db.createObjectStore("tasks", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("meta")) {
            db.createObjectStore("meta", { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  async nextId(): Promise<number> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["meta", "tasks"], "readwrite");
      const metaStore = tx.objectStore("meta");
      const getReq = metaStore.get("nextTaskId");
      getReq.onsuccess = () => {
        const current = (getReq.result?.value as number | undefined) ?? 0;
        const next = current + 1;
        metaStore.put({ key: "nextTaskId", value: next });
        tx.oncomplete = () => resolve(next);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async list(): Promise<TaskRecord[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tasks", "readonly");
      const req = tx.objectStore("tasks").getAll();
      req.onsuccess = () => {
        const items = (req.result as TaskRecord[]) ?? [];
        items.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async get(id: number): Promise<TaskRecord | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tasks", "readonly");
      const req = tx.objectStore("tasks").get(id);
      req.onsuccess = () => resolve((req.result as TaskRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(record: TaskRecord): Promise<TaskRecord> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tasks", "readwrite");
      tx.objectStore("tasks").put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(id: number): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tasks", "readwrite");
      tx.objectStore("tasks").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadSettings(): Promise<Settings> {
    const db = await this.openDb();
    const stored = await new Promise<Partial<Settings> | null>((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const req = tx.objectStore("meta").get("settings");
      req.onsuccess = () => resolve((req.result?.value as Partial<Settings>) ?? null);
      req.onerror = () => reject(req.error);
    });
    const normalized = normalizeSettings(stored ?? DEFAULT_SETTINGS);
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ tugWebSettings: normalized }).catch(() => {});
    }
    return normalized;
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const normalized = normalizeSettings(settings);
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ key: "settings", value: normalized });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ tugWebSettings: normalized }).catch(() => {});
    }
    return normalized;
  }
}

export function createDefaultTaskStore(): TaskStoreBackend {
  if (typeof indexedDB !== "undefined") {
    return new IndexedDbTaskStore();
  }
  return new MemoryTaskStore();
}
