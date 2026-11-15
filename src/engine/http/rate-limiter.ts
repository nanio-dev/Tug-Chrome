/**
 * 令牌桶限速器（支持动态修改速率，用于全局或单任务下载限速）。
 */
export class RateLimiter {
  private rateBps: number | null;
  private availableTokens = 0;
  private lastRefillMs = Date.now();
  private chain: Promise<void> = Promise.resolve();

  constructor(rateBps: number | null = null) {
    this.rateBps = rateBps && rateBps > 0 ? rateBps : null;
  }

  setRateBps(rateBps: number | null): void {
    this.rateBps = rateBps && rateBps > 0 ? rateBps : null;
    this.availableTokens = 0;
    this.lastRefillMs = Date.now();
  }

  getRateBps(): number | null {
    return this.rateBps;
  }

  async acquire(bytes: number, signal?: AbortSignal): Promise<void> {
    if (!this.rateBps || bytes <= 0) {
      return;
    }
    const next = this.chain.catch(() => {}).then(async () => {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const rate = this.rateBps;
      if (!rate || rate <= 0) return;

      const now = Date.now();
      const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
      this.lastRefillMs = now;
      this.availableTokens = Math.min(rate, this.availableTokens + elapsedSec * rate);

      if (this.availableTokens >= bytes) {
        this.availableTokens -= bytes;
        return;
      }

      const deficit = bytes - this.availableTokens;
      this.availableTokens = 0;
      const waitMs = Math.min(2000, Math.ceil((deficit / rate) * 1000));
      if (waitMs > 5) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, waitMs);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        this.lastRefillMs = Date.now();
      }
    });
    this.chain = next;
    return next;
  }
}
