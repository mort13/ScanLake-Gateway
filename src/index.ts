import { Hono } from 'hono'
import type { Env, AppVariables } from './types'
import { corsMiddleware } from './middleware/cors'
import { ipAllowlistMiddleware } from './middleware/ipAllowlist'
import { apiKeyMiddleware } from './middleware/apiKey'
import { rateLimitMiddleware } from './middleware/rateLimit'
import { filesListRoute, filesDownloadRoute } from './routes/files'
import { publicAssetsRoute } from './routes/publicAssets'
import { budgetStatusRoute } from './routes/admin'

export { RateLimiter } from './durable-objects/RateLimiter'
export { LogBuffer } from './durable-objects/LogBuffer'

type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}

const app = new Hono<AppEnv>()

// IP allowlist — blocks unlisted clients before any other logic runs.
app.use('*', ipAllowlistMiddleware)

// CORS + OPTIONS preflight — must run before auth so browsers can preflight.
app.use('/api/*', corsMiddleware)
app.use('/public/*', corsMiddleware)

// Auth + rate-limiting for all file routes.
app.use('/api/files', apiKeyMiddleware)
app.use('/api/files', rateLimitMiddleware)
app.use('/api/files/*', apiKeyMiddleware)
app.use('/api/files/*', rateLimitMiddleware)

// Admin routes — require a valid API key, no rate-limit slot consumed.
app.use('/api/admin/*', apiKeyMiddleware)
app.get('/api/admin/budget', budgetStatusRoute)

// Public (no-auth) static assets served from the "public/" R2 prefix.
app.get('/public/:key{.+}', publicAssetsRoute)

// File routes.
app.get('/api/files', filesListRoute)
app.get('/api/files/:key{.+}', filesDownloadRoute)

app.all('*', (c) => c.json({ error: 'Not found' }, 404))

export default app
