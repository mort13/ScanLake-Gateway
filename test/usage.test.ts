import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import app from '../src/index'
import type { Env } from '../src/types'
import { BASE, LONG_WINDOW_MS, PUBLIC_FILES, apiKey, randomHex, seedBuckets, seedInternalKey, seedUserKey } from './helpers'

let points: AnalyticsEngineDataPoint[]

/** Calls the app with a USAGE binding that records the data points written. */
async function callRecording(path: string, init: RequestInit = {}, usage = true): Promise<Response> {
  const dataset: AnalyticsEngineDataset = { writeDataPoint: (point) => void points.push(point ?? {}) }
  const testEnv: Env = { ...(env as Env), USAGE: usage ? dataset : undefined }
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`${BASE}${path}`, init), testEnv, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

beforeEach(async () => {
  points = []
  await seedBuckets()
})

describe('usage data points', () => {
  it('a user-key download writes one point in the order Auth reads', async () => {
    const { token, hash, meta } = await seedUserKey()
    const res = await callRecording('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(res.status).toBe(200)
    expect(points).toEqual([
      {
        indexes: [hash],
        blobs: ['user', meta.ownerId, meta.discordId, 'verified', 'GET', '/api/derived/manifest.json', '200'],
        doubles: [1, PUBLIC_FILES['manifest.json'].length],
      },
    ])
  })

  it('internal keys are "internal", with empty discordId and tier', async () => {
    const { token, hash, meta } = await seedInternalKey()
    await callRecording('/api/files', { headers: apiKey(token) })
    expect(points).toHaveLength(1)
    expect(points[0].indexes).toEqual([hash])
    expect(points[0].blobs).toEqual(['internal', meta.ownerId, '', '', 'GET', '/api/files', '200'])
  })

  it('403 and 404 outcomes are counted', async () => {
    const { token } = await seedUserKey()
    await callRecording('/api/files', { headers: apiKey(token) })
    await callRecording('/api/admin/budget', { headers: apiKey(token) })
    await callRecording('/api/derived/consolidated/positions.parquet', { headers: apiKey(token) })
    expect(points.map((p) => [p.blobs![5], p.blobs![6]])).toEqual([
      ['/api/files', '403'],
      ['/api/admin/budget', '403'],
      ['/api/derived/consolidated/positions.parquet', '404'],
    ])
  })

  it('429 outcomes are counted', async () => {
    const { token } = await seedUserKey({ limits: [{ limit: 1, windowMs: LONG_WINDOW_MS }] })
    await callRecording('/api/derived/manifest.json', { headers: apiKey(token) })
    await callRecording('/api/derived/manifest.json', { headers: apiKey(token) })
    expect(points.map((p) => p.blobs![6])).toEqual(['200', '429'])
  })

  it('a listing writes exactly one point', async () => {
    const { token } = await seedUserKey()
    await callRecording('/api/derived', { headers: apiKey(token) })
    expect(points).toHaveLength(1)
    expect(points[0].blobs![5]).toBe('/api/derived')
  })

  it('unauthenticated requests write nothing', async () => {
    await callRecording('/api/derived/manifest.json')
    await callRecording('/api/derived/manifest.json', { headers: apiKey(`slk_${randomHex(32)}`) })
    expect(points).toEqual([])
  })

  it('long paths are cut to 256 characters', async () => {
    const { token } = await seedInternalKey()
    const long = `/api/derived/${'a'.repeat(400)}`
    await callRecording(long, { headers: apiKey(token) })
    expect(points[0].blobs![5]).toBe(long.slice(0, 256))
  })

  it('without a USAGE binding nothing is written and requests still work', async () => {
    const { token } = await seedUserKey()
    const res = await callRecording('/api/derived/manifest.json', { headers: apiKey(token) }, false)
    expect(res.status).toBe(200)
    expect(points).toEqual([])
  })
})
