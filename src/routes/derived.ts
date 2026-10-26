import type { Context } from 'hono'
import type { Env, AppVariables } from '../types'
import { logEvent } from '../services/logger'
import { isSafeKey } from '../services/keys'

type DerivedEnv = {
  Bindings: Env
  Variables: AppVariables
}

/** Maximum size of a single object written to scanlake-derived (50 MB). */
export const DERIVED_MAX_BYTES = 50 * 1024 * 1024

const CONTENT_LENGTH_RE = /^\d+$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

/**
 * R2 put() throws when the body's digest differs from options.sha256
 * (error code 10037 in production, BadDigest in local Miniflare).
 */
function isChecksumMismatch(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /checksum you specified did not match|\(10037\)/i.test(message)
}

/**
 * PUT /api/derived/:key
 *
 * Writes one object into the scanlake-derived bucket, replacing any existing
 * object under the same key.  Requires the "derived:write" scope.
 *
 * Required headers:
 *   Content-Length    – body size in bytes, at most DERIVED_MAX_BYTES
 *   X-Content-SHA256  – hex SHA-256 of the body; R2 verifies it and rejects
 *                       the write if the received bytes differ
 * Optional:
 *   Content-Type      – stored as the object's content type
 *
 * Responds with { key, size, etag }.
 * Returns 400 for unsafe keys or malformed headers, 411 without
 * Content-Length, 413 when too large, 422 on checksum mismatch.
 */
export async function derivedPutRoute(c: Context<DerivedEnv>): Promise<Response> {
  const key = c.req.param('key') ?? ''

  if (!isSafeKey(key)) {
    return c.json({ error: 'Invalid file key' }, 400)
  }

  const lengthHeader = c.req.header('Content-Length')
  if (lengthHeader === undefined) {
    return c.json({ error: 'Content-Length header is required' }, 411)
  }
  if (!CONTENT_LENGTH_RE.test(lengthHeader)) {
    return c.json({ error: 'Invalid Content-Length header' }, 400)
  }
  if (Number(lengthHeader) > DERIVED_MAX_BYTES) {
    return c.json({ error: `Body exceeds the ${DERIVED_MAX_BYTES} byte limit` }, 413)
  }

  const sha256 = c.req.header('X-Content-SHA256')
  if (!sha256 || !SHA256_HEX_RE.test(sha256)) {
    return c.json({ error: 'X-Content-SHA256 header must be 64 hex characters' }, 400)
  }

  const contentType = c.req.header('Content-Type') || 'application/octet-stream'

  let object: R2Object | null
  try {
    object = await c.env.SCANLAKE_DERIVED.put(key, c.req.raw.body ?? '', {
      sha256: sha256.toLowerCase(),
      httpMetadata: { contentType },
    })
  } catch (err) {
    if (isChecksumMismatch(err)) {
      return c.json({ error: 'Body does not match X-Content-SHA256' }, 422)
    }
    throw err
  }

  // put() only returns null when an onlyIf precondition fails, which we never set.
  if (!object) {
    return c.json({ error: 'Write failed' }, 500)
  }

  const meta = c.get('apiKeyMeta')
  const hash = c.get('apiKeyHash')

  c.executionCtx.waitUntil(
    logEvent(c.env, {
      ts: Date.now(),
      apiKey: hash,
      userId: meta.ownerId,
      action: 'write',
      dataset: key,
      bytes: object.size,
    }),
  )

  return c.json({ key: object.key, size: object.size, etag: object.etag })
}
