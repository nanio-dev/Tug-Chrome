import type { NativeHelperStatus } from "../../shared/protocol";

export interface TorrentPeerDetail {
  addr: string;
  state: string;
  downloadedBytes: number;
  uploadedBytes: number;
}

export interface TorrentTrackerDetail {
  url: string;
  protocol: string;
  status: string;
}

export const NATIVE_HELPER_PORT = 16899;
export const NATIVE_HELPER_BASE_URL = `http://127.0.0.1:${NATIVE_HELPER_PORT}`;
export const NATIVE_HELPER_HOST_NAME = "cc.nanio.tug.agent";
const TOKEN_KEY = "tugAgentSessionToken";
let memoryToken: string | null = null;

export async function setHelperCredentials(token: string | null): Promise<void> {
  if (token !== null && !/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid Agent capability");
  if (typeof chrome !== "undefined" && chrome.storage?.session) {
    if (token) await chrome.storage.session.set({ [TOKEN_KEY]: token });
    else await chrome.storage.session.remove(TOKEN_KEY);
  } else memoryToken = token;
}
async function helperToken(): Promise<string | null> {
  if (typeof chrome !== "undefined" && chrome.storage?.session) {
    const stored = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY];
    return typeof stored === "string" ? stored : null;
  }
  return memoryToken;
}

export async function helperRequestHeaders(url: string, init?: HeadersInit): Promise<Headers> {
  const headers = new Headers(init);
  headers.delete("X-Tug-Agent-Token");
  // Capabilities must never be sent to a torrent's remote web seeds.
  if (new URL(url).origin === NATIVE_HELPER_BASE_URL) {
    const token = await helperToken();
    if (!token) throw new Error("请先通过 Native Messaging 连接 Tug Agent");
    headers.set("X-Tug-Agent-Token", token);
  }
  return headers;
}

async function fetchHelper(url: string, init: RequestInit = {}): Promise<Response> {
  if (new URL(url).origin !== NATIVE_HELPER_BASE_URL) throw new Error("Invalid Agent origin");
  const resp = await fetch(url, { ...init, redirect: "error", headers: await helperRequestHeaders(url, init.headers) });
  if (resp.status === 401) await setHelperCredentials(null);
  return resp;
}

export interface HelperSessionStartInput {
  url?: string;
  torrentBytesBase64?: string;
  trackers?: string[];
  onlyFiles?: number[] | null;
}

export interface HelperSessionStartResult {
  sessionId: string;
  infoHash: string;
  name: string;
  totalBytes: number;
  torrentBytesBase64: string;
  webSeedUrl: string;
}

export interface HelperSessionPeersResult {
  peers: TorrentPeerDetail[];
  trackers: TorrentTrackerDetail[];
  downloadSpeedBytes: number;
  uploadSpeedBytes: number;
  progressBytes: number;
  totalBytes: number;
}

export async function checkHelperHealth(timeoutMs = 1200): Promise<NativeHelperStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = await helperToken();
    const resp = await fetch(`${NATIVE_HELPER_BASE_URL}/health`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
      headers: token ? { "X-Tug-Agent-Token": token } : undefined,
      redirect: "error",
    });
    if (!resp.ok) {
      if (resp.status === 401) await setHelperCredentials(null);
      return { available: false };
    }
    const data = (await resp.json()) as {
      ok?: boolean;
      service?: string;
      version?: string;
      port?: number;
      activeSessions?: number;
      protocolVersion?: number;
      authRequired?: boolean;
    };
    if (!data?.ok || (data.service !== "tug-agent" && data.service !== "tug-web-helper")) {
      return { available: false };
    }
    return {
      available: data.protocolVersion === 2 && data.authRequired === true && Boolean(token),
      installed: true,
      pairingRequired: data.protocolVersion === 2 && data.authRequired === true && !token,
      protocolVersion: data.protocolVersion,
      updateRequired: data.protocolVersion !== 2 || data.authRequired !== true,
      version: data.version,
      port: data.port ?? NATIVE_HELPER_PORT,
      activeSessions: data.activeSessions ?? 0,
    };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/** One shared native handshake for simultaneous popup, manager and export requests. */
