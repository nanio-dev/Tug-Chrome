import { guessFileNameFromUrl, parseContentDisposition, sanitizeFileName } from "../../shared/filename";
import type { SegmentView } from "../../shared/types";
import type { PartStorageBackend } from "../storage/part-store";
import type { RateLimiter } from "./rate-limiter";
import { abortableDelay, openHttpStream } from "./request";
import { hashBlobSha256 } from "./sha256";

export const MIN_SEGMENT_BYTES = 64 * 1024;
const WRITE_BUFFER_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_MS = 1000;

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
  committedBytes: number;
  total: number | null;
  speedBps: number;
  etaSecs: number | null;
  rangeSupported: boolean;
  segments: SegmentView[];
  committedSegments: SegmentView[];
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
  timeoutMs?: number;
  resumeState?: {
    etag: string | null;
    lastModified: string | null;
    total: number | null;
    rangeSupported: boolean;
    segments: SegmentView[];
  };
  onProbe?: (probe: ProbeResult) => void;
  onProgress?: (progress: HttpDownloadProgress) => void;
  onPhase?: (phase: "verifying") => void;
  fetchImpl?: typeof fetch;
}
export interface HttpDownloadMetrics {
  effectiveConnections: number;
  requests: number;
  retries: number;
  networkBytes: number;
  probeMs: number;
  writeMs: number;
  elapsedMs: number;
}
export interface HttpDownloadResult {
  finalUrl: string;
  fileName: string;
  total: number;
  etag: string | null;
  lastModified: string | null;
  rangeSupported: boolean;
  segments: SegmentView[];
  metrics: HttpDownloadMetrics;
}

class ResponseError extends Error {}
class StorageError extends Error {}
class TransientError extends Error {}

