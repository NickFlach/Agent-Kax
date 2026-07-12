/**
 * Minimal in-memory fixed-window rate limiter. Deliberately simple:
 * the api-server is a single instance (see replit.md), so no shared
 * store is needed. Buckets are swept lazily when the map grows large.
 *
 * Built as a factory (rather than a middleware singleton) so tests can
 * construct tight limiters and call reset() between cases.
 */

export interface RateLimiter {
  /** Record a hit for `key`. Returns true if still within the limit. */
  hit(key: string): boolean;
  /** Forget a single key (e.g. after a successful login). */
  clear(key: string): void;
  /** Drop all buckets. Test hook. */
  reset(): void;
}

export function createRateLimiter(opts: { limit: number; windowMs: number }): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function sweep(now: number): void {
    if (buckets.size < 5000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    hit(key: string): boolean {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        sweep(now);
        buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
        return opts.limit >= 1;
      }
      bucket.count += 1;
      return bucket.count <= opts.limit;
    },
    clear(key: string): void {
      buckets.delete(key);
    },
    reset(): void {
      buckets.clear();
    },
  };
}
