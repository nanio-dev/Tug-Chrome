import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { TaskManager } from "../src/engine/core/manager.ts";
import { MemoryPartStorage } from "../src/engine/storage/part-store.ts";
import { MemoryTaskStore } from "../src/engine/storage/task-store.ts";
import { encodeBencode, utf8ToBytes } from "../src/engine/torrent/bencode.ts";
import {
  bytesToHex,
  computeSha1Bytes,
  type ParsedTorrent,
  uint8ArrayToBase64,
} from "../src/engine/torrent/parser.ts";
import { buildBucketedTorrentSegments } from "../src/engine/torrent/session.ts";

describe("TaskManager & BitTorrent/Magnet WebSeed Hybrid Engine", () => {
  let server: Server;
  let baseUrl = "";

  const fileA = utf8ToBytes("File A content inside BitTorrent multi-file archive. ".repeat(400));
  const fileB = utf8ToBytes("File B content inside BitTorrent multi-file archive! ".repeat(500));
  const combined = new Uint8Array(fileA.byteLength + fileB.byteLength);
  combined.set(fileA, 0);
  combined.set(fileB, fileA.byteLength);

  const pieceLength = 8192;
  let torrentBytes: Uint8Array = new Uint8Array(0);
  let infoHashHex = "";

  before(async () => {
    const numPieces = Math.ceil(combined.byteLength / pieceLength);
    const piecesConcat = new Uint8Array(numPieces * 20);
    for (let i = 0; i < numPieces; i++) {
      const slice = combined.subarray(i * pieceLength, (i + 1) * pieceLength);
      const h = await computeSha1Bytes(slice);
      piecesConcat.set(h, i * 20);
    }

    server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (url.pathname === "/sample.torrent") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-bittorrent");
        res.end(Buffer.from(torrentBytes));
        return;
      }

      // Directory-style BEP 19 WebSeed: /webseed/<torrentName>/<filePath>
      if (url.pathname === "/webseed/tug-bundle/alpha.txt") {
        serveRangeBuffer(req.headers.range, fileA, res);
        return;
      }
      if (url.pathname === "/webseed/tug-bundle/beta.txt") {
        serveRangeBuffer(req.headers.range, fileB, res);
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

    const infoDict = {
      files: [
        { length: fileA.byteLength, path: [utf8ToBytes("alpha.txt")] },
        { length: fileB.byteLength, path: [utf8ToBytes("beta.txt")] },
      ],
      name: utf8ToBytes("tug-bundle"),
      "piece length": pieceLength,
      pieces: piecesConcat,
    };
    infoHashHex = bytesToHex(await computeSha1Bytes(encodeBencode(infoDict)));
    torrentBytes = encodeBencode({
      "url-list": [`${baseUrl}/webseed/`],
      info: infoDict,
    });
  });

  after(() => {
    server.close();
  });

  it("downloads a multi-file .torrent with file selection (onlyFiles) and SHA-1 piece verification", async () => {
    const exportedFiles: Array<{ path: string; size: number }> = [];
    const manager = new TaskManager({
      store: new MemoryTaskStore(),
      partStore: new MemoryPartStorage(),
      hooks: {
        onExportFile: async ({ blob, relativePath }) => {
          exportedFiles.push({ path: relativePath, size: blob.size });
          return 1001;
        },
      },
    });

    await manager.updateSettings({ standaloneMode: true, btWebRtcEnabled: false, btCustomTrackers: [] });
    // 只选择第二个文件 (beta.txt, index = 1)
    const view = await manager.addTask({
      url: "",
      onlyFiles: [1],
      torrentBytesBase64: uint8ArrayToBase64(torrentBytes),
    });

    // 等待任务完成
    let finalView = view;
    for (let i = 0; i < 60; i++) {
      const current = await manager.getTaskView(view.id);
      if (current && (current.state === "completed" || current.state === "failed")) {
        finalView = current;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(finalView.state, "completed", `error: ${finalView.error}`);
    assert.equal(exportedFiles.length, 1);
    assert.equal(exportedFiles[0].path, "tug-bundle/beta.txt");
    assert.equal(exportedFiles[0].size, fileB.byteLength);
  });

  it("downloads a magnet link with xs= exact source and ws= WebSeed", async () => {
    const exportedFiles: Array<{ path: string; size: number }> = [];
    const manager = new TaskManager({
      store: new MemoryTaskStore(),
      partStore: new MemoryPartStorage(),
      hooks: {
        onExportFile: async ({ blob, relativePath }) => {
          exportedFiles.push({ path: relativePath, size: blob.size });
          return 1002;
        },
      },
    });

    await manager.updateSettings({ standaloneMode: true, btWebRtcEnabled: false, btCustomTrackers: [] });
    const magnetUri = `magnet:?xt=urn:btih:${infoHashHex}&dn=tug-bundle&xs=${encodeURIComponent(`${baseUrl}/sample.torrent`)}&ws=${encodeURIComponent(`${baseUrl}/webseed/`)}`;
    const view = await manager.addTask({ url: magnetUri });

    let finalView = view;
    for (let i = 0; i < 60; i++) {
      const current = await manager.getTaskView(view.id);
      if (current && (current.state === "completed" || current.state === "failed")) {
        finalView = current;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(finalView.state, "completed", `error: ${finalView.error}`);
    assert.equal(exportedFiles.length, 2);
  });

  it("never invokes native helper when standaloneMode is enabled", async () => {
    let helperEnsureCalls = 0;
    const manager = new TaskManager({
      store: new MemoryTaskStore(),
      partStore: new MemoryPartStorage(),
      hooks: {
        onEnsureNativeHelper: async () => {
          helperEnsureCalls += 1;
          return true;
        },
        onExportFile: async () => 1003,
      },
    });

    await manager.updateSettings({ standaloneMode: true, btWebRtcEnabled: false, btCustomTrackers: [] });
    const view = await manager.addTask({
      url: "",
      onlyFiles: [0],
      torrentBytesBase64: uint8ArrayToBase64(torrentBytes),
    });

    let finalView = view;
    for (let i = 0; i < 60; i++) {
      const current = await manager.getTaskView(view.id);
      if (current && (current.state === "completed" || current.state === "failed")) {
        finalView = current;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(finalView.state, "completed", `error: ${finalView.error}`);
    assert.equal(helperEnsureCalls, 0);
  });

  it("buckets 3024 torrent pieces into 32 contiguous visual segments", () => {
    const pieceLength = 262144;
    const pieceCount = 3024;
    const totalLength = pieceCount * pieceLength - 12345;
    const mockMeta: ParsedTorrent = {
      name: "debian-13.7.0-amd64-netinst.iso",
      infoHash: "00".repeat(20),
      infoHashBytes: new Uint8Array(20),
      pieceLength,
      pieceHashes: Array.from({ length: pieceCount }, () => "11".repeat(20)),
      totalLength,
      isMultiFile: false,
      files: [{ index: 0, path: "debian-13.7.0-amd64-netinst.iso", length: totalLength, offset: 0 }],
      trackers: [],
      webSeeds: [],
    };
    const required = Array.from({ length: pieceCount }, (_, i) => i);
    const completed = new Set<number>(required.slice(0, 1512));
    const inFlight = new Set<number>([1512, 1513]);

    const buckets = buildBucketedTorrentSegments(mockMeta, required, completed, inFlight, 32);
    assert.equal(buckets.length, 32);
    assert.equal(buckets[0].start, 0);
    assert.equal(buckets[buckets.length - 1].end, totalLength);
    assert.equal(buckets[0].state, "completed");
    assert.equal(buckets[16].state, "downloading");
    assert.equal(buckets[31].state, "pending");

    const coveredBytes = buckets.reduce((acc, s) => acc + (s.end - s.start), 0);
    assert.equal(coveredBytes, totalLength);
  });

  it("preserves downloaded part data and MIME type when export fails/cancels, then resumes export without re-downloading", async () => {
    const partStore = new MemoryPartStorage();
    let exportCalls = 0;
    let webSeedRequestCount = 0;
    const manager = new TaskManager({
      store: new MemoryTaskStore(),
      partStore,
      hooks: {
        fetchImpl: async (input, init) => {
          const urlStr = typeof input === "string" ? input : input.toString();
          if (urlStr.includes("/webseed/")) {
            webSeedRequestCount += 1;
          }
          return fetch(input, init);
        },
        onExportFile: async ({ blob }) => {
          exportCalls += 1;
          assert.equal(blob.type, "application/octet-stream");
          assert.equal(blob.size, fileA.byteLength);
          if (exportCalls === 1) {
            throw new Error("已取消保存文件（点击「继续」可重新保存，无需重新下载）");
          }
          return { downloadId: 2001, savedPath: "D:\\Downloads\\alpha.txt" };
        },
      },
    });

    await manager.updateSettings({ standaloneMode: true, btWebRtcEnabled: false, btCustomTrackers: [] });
    const view = await manager.addTask({
      url: "",
      onlyFiles: [0],
      torrentBytesBase64: uint8ArrayToBase64(torrentBytes),
    });

    let afterFirstRun = view;
    for (let i = 0; i < 60; i++) {
      const current = await manager.getTaskView(view.id);
      if (current && (current.state === "failed" || current.state === "completed")) {
        afterFirstRun = current;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(afterFirstRun.state, "failed");
    assert.equal(afterFirstRun.downloaded, afterFirstRun.total);
    assert.ok(afterFirstRun.downloaded >= fileA.byteLength);
    assert.ok(await partStore.exists(`bt-${view.id}-file-0`));
    const requestsAfterFirstRun = webSeedRequestCount;
    assert.ok(requestsAfterFirstRun > 0);

    // 点击“继续”重新导出：不应触发任何新的网络请求
    await manager.resumeTask(view.id);
    let finalView = afterFirstRun;
    for (let i = 0; i < 60; i++) {
      const current = await manager.getTaskView(view.id);
      if (current && current.state === "completed") {
        finalView = current;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(finalView.state, "completed", `error: ${finalView.error}`);
    assert.equal(exportCalls, 2);
    assert.equal(webSeedRequestCount, requestsAfterFirstRun);
  });
});

function serveRangeBuffer(
  rangeHeader: string | undefined,
  buf: Uint8Array,
  res: import("node:http").ServerResponse,
) {
  res.setHeader("Accept-Ranges", "bytes");
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d+)/);
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(buf.byteLength - 1, Number(m[2]));
      const slice = buf.subarray(start, end + 1);
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${buf.byteLength}`);
      res.setHeader("Content-Length", String(slice.byteLength));
      res.end(Buffer.from(slice));
      return;
    }
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", String(buf.byteLength));
  res.end(Buffer.from(buf));
}
