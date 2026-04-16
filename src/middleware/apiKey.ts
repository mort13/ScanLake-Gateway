import type { MiddlewareHandler } from 'hono'
import type { Env, ApiKeyMeta, AppVariables } from '../types'

/** sk_ followed by 32–64 lowercase hex characters. */
const API_KEY_RE = /^sk_[0-9a-f]{32,64}$/i

type ApiKeyEnv = {
  Bindings: Env
  Variables: AppVariables
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Validates the X-API-Key header against the shared API_KEYS KV namespace.
 *
 * Keys are stored under the SHA-256 hash of the raw key so that the plaintext
 * is never persisted.  The KV entry must be a JSON object matching ApiKeyMeta.
 *
 * On success, sets context variables:
 *   - apiKeyMeta  – the resolved ApiKeyMeta object
 *   - apiKeyHash  – hex-encoded SHA-256 hash (used as rate-limit key + log field)
 */
export const apiKeyMiddleware: MiddlewareHandler<ApiKeyEnv> = async (c, next) => {
  const rawKey = c.req.header('X-API-Key')
  if (!rawKey) {
    return c.json({ error: 'Missing X-API-Key header' }, 401)
  }

  if (!API_KEY_RE.test(rawKey)) {
    return c.json({ error: 'Invalid API key format' }, 401)
  }

  const hash = await sha256Hex(rawKey)
  const meta = await c.env.API_KEYS.get<ApiKeyMeta>(`apikey:${hash}`, 'json')

  if (!meta) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  if (!meta.active) {
    return c.json({ error: 'API key has been revoked' }, 403)
  }

  // Enforce per-key origin restrictions for browser-origin requests.
  if (meta.allowedOrigins.length > 0) {
    const origin = c.req.header('Origin') ?? ''
    if (!meta.allowedOrigins.includes(origin)) {
      return c.json({ error: 'Origin not permitted for this API key' }, 403)
    }
  }

  c.set('apiKeyMeta', meta)
  c.set('apiKeyHash', hash)
  await next()
}
