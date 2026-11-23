import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { RateLimiter, checkWindows, counterKey, windowStatus } from '../src/durable-objects/RateLimiter'
import type { RateWindow } from '../src/types'
import { LONG_WINDOW_MS, apiKey, call, randomHex, seedBuckets, seedInternalKey, seedUserKey } from './helpers'

function freshStub(): DurableObjectStub {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`test:${randomHex(8)}`))
}

/** Runs `fn` against the storage of a fresh RateLimiter instance. */
function withStorage<R>(fn: (storage: DurableObjectStorage) => Promise<R>): Promise<R> {
  return runInDurableObject(freshStub(), (_instance: RateLimiter, state) => fn(state.storage))
}

const MINUTE = 60_000
const DAY = 86_400_000
// 2026-11-23T10:00:30Z — 30 s into a minute.
const T0 = Date.UTC(2026, 10, 23, 10, 0, 30)

describe('RateLimiter fixed windows', () => {
  it('allows up to the limit, then refuses until the window resets', async () => {
    await withStorage(async (storage) => {
      const windows = [{ limit: 3, windowMs: MINUTE }]
      const remaining: number[] = []
      for (let i = 0; i < 3; i++) {
        const r = await checkWindows(storage, windows, T0 + i)
        expect(r.allowed).toBe(true)
        expect(r.limit).toBe(3)
        remaining.push(r.remaining)
      }
      expect(remaining).toEqual([2, 1, 0])

      const refused = await checkWindows(storage, windows, T0 + 10)
      expect(refused.allowed).toBe(false)
      expect(refused.remaining).toBe(0)
      // Window [10:00:00, 10:01:00) ends 30 s - 10 ms after T0 + 10.
      expect(refused.retryAfterMs).toBe(30_000 - 10)
      expect(refused.resetMs).toBe(30_000 - 10)

      const next = await checkWindows(storage, windows, T0 + 30_000)
      expect(next.allowed).toBe(true)
      expect(next.remaining).toBe(2)
    })
  })

  it('counts every window and increments none when one is full', async () => {
    await withStorage(async (storage) => {
      const windows = [
        { limit: 2, windowMs: MINUTE },
        { limit: 5, windowMs: DAY },
      ]
      await checkWindows(storage, windows, T0)
      await checkWindows(storage, windows, T0 + 1)
      const refused = await checkWindows(storage, windows, T0 + 2)
      expect(refused.allowed).toBe(false)

      const dayKey = counterKey(DAY, Math.floor(T0 / DAY))
      expect(await storage.get(dayKey)).toBe(2)

      // Next minute: allowed again, the day counter carries on.
      const later = await checkWindows(storage, windows, T0 + MINUTE)
      expect(later.allowed).toBe(true)
      expect(await storage.get(dayKey)).toBe(3)
    })
  })

  it('reports the binding window: fewest requests left', async () => {
    await withStorage(async (storage) => {
      const windows = [
        { limit: 60, windowMs: MINUTE },
        { limit: 2, windowMs: DAY },
      ]
      const first = await checkWindows(storage, windows, T0)
      expect(first).toMatchObject({ allowed: true, limit: 2, remaining: 1 })
      expect(first.resetMs).toBe(DAY - (T0 % DAY))

      await checkWindows(storage, windows, T0 + 1)
      const refused = await checkWindows(storage, windows, T0 + 2)
      expect(refused).toMatchObject({ allowed: false, limit: 2, remaining: 0 })
      // Only the day window is full, so that is how long to wait.
      expect(refused.retryAfterMs).toBe(DAY - ((T0 + 2) % DAY))
    })
  })

  it('a limit of 0 refuses everything', async () => {
    await withStorage(async (storage) => {
      const r = await checkWindows(storage, [{ limit: 0, windowMs: MINUTE }], T0)
      expect(r.allowed).toBe(false)
    })
  })

  it('prunes ended windows and the legacy timestamp array', async () => {
    await withStorage(async (storage) => {
      const oldIndex = Math.floor(T0 / MINUTE) - 5
      await storage.put({
        timestamps: [1, 2, 3],
        [counterKey(MINUTE, oldIndex)]: 7,
        // A window length no longer in use, long over.
        [counterKey(1000, 5)]: 1,
        // Still running: must survive.
        [counterKey(DAY, Math.floor(T0 / DAY))]: 4,
      })

      await checkWindows(storage, [{ limit: 10, windowMs: MINUTE }], T0)

      const keys = [...(await storage.list()).keys()].sort()
      expect(keys).toEqual(
        [counterKey(DAY, Math.floor(T0 / DAY)), counterKey(MINUTE, Math.floor(T0 / MINUTE))].sort(),
      )
    })
  })

  it('windowStatus reads without counting', async () => {
    await withStorage(async (storage) => {
      const windows = [{ limit: 10, windowMs: MINUTE }]
      await checkWindows(storage, windows, T0)
      await checkWindows(storage, windows, T0 + 1)
      expect(await windowStatus(storage, MINUTE, T0 + 2)).toEqual({ count: 2, resetMs: 30_000 - 2 })
      expect(await windowStatus(storage, MINUTE, T0 + 3)).toEqual({ count: 2, resetMs: 30_000 - 3 })
      expect(await windowStatus(storage, MINUTE, T0 + 30_000)).toEqual({ count: 0, resetMs: MINUTE })
    })
  })
})