let connecting: Promise<NativeHelperStatus> | null = null;
let nativeKeepAlivePort: chrome.runtime.Port | undefined;
export function disconnectHelperNative(): void {
  try { nativeKeepAlivePort?.disconnect(); } catch { /* Already disconnected. */ }
  nativeKeepAlivePort = undefined;
}
export function connectHelperNative(timeoutMs = 8000, diagnostic: (message: string) => void = () => {}): Promise<NativeHelperStatus> {
  if (connecting) return connecting;
  let credential: string | null = null;
  connecting = (async () => {
    if (typeof chrome === "undefined" || !chrome.runtime?.connectNative) return { available: false };
    if (nativeKeepAlivePort) disconnectHelperNative();
    let port: chrome.runtime.Port | undefined;
    let disconnected = false;
    try {
      const result = await new Promise<NativeHelperStatus>((resolve) => {
        let settled = false;
        const finish = (status: NativeHelperStatus) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(status);
        };
        const timer = setTimeout(() => finish({ available: false, nativeError: "Native Messaging handshake timed out" }), timeoutMs);
        try {
          port = chrome.runtime.connectNative(NATIVE_HELPER_HOST_NAME);
          port.onMessage.addListener((message: { ok?: boolean; message?: string; protocolVersion?: number; token?: string }) => {
            if (settled) return;
            if (message.ok === false) {
              finish({ available: false, nativeError: message.message ?? "Agent startup failed" });
              return;
            }
            if (message.protocolVersion !== 2 || !/^[a-f0-9]{64}$/i.test(message.token ?? "")) {
              finish({ available: false, installed: true, updateRequired: true });
              return;
            }
            // The native host can exit immediately when a daemon already owns the port.
            // Resolve the handshake before disconnect; persist/validate outside this callback.
            credential = message.token!;
            finish({ available: false });
          });
          port.onDisconnect.addListener(() => {
            disconnected = true;
            if (nativeKeepAlivePort === port) nativeKeepAlivePort = undefined;
            const error = chrome.runtime.lastError?.message;
            if (error) diagnostic(error);
            finish({ available: false, nativeError: error ?? "Native host disconnected before ready" });
          });
          port.postMessage({ action: "ping", extId: chrome.runtime.id });
        } catch (err) {
          finish({ available: false, nativeError: String(err) });
        }
      });
      if (!credential) return result;
      await setHelperCredentials(credential);
      const status = await checkHelperHealth(1200);
      if (status.available && !disconnected) nativeKeepAlivePort = port;
      return status;
    } finally {
      if (port !== nativeKeepAlivePort) {
        try { port?.disconnect(); } catch { /* Host may already have exited. */ }
      }
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

export async function registerExtIdWithHelper(extId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetchHelper(`${NATIVE_HELPER_BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extId }),
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function startHelperTorrentSession(
  input: HelperSessionStartInput,
  signal?: AbortSignal,
): Promise<HelperSessionStartResult> {
  const resp = await fetchHelper(`${NATIVE_HELPER_BASE_URL}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: input.url ?? undefined,
      torrentBytesBase64: input.torrentBytesBase64 ?? undefined,
      trackers: input.trackers ?? [],
      onlyFiles: input.onlyFiles ?? undefined,
    }),
    signal,
  });

  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try {
      const json = (await resp.json()) as { error?: string };
      if (json?.error) errText = json.error;
    } catch {
      // ignore
    }
    throw new Error(`本地 P2P 辅助网关建连失败: ${errText}`);
  }

  return (await resp.json()) as HelperSessionStartResult;
}

export async function getHelperSessionPeers(
  sessionId: string,
  signal?: AbortSignal,
): Promise<HelperSessionPeersResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const resp = await fetchHelper(
      `${NATIVE_HELPER_BASE_URL}/session/${encodeURIComponent(sessionId)}/peers`,
      {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as HelperSessionPeersResult;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function stopHelperTorrentSession(sessionId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetchHelper(`${NATIVE_HELPER_BASE_URL}/session/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      signal: controller.signal,
    });
  } catch {
    // ignore cleanup errors
  } finally {
    clearTimeout(timer);
  }
}

export async function exportBlobViaHelper(
  blob: Blob,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const resp = await fetchHelper(`${NATIVE_HELPER_BASE_URL}/fs/export`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relative-Path": encodeURIComponent(relativePath),
      },
      body: blob,
      signal,
    });
    if (!resp.ok) {
      const message = await resp.text();
      throw new Error(`Agent export failed (HTTP ${resp.status}): ${message.slice(0, 300)}`);
    }
    const data = (await resp.json()) as { ok?: boolean; savedPath?: string };
    if (!data?.ok || !data.savedPath) throw new Error("Agent returned an incomplete export result");
    return data.savedPath;
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw err;
  }
}

export async function openFileViaHelper(payload: {
  action: "open_file" | "reveal_file" | "open_folder";
  path?: string | null;
  subDir?: string | null;
}): Promise<{ ok: boolean; opened?: boolean; revealed?: boolean; path?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const resp = await fetchHelper(`${NATIVE_HELPER_BASE_URL}/fs/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: payload.action,
        path: payload.path ?? undefined,
        subDir: payload.subDir ?? undefined,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as {
      ok: boolean;
      opened?: boolean;
      revealed?: boolean;
      path?: string;
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteFileViaHelper(path: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const resp = await fetchHelper(`${NATIVE_HELPER_BASE_URL}/fs/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      signal: controller.signal,
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { ok?: boolean; deleted?: boolean };
    return Boolean(data?.deleted);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function uninstallViaHelper(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const resp = await fetchHelper(`${NATIVE_HELPER_BASE_URL}/uninstall`, {
      method: "POST",
      signal: controller.signal,
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { ok?: boolean };
    return Boolean(data?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
