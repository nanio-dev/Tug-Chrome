import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { runHttpDownload, type HttpDownloadProgress } from "../src/engine/http/downloader.ts";
import { MemoryPartStorage } from "../src/engine/storage/part-store.ts";
import { Sha256, hashBlobSha256 } from "../src/engine/http/sha256.ts";
import { RateLimiter } from "../src/engine/http/rate-limiter.ts";

const bytes = randomBytes(512 * 1024 + 123);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const sourceUrl = "https://example.test/file.bin";
function rangeFetch(data = bytes, change?: (start: number, end: number, probe: boolean) => Response | undefined): typeof fetch {
  return (async (_input, init) => {
    init?.signal?.throwIfAborted();
    const header = new Headers(init?.headers).get("range");
    const m = header?.match(/^bytes=(\d+)-(\d+)$/);
    const start = m ? Number(m[1]) : 0, end = m ? Number(m[2]) : data.length - 1;
    const probe = header === "bytes=0-0";
    return change?.(start, end, probe) ?? new Response(data.subarray(start, end + 1), {
      status: m ? 206 : 200, headers: { "Content-Range": `bytes ${start}-${end}/${data.length}`,
        "Content-Length": String(end - start + 1), "ETag": '"v1"' },
    });
  }) as typeof fetch;
}
const run = (store = new MemoryPartStorage(), fetchImpl = rangeFetch(), extra: Partial<Parameters<typeof runHttpDownload>[0]> = {}) =>
  runHttpDownload({ url: sourceUrl, partKey: "part", partStore: store, connections: 4, carryCookies: false,
    fetchImpl, signal: new AbortController().signal, ...extra });