describe('RateLimiter fetch API', () => {
  async function post(stub: DurableObjectStub, body: unknown): Promise<Response> {
    return stub.fetch('https://rate-limiter/check', { method: 'POST', body: JSON.stringify(body) })
  }

  it('accepts a list of windows and the old single-window body', async () => {
    const stub = freshStub()
    const windows: RateWindow[] = [{ limit: 2, windowMs: LONG_WINDOW_MS }]
    expect(await (await post(stub, { windows })).json()).toMatchObject({ allowed: true, remaining: 1 })
    expect(await (await post(stub, { limit: 2, windowMs: LONG_WINDOW_MS })).json()).toMatchObject({
      allowed: true,
      remaining: 0,
    })
    expect(await (await post(stub, { windows })).json()).toMatchObject({ allowed: false })

    const status = await stub.fetch(`https://rate-limiter/status?windowMs=${LONG_WINDOW_MS}`)
    expect(await status.json()).toMatchObject({ count: 2 })
  })

  it('rejects invalid windows', async () => {
    const stub = freshStub()
    for (const body of [{ windows: [] }, { windows: [{ limit: 1, windowMs: 0 }] }, { windows: [{ limit: -1, windowMs: 1 }] }, {}]) {
      expect((await post(stub, body)).status).toBe(400)
    }
  })
})

describe('rate limiting through the Gateway', () => {
  beforeEach(async () => {
    await seedBuckets()
  })

  it('user keys: X-RateLimit headers, then 429 with Retry-After', async () => {
    const { token } = await seedUserKey({ limits: [{ limit: 3, windowMs: LONG_WINDOW_MS }] })
    const remaining: string[] = []
    for (let i = 0; i < 3; i++) {
      const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
      expect(res.status).toBe(200)
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3')
      expect(Number(res.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(0)
      remaining.push(res.headers.get('X-RateLimit-Remaining')!)
    }
    expect(remaining).toEqual(['2', '1', '0'])

    const limited = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'Rate limit exceeded' })
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('3')
    expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  it('every key of one Discord account shares its limits', async () => {
    const limits = [{ limit: 2, windowMs: LONG_WINDOW_MS }]
    const first = await seedUserKey({ limits })
    const second = await seedUserKey({ limits, discordId: first.meta.discordId })
    const otherAccount = await seedUserKey({ limits })

    expect((await call('/api/derived/manifest.json', { headers: apiKey(first.token) })).status).toBe(200)
    expect((await call('/api/derived/manifest.json', { headers: apiKey(second.token) })).status).toBe(200)
    expect((await call('/api/derived/manifest.json', { headers: apiKey(second.token) })).status).toBe(429)
    expect((await call('/api/derived/manifest.json', { headers: apiKey(first.token) })).status).toBe(429)
    expect((await call('/api/derived/manifest.json', { headers: apiKey(otherAccount.token) })).status).toBe(200)
  })

  it('the most restrictive window sets the headers', async () => {
    const { token } = await seedUserKey({
      limits: [
        { limit: 10, windowMs: LONG_WINDOW_MS },
        { limit: 4, windowMs: LONG_WINDOW_MS * 2 },
      ],
    })
    const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.headers.get('X-RateLimit-Limit')).toBe('4')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('3')
  })

  it('a user key without limits falls back to rateLimit / rateLimitWindowMs', async () => {
    const { token } = await seedUserKey({ limits: undefined, rateLimit: 1, rateLimitWindowMs: LONG_WINDOW_MS })
    expect((await call('/api/derived/manifest.json', { headers: apiKey(token) })).status).toBe(200)
    expect((await call('/api/derived/manifest.json', { headers: apiKey(token) })).status).toBe(429)
  })

  it('a refused user-key request (403/404) costs no rate-limit slot', async () => {
    const { token } = await seedUserKey({ limits: [{ limit: 1, windowMs: LONG_WINDOW_MS }] })
    expect((await call('/api/files', { headers: apiKey(token) })).status).toBe(403)
    expect((await call('/api/derived/consolidated/positions.parquet', { headers: apiKey(token) })).status).toBe(404)
    expect((await call('/api/derived/manifest.json', { headers: apiKey(token) })).status).toBe(200)
  })

  it('a listing counts once', async () => {
    const { token } = await seedUserKey({ limits: [{ limit: 5, windowMs: LONG_WINDOW_MS }] })
    const res = await call('/api/derived', { headers: apiKey(token) })
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4')
  })

  it('internal keys: per-key limit with Retry-After, no X-RateLimit headers', async () => {
    const { token } = await seedInternalKey({ rateLimit: 2, rateLimitWindowMs: LONG_WINDOW_MS })
    expect((await call('/api/files', { headers: apiKey(token) })).status).toBe(200)
    expect((await call('/api/files', { headers: apiKey(token) })).status).toBe(200)
    const limited = await call('/api/files', { headers: apiKey(token) })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(limited.headers.get('X-RateLimit-Limit')).toBeNull()
  })
})
