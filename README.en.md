# Tug Web

<p align="center"><img src="public/tug-icon.png" alt="Tug Web" width="108" /></p>

**An independent multi-connection HTTP and BitTorrent/Magnet browser downloader with an optional Tug Agent.**

[简体中文](README.md) | English

Tug Web targets Chromium browsers (Chrome/Edge Manifest V3) and does not depend on Tug Desktop. HTTP and WebTorrent/WebSeed run inside Offscreen Document + OPFS. The optional Windows Agent adds traditional BT TCP/UDP/DHT and system file export/opening. The extension remains the sole owner of the queue, settings and recovery state.

## Features

- **HTTP/HTTPS**: 1–32 configured connections with a balanced, bounded Range job queue. Plain HTTP or identified HTTP/1.1 uses up to six effective workers, without recursively splitting queued requests; HTTPS/HTTP/2 retains configured concurrency.
- **Validated resume**: exact 206 range/length checks and strong ETag or Last-Modified/If-Range validation. Only acknowledged, synchronized writes enter persistent checkpoints. Non-Range probes use a single stream; mid-download resource changes fail explicitly.
- **Incremental SHA-256**, a shared rate limiter, network idle timeouts, and separate downloading/verifying/saving stages.
- **Torrent/Magnet**: WebRTC WebTorrent, HTTP WebSeed, per-piece SHA-1, local/remote torrents, `xs=`/`ws=` and selective files. The Agent connects to traditional TCP/UDP/DHT peers.
- **Bounded-memory storage**: random OPFS writes through a dedicated SyncAccessHandle worker, with a WritableFileStream fallback. Reset and resume have distinct semantics; storage errors propagate.
- **Recoverable export**: browser download API or an authorized Agent; per-file BT export results let retries skip saved files. Cache cleanup follows completion.
- Download interception, context menus, magnet capture, Alt bypass, popup/manager/settings, Chinese/English and light/dark themes.

The Agent currently **does not download HTTP sources**. Browser and server protocol limits still affect effective concurrency; selecting 32 does not guarantee 32 active connections to every origin.

## Build and load

Node.js >= 22 and Chrome/Edge >= 116 are required. Building the Agent also requires Rust.

```powershell
npm ci
npm run check
npm test
npm run build
```

Enable developer mode at `chrome://extensions` or `edge://extensions`, then load `dist/` or `dist/extension/`.

On Windows, double-click the root `build.bat` to build `dist` (installing missing dependencies), then reload the extension. `agent/build.bat` builds Release and copies the executable to `agent/tug-agent.exe`. Pass `--no-pause` for command-line automation; failures return a nonzero exit code.

See [Agent setup](agent/README.md). This extension requires **Agent protocol 2**; older versions show an update notice and are not used through unauthenticated endpoints. Update both components together.

## Verify

```powershell
npm run test:browser
npm run test:agent
npm run bench:http -- --connections=8,32
```

Browser tests use an installed Playwright Chromium or `TUG_TEST_BROWSER`. They create isolated profiles. Agent tests use isolated directories and native stdio authorization without registry installation.

See [testing](docs/testing.md), [architecture](docs/architecture.md), [protocol](docs/protocol.md), [privacy](docs/privacy.md) and [implementation notes](docs/implementation-notes.md).

## Layout

- `src/engine/http`: Range jobs, validation, timeouts, incremental checksum and rate limiting.
- `src/engine/storage`: OPFS worker, memory backend and IndexedDB.
- `src/engine/torrent`: parsers, WebRTC/WebSeed and Agent client.
- `src/engine/core`: task scheduling, checkpoints and per-file export.
- `src/background`, `src/offscreen`: browser integration and engine host.
- `src/manager`, `src/popup`, `src/options`: UI.
- `agent`: the optional Windows helper, without a task database.
- `tests`, `scripts`: regression/integration tests and benchmarks.

Apache License 2.0; see [LICENSE](LICENSE).
