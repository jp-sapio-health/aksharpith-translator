// Per-key in-process token bucket. Sufficient for single-instance deployments.
// Swap for Upstash/Redis when horizontal scale or multi-region is needed.

type Bucket = { tokens: number; updatedAt: number };

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_PER_MS = 1 / 60_000; // 1 token per minute

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(
  key: string,
  capacity: number = DEFAULT_CAPACITY,
  refillPerMs: number = DEFAULT_REFILL_PER_MS
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);
  const bucket: Bucket = existing
    ? {
        tokens: Math.min(capacity, existing.tokens + (now - existing.updatedAt) * refillPerMs),
        updatedAt: now,
      }
    : { tokens: capacity, updatedAt: now };

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  buckets.set(key, bucket);
  const tokensNeeded = 1 - bucket.tokens;
  const retryAfterSeconds = Math.ceil(tokensNeeded / refillPerMs / 1000);
  return { allowed: false, remaining: 0, retryAfterSeconds };
}

// Test-only helper.
export function _resetRateLimitForTests(): void {
  buckets.clear();
}
