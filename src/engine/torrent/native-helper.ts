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
    const resp = await fetch(`${NATIVE_HELPER_BASE_URL}/health`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!resp.ok) {
      return { available: false };
    }
    const data = (await resp.json()) as {
      ok?: boolean;
      service?: string;
      version?: string;
      port?: number;
      activeSessions?: number;
    };
    if (!data?.ok || (data.service !== "tug-agent" && data.service !== "tug-web-helper")) {
      return { available: false };
    }
    return {
      available: true,
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

export async function registerExtIdWithHelper(extId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`${NATIVE_HELPER_BASE_URL}/register`, {
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
  const resp = await fetch(`${NATIVE_HELPER_BASE_URL}/session/start`, {
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
    const resp = await fetch(
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
    await fetch(`${NATIVE_HELPER_BASE_URL}/session/${encodeURIComponent(sessionId)}/stop`, {
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
): Promise<string | null> {
  try {
    const resp = await fetch(`${NATIVE_HELPER_BASE_URL}/fs/export`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Relative-Path": encodeURIComponent(relativePath),
      },
      body: blob,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { ok?: boolean; savedPath?: string };
    return data?.ok && data.savedPath ? data.savedPath : null;
  } catch {
    return null;
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
    const resp = await fetch(`${NATIVE_HELPER_BASE_URL}/fs/open`, {
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
    const resp = await fetch(`${NATIVE_HELPER_BASE_URL}/fs/delete`, {
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
