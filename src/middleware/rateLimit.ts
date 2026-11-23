import type { MiddlewareHandler } from 'hono'
import type { Env, AppVariables } from '../types'
import { checkRateLimit } from '../services/rate-limit'
import type { RateLimitResult } from '../services/rate-limit'
import { GLOBAL_LIMIT, IP_LIMIT, keyRateLimit } from '../lib/limits'

type RateLimitEnv = {
  Bindings: Env
  Variables: AppVariables
}

function seconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)))
}

/** X-RateLimit-* headers describing the binding window of a user key's account. */
function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    // Seconds until the window resets (not a timestamp).
    'X-RateLimit-Reset': String(Math.ceil(result.resetMs / 1000)),
  }
}

/**
 * Enforces three rate-limit checks (in order), each in fixed windows:
 *   1. Per key or account — user keys share their Discord account's limits
 *      (gw-acct:<discordId>, every window in the key's `limits`); internal
 *      sk_ keys have their own (gw-key:<hash>, rateLimit / rateLimitWindowMs).
 *   2. Per-IP hard ceiling — 5000 req/hr, always applied regardless of key limits.
 *   3. Global hard ceiling — 10 000 000 req per 30-day window across all
 *      traffic.  Cost-control backstop; exhaustion is a 503.
 * A request refused at one step is not counted by the later ones, so a
 * throttled key does not burn IP or global budget.
 *
 * Returns 429 (503 for the global ceiling) with a Retry-After header in
 * seconds.  Responses to user keys also carry X-RateLimit-Limit, -Remaining
 * and -Reset (seconds until reset) for their account's binding window.
 */
export const rateLimitMiddleware: MiddlewareHandler<RateLimitEnv> = async (c, next) => {
  const meta = c.get('apiKeyMeta')
  const hash = c.get('apiKeyHash')
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'

  // 1. Per key / account.
  const key = keyRateLimit(meta, hash)
  const keyResult = key.windows.length > 0
    ? await checkRateLimit(c.env.RATE_LIMITER, key.name, key.windows)
    : undefined
  const headers = meta.kind === 'user' && keyResult ? rateLimitHeaders(keyResult) : {}

  if (keyResult && !keyResult.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429, { ...headers, 'Retry-After': seconds(keyResult.retryAfterMs) })
  }

  // 2. Per-IP hard ceiling.
  const ipResult = await checkRateLimit(c.env.RATE_LIMITER, `gw-ip:${ip}`, [IP_LIMIT])
  if (!ipResult.allowed) {
    return c.json({ error: 'Rate limit exceeded' }, 429, { ...headers, 'Retry-After': seconds(ipResult.retryAfterMs) })
  }

  // 3. Global hard ceiling.
  const globalResult = await checkRateLimit(c.env.RATE_LIMITER, 'gw-global', [GLOBAL_LIMIT])
  if (!globalResult.allowed) {
    return c.json(
      { error: 'Service temporarily unavailable' },
      503,
      { ...headers, 'Retry-After': seconds(globalResult.retryAfterMs) },
    )
  }

  await next()

  for (const [name, value] of Object.entries(headers)) c.header(name, value)
}
