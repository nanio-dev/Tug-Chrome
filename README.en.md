# Tug Web

<p align="center">
  <img src="public/tug-icon.png" alt="Tug Web Logo" width="108" />
</p>

<p align="center">
  <strong>100% Standalone Multi-Connection HTTP & BitTorrent / Magnet P2P Download Manager Extension (Chrome / Edge Manifest V3)</strong>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> | English
</p>

---

**Tug Web** is a **100% standalone browser download manager extension** in the Tug family built for Chromium-based browsers (Chrome, Edge, Brave, Arc). It requires **no desktop companion app and no Native Messaging binary**—all download scheduling, multi-connection HTTP range segmentation, BitTorrent/Magnet swarming, and random-access disk persistence run directly inside the browser via **Offscreen Document + OPFS (Origin Private File System)**:

- **Multi-Connection Segmented HTTP/HTTPS Engine (1–32 Connections) with Dynamic Work Stealing**
- **In-Browser BitTorrent (`.torrent`) & Magnet (`magnet:?xt=urn:btih:...`) Engine** (WebTorrent WebRTC DataChannel P2P + BEP 19 HTTP/HTTPS WebSeed hybrid acceleration + per-piece SHA-1 verification)
- **Automatic Browser Download Takeover, Magnet Click Capture, Context Menus & Batch Link Sniffer**

---

## Key Features

### 1. 100% Standalone — Zero External Dependencies
- Runs entirely inside the browser extension sandbox with no requirement for `Tug Desktop`, Python, Node.js, or external helper binaries.
- Built on a dual-layer **Service Worker + Offscreen Document** architecture so downloads continue uninterrupted when the popup is closed or tabs are switched.

### 2. Multi-Connection HTTP/HTTPS Engine with Work Stealing
- Automatically probes `Accept-Ranges`, `Content-Range`, `ETag`, and `Last-Modified`, and decodes RFC 5987 / RFC 6266 `Content-Disposition` filenames.
- Supports **1–32 concurrent connections**. When a worker finishes its assigned byte range early, it dynamically splits the largest remaining active segment (`>= 256 KiB`) in half (**Work Stealing**) to maximize tail throughput.
- Crash-safe pause & resume backed by `IndexedDB` segment checkpoints and `ETag` verification, with automatic single-stream fallback when a server responds with `200 OK`.
- Optional **SHA-256 checksum verification** and **global token-bucket bandwidth rate limiting (KiB/s)**.

### 3. Hybrid In-Browser BitTorrent & Magnet Engine
- Zero-dependency **Bencode encoder/decoder** with exact raw `info` slice extraction for 20-byte SHA-1 `info_hash` calculation.
- Supports local `.torrent` file uploads, remote `.torrent` URLs, and `magnet:?xt=urn:btih:...` links (both 40-char Hex and 32-char Base32).
- **WebTorrent (WebRTC DataChannel) + WebSocket Trackers (`wss://`)**: exchanges pieces with browser peers using the BitTorrent peer wire protocol (`bitfield`, `interested`, `unchoke`, `request`, `piece`) and fetches magnet metadata via **BEP 10 / BEP 9 (`ut_metadata`)**.
- **BEP 19 HTTP/HTTPS WebSeed (`url-list` / `ws=`) + `xs=` Exact Metadata Source**: accelerates open-source distributions and hybrid torrents with concurrent HTTP range piece fetching and strict per-piece **SHA-1 verification**.
- Supports **selective file downloading (`onlyFiles`)** for multi-file torrents.

### 4. OPFS Zero-RAM Random Disk Storage & System Export
- Writes HTTP segments and BitTorrent pieces directly to disk at arbitrary byte offsets via `FileSystemFileHandle.createWritable({ keepExistingData: true })` + `seek(offset)`, avoiding in-memory `Blob` concatenation for large multi-gigabyte downloads.
- Automatically (or manually) exports completed files to the OS Downloads folder via `chrome.downloads` and cleans up temporary OPFS cache.

### 5. Smart Download Interception & Tug Material You UI
- Configurable `chrome.downloads.onCreated` takeover, minimum file-size threshold (MB), extension allowlist, domain blocklist, and `Alt`-click temporary bypass.
- Crafted with the Tug family's **Material You Olive & Warm Cream (Light & Dark)** design system, featuring a **Toolbar Popup**, **Full-Page Download Manager (`manager.html`)**, **Options Page (`options.html`)**, and built-in **Simplified Chinese (`zh-CN`) / English (`en-US`)** localization.

---

## Project Layout

```text
Tug-Web/
├── docs/
│   ├── architecture.md          # MV3 standalone architecture, OPFS storage & module design
│   ├── protocol.md              # Internal extension RPC bus protocol & engine schemas
│   ├── privacy.md               # Least-privilege permissions & privacy policy
│   └── testing.md               # Automated test suite & manual QA checklist
├── public/
│   ├── manifest.json            # Chrome / Edge Manifest V3 manifest
│   ├── icons/                   # 16 / 32 / 48 / 64 / 128 extension icons
│   └── _locales/                # zh_CN / en Chrome extension locale bundles
├── scripts/
│   └── build-extension.mjs      # Bundles background.js / content.js and syncs dist/extension
├── src/
│   ├── shared/                  # Types, RPC client, filename sanitizer, formatters, i18n, styles
│   ├── engine/
│   │   ├── storage/             # OPFS random-write store (part-store.ts) & IndexedDB store (task-store.ts)
│   │   ├── http/                # HTTP Range multi-connection downloader, work stealing & rate limiter
│   │   ├── torrent/             # Bencode codec, Torrent/Magnet parser, WebTorrent + WebSeed session
│   │   └── core/                # TaskManager scheduler, pause/resume & system file export
│   ├── offscreen/               # Offscreen Document host for persistent downloads & WebRTC
│   ├── background/              # MV3 Service Worker: interception, context menus, badge & notifications
│   ├── content/                 # Magnet link capture, Alt-key bypass tracking & page link sniffer
│   ├── popup/                   # Toolbar Popup mini dashboard
│   ├── manager/                 # Full-screen Download Manager workspace
│   └── options/                 # Standalone extension options page
└── tests/                       # Automated tests (Bencode, HTTP Range engine, BT/Magnet, interceptor & i18n)
```

---

## Quick Start

### Prerequisites
- **Node.js** `>= 22` (Node.js 24 LTS recommended)
- **Chrome** `>= 116` or **Microsoft Edge** `>= 116`

### Install, Test & Build

```bash
# 1. Install dependencies
npm install

# 2. Run strict TypeScript type-checking
npm run check

# 3. Run unit & integration tests
npm test

# 4. Build the production extension (outputs to dist/ and dist/extension/)
npm run build
```

### Load Unpacked Extension in Chrome / Edge
1. Open your browser and navigate to:
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select `D:\git\Tug-Web\dist` (or `D:\git\Tug-Web\dist\extension`).

---

## Documentation

- [Architecture Design (`docs/architecture.md`)](docs/architecture.md)
- [Internal RPC Protocol (`docs/protocol.md`)](docs/protocol.md)
- [Privacy & Permissions (`docs/privacy.md`)](docs/privacy.md)
- [Testing & QA Guide (`docs/testing.md`)](docs/testing.md)

---

## License

Licensed under the [Apache License 2.0](LICENSE).
