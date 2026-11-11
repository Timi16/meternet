// Byte-rate limiter for the web gateway. One bucket per session, shared by
// all of that session's requests, so opening parallel downloads doesn't
// multiply the rate. Takers are served in order.

export class TokenBucket {
  private tokens: number;
  private lastMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly bytesPerSec: number,
    private readonly burstBytes: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = burstBytes;
    this.lastMs = now();
  }

  // Resolves when n bytes may be sent.
  take(n: number): Promise<void> {
    const run = this.queue.then(async () => {
      // Take first, then wait off any debt. (Waiting until the bucket holds n
      // would never finish for n > burst, because refills cap at the burst.)
      this.refill();
      this.tokens -= n;
      if (this.tokens < 0) await this.sleep((-this.tokens / this.bytesPerSec) * 1000);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burstBytes, this.tokens + ((t - this.lastMs) / 1000) * this.bytesPerSec);
    this.lastMs = t;
  }
}
