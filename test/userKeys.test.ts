import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { USER_KEYS_CONFIG_KEY } from '../src/middleware/restrictUserKeys'
import {
  PRIVATE_FILES,
  PUBLIC_FILES,
  RAW_FILE,
  USER_ID,
  apiKey,
  bearer,
  bodyText,
  call,
  randomHex,
  seedBuckets,
  seedInternalKey,
  seedUserKey,
  sha256Hex,
  type ListBody,
} from './helpers'

beforeEach(async () => {
  await seedBuckets()
})

afterEach(async () => {
  await env.API_KEYS.delete(USER_KEYS_CONFIG_KEY)
})

async function listedKeys(res: Response): Promise<string[]> {
  return (await res.json<ListBody>()).objects.map((o) => o.key)
}

describe('user keys: allowed files', () => {
  for (const [key, body] of Object.entries(PUBLIC_FILES)) {
    it(`GET /api/derived/${key} → 200`, async () => {
      const { token } = await seedUserKey()
      const res = await call(`/api/derived/${key}`, { headers: apiKey(token) })
      expect(res.status).toBe(200)
      expect(await bodyText(res)).toBe(body)
    })
  }

  it('HEAD on a public file → 200', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/derived/manifest.json', { method: 'HEAD', headers: apiKey(token) })
    expect(res.status).toBe(200)
  })

  it('a public path that does not exist → 404', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/derived/results/missing.parquet', { headers: apiKey(token) })
    expect(res.status).toBe(404)
  })
})

describe('user keys: forbidden routes', () => {
  it('GET /api/files → 403', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/files', { headers: apiKey(token) })
    expect(res.status).toBe(403)
  })

  it('GET /api/files/<key> → 403', async () => {
    const { token } = await seedUserKey()
    const res = await call(`/api/files/${RAW_FILE}`, { headers: apiKey(token) })
    expect(res.status).toBe(403)
  })

  it('GET /api/admin/budget → 403', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/admin/budget', { headers: apiKey(token) })
    expect(res.status).toBe(403)
  })

  it('PUT → 403, even with a derived:write scope in the entry', async () => {
    const { token } = await seedUserKey({ scopes: ['derived:public', 'derived:write'] })
    const body = 'overwritten'
    const sha = await sha256Hex(body)
    for (const key of ['results/ore_prices.parquet', 'monthly/x.parquet']) {
      const res = await call(`/api/derived/${key}`, {
        method: 'PUT',
        headers: { ...apiKey(token), 'Content-Length': String(body.length), 'X-Content-SHA256': sha },
        body,
      })
      expect(res.status).toBe(403)
    }
    expect(await (await env.SCANLAKE_DERIVED.get('results/ore_prices.parquet'))!.text()).toBe('ore prices')
  })

  it('an entry under ukey: is restricted even if it claims another kind', async () => {
    const { token } = await seedUserKey({ kind: undefined })
    const res = await call('/api/files', { headers: apiKey(token) })
    expect(res.status).toBe(403)
  })
})

describe('user keys: private derived files → 404', () => {
  const paths = [
    ...Object.keys(PRIVATE_FILES),
    'consolidated%2Fpositions.parquet',
    'consolidated/%70ositions.parquet',
    `monthly/${USER_ID}/`,
  ]
  for (const path of paths) {
    it(`GET /api/derived/${path} → 404`, async () => {
      const { token } = await seedUserKey()
      const res = await call(`/api/derived/${path}`, { headers: apiKey(token) })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'File not found' })
    })
  }
})

describe('user keys: listing', () => {
  it('GET /api/derived lists only the public files, without a cursor', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/derived', { headers: apiKey(token) })
    expect(res.status).toBe(200)
    const body = await res.json<ListBody>()
    expect(body.objects.map((o) => o.key)).toEqual(Object.keys(PUBLIC_FILES).sort())
    expect(body.truncated).toBe(false)
    expect(body.cursor).toBeUndefined()
  })

  it('honours prefix', async () => {
    const { token } = await seedUserKey()
    const results = await call('/api/derived?prefix=results/', { headers: apiKey(token) })
    expect(await listedKeys(results)).toEqual(['results/ore_prices.parquet'])

    const narrower = await call('/api/derived?prefix=consolidated/s', { headers: apiKey(token) })
    expect(await listedKeys(narrower)).toEqual(['consolidated/scans.parquet'])

    const monthly = await call('/api/derived?prefix=monthly/', { headers: apiKey(token) })
    expect(await listedKeys(monthly)).toEqual([])
  })

  it('honours limit and reports truncation', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/derived?limit=2', { headers: apiKey(token) })
    const body = await res.json<ListBody>()
    expect(body.objects.map((o) => o.key)).toEqual(Object.keys(PUBLIC_FILES).sort().slice(0, 2))
    expect(body.truncated).toBe(true)
    expect(body.cursor).toBeUndefined()
  })
})

