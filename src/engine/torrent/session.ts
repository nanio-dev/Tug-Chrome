import type {
  SegmentView,
  TorrentFileInfo,
  TorrentPeerInfo,
  TorrentRuntimeDetails,
} from "../../shared/types";
import type { RateLimiter } from "../http/rate-limiter";
import type { PartStorageBackend } from "../storage/part-store";
import { bytesToUtf8, decodeBencode, encodeBencode, utf8ToBytes, type BencodeValue } from "./bencode";
import {
  checkHelperHealth,
  helperRequestHeaders,
  getHelperSessionPeers,
  startHelperTorrentSession,
  stopHelperTorrentSession,
} from "./native-helper";
import {
  base64ToUint8Array,
  bytesToHex,
  computeSha1Bytes,
  DEFAULT_WEBTORRENT_TRACKERS,
  parseMagnetUri,
  parseTorrentBuffer,
  uint8ArrayToBase64,
  type ParsedTorrent,
} from "./parser";
import { announceAllHttpTrackers } from "./tracker-client";

const BT_BLOCK_LENGTH = 16384; // 16 KiB 标准 BitTorrent Wire Block 大小
const MAX_INFLIGHT_BLOCKS_PER_PEER = 64; // 每个 WebRTC 节点允许最多 64 个并发块 (1 MiB 窗口)，消除跨洋高 RTT 吞吐瓶颈
const WEBSEED_BATCH_TARGET_BYTES = 4 * 1024 * 1024; // WebSeed 每次聚合拉取连续 4 MiB 分片流，消除逐个 64KiB Piece 请求的 RTT 开销
const PROGRESS_THROTTLE_MS = 120;
class TorrentStorageError extends Error {}

const PUBLIC_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

export interface TorrentProgressUpdate {
  name: string;
  infoHash: string;
  state: "fetching_metadata" | "downloading";
  downloaded: number;
  committedBytes: number;
  total: number | null;
  speedBps: number;
  peers: number;
  etaSecs: number | null;
  files: TorrentFileInfo[];
  completedPieces: number[];
  pieceLength: number;
  pieceCount: number;
  segments: SegmentView[];
  peerList?: TorrentPeerInfo[];
}

export interface TorrentDownloadOptions {
  sourceUrl: string;
  torrentBytesBase64?: string | null;
  onlyFiles?: number[] | null;
  completedPieces?: number[];
  partKeyPrefix: string;
  partStore: PartStorageBackend;
  connections: number;
  webRtcEnabled: boolean;
  webSeedEnabled: boolean;
  useNativeHelper?: boolean;
  customTrackers: string[];
  rateLimiter?: RateLimiter;
  signal: AbortSignal;
  onMetadata?: (
    meta: ParsedTorrent,
    files: TorrentFileInfo[],
    torrentBytesBase64?: string | null,
  ) => void;
  onProgress?: (update: TorrentProgressUpdate) => void;
  onEnsureNativeHelper?: (allowProtocolFallback?: boolean) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

export interface TorrentDownloadResult {
  meta: ParsedTorrent;
  selectedFiles: TorrentFileInfo[];
  completedPieces: number[];
  totalSelectedBytes: number;
  runtimeDetails: TorrentRuntimeDetails;
}

/**
 * 计算某个分片 [pieceStart, pieceEnd) 在全局字节流中的范围。
 */
export function getPieceByteRange(
  meta: ParsedTorrent,
  pieceIndex: number,
): { start: number; end: number; length: number } {
  const start = pieceIndex * meta.pieceLength;
  const end = Math.min(meta.totalLength, start + meta.pieceLength);
  return { start, end, length: Math.max(0, end - start) };
}

/**
 * 将 BitTorrent 分片集合聚合为最多 32 个可视化区段，避免数千个子像素分段互相遮盖。
 */
export function buildBucketedTorrentSegments(
  meta: ParsedTorrent,
  requiredPieces: number[],
  completedSet: ReadonlySet<number>,
  inFlightSet: ReadonlySet<number> = new Set<number>(),
  maxBuckets = 32,
): SegmentView[] {
  if (requiredPieces.length === 0) return [];

  if (requiredPieces.length <= maxBuckets) {
    let cursor = 0;
    return requiredPieces.map((pIdx, idx) => {
      const range = getPieceByteRange(meta, pIdx);
      const start = cursor;
      const end = start + range.length;
      cursor = end;
      const done = completedSet.has(pIdx);
      return {
        index: idx,
        start,
        current: done ? end : start,
        end,
        state: done ? "completed" : inFlightSet.has(pIdx) ? "downloading" : "pending",
      };
    });
  }

  // 预计算每个 requiredPiece 在选中总字节区间中的起始位置，兼顾单文件与多文件选择性下载
  const cumulativeEnds: number[] = [];
  let totalCursor = 0;
  for (const pIdx of requiredPieces) {
    totalCursor += getPieceByteRange(meta, pIdx).length;
    cumulativeEnds.push(totalCursor);
  }

  const buckets: SegmentView[] = [];
  for (let b = 0; b < maxBuckets; b++) {
    const startIdx = Math.floor((b * requiredPieces.length) / maxBuckets);
    const endIdx = Math.floor(((b + 1) * requiredPieces.length) / maxBuckets) - 1;
    if (startIdx > endIdx) continue;

    const segStart = startIdx === 0 ? 0 : cumulativeEnds[startIdx - 1];
    const segEnd = cumulativeEnds[endIdx];
    let doneBytes = 0;
    let allDone = true;
    let anyActive = false;

    for (let i = startIdx; i <= endIdx; i++) {
      const pIdx = requiredPieces[i];
      const pRange = getPieceByteRange(meta, pIdx);
      if (completedSet.has(pIdx)) {
        doneBytes += pRange.length;
      } else {
        allDone = false;
        if (inFlightSet.has(pIdx)) {
          anyActive = true;
        }
      }
    }

    buckets.push({
      index: buckets.length,
      start: segStart,
      current: Math.min(segEnd, segStart + doneBytes),
      end: segEnd,
      state: allDone ? "completed" : doneBytes > 0 || anyActive ? "downloading" : "pending",
    });
  }

  return buckets;
}

/**
 * 计算选中的文件集合需要下载哪些分片索引。
 */
export function computeRequiredPiecesForFiles(
  meta: ParsedTorrent,
  selectedFileIndices: Set<number>,
): number[] {
  if (meta.totalLength === 0 || meta.pieceHashes.length === 0) {
    return [];
  }
  const required = new Set<number>();
  for (const file of meta.files) {
    if (!selectedFileIndices.has(file.index) || file.length <= 0) {
      continue;
    }
    const firstPiece = Math.floor(file.offset / meta.pieceLength);
    const lastPiece = Math.floor((file.offset + file.length - 1) / meta.pieceLength);
    for (let p = firstPiece; p <= lastPiece && p < meta.pieceHashes.length; p++) {
      required.add(p);
    }
  }
  return Array.from(required).sort((a, b) => a - b);
}

/**
 * 构建任意全局字节区间 [rangeGlobalStart, rangeGlobalEnd) 的 HTTP WebSeed 请求列表（遵循 BEP 19 单文件与多文件规范）。
 */
export function buildWebSeedSliceRequests(
  webSeedBase: string,
  meta: ParsedTorrent,
  rangeGlobalStart: number,
  rangeGlobalEnd: number,
): Array<{ url: string; rangeStart: number; rangeEnd: number; length: number }> {
  const trimmedSeed = webSeedBase.trim();
  const rootRawName = meta.rawName || meta.name;

  if (!meta.isMultiFile) {
    const singleUrl = trimmedSeed.endsWith("/")
      ? `${trimmedSeed}${encodeURIComponent(rootRawName)}`
      : trimmedSeed;
    return [
      {
        url: singleUrl,
        rangeStart: rangeGlobalStart,
        rangeEnd: rangeGlobalEnd - 1,
        length: rangeGlobalEnd - rangeGlobalStart,
      },
    ];
  }

  const baseWithSlash = trimmedSeed.endsWith("/") ? trimmedSeed : `${trimmedSeed}/`;
  const slices: Array<{ url: string; rangeStart: number; rangeEnd: number; length: number }> = [];
  for (const file of meta.files) {
    const fileStart = file.offset;
    const fileEnd = file.offset + file.length;
    const overlapStart = Math.max(rangeGlobalStart, fileStart);
    const overlapEnd = Math.min(rangeGlobalEnd, fileEnd);
    if (overlapStart < overlapEnd) {
      const fileRel = file.rawPath || file.path;
      const encodedRel = [rootRawName, ...fileRel.split("/")]
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      slices.push({
        url: `${baseWithSlash}${encodedRel}`,
        rangeStart: overlapStart - fileStart,
        rangeEnd: overlapEnd - fileStart - 1,
        length: overlapEnd - overlapStart,
      });
    }
  }
  return slices;
}

function concatUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * 等待 ICE 候选收集：一旦拿到公网 srflx 候选或收集完成立即放行，避免无谓阻塞。
 */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 650): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let srflxTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (srflxTimer) clearTimeout(srflxTimer);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };
    const onCandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (!ev.candidate) {
        finish();
        return;
      }
      if (ev.candidate.candidate && ev.candidate.candidate.includes(" typ srflx ") && !srflxTimer) {
        srflxTimer = setTimeout(finish, 120);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);
  });
}

