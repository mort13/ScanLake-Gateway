import type { Context } from 'hono'
import type { Env } from '../types'
import { isSafeKey } from '../services/keys'

type PublicEnv = { Bindings: Env }

/** R2 key prefix reserved for publicly readable static assets. */
const PUBLIC_PREFIX = 'public/'

/**
 * GET /public/:key{.+}
 *
 * Serves static assets stored in R2 under the "public/" prefix without
 * requiring authentication.  Only object keys starting with "public/" are
 * reachable through this route; the full bucket is never exposed.
 *
 * Supports the Range header so browsers can stream large binary files
 * (e.g. ONNX model data) efficiently.
 */
export async function publicAssetsRoute(c: Context<PublicEnv>): Promise<Response> {
  const rawKey = c.req.param('key') ?? ''

  if (!isSafeKey(rawKey)) {
    return c.json({ error: 'Invalid key' }, 400)
  }

  const r2Key = PUBLIC_PREFIX + rawKey
  const rangeHeader = c.req.header('Range')

  const options: R2GetOptions = rangeHeader ? { range: rangeHeader } : {}
  const object = await c.env.SCANLAKE_BUCKET.get(r2Key, options)

  if (!object) {
    return c.json({ error: 'Not found' }, 404)
  }

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  // Manifests (e.g. ScanLake Desktop's public/desktop/manifest.json) are replaced in place and
  // must be revalidated. Everything else is cached for a year: a changed file needs a new key
  // (like the content-addressed public/desktop/files/<sha256>), not an upload over the old one.
  headers.set(
    'Cache-Control',
    r2Key.endsWith('manifest.json') ? 'no-cache' : 'public, max-age=31536000, immutable',
  )
  if (object.etag) headers.set('ETag', `"${object.etag}"`)

  const status = rangeHeader ? 206 : 200
  return new Response(object.body, { status, headers })
}
