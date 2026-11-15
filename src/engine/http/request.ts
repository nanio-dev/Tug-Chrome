/** A timeout covers network I/O only, not disk backpressure or deliberate rate waits. */
export async function openHttpStream(
  fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs = 30000,
) {
  const abort = new AbortController();
  const parent = init.signal;
  const onAbort = () => abort.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); };
  const arm = () => {
    clear();
    timer = setTimeout(() => abort.abort(new DOMException("HTTP read timed out", "TimeoutError")), timeoutMs);
  };
  const dispose = () => { clear(); parent?.removeEventListener("abort", onAbort); };
  try {
    arm();
    const response = await fetchFn(url, { ...init, signal: abort.signal });
    clear();
    const reader = response.body?.getReader();
    return {
      response,
      async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
        if (!reader) return { done: true, value: undefined };
        abort.signal.throwIfAborted();
        arm();
        try { return await reader.read(); }
        catch (err) { throw abort.signal.aborted ? abort.signal.reason : err; }
        finally { clear(); }
      },
      async close() {
        dispose();
        abort.abort();
        await reader?.cancel().catch(() => {});
      },
    };
  } catch (err) {
    dispose();
    throw abort.signal.aborted ? abort.signal.reason : err;
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