interface PeerSessionState {
  peerKey: string;
  dc: RTCDataChannel;
  info: TorrentPeerInfo;
  handshakeReceived: boolean;
  peerChoking: boolean;
  havePieces: Set<number>;
  hasAllPieces: boolean;
  inflightBlocks: Set<string>; // `${pieceIndex}:${begin}`
  rxBuffer: Uint8Array;
  utMetadataId: number;
  metadataSize: number;
  metadataPieces: Map<number, Uint8Array>;
}

interface ActivePieceAssembler {
  pieceIndex: number;
  pieceLength: number;
  totalBlocks: number;
  buffer: Uint8Array;
  receivedBlocks: Set<number>;
  requestedBlocks: Map<number, { peerKey: string; requestedAt: number }>;
  waiters: Array<(data: Uint8Array | null) => void>;
}

/**
 * 完整实现 BEP 3 Peer Wire + BEP 9 (ut_metadata) + BEP 10 Extension Protocol 的 WebTorrent (WebRTC) 协调器。
 */
class BrowserWebTorrentSwarm {
  private readonly infoHashHex: string;
  private readonly infoHashBinary: string;
  private readonly peerIdBinary: string;
  private readonly trackers: string[];
  private readonly sockets = new Map<string, WebSocket>();
  private readonly offerMaps = new Map<string, Map<string, RTCPeerConnection>>();
  private readonly peerConnections = new Set<RTCPeerConnection>();
  private readonly peers = new Map<string, PeerSessionState>();
  private readonly activeAssemblers = new Map<number, ActivePieceAssembler>();
  private metadataResolvers: Array<(meta: ParsedTorrent) => void> = [];
  private peerConnectWaiters: Array<() => void> = [];
  private resolvedMeta: ParsedTorrent | null = null;
  private reannounceTimer: ReturnType<typeof setInterval> | null = null;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(infoHashBytes: Uint8Array, trackers: string[], initialMeta: ParsedTorrent | null) {
    this.infoHashHex = bytesToHex(infoHashBytes);
    this.infoHashBinary = Array.from(infoHashBytes)
      .map((b) => String.fromCharCode(b))
      .join("");
    const randBytes = new Uint8Array(12);
    crypto.getRandomValues(randBytes);
    this.peerIdBinary =
      "-WW0210-" +
      Array.from(randBytes)
        .map((b) => String.fromCharCode(b))
        .join("");
    this.trackers = Array.from(
      new Set(
        trackers
          .map((t) => t.trim())
          .filter((t) => t.startsWith("wss://") || t.startsWith("ws://")),
      ),
    );
    this.resolvedMeta = initialMeta;
  }

  getPeersSnapshot(): TorrentPeerInfo[] {
    return Array.from(this.peers.values()).map((p) => ({ ...p.info }));
  }

  hasConnectedPeers(): boolean {
    return this.peers.size > 0;
  }

  start(signal: AbortSignal): void {
    if (typeof WebSocket === "undefined" || typeof RTCPeerConnection === "undefined") {
      return;
    }
    signal.addEventListener("abort", () => this.close(), { once: true });

    for (const trackerUrl of this.trackers.slice(0, 12)) {
      this.connectTracker(trackerUrl).catch(() => {});
    }

    // 定期向所有 WSS Tracker 补充发送新的 WebRTC Offers 以发现更多做种节点
    this.reannounceTimer = setInterval(() => {
      if (this.disposed) return;
      if (this.peers.size >= 30) return;
      for (const trackerUrl of this.trackers.slice(0, 12)) {
        const ws = this.sockets.get(trackerUrl);
        if (ws && ws.readyState === WebSocket.OPEN) {
          this.sendOffersToOpenTracker(ws, trackerUrl, 6).catch(() => {});
        } else if (!ws || ws.readyState === WebSocket.CLOSED) {
          this.connectTracker(trackerUrl).catch(() => {});
        }
      }
    }, 8000);

    this.pumpTimer = setInterval(() => {
      if (this.disposed) return;
      this.pumpAllPieceRequests();
    }, 250);
  }

