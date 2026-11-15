import {
  createRequestId,
  type AgentInstallState,
  type CommandType,
  type ExtensionBroadcastMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type NativeHelperStatus,
  type StateSnapshot,
} from "./protocol";
import type {
  AddTaskInput,
  Settings,
  TaskEvent,
  TaskView,
  TorrentFileInfo,
  TorrentRuntimeDetails,
} from "./types";

export async function sendExtensionCommand<TResponse = unknown, TPayload = unknown>(
  type: CommandType,
  payload?: TPayload,
  target: "background" | "offscreen" = "background",
): Promise<TResponse> {
  const message: ExtensionRequest<TPayload> = {
    channel: "tug-web-rpc",
    target,
    type,
    requestId: createRequestId(),
    payload: (payload ?? {}) as TPayload,
  };

  const response = (await chrome.runtime.sendMessage(message)) as
    | ExtensionResponse<TResponse>
    | undefined;

  if (!response) {
    throw new Error("未收到后台引擎响应，请重试");
  }
  if (!response.ok) {
    throw new Error(response.error?.message || "操作失败");
  }
  return response.data;
}

export function getStateSnapshot(): Promise<StateSnapshot> {
  return sendExtensionCommand<StateSnapshot>("get_state_snapshot");
}

export function listTasks(): Promise<TaskView[]> {
  return sendExtensionCommand<TaskView[]>("list_tasks");
}

export function addTask(input: AddTaskInput): Promise<TaskView> {
  return sendExtensionCommand<TaskView, AddTaskInput>("add_task", input);
}

export function pauseTask(id: number): Promise<TaskView> {
  return sendExtensionCommand<TaskView>("pause_task", { id });
}

export function resumeTask(id: number): Promise<TaskView> {
  return sendExtensionCommand<TaskView>("resume_task", { id });
}

export function removeTask(id: number, deleteFiles: boolean): Promise<{ id: number }> {
  return sendExtensionCommand<{ id: number }>("remove_task", { id, deleteFiles });
}

export function pauseAllTasks(): Promise<TaskView[]> {
  return sendExtensionCommand<TaskView[]>("pause_all");
}

export function resumeAllTasks(): Promise<TaskView[]> {
  return sendExtensionCommand<TaskView[]>("resume_all");
}

export function listTorrentFiles(id: number): Promise<TorrentFileInfo[]> {
  return sendExtensionCommand<TorrentFileInfo[]>("list_torrent_files", { id });
}

export function setTorrentFiles(id: number, files: number[]): Promise<TorrentFileInfo[]> {
  return sendExtensionCommand<TorrentFileInfo[]>("set_torrent_files", { id, files });
}

export function getTorrentRuntime(id: number): Promise<TorrentRuntimeDetails> {
  return sendExtensionCommand<TorrentRuntimeDetails>("torrent_runtime", { id });
}

export function getSettings(): Promise<Settings> {
  return sendExtensionCommand<Settings>("get_settings");
}

export function updateSettings(settings: Partial<Settings>): Promise<Settings> {
  return sendExtensionCommand<Settings>("update_settings", settings);
}

export async function openTaskFile(taskOrId: TaskView | number): Promise<{ opened: boolean }> {
  const id = typeof taskOrId === "number" ? taskOrId : taskOrId.id;
  const chromeDownloadId = typeof taskOrId === "object" ? taskOrId.chromeDownloadId : null;

  // 在 UI 页面点击事件中同步调用 chrome.downloads.open，保留 Chromium 所需的瞬时用户手势 (User Gesture)
  if (chromeDownloadId !== null && chromeDownloadId !== undefined && chrome?.downloads?.open) {
    let syncThrew = false;
    try {
      chrome.downloads.open(chromeDownloadId);
    } catch {
      syncThrew = true;
    }

    if (!syncThrew && chrome.downloads.search) {
      const items = await chrome.downloads.search({ id: chromeDownloadId }).catch(() => []);
      if (items[0] && items[0].exists !== false && items[0].state === "complete") {
        return { opened: true };
      }
    }
  }

  return sendExtensionCommand<{ opened: boolean }>("open_task_file", { id });
}

export async function revealTaskFile(
  taskOrId: TaskView | number,
): Promise<{ revealed: boolean }> {
  const id = typeof taskOrId === "number" ? taskOrId : taskOrId.id;
  const chromeDownloadId = typeof taskOrId === "object" ? taskOrId.chromeDownloadId : null;

  if (chromeDownloadId !== null && chromeDownloadId !== undefined && chrome?.downloads?.show) {
    let syncThrew = false;
    try {
      chrome.downloads.show(chromeDownloadId);
    } catch {
      syncThrew = true;
    }

    if (!syncThrew && chrome.downloads.search) {
      const items = await chrome.downloads.search({ id: chromeDownloadId }).catch(() => []);
      if (items[0] && items[0].exists !== false) {
        return { revealed: true };
      }
    }
  }

  return sendExtensionCommand<{ revealed: boolean }>("reveal_task_file", { id });
}

export async function openDownloadsFolder(standaloneMode = false): Promise<{ opened: boolean }> {
  if (standaloneMode && chrome?.downloads?.showDefaultFolder) {
    chrome.downloads.showDefaultFolder();
    return { opened: true };
  }
  return sendExtensionCommand<{ opened: boolean }>("open_downloads_folder");
}

export function openManagerTab(initialUrl?: string): Promise<void> {
  return sendExtensionCommand<void>("open_manager_tab", { initialUrl });
}

export function getNativeHelperStatus(): Promise<NativeHelperStatus> {
  return sendExtensionCommand<NativeHelperStatus>("get_native_helper_status");
}

export function ensureNativeHelper(allowProtocolFallback = false): Promise<NativeHelperStatus> {
  return sendExtensionCommand<NativeHelperStatus>("ensure_native_helper", {
    allowProtocolFallback,
  });
}

export function activateNativeHelperProtocol(): Promise<NativeHelperStatus> {
  return sendExtensionCommand<NativeHelperStatus>("activate_native_helper_protocol");
}

export function installNativeAgent(): Promise<AgentInstallState> {
  return sendExtensionCommand<AgentInstallState>("install_native_agent");
}

export function getAgentInstallState(): Promise<AgentInstallState> {
  return sendExtensionCommand<AgentInstallState>("get_agent_install_state");
}

export function launchDownloadedAgent(downloadId: number): Promise<AgentInstallState> {
  return sendExtensionCommand<AgentInstallState>("launch_downloaded_agent", { downloadId });
}

export function uninstallNativeAgent(): Promise<{ uninstalled: boolean }> {
  return sendExtensionCommand<{ uninstalled: boolean }>("uninstall_native_agent");
}

export function subscribeTaskEvents(handler: (event: TaskEvent) => void): () => void {
  const listener = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      (message as ExtensionBroadcastMessage).channel === "tug-web-event"
    ) {
      handler((message as ExtensionBroadcastMessage).event);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}
