/**
 * lib/rate-limit.ts
 *
 * Small in-memory, per-key (typically per-IP) rate limiter for the public
 * write routes (/api/search-miss, /api/submit, /api/revise).
 *
 * Intentionally best-effort: on serverless hosting each warm instance keeps
 * its own counters, so the real ceiling is (limit × instances) and counters
 * reset on cold starts. Turnstile remains the primary abuse gate — this
 * exists to blunt bursts and naive request loops without adding an external
 * dependency. If sturdier limiting is ever needed, swap the internals for a
 * shared store (e.g. Upstash Ratelimit) behind the same function signature.
 */

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when this window ends
}

const buckets = new Map<string, Bucket>();

// Cap memory: once the map reaches this size, expired buckets are pruned
// before inserting a new one (and the map is cleared outright if nothing
// was prunable — losing counters is acceptable for a best-effort limiter).
const MAX_BUCKETS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets; 0 when the request is allowed. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter: allows up to `limit` calls per `windowMs` for the
 * given key. The first call for a key opens a window; calls beyond `limit`
 * inside that window are rejected until it expires.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
      pruneExpired(now);
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

/**
 * Client IP for rate-limit keys. Vercel (and most proxies) set
 * x-forwarded-for with the client as the first entry; fall back to
 * x-real-ip, then a shared "unknown" key so direct hits are still limited
 * as a group rather than not at all.
 */
export function getClientIp(request: { headers: Headers }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