  waitForFirstPeer(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (this.peers.size > 0) {
      return Promise.resolve(true);
    }
    if (typeof WebSocket === "undefined" || typeof RTCPeerConnection === "undefined") {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const timer = setTimeout(() => done(this.peers.size > 0), timeoutMs);
      const onAbort = () => done(false);
      signal.addEventListener("abort", onAbort, { once: true });
      this.peerConnectWaiters.push(() => done(true));
    });
  }

  waitForMetadata(timeoutMs: number, signal: AbortSignal): Promise<ParsedTorrent | null> {
    if (this.resolvedMeta) {
      return Promise.resolve(this.resolvedMeta);
    }
    if (typeof WebSocket === "undefined" || typeof RTCPeerConnection === "undefined") {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(this.resolvedMeta);
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.metadataResolvers.push((meta) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(meta);
      });
    });
  }

  requestPieceFromSwarm(
    pieceIndex: number,
    pieceByteLength: number,
    timeoutMs = 15000,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    if (this.disposed || pieceByteLength <= 0) {
      return Promise.resolve(null);
    }

    let assembler = this.activeAssemblers.get(pieceIndex);
    if (!assembler) {
      const totalBlocks = Math.max(1, Math.ceil(pieceByteLength / BT_BLOCK_LENGTH));
      assembler = {
        pieceIndex,
        pieceLength: pieceByteLength,
        totalBlocks,
        buffer: new Uint8Array(pieceByteLength),
        receivedBlocks: new Set<number>(),
        requestedBlocks: new Map(),
        waiters: [],
      };
      this.activeAssemblers.set(pieceIndex, assembler);
    }

    return new Promise<Uint8Array | null>((resolve) => {
      let settled = false;
      const finish = (data: Uint8Array | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(data);
      };
      const timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);
      const onAbort = () => finish(null);
      signal?.addEventListener("abort", onAbort, { once: true });

      assembler!.waiters.push(finish);
      this.pumpPieceRequests(assembler!);
    });
  }

  private async generateOffers(
    trackerUrl: string,
    count: number,
  ): Promise<
    Array<{
      offer_id: string;
      offer: RTCSessionDescriptionInit;
      pc: RTCPeerConnection;
    }>
  > {
    const tasks = Array.from({ length: count }, async () => {
      const pc = new RTCPeerConnection({ iceServers: PUBLIC_ICE_SERVERS });
      this.peerConnections.add(pc);
      const offerBytes = new Uint8Array(20);
      crypto.getRandomValues(offerBytes);
      const offerId = Array.from(offerBytes)
        .map((b) => String.fromCharCode(b))
        .join("");

      const dc = pc.createDataChannel("webrtc-datachannel");
      dc.binaryType = "arraybuffer";
      this.setupDataChannel(dc, trackerUrl);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 650);

      if (!pc.localDescription) return null;
      return {
        offer_id: offerId,
        offer: { type: "offer" as const, sdp: pc.localDescription.sdp },
        pc,
      };
    });

    const results = await Promise.all(tasks);
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  }

  private async sendOffersToOpenTracker(
    ws: WebSocket,
    trackerUrl: string,
    offerCount: number,
  ): Promise<void> {
    const offers = await this.generateOffers(trackerUrl, offerCount);
    let offerMap = this.offerMaps.get(trackerUrl);
    if (!offerMap) {
      offerMap = new Map();
      this.offerMaps.set(trackerUrl, offerMap);
    }
    for (const o of offers) {
      offerMap.set(o.offer_id, o.pc);
    }
    if (!this.disposed && ws.readyState === WebSocket.OPEN && offers.length > 0) {
      ws.send(
        JSON.stringify({
          action: "announce",
          info_hash: this.infoHashBinary,
          peer_id: this.peerIdBinary,
          numwant: offers.length,
          uploaded: 0,
          downloaded: 0,
          left: this.resolvedMeta?.totalLength ?? 16384,
          offers: offers.map((o) => ({ offer_id: o.offer_id, offer: o.offer })),
        }),
      );
    }
  }

  private async connectTracker(trackerUrl: string): Promise<void> {
    if (this.disposed) return;

    const offerMap = new Map<string, RTCPeerConnection>();
    this.offerMaps.set(trackerUrl, offerMap);
    // 每个 Tracker 首次并发生成 10 个 WebRTC Offer，提升发现做种节点数量
    const offersPromise = this.generateOffers(trackerUrl, 10);

    const ws = new WebSocket(trackerUrl);
    this.sockets.set(trackerUrl, ws);

    ws.onopen = async () => {
      if (this.disposed) return;
      const offers = await offersPromise;
      for (const o of offers) {
        offerMap.set(o.offer_id, o.pc);
      }
      if (this.disposed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          action: "announce",
          info_hash: this.infoHashBinary,
          peer_id: this.peerIdBinary,
          numwant: offers.length,
          uploaded: 0,
          downloaded: 0,
          left: this.resolvedMeta?.totalLength ?? 16384,
          offers: offers.map((o) => ({ offer_id: o.offer_id, offer: o.offer })),
        }),
      );
    };

    ws.onmessage = async (ev) => {
      if (this.disposed || typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.answer && msg.offer_id) {
          const pc = offerMap.get(msg.offer_id);
          if (pc && pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(msg.answer);
          }
        } else if (msg.offer && msg.offer_id && msg.peer_id) {
          const pc = new RTCPeerConnection({ iceServers: PUBLIC_ICE_SERVERS });
          this.peerConnections.add(pc);
          pc.ondatachannel = (dce) => {
            dce.channel.binaryType = "arraybuffer";
            this.setupDataChannel(dce.channel, trackerUrl);
          };
          await pc.setRemoteDescription(msg.offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await waitForIceGathering(pc, 650);
          if (pc.localDescription && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                action: "announce",
                info_hash: this.infoHashBinary,
                peer_id: this.peerIdBinary,
                to_peer_id: msg.peer_id,
                offer_id: msg.offer_id,
                answer: { type: "answer", sdp: pc.localDescription.sdp },
              }),
            );
          }
        }
      } catch {
        // 忽略格式异常的 tracker 消息
      }
    };
  }

  private sendWireMessage(dc: RTCDataChannel, msgId: number, payload?: Uint8Array): void {
    if (dc.readyState !== "open") return;
    const payloadLen = payload ? payload.byteLength : 0;
    const frame = new Uint8Array(4 + 1 + payloadLen);
    new DataView(frame.buffer).setUint32(0, 1 + payloadLen, false);
    frame[4] = msgId;
    if (payload && payloadLen > 0) {
      frame.set(payload, 5);
    }
    try {
      dc.send(frame);
    } catch {
      // 忽略关闭中的通道异常
    }
  }

  private sendBlockRequest(
    peer: PeerSessionState,
    pieceIndex: number,
    begin: number,
    length: number,
  ): void {
    const payload = new Uint8Array(12);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, pieceIndex, false);
    dv.setUint32(4, begin, false);
    dv.setUint32(8, length, false);
    this.sendWireMessage(peer.dc, 6, payload); // msgId = 6 (request)
  }

  private pumpAllPieceRequests(): void {
    for (const assembler of this.activeAssemblers.values()) {
      this.pumpPieceRequests(assembler);
    }
  }

  private pumpPieceRequests(assembler: ActivePieceAssembler): void {
    if (this.peers.size === 0) return;
    const now = Date.now();

    // 清理超过 4 秒未响应的挂起块请求以便重发给其他可用节点
    for (const [blockIdx, reqInfo] of assembler.requestedBlocks.entries()) {
      if (now - reqInfo.requestedAt >= 4000 || !this.peers.has(reqInfo.peerKey)) {
        assembler.requestedBlocks.delete(blockIdx);
        const oldPeer = this.peers.get(reqInfo.peerKey);
        oldPeer?.inflightBlocks.delete(`${assembler.pieceIndex}:${blockIdx * BT_BLOCK_LENGTH}`);
      }
    }

    const candidatePeers = Array.from(this.peers.values()).filter(
      (p) =>
        p.dc.readyState === "open" &&
        p.inflightBlocks.size < MAX_INFLIGHT_BLOCKS_PER_PEER &&
        (p.hasAllPieces ||
          p.havePieces.size === 0 ||
          p.havePieces.has(assembler.pieceIndex)),
    );

    if (candidatePeers.length === 0) return;

    // 优先使用已 unchoke 我们的节点且当前 inflight 较少的节点
    candidatePeers.sort((a, b) => {
      if (a.peerChoking !== b.peerChoking) {
        return Number(a.peerChoking) - Number(b.peerChoking);
      }
      return a.inflightBlocks.size - b.inflightBlocks.size;
    });

    let peerCursor = 0;
    for (let blockIdx = 0; blockIdx < assembler.totalBlocks; blockIdx++) {
      if (assembler.receivedBlocks.has(blockIdx) || assembler.requestedBlocks.has(blockIdx)) {
        continue;
      }

      // 寻找一个未满载的节点（若某个节点满载则跳过继续寻找下一个节点，绝不提前 break）
      let chosenPeer: PeerSessionState | null = null;
      for (let tries = 0; tries < candidatePeers.length; tries++) {
        const candidate = candidatePeers[(peerCursor + tries) % candidatePeers.length];
        if (candidate && candidate.inflightBlocks.size < MAX_INFLIGHT_BLOCKS_PER_PEER) {
          chosenPeer = candidate;
          peerCursor = peerCursor + tries + 1;
          break;
        }
      }

      if (!chosenPeer) {
        break;
      }

      const begin = blockIdx * BT_BLOCK_LENGTH;
      const length = Math.min(BT_BLOCK_LENGTH, assembler.pieceLength - begin);
      const inflightKey = `${assembler.pieceIndex}:${begin}`;
      chosenPeer.inflightBlocks.add(inflightKey);
      assembler.requestedBlocks.set(blockIdx, { peerKey: chosenPeer.peerKey, requestedAt: now });
      this.sendBlockRequest(chosenPeer, assembler.pieceIndex, begin, length);
    }
  }

  private handleIncomingPieceBlock(
    peer: PeerSessionState,
    pieceIndex: number,
    begin: number,
    block: Uint8Array,
  ): void {
    peer.inflightBlocks.delete(`${pieceIndex}:${begin}`);
    const assembler = this.activeAssemblers.get(pieceIndex);
    if (!assembler) return;

    if (begin < 0 || begin + block.byteLength > assembler.pieceLength) {
      return;
    }

    assembler.buffer.set(block, begin);
    const blockIdx = Math.floor(begin / BT_BLOCK_LENGTH);
    assembler.receivedBlocks.add(blockIdx);
    assembler.requestedBlocks.delete(blockIdx);

    if (assembler.receivedBlocks.size >= assembler.totalBlocks) {
      this.activeAssemblers.delete(pieceIndex);
      const completedBuffer = assembler.buffer;
      for (const waiter of assembler.waiters.splice(0)) {
        waiter(completedBuffer);
      }
      this.pumpAllPieceRequests();
    } else {
      this.pumpPieceRequests(assembler);
    }
  }

  private setupDataChannel(dc: RTCDataChannel, trackerUrl: string): void {
    const peerKey = `webrtc:${trackerUrl}#${Math.random().toString(36).slice(2, 7)}`;

    const state: PeerSessionState = {
      peerKey,
      dc,
      info: {
        address: peerKey,
        transport: "webrtc",
        state: "connected",
        client: "WebTorrent Peer",
        downloaded: 0,
        uploaded: 0,
      },
      handshakeReceived: false,
      peerChoking: true,
      havePieces: new Set<number>(),
      hasAllPieces: false,
      inflightBlocks: new Set<string>(),
      rxBuffer: new Uint8Array(0),
      utMetadataId: 0,
      metadataSize: 0,
      metadataPieces: new Map<number, Uint8Array>(),
    };

    dc.onopen = () => {
      if (this.disposed) return;
      this.peers.set(peerKey, state);
      for (const w of this.peerConnectWaiters.splice(0)) {
        w();
      }

      // 1. 发送 BitTorrent 68 字节握手包（启用 BEP 10 扩展协议位 reserved[5] |= 0x10）
      const handshake = new Uint8Array(68);
      handshake[0] = 19;
      handshake.set(utf8ToBytes("BitTorrent protocol"), 1);
      handshake[25] = 0x10; // BEP 10 Extension Protocol
      for (let i = 0; i < 20; i++) {
        handshake[28 + i] = this.infoHashBinary.charCodeAt(i) & 0xff;
        handshake[48 + i] = this.peerIdBinary.charCodeAt(i) & 0xff;
      }
      dc.send(handshake);

      // 2. 发送 BEP 10 扩展握手（声明支持 ut_metadata = 1）
      const extDict = encodeBencode({ m: { ut_metadata: 1 }, v: "Tug Web 1.0" });
      const extPayload = new Uint8Array(1 + extDict.byteLength);
      extPayload[0] = 0; // extended handshake id = 0
      extPayload.set(extDict, 1);
      this.sendWireMessage(dc, 20, extPayload);

      // 3. 立即发送 interested (id = 2) 与 unchoke (id = 1)
      this.sendWireMessage(dc, 2);
      this.sendWireMessage(dc, 1);
      this.pumpAllPieceRequests();
    };

    dc.onclose = () => {
      this.peers.delete(peerKey);
    };

    dc.onmessage = async (ev) => {
      if (this.disposed) return;
      let incoming: Uint8Array;
      if (ev.data instanceof ArrayBuffer) {
        incoming = new Uint8Array(ev.data);
      } else if (ev.data instanceof Blob) {
        incoming = new Uint8Array(await ev.data.arrayBuffer());
      } else {
        return;
      }

      state.rxBuffer = concatUint8Arrays(state.rxBuffer, incoming);

      // Step 1: 解析 68 字节 BitTorrent 协议握手头
      if (!state.handshakeReceived) {
        if (state.rxBuffer.byteLength < 68) {
          return;
        }
        if (
          state.rxBuffer[0] === 19 &&
          bytesToUtf8(state.rxBuffer.subarray(1, 20)) === "BitTorrent protocol"
        ) {
          const peerIdAscii = bytesToUtf8(state.rxBuffer.subarray(48, 68));
          if (peerIdAscii.startsWith("-WW")) {
            state.info.client = "WebTorrent";
          } else if (peerIdAscii.startsWith("-qB")) {
            state.info.client = "qBittorrent";
          } else if (peerIdAscii.startsWith("-TR")) {
            state.info.client = "Transmission";
          } else if (peerIdAscii.startsWith("-TW")) {
            state.info.client = "Tug Web";
          }
          state.rxBuffer = state.rxBuffer.subarray(68);
          state.handshakeReceived = true;
          this.sendWireMessage(dc, 2); // interested
        } else {
          state.handshakeReceived = true;
        }
      }

      // Step 2: 循环消费以 4 字节大端长度开头的 BitTorrent Peer Wire 消息
      while (state.rxBuffer.byteLength >= 4) {
        const view = new DataView(
          state.rxBuffer.buffer,
          state.rxBuffer.byteOffset,
          state.rxBuffer.byteLength,
        );
        const msgLen = view.getUint32(0, false);
        if (msgLen === 0) {
          state.rxBuffer = state.rxBuffer.subarray(4);
          continue;
        }
        if (msgLen > 16 * 1024 * 1024) {
          dc.close();
          return;
        }
        if (state.rxBuffer.byteLength < 4 + msgLen) {
          break;
        }

        const msgId = state.rxBuffer[4];
        const body = state.rxBuffer.subarray(5, 4 + msgLen);
        state.rxBuffer = state.rxBuffer.subarray(4 + msgLen);

        await this.handlePeerWireMessage(state, msgId, body);
      }
    };
  }

  private async handlePeerWireMessage(
    peer: PeerSessionState,
    msgId: number,
    body: Uint8Array,
  ): Promise<void> {
    switch (msgId) {
      case 0: // choke
        peer.peerChoking = true;
        break;
      case 1: // unchoke
        peer.peerChoking = false;
        this.pumpAllPieceRequests();
        break;
      case 2: // interested
        this.sendWireMessage(peer.dc, 1); // unchoke
        break;
      case 4: { // have
        if (body.byteLength >= 4) {
          const pieceIdx = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
            0,
            false,
          );
          peer.havePieces.add(pieceIdx);
          if (peer.peerChoking) {
            this.sendWireMessage(peer.dc, 2); // interested
          }
          this.pumpAllPieceRequests();
        }
        break;
      }
      case 5: { // bitfield
        for (let i = 0; i < body.byteLength; i++) {
          const byte = body[i];
          for (let bit = 0; bit < 8; bit++) {
            if ((byte & (1 << (7 - bit))) !== 0) {
              peer.havePieces.add(i * 8 + bit);
            }
          }
        }
        this.sendWireMessage(peer.dc, 2); // interested
        this.pumpAllPieceRequests();
        break;
      }
      case 7: { // piece: [index: 4][begin: 4][block...]
        if (body.byteLength > 8) {
          const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
          const pieceIdx = dv.getUint32(0, false);
          const begin = dv.getUint32(4, false);
          const block = body.subarray(8);
          peer.info.downloaded += block.byteLength;
          this.handleIncomingPieceBlock(peer, pieceIdx, begin, block);
        }
        break;
      }
      case 14: // have_all (BEP 6 Fast Extension)
        peer.hasAllPieces = true;
        this.sendWireMessage(peer.dc, 2);
        this.pumpAllPieceRequests();
        break;
      case 20: { // extended (BEP 10)
        if (body.byteLength < 1) break;
        const extId = body[0];
        const extBody = body.subarray(1);
        if (extId === 0) {
          try {
            const parsed = decodeBencode(extBody, 0, false);
            const dict = parsed.value as Record<string, BencodeValue>;
            const m = dict["m"] as Record<string, BencodeValue> | undefined;
            if (m && typeof m["ut_metadata"] === "number") {
              peer.utMetadataId = m["ut_metadata"];
            }
            if (typeof dict["metadata_size"] === "number") {
              peer.metadataSize = dict["metadata_size"];
            }
            if (dict["v"] instanceof Uint8Array) {
              const clientVer = bytesToUtf8(dict["v"]).trim();
              if (clientVer) peer.info.client = clientVer;
            }
            if (
              !this.resolvedMeta &&
              peer.utMetadataId > 0 &&
              peer.metadataSize > 0 &&
              peer.metadataSize <= 8 * 1024 * 1024
            ) {
              const totalMetaPieces = Math.ceil(peer.metadataSize / BT_BLOCK_LENGTH);
              for (let p = 0; p < totalMetaPieces; p++) {
                const reqDict = encodeBencode({ msg_type: 0, piece: p });
                const extPayload = new Uint8Array(1 + reqDict.byteLength);
                extPayload[0] = peer.utMetadataId;
                extPayload.set(reqDict, 1);
                this.sendWireMessage(peer.dc, 20, extPayload);
              }
            }
          } catch {
            // 忽略
          }
        } else if (extId === 1 && !this.resolvedMeta && peer.metadataSize > 0) {
          try {
            const headerRes = decodeBencode(extBody, 0, false);
            const header = headerRes.value as Record<string, BencodeValue>;
            if (header["msg_type"] === 1 && typeof header["piece"] === "number") {
              const pieceIdx = header["piece"];
              const pieceSlice = extBody.subarray(headerRes.nextOffset);
              peer.metadataPieces.set(pieceIdx, pieceSlice);
              const totalMetaPieces = Math.ceil(peer.metadataSize / BT_BLOCK_LENGTH);
              if (peer.metadataPieces.size >= totalMetaPieces) {
                const fullInfo = new Uint8Array(peer.metadataSize);
                let pos = 0;
                for (let i = 0; i < totalMetaPieces; i++) {
                  const part = peer.metadataPieces.get(i);
                  if (!part) return;
                  fullInfo.set(
                    part.subarray(0, Math.min(part.byteLength, peer.metadataSize - pos)),
                    pos,
                  );
                  pos += part.byteLength;
                }
                const hashCheck = bytesToHex(await computeSha1Bytes(fullInfo));
                if (hashCheck === this.infoHashHex) {
                  const decodedInfo = decodeBencode(fullInfo, 0, false).value;
                  const syntheticTorrent = encodeBencode({ info: decodedInfo });
                  const meta = await parseTorrentBuffer(syntheticTorrent);
                  this.resolvedMeta = meta;
                  for (const resolver of this.metadataResolvers.splice(0)) {
                    resolver(meta);
                  }
                }
              }
            }
          } catch {
            // 忽略
          }
        }
        break;
      }
      default:
        break;
    }
  }

  close(): void {
    this.disposed = true;
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    this.offerMaps.clear();
    for (const pc of this.peerConnections) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    this.peerConnections.clear();
    this.peers.clear();
    for (const assembler of this.activeAssemblers.values()) {
      for (const w of assembler.waiters.splice(0)) {
        w(null);
      }
    }
    this.activeAssemblers.clear();
  }
}

