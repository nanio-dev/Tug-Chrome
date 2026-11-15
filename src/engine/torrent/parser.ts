import { sanitizeFileName } from "../../shared/filename";
import { bytesToUtf8, decodeBencode, encodeBencode, type BencodeValue } from "./bencode";
import { ALL_DEFAULT_TRACKERS } from "./tracker-client";

export const DEFAULT_WEBTORRENT_TRACKERS = ALL_DEFAULT_TRACKERS;

export interface TorrentFileLayout {
  index: number;
  path: string;
  rawPath?: string;
  length: number;
  offset: number;
}

export interface ParsedTorrent {
  infoHash: string;
  infoHashBytes: Uint8Array;
  name: string;
  rawName?: string;
  totalLength: number;
  pieceLength: number;
  pieceHashes: string[]; // 每个元素为 40 位小写十六进制 SHA-1
  files: TorrentFileLayout[];
  trackers: string[];
  webSeeds: string[];
  isMultiFile: boolean;
}

export interface ParsedMagnet {
  infoHash: string;
  infoHashBytes: Uint8Array;
  name: string;
  trackers: string[];
  webSeeds: string[];
  exactSources: string[];
  exactLength: number | null;
}

export async function computeSha1Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return new Uint8Array(digest);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * RFC 4648 Base32 解码（用于 32 字符磁力链接 btih 转换为 20 字节哈希）。
 */
