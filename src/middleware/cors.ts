import { cors } from 'hono/cors'
import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types'

/**
 * CORS middleware for all gateway routes.
 *
 * Allows any origin so that browser-based clients (e.g. DuckDB-WASM via httpfs)
 * can reach the gateway.  Per-key origin restrictions are enforced separately
 * in apiKeyMiddleware when allowedOrigins is populated on the key's metadata.
 *
 * OPTIONS preflight requests are handled here and never reach auth middleware.
 */
export const corsMiddleware: MiddlewareHandler<{ Bindings: Env }> = (_c, next) => {
  const handler = cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['X-API-Key', 'Content-Type', 'Range'],
    exposeHeaders: ['Content-Length', 'Content-Disposition', 'ETag', 'Content-Range'],
    maxAge: 86400,
  })
  return handler(_c, next)
}