/**
 * 执行 BitTorrent / 磁力任务下载：
 * 1. 支持 .torrent 二进制、.torrent HTTP URL、magnet:? 链接（含 xs= 种子源与 WebRTC ut_metadata）；
 * 2. 支持文件选择 (onlyFiles)；
 * 3. 支持 HTTP/HTTPS WebSeed (BEP 19) 4MiB 连续多连接批量流式拉取 + WebRTC P2P 节点 64-block 流水线交换；
 * 4. 支持向 HTTP/HTTPS Trackers 发起 Announce（对齐 Tug-Android TrackerClient）；
 * 5. 对每个 Piece 执行严格的 SHA-1 哈希校验，并将完成的文件写入 PartStorageBackend。
 */
export async function runTorrentDownload(
  options: TorrentDownloadOptions,
): Promise<TorrentDownloadResult> {
  options.signal.throwIfAborted();
  const group = new AbortController();
  const onAbort = () => group.abort(options.signal.reason);
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await runTorrentSession({ ...options, signal: group.signal }, group);
  } finally {
    group.abort();
    options.signal.removeEventListener("abort", onAbort);
  }
}

async function runTorrentSession(options: TorrentDownloadOptions, group: AbortController): Promise<TorrentDownloadResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const canUseNativeHelper =
    options.useNativeHelper !== false && Boolean(options.onEnsureNativeHelper);
  let meta: ParsedTorrent | null = null;
  let swarm: BrowserWebTorrentSwarm | null = null;
  let resolvedTorrentBase64: string | null = options.torrentBytesBase64 ?? null;
  let helperSessionId: string | null = null;
  let helperWebSeedUrl: string | null = null;
  let helperPollTimer: ReturnType<typeof setInterval> | null = null;
  const helperPeers: TorrentPeerInfo[] = [];
  let helperDownloadSpeedBps = 0;
  const extraWebSeeds: string[] = [];
  const extraTrackers: string[] = [...options.customTrackers, ...DEFAULT_WEBTORRENT_TRACKERS];

  // 1. 解析或获取种子元数据
  if (options.torrentBytesBase64 && options.torrentBytesBase64.length > 0) {
    const rawBytes = base64ToUint8Array(options.torrentBytesBase64);
    meta = await parseTorrentBuffer(rawBytes);
  } else if (options.sourceUrl.trim().toLowerCase().startsWith("magnet:?")) {
    const magnet = parseMagnetUri(options.sourceUrl, extraTrackers);
    extraWebSeeds.push(...magnet.webSeeds);
    extraTrackers.push(...magnet.trackers);

    if (options.webRtcEnabled) {
      swarm = new BrowserWebTorrentSwarm(magnet.infoHashBytes, magnet.trackers, null);
      swarm.start(options.signal);
    }

    // 1a. 如果 magnet 带有 xs= (Exact Source .torrent HTTP URL)，优先直接拉取 .torrent
    for (const xsUrl of magnet.exactSources) {
      if (options.signal.aborted) break;
      try {
        const resp = await fetchFn(xsUrl, { signal: options.signal });
        if (resp.ok) {
          const buf = new Uint8Array(await resp.arrayBuffer());
          const candidate = await parseTorrentBuffer(buf);
          if (candidate.infoHash === magnet.infoHash) {
            meta = candidate;
            resolvedTorrentBase64 = uint8ArrayToBase64(buf);
            break;
          }
        }
      } catch {
        // 继续尝试其他源或 WebRTC
      }
    }

    // 1b. 若没有 xs=，尝试通过本地无状态辅助服务 (DHT + UDP/TCP Trackers) 与 WebRTC Swarm 获取元数据
    if (!meta && canUseNativeHelper) {
      try {
        let helperReady =
          (await options.onEnsureNativeHelper?.(false)) ||
          (await checkHelperHealth(700)).available;
        if (!helperReady && options.onEnsureNativeHelper) {
          helperReady = await options.onEnsureNativeHelper(true);
        }
        if (helperReady) {
          const helperRes = await startHelperTorrentSession(
            {
              url: options.sourceUrl,
              trackers: magnet.trackers,
              onlyFiles: options.onlyFiles,
            },
            options.signal,
          );
          helperSessionId = helperRes.sessionId;
          helperWebSeedUrl = helperRes.webSeedUrl;
          if (helperRes.torrentBytesBase64) {
            resolvedTorrentBase64 = helperRes.torrentBytesBase64;
            meta = await parseTorrentBuffer(base64ToUint8Array(helperRes.torrentBytesBase64));
          }
        }
      } catch {
        // 回退等待 WebRTC Swarm
      }
    }

    if (!meta && swarm) {
      meta = await swarm.waitForMetadata(25000, options.signal);
    }

    if (!meta) {
      if (helperSessionId) {
        await stopHelperTorrentSession(helperSessionId).catch(() => {});
      }
      swarm?.close();
      throw new Error(
        "磁力元数据获取超时：当前种子在 WebTorrent (WebRTC) 网络中暂无在线浏览器做种节点，且磁力链接未包含 HTTP 种子源 (xs/ws)。",
      );
    }
  } else {
    // URL 指向远程 .torrent 文件
    const resp = await fetchFn(options.sourceUrl, { signal: options.signal });
    if (!resp.ok) {
      throw new Error(`下载 .torrent 种子文件失败: HTTP ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    resolvedTorrentBase64 = uint8ArrayToBase64(buf);
    meta = await parseTorrentBuffer(buf);
  }

  // 合并磁力或外部附加的 trackers 与 webSeeds
  const allTrackers = Array.from(new Set([...meta.trackers, ...extraTrackers]));
  const allWebSeeds = Array.from(new Set([...meta.webSeeds, ...extraWebSeeds]));
  meta.trackers = allTrackers;
  meta.webSeeds = allWebSeeds;

  if (!swarm && options.webRtcEnabled) {
    swarm = new BrowserWebTorrentSwarm(meta.infoHashBytes, allTrackers, meta);
    swarm.start(options.signal);
  }

  const discoveredTrackerPeers: TorrentPeerInfo[] = [];
  let checkpointOnExit: (() => Promise<void>) | undefined;

  try {
    // 2. 构建文件选择状态
    const selectedSet = new Set<number>(
      options.onlyFiles && options.onlyFiles.length > 0
        ? options.onlyFiles
        : meta.files.map((f) => f.index),
    );
    const fileInfos: TorrentFileInfo[] = meta.files.map((f) => ({
      index: f.index,
      path: f.path,
      length: f.length,
      selected: selectedSet.has(f.index),
    }));

    options.onMetadata?.(meta, fileInfos, resolvedTorrentBase64);

    const invalidPieces = new Set<number>();
    const selectedKeys: string[] = [];
    // Missing/newly selected files invalidate every piece touching their absent data.
    for (const file of meta.files) {
      if (selectedSet.has(file.index)) {
        const fileKey = `${options.partKeyPrefix}-file-${file.index}`;
        selectedKeys.push(fileKey);
        const exists = await options.partStore.exists(fileKey);
        const size = exists ? await options.partStore.size(fileKey) : 0;
        const reset = !exists || size > file.length;
        if (reset || size < file.length) {
          const missingStart = file.offset + (reset ? 0 : size);
          for (let p = Math.floor(missingStart / meta.pieceLength); p <= Math.floor((file.offset + file.length - 1) / meta.pieceLength); p++) invalidPieces.add(p);
        }
        await options.partStore.allocate(fileKey, file.length, reset ? "reset" : "preserve");
      }
    }

    const requiredPieces = computeRequiredPiecesForFiles(meta, selectedSet);
    const requiredSet = new Set(requiredPieces);
    const completedSet = new Set<number>(
      (options.completedPieces ?? []).filter((p) => requiredSet.has(p) && !invalidPieces.has(p)),
    );
    const committedSet = new Set(completedSet);
    let lastCheckpoint = Date.now();
    let checkpointChain: Promise<void> = Promise.resolve();
    const checkpoint = async (force = false): Promise<void> => {
      if (!force && Date.now() - lastCheckpoint < 1000) return;
      lastCheckpoint = Date.now();
      const snapshot = Array.from(completedSet);
      const next = checkpointChain.then(async () => {
        for (const key of selectedKeys) {
          if (options.partStore.sync) await options.partStore.sync(key);
          else await options.partStore.flush?.(key);
        }
        for (const p of snapshot) committedSet.add(p);
      }).catch(err => { throw new TorrentStorageError("提交 BT 数据失败", { cause: err }); });
      checkpointChain = next;
      await next;
    };
    const inFlightSet = new Set<number>();

    const pendingPieces = requiredPieces.filter((p) => !completedSet.has(p));

    const totalSelectedBytes = meta.files.filter(f => selectedSet.has(f.index)).reduce((sum, f) => sum + f.length, 0);
    const pieceBytes = new Map(requiredPieces.map(p => {
      const range = getPieceByteRange(meta, p);
      const bytes = meta.files.filter(f => selectedSet.has(f.index)).reduce((sum, f) =>
        sum + Math.max(0, Math.min(f.offset + f.length, range.end) - Math.max(f.offset, range.start)), 0);
      return [p, bytes];
    }));
    const calcDownloadedBytes = (pieces: ReadonlySet<number> = completedSet): number => {
      let bytes = 0;
      for (const p of pieces) bytes += pieceBytes.get(p) ?? 0;
      return Math.min(totalSelectedBytes, bytes);
    };

    let downloadedBytes = calcDownloadedBytes();
    let streamingPartialBytes = 0;
    let lastSampleTime = Date.now();
    let lastSampleBytes = downloadedBytes;
    let lastEmitTime = 0;
    let smoothSpeedBps = 0;

    // 2b. 若存在待下载分片，尝试接入本地无状态 P2P 协议网关 (tug-web-helper)
    if (pendingPieces.length > 0 && canUseNativeHelper && !helperSessionId) {
      let helperReady =
        (await options.onEnsureNativeHelper?.(false)) ||
        (await checkHelperHealth(700)).available;

      // 若该种子无任何 HTTP WebSeed 且本地网关尚未绑定激活，自动通过 tug-web:// 协议唤醒网关
      if (!helperReady && allWebSeeds.length === 0 && options.onEnsureNativeHelper) {
        helperReady = await options.onEnsureNativeHelper(true);
      }

      if (helperReady) {
        try {
          const helperRes = await startHelperTorrentSession(
            {
              torrentBytesBase64: resolvedTorrentBase64 ?? undefined,
              url: resolvedTorrentBase64 ? undefined : options.sourceUrl,
              trackers: allTrackers,
              onlyFiles: Array.from(selectedSet),
            },
            options.signal,
          );
          helperSessionId = helperRes.sessionId;
          helperWebSeedUrl = helperRes.webSeedUrl;
        } catch (err) {
          console.warn("[tug-web] Start helper torrent session error:", err);
        }
      }
    }

    if (helperWebSeedUrl && !allWebSeeds.includes(helperWebSeedUrl)) {
      allWebSeeds.push(helperWebSeedUrl);
    }

    const webSeedPeers: TorrentPeerInfo[] = options.webSeedEnabled
      ? allWebSeeds.map((ws) => ({
          address: ws,
          transport: "webseed",
          state: "active",
          client:
            ws === helperWebSeedUrl
              ? "Tug Local P2P Gateway (TCP/uTP/DHT)"
              : "HTTP WebSeed (BEP 19)",
          downloaded: 0,
          uploaded: 0,
        }))
      : [];

    // 异步向所有 HTTP/HTTPS Trackers 发起 Announce（仅在使用默认 fetch 时后台运行，避免干扰本地单元测试 Mock）
    if (!options.fetchImpl) {
      void announceAllHttpTrackers(
        allTrackers,
        meta.infoHashBytes,
        Math.max(0, totalSelectedBytes - downloadedBytes),
        options.signal,
        fetchFn,
      ).then((res) => {
        for (const ws of res.webSeeds) {
          if (!allWebSeeds.includes(ws)) {
            allWebSeeds.push(ws);
            if (options.webSeedEnabled) {
              webSeedPeers.push({
                address: ws,
                transport: "webseed",
                state: "active",
                client: "HTTP WebSeed (Tracker)",
                downloaded: 0,
                uploaded: 0,
              });
            }
          }
        }
        discoveredTrackerPeers.splice(0, discoveredTrackerPeers.length, ...res.peers);
      });
    }

    const buildSegmentsView = (): SegmentView[] =>
      buildBucketedTorrentSegments(meta, requiredPieces, completedSet, inFlightSet, 32);

    const emitProgress = (force = false) => {
      if (!options.onProgress) return;
      const now = Date.now();
      if (!force && now - lastEmitTime < PROGRESS_THROTTLE_MS) {
        return;
      }
      lastEmitTime = now;

      const effectiveDownloaded = Math.min(
        totalSelectedBytes,
        downloadedBytes + Math.max(0, streamingPartialBytes),
      );

      const dt = (now - lastSampleTime) / 1000;
      if (dt >= 0.12) {
        const inst = Math.max(0, (effectiveDownloaded - lastSampleBytes) / dt);
        smoothSpeedBps = smoothSpeedBps === 0 ? inst : Math.round(smoothSpeedBps * 0.55 + inst * 0.45);
        lastSampleTime = now;
        lastSampleBytes = effectiveDownloaded;
      }
      const displaySpeedBps = Math.max(Math.round(smoothSpeedBps), helperDownloadSpeedBps);
      const remaining = Math.max(0, totalSelectedBytes - effectiveDownloaded);
      const etaSecs =
        remaining > 0 && displaySpeedBps > 0
          ? Math.ceil(remaining / displaySpeedBps)
          : remaining === 0
            ? 0
            : null;
      const currentPeerList: TorrentPeerInfo[] = [
        ...webSeedPeers,
        ...(swarm?.getPeersSnapshot() ?? []),
        ...(helperPeers.length > 0 ? helperPeers : discoveredTrackerPeers),
      ];

      options.onProgress({
        name: meta.name,
        infoHash: meta.infoHash,
        state: "downloading",
        downloaded: effectiveDownloaded,
        committedBytes: calcDownloadedBytes(committedSet),
        total: totalSelectedBytes,
        speedBps: displaySpeedBps,
        peers: currentPeerList.length,
        etaSecs,
        files: fileInfos,
        completedPieces: Array.from(committedSet).sort((a, b) => a - b),
        pieceLength: meta.pieceLength,
        pieceCount: meta.pieceHashes.length,
        segments: buildSegmentsView(),
        peerList: currentPeerList,
      });
    };

    checkpointOnExit = async () => { await checkpoint(true); emitProgress(true); };

    if (helperSessionId) {
      const sid = helperSessionId;
      helperPollTimer = setInterval(() => {
        if (options.signal.aborted) return;
        void getHelperSessionPeers(sid, options.signal).then((stats) => {
          if (!stats) return;
          helperDownloadSpeedBps = stats.downloadSpeedBytes ?? 0;
          const mapped: TorrentPeerInfo[] = stats.peers.map((p) => ({
            address: p.addr,
            transport: "tracker",
            state: p.state || "live",
            client: "BitTorrent Peer (TCP/uTP/DHT)",
            downloaded: p.downloadedBytes,
            uploaded: p.uploadedBytes,
          }));
          helperPeers.splice(0, helperPeers.length, ...mapped);
          emitProgress(false);
        });
      }, 1000);
    }

    emitProgress(true);

    if (pendingPieces.length > 0) {
      if ((!options.webSeedEnabled || allWebSeeds.length === 0) && swarm && !swarm.hasConnectedPeers()) {
        await swarm.waitForFirstPeer(10000, options.signal);
      }

      const writePieceToSelectedFiles = async (pieceIndex: number, pieceData: Uint8Array): Promise<void> => {
        const range = getPieceByteRange(meta, pieceIndex);
        for (const file of meta.files) {
          if (!selectedSet.has(file.index) || file.length <= 0) continue;
          const fileStart = file.offset;
          const fileEnd = file.offset + file.length;
          const overlapStart = Math.max(range.start, fileStart);
          const overlapEnd = Math.min(range.end, fileEnd);
          if (overlapStart < overlapEnd) {
            const sliceInPiece = pieceData.subarray(
              overlapStart - range.start,
              overlapEnd - range.start,
            );
            const offsetInFile = overlapStart - fileStart;
            const fileKey = `${options.partKeyPrefix}-file-${file.index}`;
            try { await options.partStore.writeAt(fileKey, offsetInFile, sliceInPiece); }
            catch (err) { throw new TorrentStorageError("写入 BT 数据失败", { cause: err }); }
          }
        }
      };

      const fetchSinglePiece = async (pieceIndex: number): Promise<Uint8Array> => {
        const range = getPieceByteRange(meta, pieceIndex);
        const expectedHash = meta.pieceHashes[pieceIndex];

        if (options.webSeedEnabled && allWebSeeds.length > 0) {
          for (let sIdx = 0; sIdx < allWebSeeds.length; sIdx++) {
            const seedUrl = allWebSeeds[(pieceIndex + sIdx) % allWebSeeds.length];
            try {
              const sliceReqs = buildWebSeedSliceRequests(seedUrl, meta, range.start, range.end);
              const pieceBuffer = new Uint8Array(range.length);
              let writePos = 0;

              for (const req of sliceReqs) {
                const resp = await fetchFn(req.url, {
                  method: "GET",
                  headers: await helperRequestHeaders(req.url, {
                    Range: `bytes=${req.rangeStart}-${req.rangeEnd}`,
                  }),
                  redirect: new URL(req.url).origin === "http://127.0.0.1:16899" ? "error" : "follow",
                  signal: options.signal,
                });
                if (!resp.ok && resp.status !== 206) {
                  throw new Error(`WebSeed HTTP ${resp.status}`);
                }
                const fullBody = new Uint8Array(await resp.arrayBuffer());
                const slice =
                  resp.status === 200 && fullBody.byteLength > req.length
                    ? fullBody.subarray(req.rangeStart, req.rangeEnd + 1)
                    : fullBody;

                if (slice.byteLength !== req.length) {
                  throw new Error(
                    `WebSeed 分片长度不匹配（期望 ${req.length}，收到 ${slice.byteLength}）`,
                  );
                }
                await options.rateLimiter?.acquire(slice.byteLength, options.signal);
                pieceBuffer.set(slice, writePos);
                writePos += slice.byteLength;
                const peerInfo = webSeedPeers.find((p) => p.address === seedUrl);
                if (peerInfo) {
                  peerInfo.downloaded += slice.byteLength;
                }
              }

              const actualHash = bytesToHex(await computeSha1Bytes(pieceBuffer));
              if (actualHash !== expectedHash) {
                throw new Error(
                  `BT Piece #${pieceIndex} SHA-1 校验失败（期望 ${expectedHash.slice(0, 10)}…，实际 ${actualHash.slice(0, 10)}…）`,
                );
              }
              return pieceBuffer;
            } catch (err) {
              if (sIdx === allWebSeeds.length - 1 && (!swarm || !swarm.hasConnectedPeers())) {
                throw err;
              }
            }
          }
        }

        if (swarm && swarm.hasConnectedPeers()) {
          const fromSwarm = await swarm.requestPieceFromSwarm(
            pieceIndex,
            range.length,
            15000,
            options.signal,
          );
          if (fromSwarm) {
            const actualHash = bytesToHex(await computeSha1Bytes(fromSwarm));
            if (actualHash === expectedHash) {
              await options.rateLimiter?.acquire(fromSwarm.byteLength, options.signal);
              return fromSwarm;
            }
          }
        }

        const tcpOnlyTrackers = meta.trackers.filter(
          (t) => t.startsWith("udp://") || t.startsWith("http://") || t.startsWith("https://"),
        );
        const hint =
          tcpOnlyTrackers.length > 0 && allWebSeeds.length === 0
            ? `（该种子仅包含 ${tcpOnlyTrackers.length} 个传统 UDP/HTTP Tracker 且无 WebSeed 镜像，浏览器沙箱无法直连 TCP/UDP 节点；请开启或安装 Tug Web 本地辅助网关）`
            : "（当前无在线 WebRTC Peer 或 HTTP WebSeed 节点响应）";

        throw new Error(`无法获取种子分片 #${pieceIndex} ${hint}`);
      };

      /**
       * 针对包含 WebSeed 的种子：按最多 4 MiB 的连续 Piece 区间发起单次流式 HTTP Range 请求，
       * 边流式读取边切分 Piece、边校验 SHA-1、边写入 OPFS，将数百次小分片 HTTP RTT 合并为几次长流请求。
       */
      const downloadContiguousWebSeedBatch = async (
        batchPieces: number[],
        seedUrl: string,
      ): Promise<boolean> => {
        if (batchPieces.length === 0) return true;
        const firstRange = getPieceByteRange(meta, batchPieces[0]);
        const lastRange = getPieceByteRange(meta, batchPieces[batchPieces.length - 1]);
        const batchGlobalStart = firstRange.start;
        const batchGlobalEnd = lastRange.end;
        const totalBatchLen = batchGlobalEnd - batchGlobalStart;

        const sliceReqs = buildWebSeedSliceRequests(
          seedUrl,
          meta,
          batchGlobalStart,
          batchGlobalEnd,
        );
        const peerInfo = webSeedPeers.find((p) => p.address === seedUrl);

        let currentPieceSlot = 0;
        let currentPieceBuffer = new Uint8Array(
          getPieceByteRange(meta, batchPieces[0]).length,
        );
        let currentPieceWritePos = 0;
        let totalReceived = 0;
        let trackedPartial = 0;

        const consumeStreamChunk = async (chunk: Uint8Array) => {
          let readPos = 0;
          while (readPos < chunk.byteLength && currentPieceSlot < batchPieces.length) {
            const needed = currentPieceBuffer.byteLength - currentPieceWritePos;
            const take = Math.min(needed, chunk.byteLength - readPos);
            currentPieceBuffer.set(chunk.subarray(readPos, readPos + take), currentPieceWritePos);
            currentPieceWritePos += take;
            readPos += take;
            totalReceived += take;
            streamingPartialBytes += take;
            trackedPartial += take;

            if (currentPieceWritePos === currentPieceBuffer.byteLength) {
              const pIdx = batchPieces[currentPieceSlot];
              const expectedHash = meta.pieceHashes[pIdx];
              const actualHash = bytesToHex(await computeSha1Bytes(currentPieceBuffer));
              if (actualHash !== expectedHash) {
                throw new Error(`BT Piece #${pIdx} SHA-1 校验失败`);
              }
              await writePieceToSelectedFiles(pIdx, currentPieceBuffer);
              completedSet.add(pIdx);
              await checkpoint();
              inFlightSet.delete(pIdx);
              streamingPartialBytes = Math.max(
                0,
                streamingPartialBytes - currentPieceBuffer.byteLength,
              );
              trackedPartial = Math.max(0, trackedPartial - currentPieceBuffer.byteLength);
              downloadedBytes = calcDownloadedBytes();
              emitProgress(false);

              currentPieceSlot += 1;
              if (currentPieceSlot < batchPieces.length) {
                currentPieceBuffer = new Uint8Array(
                  getPieceByteRange(meta, batchPieces[currentPieceSlot]).length,
                );
                currentPieceWritePos = 0;
              }
            } else {
              emitProgress(false);
            }
          }
        };

        try {
          for (const req of sliceReqs) {
            const resp = await fetchFn(req.url, {
              method: "GET",
              headers: await helperRequestHeaders(req.url, {
                Range: `bytes=${req.rangeStart}-${req.rangeEnd}`,
              }),
              redirect: new URL(req.url).origin === "http://127.0.0.1:16899" ? "error" : "follow",
              signal: options.signal,
            });
            if (!resp.ok && resp.status !== 206) {
              throw new Error(`WebSeed HTTP ${resp.status}`);
            }

            if (resp.status === 206 && resp.body) {
              const reader = resp.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                  await options.rateLimiter?.acquire(value.byteLength, options.signal);
                  if (peerInfo) peerInfo.downloaded += value.byteLength;
                  await consumeStreamChunk(value);
                }
              }
            } else {
              const fullBody = new Uint8Array(await resp.arrayBuffer());
              const slice =
                resp.status === 200 && fullBody.byteLength > req.length
                  ? fullBody.subarray(req.rangeStart, req.rangeEnd + 1)
                  : fullBody;
              if (slice.byteLength !== req.length) {
                throw new Error(`WebSeed 长度不匹配`);
              }
              await options.rateLimiter?.acquire(slice.byteLength, options.signal);
              if (peerInfo) peerInfo.downloaded += slice.byteLength;
              await consumeStreamChunk(slice);
            }
          }
        } finally {
          if (trackedPartial > 0) {
            streamingPartialBytes = Math.max(0, streamingPartialBytes - trackedPartial);
          }
        }

        return totalReceived === totalBatchLen && currentPieceSlot === batchPieces.length;
      };

      let cursor = 0;
      const maxPiecesPerBatch = Math.max(
        1,
        Math.min(64, Math.floor(WEBSEED_BATCH_TARGET_BYTES / Math.max(1, meta.pieceLength))),
      );

      const claimNextBatch = (): number[] => {
        if (cursor >= pendingPieces.length) return [];
        const canBatch = options.webSeedEnabled && allWebSeeds.length > 0 && maxPiecesPerBatch > 1;
        const batch: number[] = [pendingPieces[cursor]];
        cursor += 1;

        if (canBatch) {
          while (
            cursor < pendingPieces.length &&
            batch.length < maxPiecesPerBatch &&
            pendingPieces[cursor] === batch[batch.length - 1] + 1
          ) {
            batch.push(pendingPieces[cursor]);
            cursor += 1;
          }
        }
        return batch;
      };

      const isLocalGatewayOnly =
        Boolean(helperWebSeedUrl) &&
        allWebSeeds.length === 1 &&
        allWebSeeds[0] === helperWebSeedUrl;
      const workerCount = isLocalGatewayOnly
        ? Math.min(2, Math.max(1, options.connections))
        : Math.max(1, Math.min(16, options.connections));

      const workers = Array.from({ length: workerCount }, async (_, workerIdx) => {
        while (!options.signal.aborted) {
          const batch = claimNextBatch();
          if (batch.length === 0) break;
          for (const pIdx of batch) {
            inFlightSet.add(pIdx);
          }

          try {
            if (batch.length > 1 && options.webSeedEnabled && allWebSeeds.length > 0) {
              const seedUrl = allWebSeeds[workerIdx % allWebSeeds.length];
              try {
                const ok = await downloadContiguousWebSeedBatch(batch, seedUrl);
                if (ok) continue;
              } catch (err) {
                if (err instanceof TorrentStorageError || options.signal.aborted) throw err;
                // 若批量流式请求中途失败，回退逐个补齐未完成的 Piece
              }
            }

            for (const pieceIndex of batch) {
              if (completedSet.has(pieceIndex)) continue;
              const pieceData = await fetchSinglePiece(pieceIndex);
              await writePieceToSelectedFiles(pieceIndex, pieceData);
              completedSet.add(pieceIndex);
              await checkpoint();
              inFlightSet.delete(pieceIndex);
              downloadedBytes = calcDownloadedBytes();
              emitProgress(false);
            }
          } finally {
            for (const pIdx of batch) {
              inFlightSet.delete(pIdx);
            }
          }
        }
      });

      let workerError: unknown;
      await Promise.all(workers.map(async worker => {
        try { await worker; }
        catch (err) { if (workerError === undefined) workerError = err; group.abort(err); }
      }));
      if (workerError !== undefined) throw workerError;
      options.signal.throwIfAborted();
      await checkpoint(true);
      streamingPartialBytes = 0;
      emitProgress(true);
    }

    for (const file of meta.files) {
      if (selectedSet.has(file.index)) {
        const fileKey = `${options.partKeyPrefix}-file-${file.index}`;
        await options.partStore.flush?.(fileKey);
        if (await options.partStore.size(fileKey) !== file.length) throw new Error(`BT 文件长度不匹配: ${file.path}`);
      }
    }

    const runtimeDetails: TorrentRuntimeDetails = {
      infoHash: meta.infoHash,
      pieceLength: meta.pieceLength,
      pieceCount: meta.pieceHashes.length,
      completedPieces: completedSet.size,
      peers: [
        ...webSeedPeers,
        ...(swarm?.getPeersSnapshot() ?? []),
        ...(helperPeers.length > 0 ? helperPeers : discoveredTrackerPeers),
      ],
      trackers: allTrackers,
      webSeeds: allWebSeeds,
    };

    return {
      meta,
      selectedFiles: fileInfos,
      completedPieces: Array.from(completedSet).sort((a, b) => a - b),
      totalSelectedBytes,
      runtimeDetails,
    };
  } finally {
    try { await checkpointOnExit?.(); }
    finally {
      if (helperPollTimer) {
        clearInterval(helperPollTimer);
        helperPollTimer = null;
      }
      if (helperSessionId) await stopHelperTorrentSession(helperSessionId).catch(() => {});
      swarm?.close();
    }
  }
}
