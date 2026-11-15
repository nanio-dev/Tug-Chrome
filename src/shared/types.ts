import { SUPPORTED_LOCALES, type ResolvedLocale } from "./i18n/locales";

export type TaskState =
  | "queued"
  | "fetching_metadata"
  | "downloading"
  | "verifying"
  | "exporting"
  | "paused"
  | "seeding"
  | "completed"
  | "failed";

export type TaskKind = "http" | "torrent";

export function isActiveTaskState(state: TaskState): boolean {
  return state === "queued" || state === "fetching_metadata" || state === "downloading"
    || state === "verifying" || state === "exporting";
}

export interface SegmentView {
  index: number;
  start: number;
  current: number;
  end: number;
  state: "pending" | "downloading" | "completed";
}

export interface TaskView {
  id: number;
  kind: TaskKind;
  /** Number of selected output files; null/undefined means torrent metadata is unknown. */
  selectedFileCount?: number | null;
  name: string;
  url: string;
  state: TaskState;
  total: number | null;
  downloaded: number;
  uploaded: number;
  speedBps: number;
  uploadSpeedBps: number;
  peers: number;
  etaSecs: number | null;
  error: string | null;
  saveDir: string;
  fileName: string | null;
  path: string;
  createdAt: number;
  connections: number;
  rangeSupported: boolean;
  segments: SegmentView[];
  chromeDownloadId: number | null;
  referrer: string | null;
  infoHash: string | null;
}

export function canOpenTaskFile(task: Pick<TaskView, "kind" | "selectedFileCount">): boolean {
  return task.kind === "http" || task.selectedFileCount === 1;
}

export interface Settings {
  /** 子目录名（纯插件模式相对于浏览器下载目录，Agent 模式相对于系统下载目录，例如 "Tug"，留空直接存根目录） */
  downloadSubdir: string;
  /** 单任务连接数 (1–32) */
  connectionsPerTask: number;
  /** 最大同时下载任务数 (1–16) */
  maxConcurrentTasks: number;
  /** 全局下载限速 (KiB/s)，null 表示不限速 */
  globalDownloadLimitKib: number | null;
  /** 是否自动接管浏览器新下载 */
  autoInterceptDownloads: boolean;
  /** 自动接管的最小文件体积阈值 (MiB)，0 表示不限大小 */
  minInterceptSizeMib: number;
  /** 是否在页面内自动拦截 magnet: 链接点击 */
  interceptMagnetLinks: boolean;
  /** 是否自动接管 .torrent 种子文件下载 */
  interceptTorrentFiles: boolean;
  /** 不自动接管的域名列表 */
  excludedDomains: string[];
  /** 不自动接管的文件扩展名列表（不含点） */
  excludedExtensions: string[];
  /** 请求时是否携带浏览器同源登录态 Cookie */
  carryCookies: boolean;
  /** 请求时是否附加来源页面 Referer */
  carryReferer: boolean;
  /** 下载完成/失败时是否发送系统通知 */
  notifyOnComplete: boolean;
  /** 纯插件模式：开启后完全在浏览器沙箱内独立运行，不再探测、唤醒或调用本地 Tug Agent (tug-agent) 服务 */
  standaloneMode: boolean;
  /** 主题 */
  theme: "system" | "light" | "dark";
  /** 界面语言 */
  locale: "system" | ResolvedLocale;
  /** BT: 是否启用 WebRTC (WebTorrent) P2P 节点连接 */
  btWebRtcEnabled: boolean;
  /** BT: 是否启用 HTTP/HTTPS WebSeed (BEP 19) 多连接混合加速 */
  btWebSeedEnabled: boolean;
  /** BT: 自定义 WebSocket / HTTP Tracker 列表 */
  btCustomTrackers: string[];
}

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  storageEngine: string;
  downloadSubdir: string;
  activeTasks: number;
}

export interface AddTaskInput {
  url: string;
  fileName?: string | null;
  connections?: number | null;
  onlyFiles?: number[] | null;
  referrer?: string | null;
  headers?: Array<[string, string]> | null;
  checksumSha256?: string | null;
  /** Base64 编码的 .torrent 文件内容（用于本地选择种子或拖拽上传） */
  torrentBytesBase64?: string | null;
}

export interface TorrentFileInfo {
  index: number;
  path: string;
  length: number;
  selected: boolean;
}

export interface TorrentPeerInfo {
  address: string;
  transport: "webrtc" | "webseed" | "tracker";
  state: string;
  client: string | null;
  downloaded: number;
  uploaded: number;
}

