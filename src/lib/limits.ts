import type { ApiKeyMeta, RateWindow } from '../types'

/**
 * Global ceiling across all traffic, in one fixed 30-day window.  Sized as a
 * cost-control backstop for the R2 free tier.
 */
export const GLOBAL_LIMIT: RateWindow = { limit: 10_000_000, windowMs: 2_592_000_000 }

/** Hard per-IP ceiling regardless of API key limits. */
export const IP_LIMIT: RateWindow = { limit: 5000, windowMs: 3_600_000 }

/**
 * Used for a user key whose KV entry carries no valid limits: the "verified"
 * tier, the lowest ScanLake Auth issues.
 */
export const USER_KEY_DEFAULT_LIMITS: RateWindow[] = [
  { limit: 60, windowMs: 60_000 },
  { limit: 2000, windowMs: 86_400_000 },
]

/** A window the RateLimiter DO accepts: whole numbers, limit >= 0, windowMs > 0. */
export function isValidWindow(w: unknown): w is RateWindow {
  if (typeof w !== 'object' || w === null) return false
  const { limit, windowMs } = w as RateWindow
  return Number.isSafeInteger(limit) && limit >= 0 && Number.isSafeInteger(windowMs) && windowMs > 0
}

/**
 * The rate-limit counter and windows for a key.
 *
 * User keys count per Discord account (gw-acct:<discordId>), so every key of
 * one account shares the account's limits; they use the entry's `limits`,
 * else its rateLimit/rateLimitWindowMs, else the verified-tier defaults.
 *
 * Internal sk_ keys count per key (gw-key:<hash>) with rateLimit/rateLimitWindowMs;
 * an entry without valid values gets no per-key window (IP and global limits
 * still apply), which is what the old limiter effectively did with it.
 */
export function keyRateLimit(meta: ApiKeyMeta, hash: string): { name: string; windows: RateWindow[] } {
  const single: RateWindow = { limit: meta.rateLimit, windowMs: meta.rateLimitWindowMs }

  if (meta.kind !== 'user') {
    return { name: `gw-key:${hash}`, windows: isValidWindow(single) ? [single] : [] }
  }

  const fromLimits = Array.isArray(meta.limits) ? meta.limits.filter(isValidWindow) : []
  const windows = fromLimits.length > 0 ? fromLimits : isValidWindow(single) ? [single] : USER_KEY_DEFAULT_LIMITS
  // A user key without a discordId would otherwise share one counter with every such key.
  const name = meta.discordId ? `gw-acct:${meta.discordId}` : `gw-acct:key:${hash}`
  return { name, windows }
}
