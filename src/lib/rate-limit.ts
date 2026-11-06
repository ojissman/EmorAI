// In-memory sliding-window rate limiter (per-process, local memory cache —
// appropriate for a single-owner personal installation).

type Bucket = number[];

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => now - t < windowMs);
    if (alive.length === 0) buckets.delete(key);
    else buckets.set(key, alive);
  }
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

export function rateLimit(identifier: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now();
  sweep(now, windowMs);
  const hits = (buckets.get(identifier) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    const oldest = Math.min(...hits);
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    buckets.set(identifier, hits);
    return { ok: false, remaining: 0, retryAfterSec };
  }
  hits.push(now);
  buckets.set(identifier, hits);
  return { ok: true, remaining: Math.max(0, limit - hits.length), retryAfterSec: 0 };
}

/** Test/utility helper. */
export function resetRateLimits(): void {
  buckets.clear();
}
