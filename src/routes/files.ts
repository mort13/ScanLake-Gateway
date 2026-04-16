import type { Context } from 'hono'
import type { Env, AppVariables } from '../types'
import { listFiles, getFile } from '../services/r2'
import { logEvent } from '../services/logger'

type FilesEnv = {
  Bindings: Env
  Variables: AppVariables
}

/** Allowlist for R2 object key characters. Prevents path traversal. */
const SAFE_KEY_RE = /^[a-zA-Z0-9/_.\-]+$/

function isSafeKey(key: string): boolean {
  return (
    key.length > 0 &&
    SAFE_KEY_RE.test(key) &&
    !key.includes('..') && // no parent-directory traversal
    !key.startsWith('/') // no absolute paths
  )
}

/**
 * GET /api/files
 *
 * Lists objects in the scanlake-data bucket.
 * Query params:
 *   prefix  – optional key prefix filter
 *   limit   – number of results (1–1000, default 100)
 *   cursor  – pagination cursor from a previous response
 */
export async function filesListRoute(c: Context<FilesEnv>): Promise<Response> {
  const prefix = c.req.query('prefix') || undefined
  const cursor = c.req.query('cursor') || undefined
  const limitRaw = c.req.query('limit')
  const limit = limitRaw ? Math.min(Math.max(1, parseInt(limitRaw, 10)), 1000) : 100

  const result = await listFiles(c.env.SCANLAKE_BUCKET, prefix, limit, cursor)

  const meta = c.get('apiKeyMeta')
  const hash = c.get('apiKeyHash')

  c.executionCtx.waitUntil(
    logEvent(c.env, {
      ts: Date.now(),
      apiKey: hash,
      userId: meta.ownerId,
      action: 'read',
    }),
  )

  return c.json({
    objects: result.objects,
    truncated: result.truncated,
    ...(result.cursor ? { cursor: result.cursor } : {}),
  })
}

/**
 * GET /api/files/:key
 *
 * Streams a single file from the scanlake-data bucket.
 * The :key path supports slashes (e.g. 2026/04/16/user/file.parquet).
 * Returns 400 for unsafe keys, 404 for missing files.
 */
export async function filesDownloadRoute(c: Context<FilesEnv>): Promise<Response> {
  const rawKey = c.req.param('key') ?? ''

  if (!isSafeKey(rawKey)) {
    return c.json({ error: 'Invalid file key' }, 400)
  }

  const object = await getFile(c.env.SCANLAKE_BUCKET, rawKey)

  if (!object) {
    return c.json({ error: 'File not found' }, 404)
  }

  const meta = c.get('apiKeyMeta')
  const hash = c.get('apiKeyHash')
  const filename = rawKey.split('/').pop() ?? rawKey

  c.executionCtx.waitUntil(
    logEvent(c.env, {
      ts: Date.now(),
      apiKey: hash,
      userId: meta.ownerId,
      action: 'read',
      dataset: filename,
      bytes: object.size,
    }),
  )

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('content-length', String(object.size))
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/octet-stream')
  }
  if (!headers.has('content-disposition')) {
    headers.set('content-disposition', `attachment; filename="${filename}"`)
  }

  return new Response(object.body, { headers })
}
