import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  buildInitialSegments,
  computeSha256Hex,
  runHttpDownload,
  stealSegmentWork,
} from "../src/engine/http/downloader.ts";
import { MemoryPartStorage } from "../src/engine/storage/part-store.ts";

describe("HTTP Multi-Connection Segmented Engine", () => {
  let server: Server;
  let baseUrl = "";
  const fileBuffer = new Uint8Array(512 * 1024); // 512 KiB
  for (let i = 0; i < fileBuffer.byteLength; i++) {
    fileBuffer[i] = (i * 31 + 17) & 0xff;
  }

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (url.pathname === "/range-file.bin") {
        const range = req.headers.range;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("ETag", '"tug-etag-v1"');
        res.setHeader(
          "Content-Disposition",
          "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%E5%8C%85.bin",
        );

        if (range) {
          const m = range.match(/bytes=(\d+)-(\d+)/);
          if (m) {
            const start = Number(m[1]);
            const end = Math.min(fileBuffer.byteLength - 1, Number(m[2]));
            const slice = fileBuffer.subarray(start, end + 1);
            res.statusCode = 206;
            res.setHeader(
              "Content-Range",
              `bytes ${start}-${end}/${fileBuffer.byteLength}`,
            );
            res.setHeader("Content-Length", String(slice.byteLength));
            res.end(Buffer.from(slice));
            return;
          }
        }
        res.statusCode = 200;
        res.setHeader("Content-Length", String(fileBuffer.byteLength));
        res.end(Buffer.from(fileBuffer));
        return;
      }

      if (url.pathname === "/no-range.bin") {
        res.statusCode = 200;
        res.setHeader("Content-Length", String(fileBuffer.byteLength));
        res.end(Buffer.from(fileBuffer));
        return;
      }

      res.statusCode = 404;
      res.end("Not found");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(() => {
    server.close();
  });

  it("splits initial segments and steals work from largest active segment", () => {
    const segs = buildInitialSegments(10 * 1024 * 1024, 4);
    assert.equal(segs.length, 4);
    assert.equal(segs[0].start, 0);
    assert.equal(segs[3].end, 10 * 1024 * 1024);

    segs[0].state = "completed";
    segs[0].current = segs[0].end;
    segs[1].state = "downloading";
    segs[1].current = segs[1].start + 128 * 1024;
    segs[2].state = "completed";
    segs[2].current = segs[2].end;
    segs[3].state = "completed";
    segs[3].current = segs[3].end;

    const stolen = stealSegmentWork(segs, 256 * 1024);
    assert.ok(stolen, "should steal second half of segment #1");
    assert.equal(segs.length, 5);
    assert.equal(segs[1].end, stolen.start);
  });

  it("downloads with 8 concurrent Range connections, decodes RFC5987 filename, and verifies SHA-256", async () => {
    const partStore = new MemoryPartStorage();
    const expectedHash = await computeSha256Hex(fileBuffer);
    const controller = new AbortController();

    const result = await runHttpDownload({
      url: `${baseUrl}/range-file.bin`,
      partKey: "test-range",
      partStore,
      connections: 8,
      carryCookies: false,
      expectedSha256: expectedHash,
      signal: controller.signal,
    });

    assert.equal(result.rangeSupported, true);
    assert.equal(result.fileName, "中文包.bin");
    assert.equal(result.total, fileBuffer.byteLength);

    const downloaded = await partStore.readAll("test-range");
    assert.equal(await computeSha256Hex(downloaded), expectedHash);
  });

  it("falls back to single stream when server returns 200 OK instead of 206", async () => {
    const partStore = new MemoryPartStorage();
    const expectedHash = await computeSha256Hex(fileBuffer);
    const controller = new AbortController();

    const result = await runHttpDownload({
      url: `${baseUrl}/no-range.bin`,
      partKey: "test-norange",
      partStore,
      connections: 8,
      carryCookies: false,
      expectedSha256: expectedHash,
      signal: controller.signal,
    });

    assert.equal(result.rangeSupported, false);
    assert.equal(result.total, fileBuffer.byteLength);
  });
});
