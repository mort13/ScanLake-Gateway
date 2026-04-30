import type { MiddlewareHandler } from 'hono'

/**
 * Allowed server/client IP addresses (server-to-server or automation).
 * Add IPv4 or IPv6 addresses here — one string per entry.
 */
const ALLOWED_IPS: string[] = [
  // '203.0.113.10',
  // '2001:db8::1',
]

/**
 * Allowed browser origins.
 * Requests that carry an Origin header matching one of these values
 * bypass the IP check. The API key middleware still enforces authentication.
 * Add origins exactly as the browser sends them (scheme + host, no trailing slash).
 */
const ALLOWED_ORIGINS: string[] = [
  'https://dashboard.scanlake.rocks',
]

/**
 * Blocks any request that is neither:
 *   a) from a browser origin listed in ALLOWED_ORIGINS, nor
 *   b) from an IP address listed in ALLOWED_IPS.
 *
 * Cloudflare sets the real client IP in the CF-Connecting-IP header.
 * Falls back to the X-Forwarded-For header when that is absent (local dev).
 */
export const ipAllowlistMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('Origin')
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return next()
  }

  const clientIp =
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0].trim()

  if (!clientIp || !ALLOWED_IPS.includes(clientIp)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  await next()
}
