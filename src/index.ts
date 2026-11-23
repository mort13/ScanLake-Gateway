import { Hono } from 'hono'
import type { Env, AppVariables } from './types'
import { corsMiddleware } from './middleware/cors'
import { apiKeyMiddleware } from './middleware/apiKey'
import { usageMiddleware } from './middleware/usage'
import { restrictUserKeys } from './middleware/restrictUserKeys'
import { rateLimitMiddleware } from './middleware/rateLimit'
import { requireScope } from './middleware/requireScope'
import { makeListRoute, makeDownloadRoute } from './routes/files'
import { derivedPutRoute } from './routes/derived'
import { publicAssetsRoute } from './routes/publicAssets'
import { formatRoute } from './routes/format'
import { budgetStatusRoute } from './routes/admin'
import { PUBLIC_DERIVED_LIST_PREFIXES, isPublicDerivedKey } from './lib/publicDerived'

export { RateLimiter } from './durable-objects/RateLimiter'
export { LogBuffer } from './durable-objects/LogBuffer'

type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}

const app = new Hono<AppEnv>()

// CORS + OPTIONS preflight — must run before auth so browsers can preflight.
// Only GET is allowed cross-origin, so browsers can never reach the PUT route.
app.use('/api/*', corsMiddleware)
app.use('/public/*', corsMiddleware)

// Every authenticated route group runs, in order:
//   apiKeyMiddleware   resolve the key (401 unknown, 403 revoked / wrong origin)
//   usageMiddleware    count the request in Analytics Engine, whatever its outcome
//   restrictUserKeys   user (slk_) keys: public derived files only
//   rateLimitMiddleware  per key/account → per IP → global (not on admin routes)
const authenticated = [apiKeyMiddleware, usageMiddleware, restrictUserKeys] as const

// '/x/*' also matches '/x' itself in Hono, so one mount covers the listing route too
// (mounting '/x' as well would run the chain twice: two usage points, two rate-limit slots).
for (const path of ['/api/files/*', '/api/derived/*']) {
  app.use(path, ...authenticated, rateLimitMiddleware)
}

// Admin routes — require an internal key, no rate-limit slot consumed.
app.use('/api/admin/*', ...authenticated)
app.get('/api/admin/budget', budgetStatusRoute)

// Public (no-auth) static assets served from the "public/" R2 prefix.
app.get('/public/:key{.+}', publicAssetsRoute)

// Parquet format that uploads must match (no auth, proxied from the ScanLake-Format repo).
app.get('/api/format', formatRoute)

// Raw scan data (scanlake-data) — read-only, internal keys only.
app.get('/api/files', makeListRoute((env) => env.SCANLAKE_BUCKET))
app.get('/api/files/:key{.+}', makeDownloadRoute((env) => env.SCANLAKE_BUCKET))

// Derived data (scanlake-derived) — readable by internal keys, writable with "derived:write".
// User keys read only the public files (src/lib/publicDerived.ts) and list only those.
app.get(
  '/api/derived',
  makeListRoute((env) => env.SCANLAKE_DERIVED, {
    userKeyFilter: { prefixes: PUBLIC_DERIVED_LIST_PREFIXES, allow: isPublicDerivedKey },
  }),
)
app.get('/api/derived/:key{.+}', makeDownloadRoute((env) => env.SCANLAKE_DERIVED))
app.put('/api/derived/:key{.+}', requireScope('derived:write'), derivedPutRoute)

app.all('*', (c) => c.json({ error: 'Not found' }, 404))

export default app