export interface TorrentRuntimeDetails {
  infoHash: string;
  pieceLength: number;
  pieceCount: number;
  completedPieces: number;
  peers: TorrentPeerInfo[];
  trackers: string[];
  webSeeds: string[];
}

export type TaskEvent =
  | { type: "updated"; task: TaskView }
  | { type: "removed"; id: number }
  | { type: "settings"; settings: Settings };

export const DEFAULT_SETTINGS: Settings = {
  downloadSubdir: "",
  connectionsPerTask: 8,
  maxConcurrentTasks: 3,
  globalDownloadLimitKib: null,
  autoInterceptDownloads: true,
  minInterceptSizeMib: 1,
  interceptMagnetLinks: true,
  interceptTorrentFiles: true,
  excludedDomains: ["localhost", "127.0.0.1"],
  excludedExtensions: ["html", "htm", "crx", "ics"],
  carryCookies: true,
  carryReferer: true,
  notifyOnComplete: true,
  standaloneMode: false,
  theme: "system",
  locale: "system",
  btWebRtcEnabled: true,
  btWebSeedEnabled: true,
  btCustomTrackers: [
    // WebTorrent (WebRTC over WSS) 公共 Tracker
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.webtorrent.dev",
    "wss://tracker.btorrent.xyz",
    "wss://tracker.files.fm:7073/announce",
    "wss://spacetradersapi-chatbox.herokuapp.com:443/announce",
    "wss://tracker.novage.com.ua:443/announce",
    "wss://tracker.sloppyta.co:443/announce",
    "wss://peertube.cpy.re:443/tracker/socket",
    // HTTPS / HTTP 公共 Tracker（对齐 Tug-Android TrackerClient）
    "https://tracker.opentrackr.org:443/announce",
    "https://tracker.tamersunion.org:443/announce",
    "https://tracker.renfei.net:443/announce",
    "https://tracker.gbitt.info:443/announce",
    "https://tracker.lilithraws.org:443/announce",
    "https://tracker.moeblog.cn:443/announce",
    "https://tracker.zhuqiy.com:443/announce",
    "https://tracker.pmman.tech:443/announce",
    "https://tr.burnabyhighstar.com:443/announce",
    "http://tracker.opentrackr.org:1337/announce",
    "http://tracker.openbittorrent.com:80/announce",
    "http://open.acgnxtracker.com:80/announce",
    "http://tracker.bt4g.com:2095/announce",
    // Tug (crates/tug-torrent) & Tug-Android 默认公共 UDP Tracker
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
  ],
};

export function normalizeSettings(input: Partial<Settings>): Settings {
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...input,
  };
  merged.downloadSubdir = (merged.downloadSubdir ?? "")
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .replace(/[<>:"|?*]/g, "_");
  merged.connectionsPerTask = Math.max(
    1,
    Math.min(32, Math.round(Number(merged.connectionsPerTask) || 8)),
  );
  merged.maxConcurrentTasks = Math.max(
    1,
    Math.min(16, Math.round(Number(merged.maxConcurrentTasks) || 3)),
  );
  if (
    merged.globalDownloadLimitKib !== null &&
    (Number.isNaN(Number(merged.globalDownloadLimitKib)) ||
      Number(merged.globalDownloadLimitKib) <= 0)
  ) {
    merged.globalDownloadLimitKib = null;
  } else if (merged.globalDownloadLimitKib !== null) {
    merged.globalDownloadLimitKib = Math.round(Number(merged.globalDownloadLimitKib));
  }
  merged.minInterceptSizeMib = Math.max(
    0,
    Math.min(10240, Number(merged.minInterceptSizeMib) || 0),
  );
  merged.standaloneMode = Boolean(merged.standaloneMode);
  if (!["system", "light", "dark"].includes(merged.theme)) {
    merged.theme = "system";
  }
  if (merged.locale !== "system" && !SUPPORTED_LOCALES.includes(merged.locale)) {
    merged.locale = "system";
  }
  merged.excludedDomains = Array.from(
    new Set(
      (merged.excludedDomains ?? [])
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  merged.excludedExtensions = Array.from(
    new Set(
      (merged.excludedExtensions ?? [])
        .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean),
    ),
  );
  const rawTrackers = input.btCustomTrackers ?? DEFAULT_SETTINGS.btCustomTrackers;
  merged.btCustomTrackers = Array.from(
    new Set(
      rawTrackers
        .map((t) => t.trim())
        .filter(
          (t) =>
            t.startsWith("wss://") ||
            t.startsWith("ws://") ||
            t.startsWith("http://") ||
            t.startsWith("https://") ||
            t.startsWith("udp://"),
        ),
    ),
  );
  return merged;
}
