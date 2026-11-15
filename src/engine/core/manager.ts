import {
  guessFileNameFromUrl,
  isTorrentSource,
  sanitizeFileName,
} from "../../shared/filename";
import {
  normalizeSettings,
  type AddTaskInput,
  type AppInfo,
  type SegmentView,
  type Settings,
  type TaskEvent,
  type TaskState,
  type TaskView,
  type TorrentFileInfo,
  type TorrentPeerInfo,
  type TorrentRuntimeDetails,
} from "../../shared/types";
import { runHttpDownload } from "../http/downloader";
import { RateLimiter } from "../http/rate-limiter";
import {
  createDefaultPartStorage,
  type PartStorageBackend,
} from "../storage/part-store";
import {
  createDefaultTaskStore,
  recordToView,
  type TaskRecord,
  type TaskStoreBackend,
} from "../storage/task-store";
import { base64ToUint8Array, parseTorrentBuffer } from "../torrent/parser";
import { runTorrentDownload } from "../torrent/session";

export interface TaskManagerHooks {
  onEvent?: (event: TaskEvent) => void;
  onPrepareHeaders?: (params: {
    taskId: number;
    url: string;
    referrer?: string | null;
    headers?: Array<[string, string]>;
  }) => Promise<void>;
  onClearHeaders?: (taskId: number) => Promise<void>;
  onExportFile?: (params: {
    taskId: number;
    blob: Blob;
    relativePath: string;
  }) => Promise<number | null | { downloadId: number | null; savedPath?: string | null }>;
  onDeleteSystemDownload?: (chromeDownloadId: number) => Promise<void>;
  onNotifyTaskFinished?: (task: TaskView) => void;
  onEnsureNativeHelper?: (allowProtocolFallback?: boolean) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

interface ActiveRuntime {
  abort: AbortController;
  promise: Promise<void>;
  view: TaskView;
  lastPersistMs: number;
  btPeers: TorrentPeerInfo[];
}

export class TaskManager {
  private readonly store: TaskStoreBackend;
  private readonly partStore: PartStorageBackend;
  private readonly hooks: TaskManagerHooks;
  private readonly runtimes = new Map<number, ActiveRuntime>();
  private readonly rateLimiter = new RateLimiter(null);
  private settings: Settings | null = null;
  private initPromise: Promise<void> | null = null;
  private pumpChain: Promise<void> = Promise.resolve();

  constructor(options?: {
    store?: TaskStoreBackend;
    partStore?: PartStorageBackend;
    hooks?: TaskManagerHooks;
  }) {
    this.store = options?.store ?? createDefaultTaskStore();
    this.partStore = options?.partStore ?? createDefaultPartStorage();
    this.hooks = options?.hooks ?? {};
  }

