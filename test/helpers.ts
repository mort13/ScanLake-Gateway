import { env, exports } from 'cloudflare:workers'
import type { ApiKeyMeta } from '../src/types'

export const BASE = 'https://gateway.scanlake.rocks'

/** A window long enough (≈31.7 years, ends in 2033) that no test crosses its boundary. */
export const LONG_WINDOW_MS = 1_000_000_000_000

/** Sends a request through the worker's default export. */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init))
}

export function randomHex(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SeededKey {
  token: string
  hash: string
  meta: ApiKeyMeta
}

/** A fresh Discord id, so every test gets its own account rate-limit counter. */
export function newDiscordId(): string {
  return String(100_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e15)))
}

/** Stores a user (slk_) key as ScanLake Auth writes it and returns its token. */
export async function seedUserKey(overrides: Partial<ApiKeyMeta> = {}): Promise<SeededKey> {
  const token = `slk_${randomHex(32)}`
  const hash = await sha256Hex(token)
  const meta: ApiKeyMeta = {
    kind: 'user',
    ownerId: `owner-${randomHex(4)}`,
    discordId: newDiscordId(),
    tier: 'verified',
    active: true,
    // Generous, so tests that are not about limits never hit them.
    limits: [{ limit: 1000, windowMs: LONG_WINDOW_MS }],
    rateLimit: 1000,
    rateLimitWindowMs: LONG_WINDOW_MS,
    maxUploadBytes: 0,
    allowedOrigins: [],
    scopes: ['derived:public'],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  await env.API_KEYS.put(`ukey:${hash}`, JSON.stringify(meta))
  return { token, hash, meta }
}

/** Stores an internal (sk_) key the way scripts/create-api-key.mjs does. */
export async function seedInternalKey(overrides: Partial<ApiKeyMeta> = {}): Promise<SeededKey> {
  const token = `sk_${randomHex(32)}`
  const hash = await sha256Hex(token)
  const meta: ApiKeyMeta = {
    ownerId: 'scanlake-dashboard',
    active: true,
    rateLimit: 1000,
    rateLimitWindowMs: 3_600_000,
    maxUploadBytes: 0,
    allowedOrigins: [],
    scopes: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
  await env.API_KEYS.put(`apikey:${hash}`, JSON.stringify(meta))
  return { token, hash, meta }
}

export function apiKey(token: string): Record<string, string> {
  return { 'X-API-Key': token }
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export const USER_ID = '0b5e3f9a-3c1d-4e2f-9a8b-7c6d5e4f3a2b'

/** Public derived files (src/lib/publicDerived.ts) and their contents. */
export const PUBLIC_FILES: Record<string, string> = {
  'manifest.json': '{"version":1}',
  'consolidated/scans.parquet': 'scans',
  'consolidated/compositions.parquet': 'compositions',
  'results/ore_prices.parquet': 'ore prices',
}

/** Derived files user keys must not see. */
export const PRIVATE_FILES: Record<string, string> = {
  'consolidated/positions.parquet': 'positions',
  [`monthly/${USER_ID}/2026-11.parquet`]: 'monthly',
  'results/Bad-Name.parquet': 'not in the allowlist',
  'manifest.json.bak': 'old manifest',
}

export const RAW_FILE = `2026/11/01/${USER_ID}/session.parquet`

export async function seedBuckets(): Promise<void> {
  const derived = { ...PUBLIC_FILES, ...PRIVATE_FILES }
  await Promise.all([
    ...Object.entries(derived).map(([key, body]) => env.SCANLAKE_DERIVED.put(key, body)),
    env.SCANLAKE_BUCKET.put(RAW_FILE, 'raw scan data'),
  ])
}

export interface ListBody {
  objects: { key: string; size: number }[]
  truncated: boolean
  cursor?: string
}

/** The body as UTF-8 text (Response#text() warns on application/octet-stream bodies). */
export async function bodyText(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer())
}
