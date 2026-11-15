import type { TorrentPeerInfo } from "../../shared/types";
import { bytesToUtf8, decodeBencode, type BencodeValue } from "./bencode";

/**
 * 汇总自 Tug (crates/tug-torrent) 与 Tug-Android (TorrentDownloadEngine / TrackerClient)
 * 以及公共 WebTorrent / BitTorrent Tracker 列表：
 * 1. WSS/WS Trackers：用于浏览器 WebRTC DataChannel 节点发现与 SDP 交换；
 * 2. HTTPS/HTTP Trackers：用于 HTTP GET Announce 发现做种统计与对等节点（同 Tug-Android TrackerClient）；
 * 3. UDP Trackers：与 Tug / Tug-Android 保持一致，供种子元数据与外部诊断共享。
 */
export const DEFAULT_WSS_TRACKERS: string[] = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.files.fm:7073/announce",
  "wss://spacetradersapi-chatbox.herokuapp.com:443/announce",
  "wss://tracker.novage.com.ua:443/announce",
  "wss://tracker.sloppyta.co:443/announce",
  "wss://peertube.cpy.re:443/tracker/socket",
];

export const DEFAULT_HTTP_TRACKERS: string[] = [
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
];

export const DEFAULT_UDP_TRACKERS: string[] = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
];

export const ALL_DEFAULT_TRACKERS: string[] = Array.from(
  new Set([
    ...DEFAULT_WSS_TRACKERS,
    ...DEFAULT_HTTP_TRACKERS,
    ...DEFAULT_UDP_TRACKERS,
  ]),
);

export interface HttpTrackerAnnounceResult {
  peers: TorrentPeerInfo[];
  webSeeds: string[];
  complete: number;
  incomplete: number;
}

/**
 * 将 20 字节二进制数据（info_hash 或 peer_id）编码为 BitTorrent HTTP Tracker 规范要求的 URL Percent-Encoding。
 * 逻辑对齐 Tug-Android `TrackerClient.percentEncode`。
 */
export function percentEncodeBinary(bytes: Uint8Array): string {
  const hexChars = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const v = bytes[i] & 0xff;
    const isAlnum =
      (v >= 0x30 && v <= 0x39) || // 0-9
      (v >= 0x41 && v <= 0x5a) || // A-Z
      (v >= 0x61 && v <= 0x7a); // a-z
    if (isAlnum || v === 0x2d || v === 0x5f || v === 0x2e || v === 0x7e) {
      out += String.fromCharCode(v);
    } else {
      out += "%" + hexChars[v >>> 4] + hexChars[v & 0x0f];
    }
  }
  return out;
}

export function generatePeerIdBytes(prefix = "-TW0100-"): Uint8Array {
  const out = new Uint8Array(20);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 8; i++) {
    out[i] = prefix.charCodeAt(i) & 0xff;
  }
  const rand = new Uint8Array(12);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 12; i++) {
    out[8 + i] = alphabet.charCodeAt(rand[i] % alphabet.length);
  }
  return out;
}

function parseCompactIpv4Peers(compact: Uint8Array, trackerUrl: string): TorrentPeerInfo[] {
  const peers: TorrentPeerInfo[] = [];
  for (let i = 0; i + 6 <= compact.byteLength; i += 6) {
    const ip = `${compact[i]}.${compact[i + 1]}.${compact[i + 2]}.${compact[i + 3]}`;
    const port = (compact[i + 4] << 8) | compact[i + 5];
    if (port > 0 && ip !== "0.0.0.0") {
      peers.push({
        address: `${ip}:${port}`,
        transport: "tracker",
        state: "discovered",
        client: `Tracker (${ safeTrackerHost(trackerUrl) })`,
        downloaded: 0,
        uploaded: 0,
      });
    }
  }
  return peers;
}

function parseCompactIpv6Peers(compact: Uint8Array, trackerUrl: string): TorrentPeerInfo[] {
  const peers: TorrentPeerInfo[] = [];
  for (let i = 0; i + 18 <= compact.byteLength; i += 18) {
    const groups: string[] = [];
    for (let g = 0; g < 16; g += 2) {
      const val = (compact[i + g] << 8) | compact[i + g + 1];
      groups.push(val.toString(16));
    }
    const port = (compact[i + 16] << 8) | compact[i + 17];
    if (port > 0) {
      peers.push({
        address: `[${groups.join(":")}]:${port}`,
        transport: "tracker",
        state: "discovered",
        client: `Tracker6 (${safeTrackerHost(trackerUrl)})`,
        downloaded: 0,
        uploaded: 0,
      });
    }
  }
  return peers;
}

function safeTrackerHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "HTTP Tracker";
  }
}

/**
 * 向单个 HTTP / HTTPS BitTorrent Tracker 发起标准 GET Announce 请求（移植自 Tug-Android TrackerClient.kt）。
 */
