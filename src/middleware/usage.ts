import type { MiddlewareHandler } from 'hono'
import type { Env, AppVariables } from '../types'

type UsageEnv = {
  Bindings: Env
  Variables: AppVariables
}

const MAX_PATH_LENGTH = 256

/**
 * Writes one Analytics Engine data point (dataset scanlake_gateway_usage) per
 * authenticated request, after the response is ready — whatever its status,
 * so 403s from restrictUserKeys and 429s from the rate limiter count too.
 * Requests refused by apiKeyMiddleware itself (unknown key, revoked, origin)
 * are not counted.
 *
 * ScanLake Auth's admin panel reads the columns by position; keep this order:
 *   index1   key hash (SHA-256 hex of the raw key)
 *   blob1    kind: "user" | "internal"
 *   blob2    ownerId
 *   blob3    discordId ('' for internal keys)
 *   blob4    tier ('' for internal keys)
 *   blob5    method
 *   blob6    path (raw pathname, at most 256 characters)
 *   blob7    status, as a string
 *   double1  1 per request
 *   double2  response bytes (Content-Length, or 0)
 *
 * Must run right after apiKeyMiddleware.  Does nothing when USAGE is unbound.
 */
export const usageMiddleware: MiddlewareHandler<UsageEnv> = async (c, next) => {
  await next()

  const dataset = c.env.USAGE
  if (!dataset) return

  try {
    const meta = c.get('apiKeyMeta')
    const bytes = Number(c.res.headers.get('Content-Length') ?? 0)
    dataset.writeDataPoint({
      indexes: [c.get('apiKeyHash')],
      blobs: [
        meta.kind === 'user' ? 'user' : 'internal',
        meta.ownerId ?? '',
        meta.discordId ?? '',
        meta.tier ?? '',
        c.req.method,
        new URL(c.req.url).pathname.slice(0, MAX_PATH_LENGTH),
        String(c.res.status),
      ],
      doubles: [1, Number.isFinite(bytes) && bytes > 0 ? bytes : 0],
    })
  } catch (err) {
    // Usage counting must never fail the request.
    console.error('[usage] failed to write data point:', err)
  }
}
