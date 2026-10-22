/** Simple per-key token bucket (spec 13: MCP endpoint abuse). */
export interface RateLimiterOptions {
  ratePerSec: number;
  burst: number;
  now?: () => number;
  /** Buckets idle this long are dropped by prune(). */
  idleMs?: number;
  /** Hard cap on tracked keys. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  readonly #rate: number;
  readonly #burst: number;
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    if (!(opts.ratePerSec > 0) || !(opts.burst >= 1)) throw new RangeError('RateLimiter: ratePerSec > 0 and burst >= 1 required');
    this.#rate = opts.ratePerSec;
    this.#burst = opts.burst;
    this.#now = opts.now ?? (() => Date.now());
    this.#idleMs = opts.idleMs ?? 10 * 60_000;
    this.#maxKeys = opts.maxKeys ?? 50_000;
  }

  /** Takes one token. Returns 0 when allowed, else seconds until a token is available. */
  take(key: string): number {
    const now = this.#now();
    let b = this.#buckets.get(key);
    if (b === undefined) {
      if (this.#buckets.size >= this.#maxKeys) this.#evict();
      b = { tokens: this.#burst, last: now };
    } else {
      b.tokens = Math.min(this.#burst, b.tokens + ((now - b.last) / 1000) * this.#rate);
      b.last = now;
      // Map order = recency (LRU): re-insert at the end.
      this.#buckets.delete(key);
    }
    this.#buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return (1 - b.tokens) / this.#rate;
  }

  /** Drops buckets idle longer than idleMs (a full bucket again by then, so nothing is forgiven). */
  prune(): void {
    const cutoff = this.#now() - this.#idleMs;
    for (const [k, b] of this.#buckets) if (b.last < cutoff) this.#buckets.delete(k);
  }

  get size(): number {
    return this.#buckets.size;
  }

  /**
   * At the key cap: drop idle buckets, then only the least recently used
   * ones. Never clears everyone (flooding new keys must not reset other
   * clients' limits).
   */
  #evict(): void {
    this.prune();
    for (const k of this.#buckets.keys()) {
      if (this.#buckets.size < this.#maxKeys) break;
      this.#buckets.delete(k);
    }
  }
}
