import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bytesToUtf8,
  decodeBencode,
  encodeBencode,
  utf8ToBytes,
} from "../src/engine/torrent/bencode.ts";
import {
  base32ToBytes,
  bytesToHex,
  computeSha1Bytes,
  parseMagnetUri,
  parseTorrentBuffer,
} from "../src/engine/torrent/parser.ts";

describe("Bencode & Torrent/Magnet Parser", () => {
  it("round-trips bencode integers, strings, lists, and dictionaries", () => {
    const sample = {
      announce: "https://tracker.example.com/announce",
      "creation date": 1731570000,
      info: {
        length: 65536,
        name: "ubuntu-minimal.iso",
        "piece length": 32768,
        pieces: new Uint8Array(40).fill(0xab),
      },
    };

    const encoded = encodeBencode(sample);
    const decoded = decodeBencode(encoded, 0, true);
    assert.ok(decoded.rawInfoSlice, "should capture raw info slice");

    const root = decoded.value as Record<string, unknown>;
    assert.equal(
      bytesToUtf8(root["announce"] as Uint8Array),
      "https://tracker.example.com/announce",
    );
    assert.equal(root["creation date"], 1731570000);
  });

  it("parses single-file and multi-file .torrent buffers and computes exact SHA-1 infoHash", async () => {
    const piece0 = utf8ToBytes("Hello Tug BitTorrent Piece 0!");
    const piece1 = utf8ToBytes("Second Piece Data for Verification");
    const hash0 = await computeSha1Bytes(piece0);
    const hash1 = await computeSha1Bytes(piece1);
    const piecesConcat = new Uint8Array(40);
    piecesConcat.set(hash0, 0);
    piecesConcat.set(hash1, 20);

    const infoDict = {
      files: [
        { length: piece0.byteLength, path: [utf8ToBytes("docs"), utf8ToBytes("readme.txt")] },
        { length: piece1.byteLength, path: [utf8ToBytes(".."), utf8ToBytes("payload.bin")] },
      ],
      name: utf8ToBytes("multi-pack"),
      "piece length": 64,
      pieces: piecesConcat,
    };

    const rawInfoBytes = encodeBencode(infoDict);
    const expectedInfoHash = bytesToHex(await computeSha1Bytes(rawInfoBytes));

    const torrentBytes = encodeBencode({
      announce: "wss://tracker.openwebtorrent.com",
      "url-list": ["https://cdn.example.com/seeds/"],
      info: infoDict,
    });

    const parsed = await parseTorrentBuffer(torrentBytes);
    assert.equal(parsed.infoHash, expectedInfoHash);
    assert.equal(parsed.name, "multi-pack");
    assert.equal(parsed.isMultiFile, true);
    assert.equal(parsed.files.length, 2);
    assert.equal(parsed.files[0].path, "docs/readme.txt");
    // 确认 '..' 路径穿越段被过滤
    assert.equal(parsed.files[1].path, "payload.bin");
    assert.equal(parsed.pieceHashes.length, 2);
    assert.deepEqual(parsed.webSeeds, ["https://cdn.example.com/seeds/"]);
  });

  it("parses both 40-hex and 32-base32 magnet URIs", () => {
    const hexHash = "0123456789abcdef0123456789abcdef01234567";
    const magnetHex = parseMagnetUri(
      `magnet:?xt=urn:btih:${hexHash}&dn=Debian+13.7+ISO&tr=wss%3A%2F%2Ftracker.example.com&ws=https%3A%2F%2Fmirror.example.com%2Fdebian.iso`,
    );
    assert.equal(magnetHex.infoHash, hexHash);
    assert.equal(magnetHex.name, "Debian 13.7 ISO");
    assert.ok(magnetHex.trackers.includes("wss://tracker.example.com"));
    assert.ok(magnetHex.webSeeds.includes("https://mirror.example.com/debian.iso"));

    // Base32 of 20 bytes of 0x00 is 32 'A's
    const base32Zeros = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    assert.equal(bytesToHex(base32ToBytes(base32Zeros)), "0".repeat(40));
    const magnetB32 = parseMagnetUri(`magnet:?xt=urn:btih:${base32Zeros}&dn=ZeroTest`);
    assert.equal(magnetB32.infoHash, "0".repeat(40));
  });
});