describe("HTTP data integrity and recovery", () => {
  for (const kind of ["ignored-range", "wrong-range", "changed-etag"] as const) {
    it(`rejects ${kind} instead of reporting a corrupt file as complete`, async () => {
      const store = new MemoryPartStorage();
      await assert.rejects(run(store, rangeFetch(bytes, (start, end, probe) => {
        if (probe) return;
        if (kind === "ignored-range") return new Response(bytes, { status: 200 });
        return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
          "Content-Range": kind === "wrong-range" ? `bytes 0-${end - start}/${bytes.length}` : `bytes ${start}-${end}/${bytes.length}`,
          "ETag": kind === "changed-etag" ? '"v2"' : '"v1"',
        } });
      })), /分片范围|版本/);
    });
  }

  it("propagates disk failures without retrying or committing buffered data", async () => {
    class BrokenDisk extends MemoryPartStorage {
      writes = 0;
      async writeAt(): Promise<void> { this.writes++; throw new Error("Disk full"); }
    }
    const store = new BrokenDisk();
    const progress: HttpDownloadProgress[] = [];
    await assert.rejects(run(store, rangeFetch(), { onProgress: p => progress.push(p) }), /写入/);
    assert.ok(store.writes <= 4, "disk errors must not run the network retry loop");
    assert.ok(progress.every(p => p.committedBytes === 0));
  });

  it("does not advance durable offsets when sync fails", async () => {
    class BrokenSync extends MemoryPartStorage { async sync(): Promise<void> { throw new Error("fsync failed"); } }
    const progress: HttpDownloadProgress[] = [];
    await assert.rejects(run(new BrokenSync(), rangeFetch(), { onProgress: p => progress.push(p) }), /提交/);
    assert.ok(progress.every(p => p.committedBytes === 0));
  });

  it("retries a truncated stream at the committed byte offset with If-Range", async () => {
    const store = new MemoryPartStorage();
    const requests: string[] = [];
    let first = true;
    const normal = rangeFetch();
    const result = await run(store, (async (input, init) => {
      const headers = new Headers(init?.headers);
      const range = headers.get("range")!;
      requests.push(range);
      if (range !== "bytes=0-0") assert.equal(headers.get("if-range"), '"v1"');
      if (first && range !== "bytes=0-0") {
        first = false;
        return new Response(bytes.subarray(0, 65536), { status: 206, headers: {
          "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`, "Content-Length": String(bytes.length),
        } });
      }
      return normal(input, init);
    }) as typeof fetch, { connections: 1 });
    assert.ok(requests.includes(`bytes=65536-${bytes.length - 1}`));
    assert.equal(result.metrics.retries, 1);
    assert.equal(digest(await store.readAll("part")), digest(bytes));
  });

  it("safely resumes validated extents and resets them when the validator disappears", async () => {
    for (const etag of ['"v1"', null]) {
      const store = new MemoryPartStorage();
      await store.allocate("part", bytes.length);
      await store.writeAt("part", 0, bytes.subarray(0, 65536));
      let firstRange = "";
      const normal = rangeFetch();
      await run(store, (async (input, init) => {
        const h = new Headers(init?.headers).get("range")!;
        if (h !== "bytes=0-0" && !firstRange) firstRange = h;
        return normal(input, init);
      }) as typeof fetch, { connections: 1, resumeState: {
        etag, lastModified: null, total: bytes.length, rangeSupported: true,
        segments: [{ index: 0, start: 0, current: 65536, end: bytes.length, state: "pending" }],
      } });
      assert.equal(firstRange, `bytes=${etag ? 65536 : 0}-${bytes.length - 1}`);
      assert.equal(digest(await store.readAll("part")), digest(bytes));
    }
  });

  it("settles sibling requests before a failed download returns", async () => {
    let active = 0;
    const normal = rangeFetch();
    await assert.rejects(run(new MemoryPartStorage(), (async (input, init) => {
      const h = new Headers(init?.headers).get("range")!;
      if (h === "bytes=0-0") return normal(input, init);
      if (h.startsWith("bytes=0-")) return new Response(bytes, { status: 200 });
      active++;
      return new Promise<Response>((_, reject) => {
        const aborted = () => { active--; reject(init!.signal!.reason); };
        init!.signal!.addEventListener("abort", aborted, { once: true });
        if (init!.signal!.aborted) aborted();
      });
    }) as typeof fetch), /分片范围/);
    assert.equal(active, 0);
  });

  it("times out a stalled probe and honors an already canceled signal", async () => {
    const stalled = (async (_input, init) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })) as typeof fetch;
    await assert.rejects(run(new MemoryPartStorage(), stalled, { timeoutMs: 20 }), { name: "TimeoutError" });
    const canceled = AbortSignal.abort();
    await assert.rejects(run(new MemoryPartStorage(), stalled, { signal: canceled }), { name: "AbortError" });
  });

  it("resets a larger old file and trims growing buffers to their logical length", async () => {
    const store = new MemoryPartStorage();
    await store.allocate("part", 2 * bytes.length);
    await store.writeAt("part", 0, randomBytes(2 * bytes.length));
    await run(store);
    assert.equal((await store.toBlob("part")).size, bytes.length);
    await store.allocate("unknown", 0);
    await store.writeAt("unknown", 0, new Uint8Array(3));
    await store.writeAt("unknown", 3, new Uint8Array(1));
    assert.equal((await store.readAll("unknown")).length, 4);
  });

  it("checks empty files and hashes downloads without readAll", async () => {
    const empty = (async () => new Response(null, { status: 416, headers: { "Content-Range": "bytes */0" } })) as typeof fetch;
    await run(new MemoryPartStorage(), empty, { expectedSha256: digest(new Uint8Array()) });
    await assert.rejects(run(new MemoryPartStorage(), empty, { expectedSha256: "0".repeat(64) }), /校验不匹配/);
    class NoReadAll extends MemoryPartStorage {
      async readAll(): Promise<Uint8Array> { throw new Error("whole-file allocation forbidden"); }
      async toBlob(): Promise<Blob> { return new Blob([bytes]); }
    }
    await run(new NoReadAll(), rangeFetch(), { expectedSha256: digest(bytes) });
  });

  it("uses decoded lengths for compressed single streams", async () => {
    const store = new MemoryPartStorage();
    const decoded = new Uint8Array(65536).fill(42);
    const compressed = (async () => new Response(decoded, { status: 200, headers: {
      "Content-Encoding": "gzip", "Content-Length": "97",
    } })) as typeof fetch;
    const result = await run(store, compressed);
    assert.equal(result.total, decoded.length);
    assert.deepEqual(await store.readAll("part"), decoded);
  });
});

describe("Incremental SHA-256", () => {
  it("matches native SHA-256 across padding boundaries, sliced buffers and many updates", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000000]) {
      const data = randomBytes(length);
      for (const chunk of [1, 63, 65537]) {
        const hash = new Sha256();
        for (let i = 0; i < data.length; i += chunk) hash.update(data.subarray(i, i + chunk));
        assert.equal(hash.digestHex(), digest(data), `length=${length}, chunk=${chunk}`);
      }
    }
    assert.equal(await hashBlobSha256(new Blob(["abc"]), new AbortController().signal),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("Global rate limiter", () => {
  it("retains more than two seconds of debt for a large chunk", async () => {
    const limiter = new RateLimiter(32 * 1024);
    const start = performance.now();
    await limiter.acquire(80 * 1024);
    assert.ok(performance.now() - start >= 2450);
  });
  it("wakes immediately when limiting is disabled and cancels queued tasks promptly", async () => {
    const limiter = new RateLimiter(1);
    const first = limiter.acquire(10000);
    const abort = new AbortController();
    const queued = limiter.acquire(10000, abort.signal);
    abort.abort();
    await assert.rejects(queued, { name: "AbortError" });
    limiter.setRateBps(null);
    await first;
  });
});
