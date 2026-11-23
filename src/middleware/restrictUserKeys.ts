import type { MiddlewareHandler } from 'hono'
import type { Env, AppVariables } from '../types'
import { isPublicDerivedPath } from '../lib/publicDerived'

type RestrictEnv = {
  Bindings: Env
  Variables: AppVariables
}

/**
 * Kill switch shared with ScanLake Auth.  A missing entry means both are on;
 * `issuing` is Auth's business, the Gateway only reads `serving`.
 */
export const USER_KEYS_CONFIG_KEY = 'config:user-keys'

interface UserKeysConfig {
  issuing?: boolean
  serving?: boolean
}

/**
 * Whether user keys are being served.  Cached at the edge for 60 s, so
 * flipping the switch takes up to a minute to reach every location.  An entry
 * that is not valid JSON counts as paused: the only reason to write the key is
 * to change the switch, and failing closed is the safe reading of a typo.
 */
export async function userKeysServing(env: Env): Promise<boolean> {
  try {
    const config = await env.API_KEYS.get<UserKeysConfig>(USER_KEYS_CONFIG_KEY, { type: 'json', cacheTtl: 60 })
    return config?.serving !== false
  } catch (err) {
    console.error(`[restrictUserKeys] unreadable ${USER_KEYS_CONFIG_KEY}, treating user keys as paused:`, err)
    return false
  }
}

const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * Limits user keys (kind "user", issued by ScanLake Auth) to the public
 * derived files.  Internal sk_ keys pass through untouched.
 *
 * For user keys:
 *   - paused (config:user-keys serving=false)     → 403
 *   - /api/files*, /api/admin/*                    → 403
 *   - any method other than GET/HEAD (e.g. PUT)    → 403
 *   - GET /api/derived                             → listing, filtered by the route
 *   - GET /api/derived/<public file>               → served
 *   - GET /api/derived/<anything else>             → 404, whether it exists or not
 *
 * Must run after apiKeyMiddleware.  Mounted on every authenticated route
 * group; a new route group must mount it too.
 */
export const restrictUserKeys: MiddlewareHandler<RestrictEnv> = async (c, next) => {
  if (c.get('apiKeyMeta').kind !== 'user') return next()

  if (!(await userKeysServing(c.env))) {
    return c.json({ error: 'API access for user keys is paused' }, 403)
  }

  // Raw, still percent-encoded path: the allowlist only matches unencoded paths.
  const path = new URL(c.req.url).pathname

  if (path !== '/api/derived' && !path.startsWith('/api/derived/')) {
    return c.json({ error: 'User API keys can only read public derived data' }, 403)
  }

  if (!READ_METHODS.has(c.req.method)) {
    return c.json({ error: 'User API keys are read-only' }, 403)
  }

  if (path === '/api/derived' || isPublicDerivedPath(path)) {
    return next()
  }

  // Same body as a missing file, so private paths (positions, monthly/) are not confirmed to exist.
  return c.json({ error: 'File not found' }, 404)
}
