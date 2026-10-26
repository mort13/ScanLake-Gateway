export interface Env {
  SCANLAKE_BUCKET: R2Bucket
  SCANLAKE_LOGS: R2Bucket
  SCANLAKE_DERIVED: R2Bucket
  RATE_LIMITER: DurableObjectNamespace
  LOG_BUFFER: DurableObjectNamespace
  ALLOWED_ORIGIN: string
  API_KEYS: KVNamespace
}

export interface ApiKeyMeta {
  /** The userId this key is associated with (from the store worker). */
  ownerId: string
  active: boolean
  /** Max requests allowed in the rate-limit window. */
  rateLimit: number
  /** Rate-limit window in milliseconds (e.g. 3_600_000 for 1 h). */
  rateLimitWindowMs: number
  /** Maximum bytes allowed per individual file in a single upload (store field, unused here). */
  maxUploadBytes: number
  /**
   * If non-empty, requests must carry a matching Origin header.
   * Enforced for browser-origin calls.
   */
  allowedOrigins: string[]
  /**
   * Extra permissions beyond read access (e.g. "derived:write").
   * Keys without scopes are read-only.
   */
  scopes?: string[]
  createdAt: string
}

export type AppVariables = {
  apiKeyMeta: ApiKeyMeta
  apiKeyHash: string
}

export type Event = {
  ts: number
  apiKey: string
  userId: string
  action: 'ingest' | 'query' | 'read' | 'write'
  dataset?: string
  bytes?: number
}
