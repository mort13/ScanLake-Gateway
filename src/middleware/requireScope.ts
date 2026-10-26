import type { MiddlewareHandler } from 'hono'
import type { Env, AppVariables } from '../types'

type RequireScopeEnv = {
  Bindings: Env
  Variables: AppVariables
}

/**
 * Rejects the request with 403 unless the API key's metadata lists `scope`.
 *
 * Must run after apiKeyMiddleware (which sets apiKeyMeta).  Keys without a
 * `scopes` field are treated as read-only and never pass this check.
 */
export function requireScope(scope: string): MiddlewareHandler<RequireScopeEnv> {
  return async (c, next) => {
    const scopes = c.get('apiKeyMeta').scopes ?? []
    if (!scopes.includes(scope)) {
      return c.json({ error: `API key lacks required scope: ${scope}` }, 403)
    }
    await next()
  }
}