  async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.bootstrap();
    }
    return this.initPromise;
  }

  private async bootstrap(): Promise<void> {
    const loadedSettings = await this.store.loadSettings();
    this.settings = loadedSettings;
    this.rateLimiter.setRateBps(
      loadedSettings.globalDownloadLimitKib
        ? loadedSettings.globalDownloadLimitKib * 1024
        : null,
    );

    // 恢复上次未正常结束的活动任务为 paused，已完成任务保持 completed
    const records = await this.store.list();
    for (const record of records) {
      if (
        record.state === "downloading" ||
        record.state === "fetching_metadata" ||
        record.state === "queued"
      ) {
        record.state = "paused";
        record.updatedAt = Math.floor(Date.now() / 1000);
        await this.store.put(record);
      }
    }
  }

  async getAppInfo(): Promise<AppInfo> {
    await this.ensureInitialized();
    const settings = await this.getSettings();
    return {
      name: "Tug Web",
      version: "1.0.0",
      platform: typeof navigator !== "undefined" ? navigator.userAgent : "Node",
      storageEngine: this.partStore.name.toUpperCase(),
      downloadSubdir: settings.downloadSubdir || "Downloads",
      activeTasks: this.runtimes.size,
    };
  }

  async getSettings(): Promise<Settings> {
    await this.ensureInitialized();
    if (!this.settings) {
      this.settings = await this.store.loadSettings();
    }
    return structuredClone(this.settings);
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.ensureInitialized();
    const current = await this.getSettings();
    const next = normalizeSettings({ ...current, ...patch });
    this.settings = await this.store.saveSettings(next);
    this.rateLimiter.setRateBps(
      this.settings.globalDownloadLimitKib
        ? this.settings.globalDownloadLimitKib * 1024
        : null,
    );
    this.emit({ type: "settings", settings: structuredClone(this.settings) });
    await this.pump();
    return structuredClone(this.settings);
  }

  async listTasks(): Promise<TaskView[]> {
    await this.ensureInitialized();
    const records = await this.store.list();
    return records.map((record) => {
      const runtime = this.runtimes.get(record.id);
      return runtime ? structuredClone(runtime.view) : recordToView(record);
    });
  }

  async addTask(input: AddTaskInput): Promise<TaskView> {
    await this.ensureInitialized();
    const settings = await this.getSettings();
    const source = (input.url ?? "").trim();
    const hasTorrentBytes = Boolean(
      input.torrentBytesBase64 && input.torrentBytesBase64.trim().length > 0,
    );
    const isTorrent = isTorrentSource(source, input.torrentBytesBase64);

    if (!isTorrent && !/^https?:\/\//i.test(source)) {
      throw new Error("仅支持 HTTP/HTTPS 链接、magnet 磁力链接或 .torrent 种子文件");
    }

    const existingTasks = await this.listTasks();
    const usedNames = new Set(
      existingTasks.map((t) => (t.fileName || t.name).toLowerCase()),
    );

    const connections = Math.max(
      1,
      Math.min(32, Math.round(Number(input.connections ?? settings.connectionsPerTask) || 8)),
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const id = await this.store.nextId();

    let name = input.fileName?.trim()
      ? sanitizeFileName(input.fileName.trim())
      : guessFileNameFromUrl(source || "torrent");
    let infoHash: string | null = null;
    let btFiles: TorrentFileInfo[] = [];
    let btPieceLength = 0;
    let btPieceCount = 0;
    let btTrackers: string[] = [];
    let btWebSeeds: string[] = [];
    let total: number | null = null;

    if (isTorrent && hasTorrentBytes && input.torrentBytesBase64) {
      const parsed = await parseTorrentBuffer(base64ToUint8Array(input.torrentBytesBase64));
      name = sanitizeFileName(parsed.name, name);
      infoHash = parsed.infoHash;
      total = parsed.totalLength;
      btPieceLength = parsed.pieceLength;
      btPieceCount = parsed.pieceHashes.length;
      btTrackers = parsed.trackers;
      btWebSeeds = parsed.webSeeds;
      const selectedSet = new Set(
        input.onlyFiles && input.onlyFiles.length > 0
          ? input.onlyFiles
          : parsed.files.map((f) => f.index),
      );
      btFiles = parsed.files.map((f) => ({
        index: f.index,
        path: f.path,
        length: f.length,
        selected: selectedSet.has(f.index),
      }));
    }

    name = this.deduplicateName(name, usedNames);

    const customHeaders: Array<[string, string]> = [...(input.headers ?? [])];
    const referrer =
      settings.carryReferer && input.referrer && input.referrer.trim()
        ? input.referrer.trim()
        : null;
    if (referrer && !customHeaders.some(([k]) => k.toLowerCase() === "referer")) {
      customHeaders.push(["Referer", referrer]);
    }

    const record: TaskRecord = {
      id,
      kind: isTorrent ? "torrent" : "http",
      name,
      url: source || `torrent://${infoHash ?? id}`,
      finalUrl: null,
      saveDir: settings.downloadSubdir,
      fileName: isTorrent ? null : name,
      state: "queued",
      total,
      downloaded: 0,
      uploaded: 0,
      error: null,
      connections,
      rangeSupported: true,
      etag: null,
      lastModified: null,
      referrer,
      headers: customHeaders,
      checksumSha256: input.checksumSha256?.trim() || null,
      segments: [],
      chromeDownloadId: null,
      createdAt: nowSec,
      updatedAt: nowSec,
      infoHash,
      torrentBytesBase64: input.torrentBytesBase64 ?? null,
      onlyFiles: input.onlyFiles ?? null,
      btFiles,
      btCompletedPieces: [],
      btPieceLength,
      btPieceCount,
      btTrackers,
      btWebSeeds,
    };

    await this.store.put(record);
    const view = recordToView(record);
    this.emit({ type: "updated", task: view });
    await this.pump();
    return (await this.getTaskView(id)) ?? view;
  }

  async getTaskView(id: number): Promise<TaskView | null> {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      return structuredClone(runtime.view);
    }
    const record = await this.store.get(id);
    return record ? recordToView(record) : null;
  }

  async pauseTask(id: number): Promise<TaskView> {
    await this.ensureInitialized();
    const runtime = this.runtimes.get(id);
    if (runtime) {
      runtime.abort.abort();
      await runtime.promise.catch(() => {});
    } else {
      const record = await this.store.get(id);
      if (!record) {
        throw new Error(`任务不存在: ${id}`);
      }
      if (
        record.state === "queued" ||
        record.state === "downloading" ||
        record.state === "fetching_metadata"
      ) {
        record.state = "paused";
        record.error = null;
        record.updatedAt = Math.floor(Date.now() / 1000);
        await this.store.put(record);
        this.emit({ type: "updated", task: recordToView(record) });
      }
    }
    await this.pump();
    const updated = await this.getTaskView(id);
    if (!updated) throw new Error(`任务不存在: ${id}`);
    return updated;
  }

  async resumeTask(id: number): Promise<TaskView> {
    await this.ensureInitialized();
    if (this.runtimes.has(id)) {
      return structuredClone(this.runtimes.get(id)!.view);
    }
    const record = await this.store.get(id);
    if (!record) {
      throw new Error(`任务不存在: ${id}`);
    }
    if (record.state === "completed") {
      return recordToView(record);
    }
    record.state = "queued";
    record.error = null;
    record.updatedAt = Math.floor(Date.now() / 1000);
    await this.store.put(record);
    this.emit({ type: "updated", task: recordToView(record) });
    await this.pump();
    return (await this.getTaskView(id)) ?? recordToView(record);
  }

  async removeTask(id: number, deleteFiles: boolean): Promise<{ id: number }> {
    await this.ensureInitialized();
    if (this.runtimes.has(id)) {
      await this.pauseTask(id).catch(() => {});
    }
    const record = await this.store.get(id);
    if (!record) {
      return { id };
    }

    await this.store.delete(id);

    // 清理 OPFS 中的临时分片缓存
    await this.partStore.remove(this.httpPartKey(id)).catch(() => {});
    for (let i = 0; i < Math.max(1, record.btFiles.length); i++) {
      await this.partStore.remove(`${this.btPartKeyPrefix(id)}-file-${i}`).catch(() => {});
    }

    if (deleteFiles && record.chromeDownloadId !== null) {
      await this.hooks.onDeleteSystemDownload?.(record.chromeDownloadId).catch(() => {});
    }

    this.emit({ type: "removed", id });
    await this.pump();
    return { id };
  }

  async pauseAll(): Promise<TaskView[]> {
    await this.ensureInitialized();
    const tasks = await this.listTasks();
    for (const task of tasks) {
      if (
        task.state === "queued" ||
        task.state === "downloading" ||
        task.state === "fetching_metadata"
      ) {
        await this.pauseTask(task.id).catch(() => {});
      }
    }
    return this.listTasks();
  }

  async resumeAll(): Promise<TaskView[]> {
    await this.ensureInitialized();
    const tasks = await this.listTasks();
    for (const task of tasks) {
      if (task.state === "paused" || task.state === "failed") {
        await this.resumeTask(task.id).catch(() => {});
      }
    }
    return this.listTasks();
  }

  async listTorrentFiles(id: number): Promise<TorrentFileInfo[]> {
    await this.ensureInitialized();
    const record = await this.store.get(id);
    if (!record) throw new Error(`任务不存在: ${id}`);
    if (record.kind !== "torrent") {
      throw new Error("不是 BitTorrent 任务");
    }
    if (record.btFiles.length === 0 && record.torrentBytesBase64) {
      const parsed = await parseTorrentBuffer(base64ToUint8Array(record.torrentBytesBase64));
      record.btFiles = parsed.files.map((f) => ({
        index: f.index,
        path: f.path,
        length: f.length,
        selected: true,
      }));
      await this.store.put(record);
    }
    return structuredClone(record.btFiles);
  }

  async setTorrentFiles(id: number, fileIndices: number[]): Promise<TorrentFileInfo[]> {
    await this.ensureInitialized();
    const record = await this.store.get(id);
    if (!record) throw new Error(`任务不存在: ${id}`);
    if (record.kind !== "torrent") throw new Error("不是 BitTorrent 任务");
    if (record.state === "completed") {
      throw new Error("任务已完成，不可修改文件选择");
    }
    const cleanIndices = Array.from(new Set(fileIndices)).sort((a, b) => a - b);
    if (cleanIndices.length === 0) {
      throw new Error("请至少选择一个文件");
    }

    const wasRunning = this.runtimes.has(id);
    if (wasRunning) {
      await this.pauseTask(id);
    }

    const fresh = (await this.store.get(id))!;
    fresh.onlyFiles = cleanIndices;
    const selectedSet = new Set(cleanIndices);
    fresh.btFiles = fresh.btFiles.map((f) => ({
      ...f,
      selected: selectedSet.has(f.index),
    }));
    await this.store.put(fresh);
    this.emit({ type: "updated", task: recordToView(fresh) });

    if (wasRunning) {
      await this.resumeTask(id);
    }
    return structuredClone(fresh.btFiles);
  }

  async getTorrentRuntime(id: number): Promise<TorrentRuntimeDetails> {
    await this.ensureInitialized();
    const record = await this.store.get(id);
    if (!record) throw new Error(`任务不存在: ${id}`);
    const runtime = this.runtimes.get(id);
    return {
      infoHash: record.infoHash ?? "pending",
      pieceLength: record.btPieceLength,
      pieceCount: record.btPieceCount,
      completedPieces: record.btCompletedPieces.length,
      peers: runtime ? structuredClone(runtime.btPeers) : [],
      trackers: record.btTrackers,
      webSeeds: record.btWebSeeds,
    };
  }

  async pump(): Promise<void> {
    const nextPump = this.pumpChain.catch(() => {}).then(async () => {
      const settings = await this.getSettings();
      const maxConcurrent = Math.max(1, settings.maxConcurrentTasks);

      while (this.runtimes.size < maxConcurrent) {
        const records = await this.store.list();
        // 按创建时间先后启动排队任务
        const nextQueued = [...records]
          .reverse()
          .find((r) => r.state === "queued" && !this.runtimes.has(r.id));
        if (!nextQueued) {
          break;
        }
        this.startTaskRuntime(nextQueued);
      }
    });
    this.pumpChain = nextPump;
    return nextPump;
  }

  private startTaskRuntime(record: TaskRecord): void {
    const abort = new AbortController();
    const initialState: TaskState =
      record.kind === "torrent" && record.btFiles.length === 0
        ? "fetching_metadata"
        : "downloading";

    record.state = initialState;
    record.error = null;
    const initialView = recordToView(record);

    const runtime: ActiveRuntime = {
      abort,
      promise: Promise.resolve(),
      view: initialView,
      lastPersistMs: Date.now(),
      btPeers: [],
    };
    this.runtimes.set(record.id, runtime);
    this.emit({ type: "updated", task: structuredClone(initialView) });

    const runPromise = (
      record.kind === "torrent"
        ? this.executeTorrentTask(record, runtime)
        : this.executeHttpTask(record, runtime)
    )
      .catch(async (err) => {
        await this.handleTaskFailureOrAbort(record.id, abort.signal.aborted, err);
      })
      .finally(() => {
        this.runtimes.delete(record.id);
        void this.pump();
      });

    runtime.promise = runPromise;
  }

  private async executeHttpTask(record: TaskRecord, runtime: ActiveRuntime): Promise<void> {
    const settings = await this.getSettings();
    const partKey = this.httpPartKey(record.id);

    const alreadyCompleteInPartStore =
      record.total !== null &&
      record.total > 0 &&
      record.segments.length > 0 &&
      record.segments.every((s) => s.state === "completed") &&
      (await this.partStore.exists(partKey));

    if (!alreadyCompleteInPartStore) {
      await this.hooks.onPrepareHeaders?.({
        taskId: record.id,
        url: record.url,
        referrer: settings.carryReferer ? record.referrer : null,
        headers: record.headers,
      });
    }

    try {
      if (!alreadyCompleteInPartStore) {
        const result = await runHttpDownload({
          url: record.url,
          partKey,
          partStore: this.partStore,
          connections: record.connections,
          carryCookies: settings.carryCookies,
          headers: record.headers,
          expectedSha256: record.checksumSha256,
          rateLimiter: this.rateLimiter,
          signal: runtime.abort.signal,
          resumeState:
            record.segments.length > 0
              ? {
                  etag: record.etag,
                  lastModified: record.lastModified,
                  total: record.total,
                  rangeSupported: record.rangeSupported,
                  segments: record.segments,
                }
              : undefined,
          fetchImpl: this.hooks.fetchImpl,
          onProbe: (probe) => {
            record.finalUrl = probe.finalUrl;
            record.etag = probe.etag;
            record.lastModified = probe.lastModified;
            record.rangeSupported = probe.rangeSupported;
            if (probe.total !== null) {
              record.total = probe.total;
            }
            if (!record.fileName && probe.fileName) {
              record.fileName = probe.fileName;
              record.name = probe.fileName;
            }
          },
          onProgress: (prog) => {
            record.downloaded = prog.downloaded;
            record.total = prog.total ?? record.total;
            record.rangeSupported = prog.rangeSupported;
            record.segments = prog.segments;
            runtime.view = recordToView(record, {
              speedBps: prog.speedBps,
              etaSecs: prog.etaSecs,
              segments: prog.segments,
            });
            this.emit({ type: "updated", task: structuredClone(runtime.view) });

            const now = Date.now();
            if (now - runtime.lastPersistMs >= 1000) {
              runtime.lastPersistMs = now;
              record.updatedAt = Math.floor(now / 1000);
              void this.store.put(structuredClone(record));
            }
          },
        });

        const finalName = record.fileName || result.fileName || record.name;
        record.fileName = finalName;
        record.name = finalName;
        record.total = result.total;
        record.downloaded = result.total;
        record.rangeSupported = result.rangeSupported;
        record.segments = result.segments;
      } else {
        record.downloaded =
          record.total !== null && record.total > 0 ? record.total : record.downloaded;
      }

      const finalName = record.fileName || record.name;
      record.updatedAt = Math.floor(Date.now() / 1000);
      await this.store.put(structuredClone(record));

      // 导出到操作系统下载目录
      if (this.hooks.onExportFile) {
        const blob = await this.partStore.toBlob(partKey);
        const relPath = record.saveDir
          ? `${record.saveDir}/${finalName}`
          : finalName;
        const exported = await this.hooks.onExportFile({
          taskId: record.id,
          blob,
          relativePath: relPath,
        });
        if (typeof exported === "number" || exported === null) {
          record.chromeDownloadId = exported;
        } else {
          record.chromeDownloadId = exported.downloadId;
          if (exported.savedPath) {
            record.exportedPath = exported.savedPath;
          }
        }
        await this.partStore.remove(partKey).catch(() => {});
      }

      record.state = "completed";
      record.error = null;
      record.updatedAt = Math.floor(Date.now() / 1000);
      await this.store.put(structuredClone(record));

      const completedView = recordToView(record, {
        speedBps: 0,
        etaSecs: 0,
        segments: record.segments,
      });
      runtime.view = completedView;
      this.emit({ type: "updated", task: structuredClone(completedView) });
      this.hooks.onNotifyTaskFinished?.(completedView);
    } finally {
      await this.hooks.onClearHeaders?.(record.id).catch(() => {});
    }
  }

  private async executeTorrentTask(record: TaskRecord, runtime: ActiveRuntime): Promise<void> {
    const settings = await this.getSettings();
    const partPrefix = this.btPartKeyPrefix(record.id);

    const result = await runTorrentDownload({
      sourceUrl: record.url,
      torrentBytesBase64: record.torrentBytesBase64,
      onlyFiles: record.onlyFiles,
      completedPieces: record.btCompletedPieces,
      partKeyPrefix: partPrefix,
      partStore: this.partStore,
      connections: record.connections,
      webRtcEnabled: settings.btWebRtcEnabled,
      webSeedEnabled: settings.btWebSeedEnabled,
      useNativeHelper: !settings.standaloneMode,
      customTrackers: settings.btCustomTrackers,
      rateLimiter: this.rateLimiter,
      signal: runtime.abort.signal,
      fetchImpl: this.hooks.fetchImpl,
      onEnsureNativeHelper: settings.standaloneMode
        ? undefined
        : this.hooks.onEnsureNativeHelper,
      onMetadata: (meta, files, resolvedTorrentBase64) => {
        record.name = meta.name;
        record.infoHash = meta.infoHash;
        if (resolvedTorrentBase64 && !record.torrentBytesBase64) {
          record.torrentBytesBase64 = resolvedTorrentBase64;
        }
        record.btFiles = files;
        record.btPieceLength = meta.pieceLength;
        record.btPieceCount = meta.pieceHashes.length;
        record.btTrackers = meta.trackers;
        record.btWebSeeds = meta.webSeeds;
        record.state = "downloading";
        void this.store.put(structuredClone(record));
      },
      onProgress: (prog) => {
        record.state = prog.state;
        record.name = prog.name || record.name;
        record.infoHash = prog.infoHash || record.infoHash;
        record.downloaded = prog.downloaded;
        record.total = prog.total;
        record.btFiles = prog.files;
        record.btCompletedPieces = prog.completedPieces;
        record.segments = prog.segments;
        if (prog.peerList) {
          runtime.btPeers = prog.peerList;
        }
        runtime.view = recordToView(record, {
          speedBps: prog.speedBps,
          peers: prog.peers,
          etaSecs: prog.etaSecs,
          segments: prog.segments,
        });
        this.emit({ type: "updated", task: structuredClone(runtime.view) });

        const now = Date.now();
        if (now - runtime.lastPersistMs >= 1000) {
          runtime.lastPersistMs = now;
          record.updatedAt = Math.floor(now / 1000);
          void this.store.put(structuredClone(record));
        }
      },
    });

    runtime.btPeers = result.runtimeDetails.peers;
    record.btCompletedPieces = result.completedPieces;
    record.btFiles = result.selectedFiles;
    record.total = result.totalSelectedBytes;
    record.downloaded = result.totalSelectedBytes;
    record.updatedAt = Math.floor(Date.now() / 1000);
    await this.store.put(structuredClone(record));

    // 导出选中的 BT 文件到系统下载目录
    if (this.hooks.onExportFile) {
      for (const file of result.selectedFiles) {
        if (!file.selected) continue;
        const fileKey = `${partPrefix}-file-${file.index}`;
        if (await this.partStore.exists(fileKey)) {
          const blob = await this.partStore.toBlob(fileKey);
          const relPath = record.saveDir
            ? result.meta.isMultiFile
              ? `${record.saveDir}/${result.meta.name}/${file.path}`
              : `${record.saveDir}/${file.path}`
            : result.meta.isMultiFile
              ? `${result.meta.name}/${file.path}`
              : file.path;
          const exported = await this.hooks.onExportFile({
            taskId: record.id,
            blob,
            relativePath: relPath,
          });
          if (typeof exported === "number") {
            record.chromeDownloadId = exported;
          } else if (exported && typeof exported === "object") {
            if (exported.downloadId !== null) {
              record.chromeDownloadId = exported.downloadId;
            }
            if (exported.savedPath) {
              record.exportedPath = exported.savedPath;
            }
          }
          await this.partStore.remove(fileKey).catch(() => {});
        }
      }
    }

    record.state = "completed";
    record.error = null;
    record.updatedAt = Math.floor(Date.now() / 1000);
    await this.store.put(structuredClone(record));

    const completedView = recordToView(record, {
      speedBps: 0,
      peers: 0,
      etaSecs: 0,
      segments: record.segments,
    });
    runtime.view = completedView;
    this.emit({ type: "updated", task: structuredClone(completedView) });
    this.hooks.onNotifyTaskFinished?.(completedView);
  }

  private async handleTaskFailureOrAbort(
    id: number,
    aborted: boolean,
    err: unknown,
  ): Promise<void> {
    const record = await this.store.get(id);
    if (!record) return;
    const runtime = this.runtimes.get(id);
    if (runtime) {
      record.downloaded = runtime.view.downloaded;
      record.total = runtime.view.total;
      record.segments = runtime.view.segments;
    }

    const isAbortError =
      aborted || (err instanceof DOMException && err.name === "AbortError");

    if (isAbortError) {
      record.state = "paused";
      record.error = null;
    } else {
      record.state = "failed";
      record.error = err instanceof Error ? err.message : String(err);
    }
    record.updatedAt = Math.floor(Date.now() / 1000);
    await this.store.put(structuredClone(record));

    const updatedView = recordToView(record, {
      speedBps: 0,
      peers: 0,
      etaSecs: null,
      segments: record.segments,
    });
    this.emit({ type: "updated", task: updatedView });
    if (record.state === "failed") {
      this.hooks.onNotifyTaskFinished?.(updatedView);
    }
  }

  private deduplicateName(name: string, usedLowerNames: Set<string>): string {
    if (!usedLowerNames.has(name.toLowerCase())) {
      return name;
    }
    const dotIdx = name.lastIndexOf(".");
    const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
    for (let i = 1; i <= 999; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!usedLowerNames.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  private httpPartKey(id: number): string {
    return `task-${id}.part`;
  }

  private btPartKeyPrefix(id: number): string {
    return `bt-${id}`;
  }

  private emit(event: TaskEvent): void {
    this.hooks.onEvent?.(event);
  }
}
