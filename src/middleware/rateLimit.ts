import type { MiddlewareHandler } from 'hono'
import type { Env, AppVariables } from '../types'
import { checkRateLimit } from '../services/rate-limit'

/**
 * Global ceiling — total requests across all keys/IPs. Sized to stay within
 * Cloudflare R2 free tier: 1 000 000 Class A (write) ops / month.
 */
const GLOBAL_HARD_LIMIT = 10_000_000
const GLOBAL_WINDOW_MS = 2_592_000_000 // 30 days

/** Hard per-IP ceiling regardless of API key limits. */
const IP_HARD_LIMIT = 500
const IP_WINDOW_MS = 3_600_000 // 1 hour

type RateLimitEnv = {
  Bindings: Env
  Variables: AppVariables
}

/**
 * Enforces three rate-limit checks (in order):
 *   1. Global hard ceiling — 10 000 000 req/30 days across all traffic. Cost-control backstop.
 *   2. Per-API-key limit — from the key's own metadata (rateLimit / rateLimitWindowMs).
 *   3. Per-IP hard ceiling — 500 req/hr, always applied regardless of key limits.
 *
 * Returns 429 with a Retry-After header (seconds) on exhaustion.
 */
export const rateLimitMiddleware: MiddlewareHandler<RateLimitEnv> = async (c, next) => {
  const meta = c.get('apiKeyMeta')
  const hash = c.get('apiKeyHash')
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'

  // 1. Global hard ceiling — checked first to short-circuit all further work.
  const globalResult = await checkRateLimit(
    c.env.RATE_LIMITER,
    'gw-global',
    GLOBAL_HARD_LIMIT,
    GLOBAL_WINDOW_MS,
  )
  if (!globalResult.allowed) {
    const retryAfter = Math.ceil((globalResult.retryAfterMs ?? 60_000) / 1000)
    return c.json({ error: 'Service temporarily unavailable' }, 503, { 'Retry-After': String(retryAfter) })
  }

  // 2. Per-key check.
  const keyResult = await checkRateLimit(
    c.env.RATE_LIMITER,
    `gw-key:${hash}`,
    meta.rateLimit,
    meta.rateLimitWindowMs,
  )
  if (!keyResult.allowed) {
    const retryAfter = Math.ceil((keyResult.retryAfterMs ?? 60_000) / 1000)
    return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(retryAfter) })
  }

  // 2. Per-IP hard ceiling.
  const ipResult = await checkRateLimit(
    c.env.RATE_LIMITER,
    `gw-ip:${ip}`,
    IP_HARD_LIMIT,
    IP_WINDOW_MS,
  )
  if (!ipResult.allowed) {
    const retryAfter = Math.ceil((ipResult.retryAfterMs ?? 60_000) / 1000)
    return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(retryAfter) })
  }

  await next()
}
