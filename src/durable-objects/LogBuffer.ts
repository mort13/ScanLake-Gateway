import type { Env, Event } from '../types'

interface EventRow extends Record<string, SqlStorageValue> {
  ts: number
  apiKey: string
  userId: string
  action: string
  dataset: string | null
  bytes: number | null
}

/**
 * Durable Object that buffers access-log events in SQLite and flushes them
 * as a JSONL file to the scanlake-logs R2 bucket at the top of each hour.
 *
 * Routing key convention:  "logbuffer:yyyy-mm-dd-HH"
 * R2 output key:           "logs/yyyy/mm/dd/HH.jsonl"
 *
 * Existing log files are read and extended (read-modify-write) so that
 * multiple flushes within a single hour are safely merged.
 */
export class LogBuffer implements DurableObject {
  private ctx: DurableObjectState
  private env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env

    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        apiKey  TEXT    NOT NULL,
        userId  TEXT    NOT NULL,
        action  TEXT    NOT NULL,
        dataset TEXT,
        bytes   INTEGER
      )
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/log') {
      const event = (await request.json()) as Event

      this.ctx.storage.sql.exec(
        `INSERT INTO events (ts, apiKey, userId, action, dataset, bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        event.ts,
        event.apiKey,
        event.userId,
        event.action,
        event.dataset ?? null,
        event.bytes ?? null,
      )

      // Arm the alarm at the top of the next hour if not already set.
      const existing = await this.ctx.storage.getAlarm()
      if (existing === null) {
        const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000
        await this.ctx.storage.setAlarm(nextHour)
      }

      return new Response('accepted', { status: 202 })
    }

    return new Response('Not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<EventRow>(`SELECT ts, apiKey, userId, action, dataset, bytes FROM events ORDER BY ts`)
      .toArray()

    if (rows.length === 0) return

    // Derive the R2 key from the earliest event's timestamp.
    const date = new Date(rows[0].ts)
    const yyyy = date.getUTCFullYear()
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(date.getUTCDate()).padStart(2, '0')
    const HH = String(date.getUTCHours()).padStart(2, '0')
    const r2Key = `logs/${yyyy}/${mm}/${dd}/${HH}.jsonl`

    const newLines = rows
      .map((e) =>
        JSON.stringify({
          ts: e.ts,
          apiKey: e.apiKey,
          userId: e.userId,
          action: e.action,
          ...(e.dataset != null ? { dataset: e.dataset } : {}),
          ...(e.bytes != null ? { bytes: e.bytes } : {}),
        }),
      )
      .join('\n')

    // Read-modify-write: append to any content already written this hour.
    const existing = await this.env.SCANLAKE_LOGS.get(r2Key)
    const existingContent = existing ? await existing.text() : ''
    const combined = existingContent
      ? existingContent.trimEnd() + '\n' + newLines + '\n'
      : newLines + '\n'

    await this.env.SCANLAKE_LOGS.put(r2Key, combined, {
      httpMetadata: { contentType: 'application/x-ndjson' },
    })

    // Clear flushed events.
    this.ctx.storage.sql.exec(`DELETE FROM events`)
  }
}
