import { TaskManager } from "../engine/core/manager";
import { exportBlobViaHelper } from "../engine/torrent/native-helper";
import {
  createRequestId,
  type ExportBlobPayload,
  type ExtensionBroadcastMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type NativeHelperStatus,
  type PrepareHeadersPayload,
  type StateSnapshot,
} from "../shared/protocol";
import type { AddTaskInput, Settings, TaskEvent } from "../shared/types";

function sendToBackground<TResponse = unknown, TPayload = unknown>(
  type: ExtensionRequest["type"],
  payload: TPayload,
): Promise<TResponse> {
  const req: ExtensionRequest<TPayload> = {
    channel: "tug-web-rpc",
    target: "background",
    type,
    requestId: createRequestId(),
    payload,
  };
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(req, (resp: ExtensionResponse<TResponse> | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp) {
        reject(new Error("Empty response from background"));
        return;
      }
      if (!resp.ok) {
        reject(new Error(resp.error.message));
        return;
      }
      resolve(resp.data);
    });
  });
}

function broadcastEvent(event: TaskEvent): void {
  const message: ExtensionBroadcastMessage = {
    channel: "tug-web-event",
    event,
  };
  chrome.runtime.sendMessage(message).catch(() => {
    // 没有打开 Popup/Manager 时忽略接收方不存在错误
  });
}

const manager = new TaskManager({
  hooks: {
    onEvent: (event) => {
      broadcastEvent(event);
    },
    onPrepareHeaders: async ({ taskId, url, referrer, headers }) => {
      await sendToBackground<void, PrepareHeadersPayload>("prepare_request_headers", {
        taskId,
        url,
        referrer,
        headers,
      }).catch(() => {});
    },
    onClearHeaders: async (taskId) => {
      await sendToBackground<void, { taskId: number }>("clear_request_headers", {
        taskId,
      }).catch(() => {});
    },
    onExportFile: async ({ taskId, blob, relativePath }) => {
      const settings = await manager.getSettings();
      if (!settings.standaloneMode) {
        // 优先检测是否运行中；若 Helper 因空闲超时退出但已安装，静默通过 Native Messaging 拉起，避免回退弹出浏览器 blob: 确认框
        let helperStatus = await sendToBackground<NativeHelperStatus>(
          "get_native_helper_status",
          {},
        ).catch(() => ({
          available: false,
        }));
        if (!helperStatus.available) {
          helperStatus = await sendToBackground<
            NativeHelperStatus,
            { allowProtocolFallback?: boolean }
          >("ensure_native_helper", { allowProtocolFallback: false }).catch(() => ({
            available: false,
          }));
        }
        if (helperStatus.available) {
          const savedPath = await exportBlobViaHelper(blob, relativePath);
          if (savedPath) {
            return { downloadId: null, savedPath };
          }
        }
      }

      // 2. 纯浏览器模式：使用 chrome.downloads.download 导出
      const blobUrl = URL.createObjectURL(blob);
      try {
        const result = await sendToBackground<
          { downloadId: number | null; savedPath?: string | null },
          ExportBlobPayload
        >("export_blob_to_downloads", {
          taskId,
          blobUrl,
          relativePath,
        });
        return result;
      } finally {
        setTimeout(() => {
          URL.revokeObjectURL(blobUrl);
        }, 10000);
      }
    },
    onEnsureNativeHelper: async (allowProtocolFallback) => {
      const settings = await manager.getSettings();
      if (settings.standaloneMode) {
        return false;
      }
      const status = await sendToBackground<
        NativeHelperStatus,
        { allowProtocolFallback?: boolean }
      >("ensure_native_helper", { allowProtocolFallback }).catch(() => ({
        available: false,
      }));
      return status.available;
    },
  },
});

async function handleOffscreenCommand(
  req: ExtensionRequest,
): Promise<unknown> {
  switch (req.type) {
    case "ping": {
      const info = await manager.getAppInfo();
      return {
        version: info.version,
        engineReady: true,
        activeCount: info.activeTasks,
      };
    }
    case "get_state_snapshot": {
      const [info, settings, tasks] = await Promise.all([
        manager.getAppInfo(),
        manager.getSettings(),
        manager.listTasks(),
      ]);
      const snapshot: StateSnapshot = { info, settings, tasks };
      return snapshot;
    }
    case "list_tasks":
      return manager.listTasks();
    case "add_task":
      return manager.addTask(req.payload as AddTaskInput);
    case "pause_task":
      return manager.pauseTask((req.payload as { id: number }).id);
    case "resume_task":
      return manager.resumeTask((req.payload as { id: number }).id);
    case "remove_task": {
      const p = req.payload as { id: number; deleteFiles: boolean };
      return manager.removeTask(p.id, Boolean(p.deleteFiles));
    }
    case "pause_all":
      return manager.pauseAll();
    case "resume_all":
      return manager.resumeAll();
    case "list_torrent_files":
      return manager.listTorrentFiles((req.payload as { id: number }).id);
    case "set_torrent_files": {
      const p = req.payload as { id: number; files: number[] };
      return manager.setTorrentFiles(p.id, p.files);
    }
    case "torrent_runtime":
      return manager.getTorrentRuntime((req.payload as { id: number }).id);
    case "get_settings":
      return manager.getSettings();
    case "update_settings":
      return manager.updateSettings(req.payload as Partial<Settings>);
    case "download_agent_binary": {
      const { url } = req.payload as { url: string };
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const totalBytes = Number(res.headers.get("content-length") || "0") || 0;
      const chunks: BlobPart[] = [];
      let bytesReceived = 0;
      let lastReportAt = 0;

      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const copy = new Uint8Array(value.byteLength);
            copy.set(value);
            chunks.push(copy);
            bytesReceived += value.byteLength;
            const now = Date.now();
            if (now - lastReportAt >= 120) {
              lastReportAt = now;
              void sendToBackground("report_agent_install_progress", {
                bytesReceived,
                totalBytes,
              }).catch(() => {});
            }
          }
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        chunks.push(buf);
        bytesReceived = buf.byteLength;
      }

      const finalTotal = totalBytes > 0 ? totalBytes : bytesReceived;
      void sendToBackground("report_agent_install_progress", {
        bytesReceived,
        totalBytes: finalTotal,
      }).catch(() => {});

      const blob = new Blob(chunks, { type: "application/octet-stream" });
      const blobUrl = URL.createObjectURL(blob);
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 60000);
      return { blobUrl, totalBytes: finalTotal };
    }
    default:
      throw new Error(`Unsupported offscreen command: ${req.type}`);
  }
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse): boolean | undefined => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as ExtensionRequest).channel !== "tug-web-rpc" ||
      (message as ExtensionRequest).target !== "offscreen"
    ) {
      return undefined;
    }

    const req = message as ExtensionRequest;
    handleOffscreenCommand(req)
      .then((data) => {
        const res: ExtensionResponse = {
          ok: true,
          requestId: req.requestId,
          data,
        };
        sendResponse(res);
      })
      .catch((err) => {
        const res: ExtensionResponse = {
          ok: false,
          requestId: req.requestId,
          error: {
            code: "ENGINE_ERROR",
            message: err instanceof Error ? err.message : String(err),
            retryable: true,
          },
        };
        sendResponse(res);
      });

    return true;
  },
);

void manager.ensureInitialized();
