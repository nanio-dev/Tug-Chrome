export const AGENT_DOWNLOAD_URL = "https://tug.nanio.cc/downloads/tug-agent.exe";

/** Download once; keep the completed bytes alive until the offscreen document closes. */
export async function cacheAgentPackage(url: string, progress: (received: number, total: number) => void, fetchFn: typeof fetch = fetch) {
  const parsed = new URL(url);
  const expected = new URL(AGENT_DOWNLOAD_URL);
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) throw new Error("Invalid Agent download URL");
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
