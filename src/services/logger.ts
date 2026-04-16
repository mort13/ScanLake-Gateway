import type { Env, Event } from '../types'

/**
 * Sends a structured log event to the LogBuffer Durable Object for the
 * current hour.  Fire-and-forget — wrap in executionCtx.waitUntil() at
 * the call site so logging never blocks the response.
 *
 * The apiKey field must already be the SHA-256 hash of the raw key.
 * Plaintext keys are never logged.
 */
export async function logEvent(env: Env, event: Event): Promise<void> {
  try {
    // Route to an hourly DO instance so all events within an hour share one DB.
    const date = new Date(event.ts)
    const key = [
      'logbuffer',
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
      String(date.getUTCHours()).padStart(2, '0'),
    ].join(':')

    const stub = env.LOG_BUFFER.get(env.LOG_BUFFER.idFromName(key))

    await stub.fetch('https://log-buffer/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
  } catch (err) {
    // Logging must never surface errors to callers.
    console.error('[logger] failed to log event:', err)
  }
}
