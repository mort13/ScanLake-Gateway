import type { Context } from 'hono'
import type { Env, AppVariables } from '../types'
import { listFiles, getFile } from '../services/r2'
import { logEvent } from '../services/logger'
import { isSafeKey } from '../services/keys'

type FilesEnv = {
  Bindings: Env
  Variables: AppVariables
}

/** Picks the R2 bucket a route operates on (e.g. env => env.SCANLAKE_BUCKET). */
export type BucketSelector = (env: Env) => R2Bucket

/**
 * GET /api/files, GET /api/derived
 *
 * Lists objects in the selected bucket.
 * Query params:
 *   prefix  – optional key prefix filter
 *   limit   – number of results (1–1000, default 100)
 *   cursor  – pagination cursor from a previous response
 */
export function makeListRoute(selectBucket: BucketSelector) {
  return async function listRoute(c: Context<FilesEnv>): Promise<Response> {
    const prefix = c.req.query('prefix') || undefined
    const cursor = c.req.query('cursor') || undefined
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Math.min(Math.max(1, parseInt(limitRaw, 10)), 1000) : 100

    const result = await listFiles(selectBucket(c.env), prefix, limit, cursor)

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
}

/**
 * GET /api/files/:key, GET /api/derived/:key
 *
 * Streams a single file from the selected bucket.
 * The :key path supports slashes (e.g. 2026/04/16/user/file.parquet).
 * Returns 400 for unsafe keys, 404 for missing files.
 */
export function makeDownloadRoute(selectBucket: BucketSelector) {
  return async function downloadRoute(c: Context<FilesEnv>): Promise<Response> {
    const rawKey = c.req.param('key') ?? ''

    if (!isSafeKey(rawKey)) {
      return c.json({ error: 'Invalid file key' }, 400)
    }

    const object = await getFile(selectBucket(c.env), rawKey)

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
}
