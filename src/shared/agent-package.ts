export const AGENT_DOWNLOAD_URL = "https://tug.nanio.cc/downloads/tug-agent.exe";
export const AGENT_PACKAGES = {
  windows: { kind: "windows", filename: "tug-agent.exe", url: AGENT_DOWNLOAD_URL },
  macos: { kind: "macos", filename: "tug-agent-macos-universal.zip", url: "https://tug.nanio.cc/downloads/tug-agent-macos-universal.zip" },
  linuxX64: { kind: "linux", filename: "tug-agent-linux-x64.tar.gz", url: "https://tug.nanio.cc/downloads/tug-agent-linux-x64.tar.gz" },
  linuxArm64: { kind: "linux", filename: "tug-agent-linux-arm64.tar.gz", url: "https://tug.nanio.cc/downloads/tug-agent-linux-arm64.tar.gz" },
} as const;
export type AgentPackage = typeof AGENT_PACKAGES[keyof typeof AGENT_PACKAGES];

export function getAgentPackage(platform: { os: string; arch: string }): AgentPackage {
  if (platform.os === "mac") return AGENT_PACKAGES.macos;
  if (platform.os === "win" && ["x86-64", "arm64"].includes(platform.arch)) return AGENT_PACKAGES.windows;
  if (platform.os === "linux" && platform.arch === "x86-64") return AGENT_PACKAGES.linuxX64;
  if (platform.os === "linux" && platform.arch === "arm64") return AGENT_PACKAGES.linuxArm64;
  throw new Error("Agent is not available for this operating system or CPU architecture");
}

/** Download once; keep the completed bytes alive until the offscreen document closes. */
export async function cacheAgentPackage(url: string, progress: (received: number, total: number) => void, fetchFn: typeof fetch = fetch) {
  const parsed = new URL(url);
  if (!Object.values(AGENT_PACKAGES).some(pkg => parsed.origin === new URL(pkg.url).origin && parsed.pathname === new URL(pkg.url).pathname)) throw new Error("Invalid Agent download URL");
  const response = await fetchFn(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const declared = response.headers.has("content-encoding") ? 0 : Number(response.headers.get("content-length")) || 0;
  const chunks: BlobPart[] = [];
  let received = 0, lastReport = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new Uint8Array(value)); received += value.byteLength;
      if (Date.now() - lastReport >= 120) { lastReport = Date.now(); progress(received, declared); }
    }
  } else {
    const value = await response.arrayBuffer();chunks.push(value);received = value.byteLength;
  }
  if (!received || (declared > 0 && declared !== received)) throw new Error("Agent package download is incomplete");
  progress(received, received);
  return { blobUrl: URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" })), totalBytes: received };
}