function contentRange(header: string | null) {
  const m = header?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!m) return null;
  const [start, end, total] = m.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total
    ? { start, end, total } : null;
}
export function parseContentRangeTotal(header: string | null | undefined): number | null {
  const m = header?.match(/^bytes (?:\d+-\d+|\*)\/(\d+)$/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function contentLength(headers: Headers): number | null {
  // fetch exposes decoded bytes, while Content-Length describes the encoded body.
  if (headers.has("content-encoding") && headers.get("content-encoding")?.toLowerCase() !== "identity") return null;
  const raw = headers.get("content-length");
  if (raw === null) return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) throw new ResponseError("Invalid Content-Length");
  return n;
}
function requestHeaders(headers?: Array<[string, string]>): Headers {
  const result = new Headers();
  for (const [key, value] of headers ?? []) {
    if (key && value) result.set(key, value);
  }
  result.delete("Range");
  result.delete("If-Range");
  return result;
}
function validator(probe: Pick<ProbeResult, "etag" | "lastModified">): string | null {
  return probe.etag && !probe.etag.startsWith("W/") ? probe.etag : probe.lastModified;
}

/** Small fixed Range jobs balance tails without cutting requests queued in Chromium. */
export function buildRangeQueue(total: number, connections: number): SegmentView[] {
  if (total <= 0) return [];
  const workers = Math.max(1, Math.min(32, Math.floor(connections) || 1));
  // Keep a whole number of worker waves: 16 x 8 MiB jobs leave four of six
  // connections idle at the tail; 18 balanced jobs cover the same 128 MiB.
  const desired = workers * Math.max(1, Math.ceil(total / (8 * 1024 * 1024 * workers)));
  const count = Math.min(desired, workers * Math.floor(4096 / workers), Math.max(1, Math.floor(total / MIN_SEGMENT_BYTES)));
  const size = Math.floor(total / count);
  return Array.from({ length: count }, (_, index) => ({
    index, start: index * size, current: index * size, end: index === count - 1 ? total : (index + 1) * size, state: "pending",
  }));
}

export async function probeHttpSource(url: string, options: {
  carryCookies: boolean; headers?: Array<[string, string]>; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<ProbeResult> {
  const headers = requestHeaders(options.headers);
  headers.set("Range", "bytes=0-0");
  const stream = await openHttpStream(options.fetchImpl ?? fetch, url, {
    headers, credentials: options.carryCookies ? "include" : "omit", signal: options.signal,
  }, options.timeoutMs);
  try {
    const r = stream.response;
    let total: number | null;
    if (r.status === 416) {
      total = parseContentRangeTotal(r.headers.get("content-range"));
      if (total !== 0) throw new ResponseError("Range probe rejected by server");
    } else if (r.status === 206) {
      const range = contentRange(r.headers.get("content-range"));
      if (!range || range.start !== 0 || range.end !== 0) throw new ResponseError("Invalid Range probe response");
      total = r.headers.has("content-encoding") && r.headers.get("content-encoding")?.toLowerCase() !== "identity" ? null : range.total;
    } else if (r.status === 200) total = contentLength(r.headers);
    else throw new ResponseError(`HTTP ${r.status} ${r.statusText}`.trim());
    return {
      finalUrl: r.url || url, total, rangeSupported: r.status === 206 && total !== null && total > 0,
      etag: r.headers.get("etag"), lastModified: r.headers.get("last-modified"),
      fileName: parseContentDisposition(r.headers.get("content-disposition")) ?? guessFileNameFromUrl(r.url || url),
    };
  } finally { await stream.close(); }
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

function validResumeSegments(segments: SegmentView[], total: number, fileSize: number): boolean {
  let end = 0;
  for (const s of segments) {
    if (![s.start, s.current, s.end].every(Number.isSafeInteger) || s.start !== end || s.end <= s.start
      || s.current < s.start || s.current > s.end || (s.current > s.start && s.current > fileSize)) return false;
    end = s.end;
  }
  return end === total;
}

export async function runHttpDownload(options: HttpDownloadOptions): Promise<HttpDownloadResult> {
  options.signal.throwIfAborted();
  const expected = options.expectedSha256?.trim().toLowerCase();
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) throw new Error("SHA-256 must contain 64 hexadecimal characters");
  const startTime = performance.now();
  const fetchFn = options.fetchImpl ?? fetch;
  const probe = await probeHttpSource(options.url, { ...options, fetchImpl: fetchFn });
  const protocol = typeof performance.getEntriesByName === "function"
    ? (performance.getEntriesByName(probe.finalUrl).at(-1) as PerformanceResourceTiming | undefined)?.nextHopProtocol : "";
  const requested = Math.max(1, Math.min(32, Math.floor(options.connections) || 1));
  const connections = new URL(probe.finalUrl).protocol === "http:" || protocol === "http/1.1"
    ? Math.min(6, requested) : requested;
  const metrics: HttpDownloadMetrics = { effectiveConnections: connections, requests: 1, retries: 0,
    networkBytes: 0, probeMs: performance.now() - startTime, writeMs: 0, elapsedMs: 0 };
  let total = probe.total;
  let segments: SegmentView[] = [];
  const resume = options.resumeState;
  if (resume && probe.rangeSupported && total !== null && resume.total === total
    && validator(resume) !== null && validator(resume) === validator(probe)
    && await options.partStore.exists(options.partKey)
    && validResumeSegments(resume.segments, total, await options.partStore.size(options.partKey))) {
    segments = resume.segments.map((s, index) => ({ ...s, index, state: s.current === s.end ? "completed" : "pending" }));
  } else {
    await options.partStore.allocate(options.partKey, total ?? 0, "reset");
    segments = probe.rangeSupported && total ? buildRangeQueue(total, connections)
      : [{ index: 0, start: 0, current: 0, end: total ?? 0, state: "pending" }];
  }
  options.onProbe?.(probe);
  const committed = segments.map(s => s.current);
  const received = segments.map(s => s.current);
  let lastEmit = 0, lastSample = performance.now();
  let sampleBytes = segments.reduce((sum, s) => sum + s.current - s.start, 0), speed = 0;
  const emit = (force = false) => {
    if (!options.onProgress) return;
    const now = performance.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    const downloaded = segments.reduce((sum, s, i) => sum + received[i] - s.start, 0);
    if (now - lastSample >= 120) {
      const instant = Math.max(0, (downloaded - sampleBytes) * 1000 / (now - lastSample));
      speed = speed ? Math.round(speed * 0.55 + instant * 0.45) : instant;
      lastSample = now; sampleBytes = downloaded;
    }
    options.onProgress({ downloaded, total, speedBps: Math.round(speed),
      etaSecs: total !== null && speed > 0 ? Math.ceil(Math.max(0, total - downloaded) / speed) : null,
      rangeSupported: probe.rangeSupported,
      segments: segments.map((s, i) => ({ ...s, current: received[i] })),
      committedBytes: segments.reduce((sum, s, i) => sum + committed[i] - s.start, 0),
      committedSegments: segments.map((s, i) => ({ ...s, current: committed[i], state: committed[i] === s.end ? "completed" : "pending" })),
    });
  };
  const group = new AbortController();
  const onAbort = () => group.abort(options.signal.reason);
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  let cursor = 0, failure: unknown;
  const downloadSegment = async (seg: SegmentView, buffer: Uint8Array): Promise<void> => {
    const index = seg.index;
    let buffered = 0, position = seg.current, written = position, lastCommit = performance.now();
    const writeBuffer = async () => {
      if (!buffered) return;
      const started = performance.now();
      try { await options.partStore.writeAt(options.partKey, written, buffer.subarray(0, buffered)); }
      catch (err) { throw new StorageError("写入下载数据失败", { cause: err }); }
      finally { metrics.writeMs += performance.now() - started; }
      written += buffered;
      buffered = 0;
    };
    const checkpoint = async () => {
      await writeBuffer();
      try {
        if (options.partStore.sync) await options.partStore.sync(options.partKey);
        else await options.partStore.flush?.(options.partKey);
      } catch (err) { throw new StorageError("提交下载数据失败", { cause: err }); }
      committed[index] = written;
      seg.current = written;
      lastCommit = performance.now();
      emit(true);
    };
    for (let attempt = 0; ; attempt++) {
      group.signal.throwIfAborted();
      let stream: Awaited<ReturnType<typeof openHttpStream>> | undefined;
      try {
        const headers = requestHeaders(options.headers);
        const ranged = probe.rangeSupported;
        const requestStart = position;
        if (ranged) {
          headers.set("Range", `bytes=${position}-${seg.end - 1}`);
          const tag = validator(probe);
          if (tag) headers.set("If-Range", tag);
        }
        metrics.requests++;
        stream = await openHttpStream(fetchFn, probe.finalUrl, {
          headers, credentials: options.carryCookies ? "include" : "omit", signal: group.signal,
        }, options.timeoutMs);
        const r = stream.response;
        if (r.status === 408 || r.status === 429 || r.status >= 500) throw new TransientError(`HTTP ${r.status}`);
        if (ranged) {
          const range = contentRange(r.headers.get("content-range"));
          if (r.status !== 206 || !range || range.start !== requestStart || range.end !== seg.end - 1 || range.total !== total)
            throw new ResponseError("服务器返回的分片范围已变化，请重新下载");
          const length = contentLength(r.headers);
          if (length !== null && length !== seg.end - requestStart) throw new ResponseError("分片长度不匹配");
        } else {
          if (r.status !== 200) throw new ResponseError(`HTTP ${r.status}`);
          const length = contentLength(r.headers);
          if (total !== null && length !== null && length !== total) throw new ResponseError("服务器文件长度已变化，请重新下载");
          if (total === null && length !== null) { total = length; seg.end = length; }
        }
        if (probe.etag && r.headers.has("etag") && r.headers.get("etag") !== probe.etag)
          throw new ResponseError("服务器文件版本已变化，请重新下载");
        seg.state = "downloading";
        while (true) {
          const { value, done } = await stream.read();
          if (done) break;
          group.signal.throwIfAborted();
          if (!value?.byteLength) continue;
          metrics.networkBytes += value.byteLength;
          if (total !== null && position + value.byteLength > seg.end) throw new ResponseError("响应超出请求范围");
          await options.rateLimiter?.acquire(value.byteLength, group.signal);
          for (let at = 0; at < value.length;) {
            const count = Math.min(buffer.length - buffered, value.length - at);
            buffer.set(value.subarray(at, at + count), buffered);
            at += count; buffered += count; position += count;
            received[index] = position;
            if (buffered === buffer.length) await writeBuffer();
          }
          if (total === null) seg.end = position;
          if (performance.now() - lastCommit >= CHECKPOINT_MS) await checkpoint();
          emit();
        }
        if (total !== null && position !== seg.end) throw new TransientError("分片连接提前关闭");
        await checkpoint();
        seg.state = "completed";
        if (!probe.rangeSupported && total === null) total = position;
        return;
      } catch (err) {
        // Flush valid buffered bytes on cancellation/network failures, never discard
        // them after advancing a resume offset. Storage failures cannot be retried.
        if (!(err instanceof StorageError)) await checkpoint();
        if (group.signal.aborted || err instanceof StorageError || err instanceof ResponseError
          || !probe.rangeSupported || attempt >= 4
          || !(err instanceof TypeError || err instanceof TransientError || (err instanceof DOMException && err.name === "TimeoutError"))) throw err;
        metrics.retries++;
        await stream?.close(); stream = undefined;
        await abortableDelay(Math.min(8000, 300 * 2 ** attempt), group.signal);
      } finally { await stream?.close(); }
    }
  };
  emit(true);
  try {
    if (total !== 0) {
      const workers = Array.from({ length: probe.rangeSupported ? connections : 1 }, async () => {
        const buffer = new Uint8Array(WRITE_BUFFER_BYTES);
        try {
          while (!group.signal.aborted) {
            const seg = segments[cursor++];
            if (!seg) break;
            if (seg.current < seg.end || !probe.rangeSupported) await downloadSegment(seg, buffer);
          }
        } catch (err) { if (failure === undefined) failure = err; group.abort(err); }
      });
      await Promise.all(workers);
      if (failure !== undefined) throw failure;
      group.signal.throwIfAborted();
    } else segments[0].state = "completed";
    await options.partStore.flush?.(options.partKey);
    if (await options.partStore.size(options.partKey) !== total) throw new StorageError("最终文件长度不匹配");
    if (expected) {
      options.onPhase?.("verifying");
      const actual = await hashBlobSha256(await options.partStore.toBlob(options.partKey), options.signal);
      if (actual !== expected) {
        for (const s of segments) {
          s.current = received[s.index] = committed[s.index] = s.start;
          s.state = "pending";
        }
        throw new Error(`SHA-256 校验不匹配（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
      }
    }
    emit(true);
    metrics.elapsedMs = performance.now() - startTime;
    return { finalUrl: probe.finalUrl, fileName: sanitizeFileName(probe.fileName || guessFileNameFromUrl(probe.finalUrl)),
      total: total ?? 0, etag: probe.etag, lastModified: probe.lastModified,
      rangeSupported: probe.rangeSupported, segments, metrics };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    group.abort();
    // All workers have settled, so no writes can race with pause/delete/new runs.
    await options.partStore.flush?.(options.partKey);
    emit(true);
  }
}