describe('user keys: kill switch', () => {
  it('serving=false → 403 for user keys', async () => {
    const { token } = await seedUserKey()
    await env.API_KEYS.put(USER_KEYS_CONFIG_KEY, JSON.stringify({ issuing: true, serving: false }))
    const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'API access for user keys is paused' })
  })

  it('serving=false leaves internal keys alone', async () => {
    const { token } = await seedInternalKey()
    await env.API_KEYS.put(USER_KEYS_CONFIG_KEY, JSON.stringify({ issuing: false, serving: false }))
    const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.status).toBe(200)
  })

  it('serving=true or a missing entry → served', async () => {
    const { token } = await seedUserKey()
    expect((await call('/api/derived/manifest.json', { headers: apiKey(token) })).status).toBe(200)
    await env.API_KEYS.put(USER_KEYS_CONFIG_KEY, JSON.stringify({ issuing: false, serving: true }))
    expect((await call('/api/derived/manifest.json', { headers: apiKey(token) })).status).toBe(200)
  })

  it('an unreadable entry counts as paused', async () => {
    const { token } = await seedUserKey()
    await env.API_KEYS.put(USER_KEYS_CONFIG_KEY, '{not json')
    const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.status).toBe(403)
  })
})

describe('key resolution', () => {
  it('unknown slk_ key → 401', async () => {
    const res = await call('/api/derived/manifest.json', { headers: apiKey(`slk_${randomHex(32)}`) })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid API key' })
  })

  it('revoked (deleted) user key → 401', async () => {
    const { token, hash } = await seedUserKey()
    expect((await call('/api/derived/manifest.json', { headers: apiKey(token) })).status).toBe(200)
    await env.API_KEYS.delete(`ukey:${hash}`)
    expect((await call('/api/derived/manifest.json', { headers: apiKey(token) })).status).toBe(401)
  })

  it('user key with active:false → 403', async () => {
    const { token } = await seedUserKey({ active: false })
    const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.status).toBe(403)
  })

  it('malformed slk_ keys → 401 (wrong length, uppercase hex)', async () => {
    for (const bad of [`slk_${randomHex(31)}`, `slk_${randomHex(32).toUpperCase()}`, 'slk_']) {
      const res = await call('/api/derived/manifest.json', { headers: apiKey(bad) })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid API key format' })
    }
  })

  it('a user key is not looked up under apikey:, so Store never sees it', async () => {
    const token = `slk_${randomHex(32)}`
    const hash = await sha256Hex(token)
    await env.API_KEYS.put(
      `apikey:${hash}`,
      JSON.stringify({ ownerId: 'x', active: true, rateLimit: 10, rateLimitWindowMs: 60_000, maxUploadBytes: 0, allowedOrigins: [] }),
    )
    const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.status).toBe(401)
  })

  it('missing key → 401', async () => {
    const res = await call('/api/derived/manifest.json')
    expect(res.status).toBe(401)
  })

  it('Authorization: Bearer works for user keys', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/derived/manifest.json', { headers: bearer(token) })
    expect(res.status).toBe(200)
    const lower = await call('/api/derived/manifest.json', { headers: { Authorization: `bearer ${token}` } })
    expect(lower.status).toBe(200)
  })

  it('X-API-Key wins over Authorization', async () => {
    const { token } = await seedUserKey()
    const res = await call('/api/derived/manifest.json', {
      headers: { ...apiKey(`slk_${randomHex(32)}`), ...bearer(token) },
    })
    expect(res.status).toBe(401)
  })

  it('CORS preflight allows Authorization and exposes the rate-limit headers', async () => {
    const res = await call('/api/derived/manifest.json', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization')
  })
})

describe('internal sk_ keys are unchanged', () => {
  it('can list and read /api/files', async () => {
    const { token } = await seedInternalKey()
    const list = await call('/api/files', { headers: apiKey(token) })
    expect(list.status).toBe(200)
    expect(await listedKeys(list)).toContain(RAW_FILE)

    const file = await call(`/api/files/${RAW_FILE}`, { headers: apiKey(token) })
    expect(file.status).toBe(200)
    expect(await bodyText(file)).toBe('raw scan data')
  })

  it('sees the whole derived bucket, positions and monthly included', async () => {
    const { token } = await seedInternalKey()
    const list = await call('/api/derived', { headers: apiKey(token) })
    const keys = await listedKeys(list)
    for (const key of [...Object.keys(PUBLIC_FILES), ...Object.keys(PRIVATE_FILES)]) expect(keys).toContain(key)

    const positions = await call('/api/derived/consolidated/positions.parquet', { headers: apiKey(token) })
    expect(positions.status).toBe(200)
    expect(await bodyText(positions)).toBe('positions')
  })

  it('gets no X-RateLimit headers', async () => {
    const { token } = await seedInternalKey()
    const res = await call('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-RateLimit-Limit')).toBeNull()
  })

  it('can read /api/admin/budget', async () => {
    const { token } = await seedInternalKey()
    const res = await call('/api/admin/budget', { headers: apiKey(token) })
    expect(res.status).toBe(200)
    const body = await res.json<{ limit: number; windowLabel: string; used: number; remaining: number }>()
    expect(body.limit).toBe(10_000_000)
    expect(body.windowLabel).toBe('30-day window')
    expect(body.used + body.remaining).toBe(10_000_000)
  })

  it('PUT still needs derived:write', async () => {
    const { token } = await seedInternalKey()
    const res = await call('/api/derived/results/x.parquet', {
      method: 'PUT',
      headers: { ...apiKey(token), 'Content-Length': '1', 'X-Content-SHA256': '0'.repeat(64) },
      body: 'x',
    })
    expect(res.status).toBe(403)
  })
})
