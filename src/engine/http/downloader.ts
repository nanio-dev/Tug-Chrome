import {
  guessFileNameFromUrl,
  parseContentDisposition,
  sanitizeFileName,
} from "../../shared/filename";
import type { SegmentView } from "../../shared/types";
import type { PartStorageBackend } from "../storage/part-store";
import type { RateLimiter } from "./rate-limiter";

export const MIN_SEGMENT_BYTES = 64 * 1024; // 64 KiB
export const MIN_STEAL_BYTES = 256 * 1024; // 256 KiB
const WORKER_WRITE_BUFFER_BYTES = 2 * 1024 * 1024; // 每个连接 2 MiB 聚合写缓冲，避免每个 16 KiB 网络包触发磁盘 IPC
const PROGRESS_THROTTLE_MS = 120; // 最多每 120ms (~8 FPS) 广播一次 UI 进度，防止高频 IPC 阻塞下载流

export interface ProbeResult {
  finalUrl: string;
  total: number | null;
  rangeSupported: boolean;
  etag: string | null;
  lastModified: string | null;
  fileName: string | null;
}

export interface HttpDownloadProgress {
  downloaded: number;
  total: number | null;
  speedBps: number;
  etaSecs: number | null;
  rangeSupported: boolean;
  segments: SegmentView[];
}

export interface HttpDownloadOptions {
  url: string;
  partKey: string;
  partStore: PartStorageBackend;
  connections: number;
  carryCookies: boolean;
  headers?: Array<[string, string]>;
  expectedSha256?: string | null;
  rateLimiter?: RateLimiter;
  signal: AbortSignal;
  resumeState?: {
    etag: string | null;
    lastModified: string | null;
    total: number | null;
    rangeSupported: boolean;
    segments: SegmentView[];
  };
  onProbe?: (probe: ProbeResult) => void;
  onProgress?: (progress: HttpDownloadProgress) => void;
  fetchImpl?: typeof fetch;
}

export interface HttpDownloadResult {
  finalUrl: string;
  fileName: string;
  total: number;
  etag: string | null;
  lastModified: string | null;
  rangeSupported: boolean;
  segments: SegmentView[];
}

/**
 * 解析 Content-Range: bytes start-end/total
 */
export function parseContentRangeTotal(header: string | null | undefined): number | null {
  if (!header) return null;
  const match = header.match(/bytes\s+(?:\d+-\d+|\*)\/(\d+|\*)/i);
  if (!match) return null;
  if (match[1] === "*") return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/**
 * 将文件总长度划分为初始的多连接分段区间 [start, end)（半开区间）。
 */
export function buildInitialSegments(
  total: number,
  connections: number,
  minSegmentBytes = MIN_SEGMENT_BYTES,
): SegmentView[] {
  if (total <= 0) {
    return [];
  }
  const clampedConn = Math.max(1, Math.min(32, Math.floor(connections) || 1));
  const maxBySize = Math.max(1, Math.floor(total / Math.max(1, minSegmentBytes)));
  const count = Math.min(clampedConn, maxBySize);
  const baseChunk = Math.floor(total / count);
  const segments: SegmentView[] = [];

  let offset = 0;
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const end = isLast ? total : offset + baseChunk;
    segments.push({
      index: i,
      start: offset,
      current: offset,
      end,
      state: "pending",
    });
    offset = end;
  }
  return segments;
}

/**
 * 动态分片窃取（Work Stealing）：
 * 当空闲连接找不到 pending 分片时，从剩余字节最多的 downloading 分片对半切出后半段。
 */
export function stealSegmentWork(
  segments: SegmentView[],
  minStealBytes = MIN_STEAL_BYTES,
): SegmentView | null {
  let candidate: SegmentView | null = null;
  let maxRemaining = 0;

  for (const seg of segments) {
    if (seg.state !== "downloading") continue;
    const remaining = seg.end - seg.current;
    if (remaining >= minStealBytes * 2 && remaining > maxRemaining) {
      maxRemaining = remaining;
      candidate = seg;
    }
  }

  if (!candidate) {
    return null;
  }

  const splitPoint = candidate.current + Math.floor((candidate.end - candidate.current) / 2);
  const oldEnd = candidate.end;
  candidate.end = splitPoint;

  const stolen: SegmentView = {
    index: segments.length,
    start: splitPoint,
    current: splitPoint,
    end: oldEnd,
    state: "pending",
  };
  segments.push(stolen);
  return stolen;
}

