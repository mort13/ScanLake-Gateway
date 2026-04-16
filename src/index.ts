import { Hono } from 'hono'
import type { Env, AppVariables } from './types'
import { corsMiddleware } from './middleware/cors'
import { apiKeyMiddleware } from './middleware/apiKey'
import { rateLimitMiddleware } from './middleware/rateLimit'
import { filesListRoute, filesDownloadRoute } from './routes/files'

export { RateLimiter } from './durable-objects/RateLimiter'
export { LogBuffer } from './durable-objects/LogBuffer'

type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}

const app = new Hono<AppEnv>()

// CORS + OPTIONS preflight — must run before auth so browsers can preflight.
app.use('/api/*', corsMiddleware)

// Auth + rate-limiting for all file routes.
app.use('/api/files', apiKeyMiddleware)
app.use('/api/files', rateLimitMiddleware)
app.use('/api/files/*', apiKeyMiddleware)
app.use('/api/files/*', rateLimitMiddleware)

// File routes.
app.get('/api/files', filesListRoute)
app.get('/api/files/:key{.+}', filesDownloadRoute)

app.all('*', (c) => c.json({ error: 'Not found' }, 404))

export default app
