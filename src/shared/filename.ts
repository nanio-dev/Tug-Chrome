import type { Settings } from "./types";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * 清洗文件名，防止路径穿越、非法字符或 Windows 保留设备名。
 */
export function sanitizeFileName(raw: string, fallback = "download"): string {
  // 取最后一段路径组件，防止 ../ 或子目录注入
  const base = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "." && part !== "..")
    .pop() ?? "";

  let cleaned = base
    // 过滤控制字符与 Windows 非法字符 <>:"/\|?*
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_")
    // 合并多余空白
    .replace(/\s+/g, " ")
    // 去掉首尾空格和尾部的点
    .trim()
    .replace(/\.+$/, "")
    .trim();

  if (!cleaned) {
    return fallback;
  }

  // 检查 Windows 保留名（如 CON, NUL, COM1.txt）
  const dotIndex = cleaned.indexOf(".");
  const stem = (dotIndex === -1 ? cleaned : cleaned.slice(0, dotIndex)).toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(stem)) {
    cleaned = `_${cleaned}`;
  }

  // 限制最大长度（保留扩展名）
  if (cleaned.length > 200) {
    const extMatch = cleaned.match(/(\.[a-zA-Z0-9]{1,12})$/);
    if (extMatch) {
      const ext = extMatch[1];
      cleaned = cleaned.slice(0, 200 - ext.length) + ext;
    } else {
      cleaned = cleaned.slice(0, 200);
    }
  }

  return cleaned || fallback;
}

/**
 * 解析 HTTP Content-Disposition 头中的文件名（支持 RFC 5987 filename* 与常规 filename）。
 */
export function parseContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;

  // 1. 优先匹配 filename*=UTF-8''...
  const rfc5987Match = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (rfc5987Match) {
    const rawValue = rfc5987Match[2].trim().replace(/^"(.*)"$/, "$1");
    try {
      const decoded = decodeURIComponent(rawValue);
      if (decoded.trim()) {
        return sanitizeFileName(decoded.trim());
      }
    } catch {
      if (rawValue.trim()) {
        return sanitizeFileName(rawValue.trim());
      }
    }
  }

  // 2. 匹配带引号的 filename="..."
  const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch && quotedMatch[1].trim()) {
    try {
      return sanitizeFileName(decodeURIComponent(quotedMatch[1].trim()));
    } catch {
      return sanitizeFileName(quotedMatch[1].trim());
    }
  }

  // 3. 匹配不带引号的 filename=...
  const bareMatch = header.match(/filename\s*=\s*([^;\s]+)/i);
  if (bareMatch && bareMatch[1].trim()) {
    try {
      return sanitizeFileName(decodeURIComponent(bareMatch[1].trim()));
    } catch {
      return sanitizeFileName(bareMatch[1].trim());
    }
  }

  return null;
}

/**
 * 从 URL 或磁力链接推断文件名。
 */
export function guessFileNameFromUrl(source: string): string {
  const trimmed = source.trim();
  if (trimmed.toLowerCase().startsWith("magnet:")) {
    const query = trimmed.slice(trimmed.indexOf("?") + 1);
    const params = new URLSearchParams(query);
    const dn = params.get("dn");
    if (dn && dn.trim()) {
      return sanitizeFileName(dn.trim(), "magnet");
    }
    const xt = params.get("xt") ?? "";
    const hashMatch = xt.match(/urn:btih:([a-zA-Z0-9]+)/i);
    if (hashMatch) {
      return `magnet-${hashMatch[1].slice(0, 12).toLowerCase()}`;
    }
    return "magnet";
  }

  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.pop();
    if (last) {
      try {
        return sanitizeFileName(decodeURIComponent(last), "download");
      } catch {
        return sanitizeFileName(last, "download");
      }
    }
    return sanitizeFileName(parsed.hostname || "download");
  } catch {
    return "download";
  }
}

/**
 * 判断输入源是否为 BT 种子或磁力。
 */
export function isTorrentSource(source: string, torrentBytesBase64?: string | null): boolean {
  if (torrentBytesBase64 && torrentBytesBase64.length > 0) {
    return true;
  }
  const trimmed = source.trim();
  if (trimmed.toLowerCase().startsWith("magnet:?")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.pathname.toLowerCase().endsWith(".torrent");
    }
  } catch {
    // 非 URL
  }
  return false;
}

/**
 * 从自由文本中提取第一个可用的下载候选链接。
 */
export function extractDownloadCandidate(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}/i.test(line)) {
      return line;
    }
    if (/^https?:\/\/\S+/i.test(line)) {
      return line;
    }
  }
  return null;
}

export interface DownloadInterceptCandidate {
  url: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  totalBytes?: number;
  byExtensionId?: string;
}

/**
 * 判断浏览器下载项是否应当由 Tug Web 接管。
 */
export function shouldInterceptBrowserDownload(
  item: DownloadInterceptCandidate,
  settings: Settings,
  selfExtensionId?: string,
): { intercept: boolean; reason: string } {
  if (!settings.autoInterceptDownloads) {
    return { intercept: false, reason: "auto_intercept_disabled" };
  }

  if (selfExtensionId && item.byExtensionId === selfExtensionId) {
    return { intercept: false, reason: "initiated_by_self" };
  }

  const targetUrl = (item.finalUrl || item.url || "").trim();
  if (!targetUrl) {
    return { intercept: false, reason: "empty_url" };
  }

  const lowerUrl = targetUrl.toLowerCase();
  if (
    lowerUrl.startsWith("blob:") ||
    lowerUrl.startsWith("data:") ||
    lowerUrl.startsWith("chrome-extension:") ||
    lowerUrl.startsWith("edge-extension:") ||
    lowerUrl.startsWith("filesystem:") ||
    lowerUrl.startsWith("about:") ||
    lowerUrl.startsWith(" file:")
  ) {
    return { intercept: false, reason: "non_network_scheme" };
  }

  if (lowerUrl.startsWith("magnet:?")) {
    return settings.interceptMagnetLinks
      ? { intercept: true, reason: "magnet_link" }
      : { intercept: false, reason: "magnet_disabled" };
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { intercept: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { intercept: false, reason: "unsupported_protocol" };
  }

  const host = parsed.hostname.toLowerCase();
  for (const excluded of settings.excludedDomains) {
    const rule = excluded.toLowerCase().trim();
    if (!rule) continue;
    if (host === rule || host.endsWith(`.${rule}`)) {
      return { intercept: false, reason: `excluded_domain:${rule}` };
    }
  }

  const guessedName = item.filename
    ? sanitizeFileName(item.filename)
    : guessFileNameFromUrl(targetUrl);
  const extMatch = guessedName.toLowerCase().match(/\.([a-z0-9]{1,12})$/);
  const ext = extMatch ? extMatch[1] : "";

  const isTorrent =
    ext === "torrent" ||
    item.mime === "application/x-bittorrent" ||
    parsed.pathname.toLowerCase().endsWith(".torrent");

  if (isTorrent) {
    return settings.interceptTorrentFiles
      ? { intercept: true, reason: "torrent_file" }
      : { intercept: false, reason: "torrent_disabled" };
  }

  if (ext && settings.excludedExtensions.includes(ext)) {
    return { intercept: false, reason: `excluded_extension:${ext}` };
  }

  const minBytes = settings.minInterceptSizeMib * 1024 * 1024;
  if (
    minBytes > 0 &&
    typeof item.totalBytes === "number" &&
    item.totalBytes > 0 &&
    item.totalBytes < minBytes
  ) {
    return { intercept: false, reason: "below_min_size" };
  }

  return { intercept: true, reason: "matched" };
}
