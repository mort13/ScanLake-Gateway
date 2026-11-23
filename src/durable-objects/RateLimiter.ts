import type { RateWindow } from '../types'
import { isValidWindow } from '../lib/limits'

/** POST /check body.  The single-window form ({ limit, windowMs }) is still accepted. */
export interface CheckRequest {
  windows?: RateWindow[]
  limit?: number
  windowMs?: number
}

export interface CheckResult {
  /** True if every window had room; only then were the counters incremented. */
  allowed: boolean
  /** Limit of the binding window: the one with the fewest requests left. */
  limit: number
  /** Requests left in the binding window after this one (0 when refused). */
  remaining: number
  /** Milliseconds until the binding window resets. */
  resetMs: number
  /** When refused: milliseconds until every full window has reset.  0 when allowed. */
  retryAfterMs: number
}

export interface StatusResult {
  /** Requests counted in the current window of `windowMs`. */
  count: number
  /** Milliseconds until that window resets. */
  resetMs: number
}

/** Storage key of the counter for window number `index` of length `windowMs`. */
export function counterKey(windowMs: number, index: number): string {
  return `w:${windowMs}:${index}`
}

/** Storage key of the pre-counter implementation (one timestamp per request). */
const LEGACY_KEY = 'timestamps'

/**
 * Deletes counters whose window has ended (of any length, so windows a key no
 * longer uses are cleaned up too) and the legacy timestamp array.
 */
async function prune(storage: DurableObjectStorage, now: number): Promise<void> {
  const stored = await storage.list<number>({ prefix: 'w:' })
  const expired: string[] = [LEGACY_KEY]
  for (const key of stored.keys()) {
    const [, msRaw, indexRaw] = key.split(':')
    const windowMs = Number(msRaw)
    const index = Number(indexRaw)
    if (!(windowMs > 0) || !Number.isFinite(index) || (index + 1) * windowMs <= now) expired.push(key)
  }
  // delete() takes at most 128 keys per call.
  for (let i = 0; i < expired.length; i += 128) await storage.delete(expired.slice(i, i + 128))
}

/**
 * Counts one request against every window, but only if all of them have room.
 *
 * Fixed windows aligned to the epoch: window number floor(now / windowMs) of
 * each length gets its own counter under w:<windowMs>:<index>.  A refused
 * request increments nothing, so retrying while throttled costs no budget.
 */
export async function checkWindows(
  storage: DurableObjectStorage,
  windows: RateWindow[],
  now: number,
): Promise<CheckResult> {
  const slots = windows.map((w) => {
    const index = Math.floor(now / w.windowMs)
    return { ...w, key: counterKey(w.windowMs, index), resetMs: (index + 1) * w.windowMs - now }
  })
  const counts = await storage.get<number>(slots.map((s) => s.key))
  const withCounts = slots.map((s) => ({ ...s, count: counts.get(s.key) ?? 0 }))

  const allowed = withCounts.every((s) => s.count < s.limit)
  if (allowed) {
    // A counter about to be created means a new window started (or this is the
    // first request): drop the ones that ended.  Refused requests never prune,
    // so a client hammering a full window costs no extra storage operations.
    if (withCounts.some((s) => s.count === 0)) await prune(storage, now)

    const updates: Record<string, number> = {}
    for (const s of withCounts) updates[s.key] = s.count + 1
    await storage.put(updates)
  }

  // Binding window: fewest requests left; on a tie, the one that resets last.
  let binding = withCounts[0]
  let bindingRemaining = Infinity
  for (const s of withCounts) {
    const remaining = Math.max(0, s.limit - s.count - (allowed ? 1 : 0))
    if (remaining < bindingRemaining || (remaining === bindingRemaining && s.resetMs > binding.resetMs)) {
      binding = s
      bindingRemaining = remaining
    }
  }

  const retryAfterMs = allowed
    ? 0
    : Math.max(...withCounts.filter((s) => s.count >= s.limit).map((s) => s.resetMs))

  return {
    allowed,
    limit: binding.limit,
    remaining: bindingRemaining,
    resetMs: binding.resetMs,
    retryAfterMs,
  }
}

/** Current count of the window of `windowMs` containing `now`, without recording a request. */
export async function windowStatus(
  storage: DurableObjectStorage,
  windowMs: number,
  now: number,
): Promise<StatusResult> {
  const index = Math.floor(now / windowMs)
  const count = (await storage.get<number>(counterKey(windowMs, index))) ?? 0
  return { count, resetMs: (index + 1) * windowMs - now }
}

/**
 * Fixed-window rate limiter backed by Durable Object storage.
 *
 * Each rate-limit name (gw-acct:<discordId>, gw-key:<hash>, gw-ip:<ip>,
 * gw-global) gets its own DO instance holding one counter per active window,
 * so storage stays a handful of small keys however much traffic arrives.
 *
 *   POST /check   { windows: [{ limit, windowMs }, …] } → CheckResult
 *   GET  /status?windowMs=<ms>                          → StatusResult
 */
export class RateLimiter implements DurableObject {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Read-only status check — returns the current count without recording a request.
    if (request.method === 'GET' && url.pathname === '/status') {
      const windowMs = parseInt(url.searchParams.get('windowMs') ?? '3600000', 10)
      if (!(windowMs > 0)) return new Response('Invalid windowMs', { status: 400 })
      return Response.json(await windowStatus(this.state.storage, windowMs, Date.now()))
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const body = (await request.json()) as CheckRequest
    const windows = body.windows ?? [{ limit: body.limit, windowMs: body.windowMs }]
    if (windows.length === 0 || !windows.every(isValidWindow)) {
      return new Response('Invalid windows', { status: 400 })
    }

    return Response.json(await checkWindows(this.state.storage, windows, Date.now()))
  }
}
