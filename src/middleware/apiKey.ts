import type { MiddlewareHandler } from 'hono'
import type { Env, ApiKeyMeta, AppVariables } from '../types'

/** Internal keys: sk_ followed by 32–64 hex characters, stored under apikey:<hash>. */
const API_KEY_RE = /^sk_[0-9a-f]{32,64}$/i

/**
 * User keys issued by ScanLake Auth: slk_ followed by 64 lowercase hex
 * characters, stored under ukey:<hash>.  The separate prefix keeps them out of
 * ScanLake Store, which shares API_KEYS but only looks up apikey: entries.
 */
const USER_KEY_RE = /^slk_[0-9a-f]{64}$/

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i

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

/** The key from X-API-Key, or else from "Authorization: Bearer <key>". */
function readKey(header: (name: string) => string | undefined): string | undefined {
  const apiKey = header('X-API-Key')
  if (apiKey) return apiKey
  return header('Authorization')?.match(BEARER_RE)?.[1]
}

/**
 * Validates the request's API key against the shared API_KEYS KV namespace.
 *
 * The key is read from X-API-Key or, failing that, "Authorization: Bearer".
 * Keys are stored under the SHA-256 hash of the raw key so that the plaintext
 * is never persisted:
 *   - sk_  keys → apikey:<hash>  (internal keys; unchanged)
 *   - slk_ keys → ukey:<hash>    (user keys, written by ScanLake Auth; a
 *     revoked key is deleted, so it is simply not found)
 * The KV entry must be a JSON object matching ApiKeyMeta.  Entries found under
 * ukey: are always treated as user keys, whatever their kind field says.
 *
 * On success, sets context variables:
 *   - apiKeyMeta  – the resolved ApiKeyMeta object
 *   - apiKeyHash  – hex-encoded SHA-256 hash (used as rate-limit key + log field)
 */
export const apiKeyMiddleware: MiddlewareHandler<ApiKeyEnv> = async (c, next) => {
  const rawKey = readKey((name) => c.req.header(name))
  if (!rawKey) {
    return c.json({ error: 'Missing X-API-Key header' }, 401)
  }

  let hash: string
  let meta: ApiKeyMeta | null
  if (USER_KEY_RE.test(rawKey)) {
    hash = await sha256Hex(rawKey)
    const stored = await c.env.API_KEYS.get<ApiKeyMeta>(`ukey:${hash}`, 'json')
    meta = stored ? { ...stored, kind: 'user' } : null
  } else if (API_KEY_RE.test(rawKey)) {
    hash = await sha256Hex(rawKey)
    meta = await c.env.API_KEYS.get<ApiKeyMeta>(`apikey:${hash}`, 'json')
  } else {
    return c.json({ error: 'Invalid API key format' }, 401)
  }

  if (!meta) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  if (!meta.active) {
    return c.json({ error: 'API key has been revoked' }, 403)
  }

  // Enforce per-key origin restrictions for browser-origin requests.
  if (meta.allowedOrigins?.length) {
    const origin = c.req.header('Origin') ?? ''
    if (!meta.allowedOrigins.includes(origin)) {
      return c.json({ error: 'Origin not permitted for this API key' }, 403)
    }
  }

  c.set('apiKeyMeta', meta)
  c.set('apiKeyHash', hash)
  await next()
}
