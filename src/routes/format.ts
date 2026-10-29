import type { Context } from 'hono'
import type { Env } from '../types'

type FormatEnv = { Bindings: Env }

/** How long the format is cached at the edge and by clients. */
const FORMAT_CACHE_SECONDS = 300

/**
 * GET /api/format
 *
 * Serves the parquet format (format.json from the ScanLake-Format repository)
 * that ScanLake Store checks every upload against: the columns and column
 * types each of scans, compositions and confidences must have.
 * Public — no API key needed.  Returns 502 if the repository is unreachable.
 */
export async function formatRoute(c: Context<FormatEnv>): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(c.env.FORMAT_URL, {
      cf: { cacheTtl: FORMAT_CACHE_SECONDS, cacheEverything: true },
    })
  } catch (err) {
    console.error('Format fetch failed:', err)
    return c.json({ error: 'Format unavailable' }, 502)
  }
  if (!upstream.ok) {
    return c.json({ error: 'Format unavailable' }, 502)
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${FORMAT_CACHE_SECONDS}`,
    },
  })
}
