import type { RateWindow } from '../types'
import type { CheckResult, StatusResult } from '../durable-objects/RateLimiter'

export type RateLimitResult = CheckResult

/**
 * Counts one request against the RateLimiter DO named `name`, in every window
 * at once: it is allowed (and counted) only if all windows have room.
 */
export async function checkRateLimit(
  namespace: DurableObjectNamespace,
  name: string,
  windows: RateWindow[],
): Promise<RateLimitResult> {
  const stub = namespace.get(namespace.idFromName(name))
  const res = await stub.fetch('https://rate-limiter/check', {
    method: 'POST',
    body: JSON.stringify({ windows }),
  })
  if (!res.ok) {
    throw new Error(`RateLimiter ${name} refused the check: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

/** Requests counted so far in the current window of `windowMs`, without recording one. */
export async function getWindowUsage(
  namespace: DurableObjectNamespace,
  name: string,
  windowMs: number,
): Promise<StatusResult> {
  const stub = namespace.get(namespace.idFromName(name))
  const res = await stub.fetch(`https://rate-limiter/status?windowMs=${windowMs}`, { method: 'GET' })
  return res.json()
}