/**
 * 探测 HTTP 资源是否支持 Range 请求、文件总长、ETag 与文件名。
 */
export async function probeHttpSource(
  url: string,
  options: {
    carryCookies: boolean;
    headers?: Array<[string, string]>;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<ProbeResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const probeAbort = new AbortController();
  const onParentAbort = () => probeAbort.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const reqHeaders = new Headers();
    for (const [k, v] of options.headers ?? []) {
      if (k && v) {
        try {
          reqHeaders.set(k, v);
        } catch {
          // 忽略浏览器禁止直接在 fetch 设置的受限头（由 background DNR 处理）
        }
      }
    }
    reqHeaders.set("Range", "bytes=0-0");

    const response = await fetchFn(url, {
      method: "GET",
      headers: reqHeaders,
      credentials: options.carryCookies ? "include" : "omit",
      signal: probeAbort.signal,
    });

    if (response.status === 416) {
      const total = parseContentRangeTotal(response.headers.get("content-range")) ?? 0;
      const fileName =
        parseContentDisposition(response.headers.get("content-disposition")) ??
        guessFileNameFromUrl(response.url || url);
      return {
        finalUrl: response.url || url,
        total,
        rangeSupported: false,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        fileName,
      };
    }

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
    }

    const finalUrl = response.url || url;
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    const fileName =
      parseContentDisposition(response.headers.get("content-disposition")) ??
      guessFileNameFromUrl(finalUrl);

    if (response.status === 206) {
      const total = parseContentRangeTotal(response.headers.get("content-range"));
      await response.body?.cancel().catch(() => {});
      return {
        finalUrl,
        total,
        rangeSupported: total !== null && total > 0,
        etag,
        lastModified,
        fileName,
      };
    }

    // 200 OK：服务器忽略了 Range 头，不支持分段
    const contentLengthHeader = response.headers.get("content-length");
    const parsedLen = contentLengthHeader ? Number(contentLengthHeader) : null;
    const total = parsedLen !== null && Number.isFinite(parsedLen) && parsedLen >= 0 ? parsedLen : null;
    await response.body?.cancel().catch(() => {});

    return {
      finalUrl,
      total,
      rangeSupported: false,
      etag,
      lastModified,
      fileName,
    };
  } finally {
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 执行完整的多连接分段 HTTP/HTTPS 下载，支持断点续传、动态分片窃取、2MiB 写入聚合缓冲与 SHA-256 校验。
 */
export async function runHttpDownload(options: HttpDownloadOptions): Promise<HttpDownloadResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const probe = await probeHttpSource(options.url, {
    carryCookies: options.carryCookies,
    headers: options.headers,
    signal: options.signal,
    fetchImpl: fetchFn,
  });

  options.onProbe?.(probe);

  const targetUrl = probe.finalUrl || options.url;
  const resolvedName = sanitizeFileName(
    probe.fileName || guessFileNameFromUrl(targetUrl),
    "download",
  );

  // 检查是否可以安全复用上次暂停的续传分片
  let segments: SegmentView[] = [];
  let canResume = false;
  if (
    options.resumeState &&
    probe.rangeSupported &&
    probe.total !== null &&
    options.resumeState.total === probe.total &&
    options.resumeState.segments.length > 0 &&
    (await options.partStore.exists(options.partKey))
  ) {
    const etagMatch =
      !options.resumeState.etag || !probe.etag || options.resumeState.etag === probe.etag;
    const lmMatch =
      !options.resumeState.lastModified ||
      !probe.lastModified ||
      options.resumeState.lastModified === probe.lastModified;

    if (etagMatch && lmMatch) {
      canResume = true;
      segments = options.resumeState.segments.map((s) => ({
        ...s,
        state: s.current >= s.end ? "completed" : "pending",
      }));
    }
  }

  if (!canResume) {
    if (probe.rangeSupported && probe.total !== null && probe.total > 0) {
      await options.partStore.allocate(options.partKey, probe.total);
      segments = buildInitialSegments(probe.total, options.connections);
    } else {
      await options.partStore.allocate(options.partKey, probe.total ?? 0);
      segments = [
        {
          index: 0,
          start: 0,
          current: 0,
          end: probe.total ?? 0,
          state: "pending",
        },
      ];
    }
  }

  let totalBytes = probe.total;
  let downloadedBytes = segments.reduce((sum, s) => sum + Math.max(0, s.current - s.start), 0);
  let lastSpeedSampleTime = Date.now();
  let lastSpeedSampleBytes = downloadedBytes;
  let lastEmitTime = 0;
  let smoothSpeedBps = 0;

  const emitProgress = (force = false) => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmitTime < PROGRESS_THROTTLE_MS) {
      return;
    }
    lastEmitTime = now;

    const dt = (now - lastSpeedSampleTime) / 1000;
    if (dt >= 0.12) {
      const instSpeed = Math.max(0, (downloadedBytes - lastSpeedSampleBytes) / dt);
      smoothSpeedBps =
        smoothSpeedBps === 0 ? instSpeed : Math.round(smoothSpeedBps * 0.55 + instSpeed * 0.45);
      lastSpeedSampleTime = now;
      lastSpeedSampleBytes = downloadedBytes;
    }
    const remaining =
      totalBytes !== null && totalBytes > downloadedBytes ? totalBytes - downloadedBytes : null;
    const etaSecs =
      remaining !== null && smoothSpeedBps > 0 ? Math.ceil(remaining / smoothSpeedBps) : null;

    options.onProgress({
      downloaded: downloadedBytes,
      total: totalBytes,
      speedBps: Math.round(smoothSpeedBps),
      etaSecs,
      rangeSupported: probe.rangeSupported,
      segments: segments.map((s) => ({ ...s })),
    });
  };

  if (!probe.rangeSupported || totalBytes === null || totalBytes === 0) {
    // 单连接流式下载（处理不支持 Range 或长度未知的响应）
    if (totalBytes === 0) {
      emitProgress(true);
      return {
        finalUrl: targetUrl,
        fileName: resolvedName,
        total: 0,
        etag: probe.etag,
        lastModified: probe.lastModified,
        rangeSupported: false,
        segments,
      };
    }

    const reqHeaders = new Headers();
    for (const [k, v] of options.headers ?? []) {
      if (k && v) {
        try {
          reqHeaders.set(k, v);
        } catch {
          // 忽略受限头
        }
      }
    }

    const response = await fetchFn(targetUrl, {
      method: "GET",
      headers: reqHeaders,
      credentials: options.carryCookies ? "include" : "omit",
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
    }

    segments[0].state = "downloading";
    let offset = 0;
    const writeBuf = new Uint8Array(WORKER_WRITE_BUFFER_BYTES);
    let writeBufStart = 0;
    let writeBufLen = 0;

    const flushSingleBuffer = async () => {
      if (writeBufLen <= 0) return;
      const slice = writeBuf.subarray(0, writeBufLen);
      const startOff = writeBufStart;
      writeBufStart += writeBufLen;
      writeBufLen = 0;
      await options.partStore.writeAt(options.partKey, startOff, slice);
    };

    const reader = response.body?.getReader();
    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await options.rateLimiter?.acquire(value.byteLength, options.signal);
            offset += value.byteLength;
            downloadedBytes = offset;
            segments[0].current = offset;
            if (totalBytes === null || offset > totalBytes) {
              segments[0].end = offset;
            }

            if (value.byteLength >= WORKER_WRITE_BUFFER_BYTES) {
              await flushSingleBuffer();
              await options.partStore.writeAt(
                options.partKey,
                offset - value.byteLength,
                value,
              );
              writeBufStart = offset;
            } else {
              if (writeBufLen + value.byteLength > WORKER_WRITE_BUFFER_BYTES) {
                await flushSingleBuffer();
              }
              if (writeBufLen === 0) {
                writeBufStart = offset - value.byteLength;
              }
              writeBuf.set(value, writeBufLen);
              writeBufLen += value.byteLength;
            }

            emitProgress(false);
          }
        }
      }
    } finally {
      await flushSingleBuffer();
    }

    totalBytes = offset;
    segments[0].end = offset;
    segments[0].state = "completed";
    emitProgress(true);
  } else {
    // 多连接分段下载 + 动态分片窃取 (Work Stealing) + 2 MiB 块聚合落盘
    const claimNextSegment = (): SegmentView | null => {
      const pending = segments.find((s) => s.state === "pending" && s.current < s.end);
      if (pending) {
        pending.state = "downloading";
        return pending;
      }
      const stolen = stealSegmentWork(segments, MIN_STEAL_BYTES);
      if (stolen) {
        stolen.state = "downloading";
        return stolen;
      }
      return null;
    };

    const downloadSingleSegment = async (seg: SegmentView): Promise<void> => {
      let attempt = 0;
      const maxAttempts = 5;
      const writeBuf = new Uint8Array(WORKER_WRITE_BUFFER_BYTES);

      while (seg.current < seg.end) {
        if (options.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        let writeBufStart = seg.current;
        let writeBufLen = 0;

        const flushSegmentBuffer = async () => {
          if (writeBufLen <= 0) return;
          const slice = writeBuf.subarray(0, writeBufLen);
          const startOff = writeBufStart;
          writeBufStart += writeBufLen;
          writeBufLen = 0;
          await options.partStore.writeAt(options.partKey, startOff, slice);
        };

        try {
          const reqHeaders = new Headers();
          for (const [k, v] of options.headers ?? []) {
            if (k && v) {
              try {
                reqHeaders.set(k, v);
              } catch {
                // 忽略受限头
              }
            }
          }
          // 注意：seg.end 在 Work Stealing 时可能被其他 worker 动态缩小
          reqHeaders.set("Range", `bytes=${seg.current}-${seg.end - 1}`);

          const response = await fetchFn(targetUrl, {
            method: "GET",
            headers: reqHeaders,
            credentials: options.carryCookies ? "include" : "omit",
            signal: options.signal,
          });

          if (response.status !== 206 && response.status !== 200) {
            throw new Error(`分片请求失败: HTTP ${response.status}`);
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error("响应体为空");
          }

          while (seg.current < seg.end) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            // 如果该分片在下载过程中被其他空闲连接窃取了后半部分，只写到最新 seg.end 为止
            const remainingAllowed = seg.end - seg.current;
            if (remainingAllowed <= 0) {
              await reader.cancel().catch(() => {});
              break;
            }

            const sliceToWrite =
              value.byteLength > remainingAllowed ? value.subarray(0, remainingAllowed) : value;

            await options.rateLimiter?.acquire(sliceToWrite.byteLength, options.signal);

            const chunkOffset = seg.current;
            seg.current += sliceToWrite.byteLength;
            downloadedBytes += sliceToWrite.byteLength;

            if (sliceToWrite.byteLength >= WORKER_WRITE_BUFFER_BYTES) {
              await flushSegmentBuffer();
              await options.partStore.writeAt(options.partKey, chunkOffset, sliceToWrite);
              writeBufStart = seg.current;
            } else {
              if (writeBufLen + sliceToWrite.byteLength > WORKER_WRITE_BUFFER_BYTES) {
                await flushSegmentBuffer();
              }
              if (writeBufLen === 0) {
                writeBufStart = chunkOffset;
              }
              writeBuf.set(sliceToWrite, writeBufLen);
              writeBufLen += sliceToWrite.byteLength;
            }

            emitProgress(false);

            if (seg.current >= seg.end) {
              await reader.cancel().catch(() => {});
              break;
            }
          }

          await flushSegmentBuffer();

          if (seg.current >= seg.end) {
            seg.state = "completed";
            emitProgress(true);
            return;
          }
          throw new Error("分片连接提前关闭");
        } catch (err) {
          await flushSegmentBuffer().catch(() => {});
          if (options.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
            seg.state = "pending";
            throw err;
          }
          attempt += 1;
          if (attempt >= maxAttempts) {
            seg.state = "pending";
            throw err;
          }
          const backoffMs = Math.min(8000, 300 * 2 ** (attempt - 1));
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, backoffMs);
            options.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
      }
      seg.state = "completed";
    };

    const workerCount = Math.max(1, Math.min(32, options.connections));
    const workers = Array.from({ length: workerCount }, async () => {
      while (!options.signal.aborted) {
        const seg = claimNextSegment();
        if (!seg) break;
        await downloadSingleSegment(seg);
      }
    });

    await Promise.all(workers);
    emitProgress(true);
  }

  await options.partStore.flush?.(options.partKey);

  // 可选 SHA-256 完整性校验
  if (options.expectedSha256 && options.expectedSha256.trim()) {
    const expected = options.expectedSha256.trim().toLowerCase();
    const bytes = await options.partStore.readAll(options.partKey);
    const actual = await computeSha256Hex(bytes);
    if (actual !== expected) {
      throw new Error(`SHA-256 校验不匹配（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
    }
  }

  return {
    finalUrl: targetUrl,
    fileName: resolvedName,
    total: totalBytes ?? downloadedBytes,
    etag: probe.etag,
    lastModified: probe.lastModified,
    rangeSupported: probe.rangeSupported,
    segments,
  };
}
