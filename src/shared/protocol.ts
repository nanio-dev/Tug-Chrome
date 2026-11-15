import type {
  AddTaskInput,
  AppInfo,
  Settings,
  TaskEvent,
  TaskView,
  TorrentFileInfo,
  TorrentRuntimeDetails,
} from "./types";

export type CommandType =
  | "ping"
  | "get_state_snapshot"
  | "list_tasks"
  | "add_task"
  | "pause_task"
  | "resume_task"
  | "remove_task"
  | "pause_all"
  | "resume_all"
  | "list_torrent_files"
  | "set_torrent_files"
  | "torrent_runtime"
  | "get_settings"
  | "update_settings"
  | "open_task_file"
  | "reveal_task_file"
  | "open_downloads_folder"
  | "open_manager_tab"
  | "handle_torrent_url"
  | "prepare_request_headers"
  | "clear_request_headers"
  | "export_blob_to_downloads"
  | "cancel_task_export"
  | "get_native_helper_status"
  | "ensure_native_helper"
  | "activate_native_helper_protocol"
  | "install_native_agent"
  | "get_agent_install_state"
  | "export_downloaded_agent"
  | "launch_downloaded_agent"
  | "reset_agent_install_state"
  | "uninstall_native_agent"
  | "download_agent_binary"
  | "report_agent_install_progress"
  | "get_diagnostic_logs"
  | "clear_diagnostic_logs";

export type AgentInstallPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "confirming_save"
  | "launching"
  | "waiting_ready"
  | "need_manual_launch"
  | "need_pairing"
  | "ready"
  | "error";

export interface AgentInstallState {
  phase: AgentInstallPhase;
  bytesReceived: number;
  totalBytes: number;
  downloadId: number | null;
  message?: string;
}

export interface NativeHelperStatus {
  available: boolean;
  installed?: boolean;
  standaloneMode?: boolean;
  version?: string;
  port?: number;
  activeSessions?: number;
  protocolVersion?: number;
  updateRequired?: boolean;
  pairingRequired?: boolean;
  nativeError?: string;
}

export interface ExtensionRequest<T = unknown> {
  channel: "tug-web-rpc";
  target: "background" | "offscreen";
  type: CommandType;
  requestId: string;
  payload: T;
}

export interface RpcError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ExtensionResponse<T = unknown> =
  | {
      ok: true;
      requestId: string;
      data: T;
    }
  | {
      ok: false;
      requestId: string;
      error: RpcError;
    };

export interface ExtensionBroadcastMessage {
  channel: "tug-web-event";
  event: TaskEvent;
}

export interface StateSnapshot {
  info: AppInfo;
  settings: Settings;
  tasks: TaskView[];
}

export interface PrepareHeadersPayload {
  taskId: number;
  url: string;
  referrer?: string | null;
  headers?: Array<[string, string]> | null;
}

export interface ExportBlobPayload {
  exportId: string;
  taskId: number;
  blobUrl: string;
  relativePath: string;
}

let reqCounter = 0;

export function createRequestId(): string {
  reqCounter += 1;
  return `req-${Date.now()}-${reqCounter}`;
}
