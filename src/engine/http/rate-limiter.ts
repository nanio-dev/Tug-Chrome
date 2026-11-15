/** Shared token bucket. Large chunks retain their full debt; changes wake sleepers. */
export class RateLimiter {
  private rateBps: number | null;
  private availableTokens = 0;
  private lastRefillMs = performance.now();
  private chain: Promise<void> = Promise.resolve();
  private readonly sleepers = new Set<() => void>();

  constructor(rateBps: number | null = null) {
    this.rateBps = rateBps && rateBps > 0 ? rateBps : null;
  }

  setRateBps(rateBps: number | null): void {
    this.rateBps = rateBps && rateBps > 0 ? rateBps : null;
    this.availableTokens = 0;
    this.lastRefillMs = performance.now();
    for (const wake of this.sleepers) wake();
  }

  getRateBps(): number | null { return this.rateBps; }

  async acquire(bytes: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.rateBps || bytes <= 0) return;
    const next = this.chain.then(async () => {
      let remaining = bytes;
      while (remaining > 0) {
        signal?.throwIfAborted();
        const rate = this.rateBps;
        if (!rate) return;
        const now = performance.now();
        this.availableTokens = Math.min(rate, this.availableTokens + (now - this.lastRefillMs) * rate / 1000);
        this.lastRefillMs = now;
        const take = Math.min(remaining, this.availableTokens);
        remaining -= take;
        this.availableTokens -= take;
        if (remaining <= 0) return;
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            this.sleepers.delete(finish);
            resolve();
          };
          const timer = setTimeout(finish, Math.min(250, Math.ceil(remaining * 1000 / rate)));
          this.sleepers.add(finish);
          signal?.addEventListener("abort", finish, { once: true });
        });
      }
    });
    this.chain = next.catch(() => {});
    if (!signal) return next;
    // A canceled task must not wait behind another task's rate-limited chunk.
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { await Promise.race([next, aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }
}