export async function announceHttpTracker(
  trackerUrl: string,
  infoHashBytes: Uint8Array,
  peerIdBytes: Uint8Array,
  leftBytes: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpTrackerAnnounceResult> {
  const sep = trackerUrl.includes("?") ? "&" : "?";
  const query =
    `info_hash=${percentEncodeBinary(infoHashBytes)}` +
    `&peer_id=${percentEncodeBinary(peerIdBytes)}` +
    `&port=6881&uploaded=0&downloaded=0` +
    `&left=${Math.max(0, Math.floor(leftBytes))}` +
    `&compact=1&numwant=200&event=started`;

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), 6000);
  const onParentAbort = () => timeoutCtrl.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });

  try {
    const resp = await fetchImpl(`${trackerUrl}${sep}${query}`, {
      method: "GET",
      signal: timeoutCtrl.signal,
    });
    if (!resp.ok) {
      return { peers: [], webSeeds: [], complete: 0, incomplete: 0 };
    }
    const body = new Uint8Array(await resp.arrayBuffer());
    const decoded = decodeBencode(body, 0, false);
    if (
      !decoded.value ||
      typeof decoded.value !== "object" ||
      Array.isArray(decoded.value) ||
      decoded.value instanceof Uint8Array
    ) {
      return { peers: [], webSeeds: [], complete: 0, incomplete: 0 };
    }
    const root = decoded.value as Record<string, BencodeValue>;
    if (root["failure reason"] instanceof Uint8Array) {
      return { peers: [], webSeeds: [], complete: 0, incomplete: 0 };
    }

    const complete = typeof root["complete"] === "number" ? root["complete"] : 0;
    const incomplete = typeof root["incomplete"] === "number" ? root["incomplete"] : 0;
    const peers: TorrentPeerInfo[] = [];

    if (root["peers"] instanceof Uint8Array) {
      peers.push(...parseCompactIpv4Peers(root["peers"], trackerUrl));
    } else if (Array.isArray(root["peers"])) {
      for (const item of root["peers"]) {
        if (item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Uint8Array)) {
          const d = item as Record<string, BencodeValue>;
          const ip = d["ip"] instanceof Uint8Array ? bytesToUtf8(d["ip"]) : "";
          const port = typeof d["port"] === "number" ? d["port"] : 0;
          if (ip && port > 0) {
            peers.push({
              address: `${ip}:${port}`,
              transport: "tracker",
              state: "discovered",
              client: `Tracker (${safeTrackerHost(trackerUrl)})`,
              downloaded: 0,
              uploaded: 0,
            });
          }
        }
      }
    }

    if (root["peers6"] instanceof Uint8Array) {
      peers.push(...parseCompactIpv6Peers(root["peers6"], trackerUrl));
    }

    const webSeeds: string[] = [];
    const wsRaw = root["url-list"] ?? root["httpseeds"];
    if (wsRaw instanceof Uint8Array) {
      const u = bytesToUtf8(wsRaw).trim();
      if (u.startsWith("http://") || u.startsWith("https://")) webSeeds.push(u);
    } else if (Array.isArray(wsRaw)) {
      for (const entry of wsRaw) {
        if (entry instanceof Uint8Array) {
          const u = bytesToUtf8(entry).trim();
          if (u.startsWith("http://") || u.startsWith("https://")) webSeeds.push(u);
        }
      }
    }

    return { peers, webSeeds, complete, incomplete };
  } catch {
    return { peers: [], webSeeds: [], complete: 0, incomplete: 0 };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * 并发向多个 HTTP/HTTPS Trackers 发起 Announce，返回去重后的节点列表与 WebSeeds。
 */
export async function announceAllHttpTrackers(
  trackers: string[],
  infoHashBytes: Uint8Array,
  leftBytes: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpTrackerAnnounceResult> {
  const httpTrackers = Array.from(
    new Set(
      trackers
        .map((t) => t.trim())
        .filter((t) => t.startsWith("https://") || t.startsWith("http://")),
    ),
  ).slice(0, 14);

  if (httpTrackers.length === 0) {
    return { peers: [], webSeeds: [], complete: 0, incomplete: 0 };
  }

  const peerId = generatePeerIdBytes("-TW0100-");
  const results = await Promise.all(
    httpTrackers.map((tr) =>
      announceHttpTracker(tr, infoHashBytes, peerId, leftBytes, signal, fetchImpl),
    ),
  );

  const peerMap = new Map<string, TorrentPeerInfo>();
  const webSeedSet = new Set<string>();
  let maxComplete = 0;
  let maxIncomplete = 0;

  for (const r of results) {
    if (r.complete > maxComplete) maxComplete = r.complete;
    if (r.incomplete > maxIncomplete) maxIncomplete = r.incomplete;
    for (const ws of r.webSeeds) {
      webSeedSet.add(ws);
    }
    for (const p of r.peers) {
      if (!peerMap.has(p.address) && peerMap.size < 60) {
        peerMap.set(p.address, p);
      }
    }
  }

  return {
    peers: Array.from(peerMap.values()),
    webSeeds: Array.from(webSeedSet),
    complete: maxComplete,
    incomplete: maxIncomplete,
  };
}