export function base32ToBytes(base32: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = base32.trim().toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${cleaned[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function asString(val: BencodeValue | undefined): string | null {
  if (val instanceof Uint8Array) {
    return bytesToUtf8(val);
  }
  return null;
}

function asStringList(val: BencodeValue | undefined): string[] {
  if (!val) return [];
  if (val instanceof Uint8Array) {
    const s = bytesToUtf8(val).trim();
    return s ? [s] : [];
  }
  if (Array.isArray(val)) {
    const out: string[] = [];
    for (const item of val) {
      out.push(...asStringList(item));
    }
    return out;
  }
  return [];
}

/**
 * 解析 .torrent 二进制字节流。
 */
export async function parseTorrentBuffer(buffer: Uint8Array): Promise<ParsedTorrent> {
  const decoded = decodeBencode(buffer, 0, true);
  if (
    !decoded.value ||
    typeof decoded.value !== "object" ||
    Array.isArray(decoded.value) ||
    decoded.value instanceof Uint8Array
  ) {
    throw new Error("无效的 .torrent 文件：根节点不是字典");
  }

  const root = decoded.value as Record<string, BencodeValue>;
  const infoVal = root["info"];
  if (
    !infoVal ||
    typeof infoVal !== "object" ||
    Array.isArray(infoVal) ||
    infoVal instanceof Uint8Array
  ) {
    throw new Error("无效的 .torrent 文件：缺少 info 字典");
  }

  const infoDict = infoVal as Record<string, BencodeValue>;
  const rawInfo = decoded.rawInfoSlice ?? encodeBencode(infoDict);
  const infoHashBytes = await computeSha1Bytes(rawInfo);
  const infoHash = bytesToHex(infoHashBytes);

  const rawName =
    asString(infoDict["name.utf-8"]) ?? asString(infoDict["name"]) ?? `torrent-${infoHash.slice(0, 8)}`;
  const name = sanitizeFileName(rawName, "torrent");

  const pieceLength = Number(infoDict["piece length"] ?? 0);
  if (!Number.isInteger(pieceLength) || pieceLength <= 0) {
    throw new Error("无效的 .torrent 文件：piece length 非法");
  }

  const piecesBytes = infoDict["pieces"];
  if (!(piecesBytes instanceof Uint8Array) || piecesBytes.byteLength % 20 !== 0) {
    throw new Error("无效的 .torrent 文件：pieces SHA-1 列表长度非法");
  }

  const pieceCount = piecesBytes.byteLength / 20;
  const pieceHashes: string[] = [];
  for (let i = 0; i < pieceCount; i++) {
    pieceHashes.push(bytesToHex(piecesBytes.subarray(i * 20, (i + 1) * 20)));
  }

  const files: TorrentFileLayout[] = [];
  let totalLength = 0;
  let isMultiFile = false;

  if (Array.isArray(infoDict["files"])) {
    isMultiFile = true;
    const rawFiles = infoDict["files"] as BencodeValue[];
    let offset = 0;
    rawFiles.forEach((entry, idx) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry instanceof Uint8Array) {
        return;
      }
      const fDict = entry as Record<string, BencodeValue>;
      const len = Number(fDict["length"] ?? 0);
      const rawSegments = asStringList(fDict["path.utf-8"] ?? fDict["path"])
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
      const pathParts = rawSegments
        .map((seg) => sanitizeFileName(seg, "part"))
        .filter(Boolean);
      const relPath = pathParts.length > 0 ? pathParts.join("/") : `file-${idx}`;
      const rawRelPath = rawSegments.length > 0 ? rawSegments.join("/") : relPath;
      files.push({
        index: files.length,
        path: relPath,
        rawPath: rawRelPath,
        length: Math.max(0, len),
        offset,
      });
      offset += Math.max(0, len);
    });
    totalLength = offset;
  } else {
    const singleLen = Number(infoDict["length"] ?? 0);
    totalLength = Math.max(0, singleLen);
    files.push({
      index: 0,
      path: name,
      rawPath: rawName,
      length: totalLength,
      offset: 0,
    });
  }

  const trackersSet = new Set<string>();
  for (const t of asStringList(root["announce"])) {
    trackersSet.add(t);
  }
  for (const t of asStringList(root["announce-list"])) {
    trackersSet.add(t);
  }

  const webSeedsSet = new Set<string>();
  const wsCandidates = [
    ...asStringList(root["url-list"]),
    ...asStringList(root["httpseeds"]),
    ...asStringList(root["ws"]),
    ...asStringList(infoDict["url-list"]),
    ...asStringList(infoDict["ws"]),
  ];
  for (const ws of wsCandidates) {
    if (ws.startsWith("http://") || ws.startsWith("https://")) {
      webSeedsSet.add(ws);
    }
  }

  return {
    infoHash,
    infoHashBytes,
    name,
    rawName,
    totalLength,
    pieceLength,
    pieceHashes,
    files,
    trackers: Array.from(trackersSet),
    webSeeds: Array.from(webSeedsSet),
    isMultiFile,
  };
}

/**
 * 解析 magnet:?xt=urn:btih:... 磁力链接，并自动补全默认 WebSocket Trackers。
 */
export function parseMagnetUri(uri: string, extraTrackers: string[] = []): ParsedMagnet {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith("magnet:?")) {
    throw new Error("不是合法的 magnet: 链接");
  }

  const query = trimmed.slice(trimmed.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const xts = params.getAll("xt");
  let btihRaw: string | null = null;

  for (const xt of xts) {
    const m = xt.match(/^urn:btih:([a-zA-Z0-9]+)$/i);
    if (m) {
      btihRaw = m[1];
      break;
    }
  }

  if (!btihRaw) {
    throw new Error("磁力链接缺少 xt=urn:btih: 参数");
  }

  let infoHashBytes: Uint8Array;
  if (btihRaw.length === 40 && /^[0-9a-fA-F]{40}$/.test(btihRaw)) {
    infoHashBytes = hexToBytes(btihRaw);
  } else if (btihRaw.length === 32) {
    infoHashBytes = base32ToBytes(btihRaw);
    if (infoHashBytes.byteLength !== 20) {
      throw new Error("磁力链接 Base32 InfoHash 长度非法");
    }
  } else {
    throw new Error(`磁力链接 InfoHash 长度非法 (${btihRaw.length})`);
  }

  const infoHash = bytesToHex(infoHashBytes);
  const dn = params.get("dn");
  const name = dn && dn.trim() ? sanitizeFileName(dn.trim(), `magnet-${infoHash.slice(0, 8)}`) : `magnet-${infoHash.slice(0, 8)}`;

  const trackers = Array.from(
    new Set([
      ...params.getAll("tr").map((t) => t.trim()).filter(Boolean),
      ...extraTrackers,
      ...DEFAULT_WEBTORRENT_TRACKERS,
    ]),
  );

  const webSeeds = Array.from(
    new Set(
      [...params.getAll("ws"), ...params.getAll("as")]
        .map((u) => u.trim())
        .filter((u) => u.startsWith("http://") || u.startsWith("https://")),
    ),
  );

  const exactSources = Array.from(
    new Set(
      params
        .getAll("xs")
        .map((u) => u.trim())
        .filter((u) => u.startsWith("http://") || u.startsWith("https://")),
    ),
  );

  const xlParam = params.get("xl");
  const xlNum = xlParam ? Number(xlParam) : NaN;
  const exactLength = Number.isFinite(xlNum) && xlNum > 0 ? xlNum : null;

  return {
    infoHash,
    infoHashBytes,
    name,
    trackers,
    webSeeds,
    exactSources,
    exactLength,
  };
}

export function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
