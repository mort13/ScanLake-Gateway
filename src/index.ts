import { Hono } from 'hono'
import type { Env, AppVariables } from './types'
import { corsMiddleware } from './middleware/cors'
import { apiKeyMiddleware } from './middleware/apiKey'
import { rateLimitMiddleware } from './middleware/rateLimit'
import { requireScope } from './middleware/requireScope'
import { makeListRoute, makeDownloadRoute } from './routes/files'
import { derivedPutRoute } from './routes/derived'
import { publicAssetsRoute } from './routes/publicAssets'
import { formatRoute } from './routes/format'
import { budgetStatusRoute } from './routes/admin'

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

// Auth + rate-limiting for all file routes.
app.use('/api/files', apiKeyMiddleware)
app.use('/api/files', rateLimitMiddleware)
app.use('/api/files/*', apiKeyMiddleware)
app.use('/api/files/*', rateLimitMiddleware)
app.use('/api/derived', apiKeyMiddleware)
app.use('/api/derived', rateLimitMiddleware)
app.use('/api/derived/*', apiKeyMiddleware)
app.use('/api/derived/*', rateLimitMiddleware)

// Admin routes — require a valid API key, no rate-limit slot consumed.
app.use('/api/admin/*', apiKeyMiddleware)
app.get('/api/admin/budget', budgetStatusRoute)

// Public (no-auth) static assets served from the "public/" R2 prefix.
app.get('/public/:key{.+}', publicAssetsRoute)

// Parquet format that uploads must match (no auth, proxied from the ScanLake-Format repo).
app.get('/api/format', formatRoute)

// Raw scan data (scanlake-data) — read-only.
app.get('/api/files', makeListRoute((env) => env.SCANLAKE_BUCKET))
app.get('/api/files/:key{.+}', makeDownloadRoute((env) => env.SCANLAKE_BUCKET))

// Derived data (scanlake-derived) — readable by any key, writable with "derived:write".
app.get('/api/derived', makeListRoute((env) => env.SCANLAKE_DERIVED))
app.get('/api/derived/:key{.+}', makeDownloadRoute((env) => env.SCANLAKE_DERIVED))
app.put('/api/derived/:key{.+}', requireScope('derived:write'), derivedPutRoute)

app.all('*', (c) => c.json({ error: 'Not found' }, 404))

export default app
