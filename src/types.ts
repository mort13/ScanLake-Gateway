export interface Env {
  SCANLAKE_BUCKET: R2Bucket
  SCANLAKE_LOGS: R2Bucket
  SCANLAKE_DERIVED: R2Bucket
  RATE_LIMITER: DurableObjectNamespace
  LOG_BUFFER: DurableObjectNamespace
  ALLOWED_ORIGIN: string
  API_KEYS: KVNamespace
  /** URL of format.json in the ScanLake-Format repository, served at /api/format. */
  FORMAT_URL: string
  /**
   * Per-request usage counts (dataset "scanlake_gateway_usage"), queried by
   * ScanLake Auth's admin panel.  Optional: nothing is written when unbound.
   */
  USAGE?: AnalyticsEngineDataset
}

/** One rate-limit window: at most `limit` requests per fixed window of `windowMs`. */
export interface RateWindow {
  limit: number
  windowMs: number
}

/** Account tier of a user key, set by ScanLake Auth. */
export type UserKeyTier = 'verified' | 'trusted'

/**
 * Metadata stored in the API_KEYS KV namespace for one key.
 *
 * Two kinds of key share this shape:
 *   - internal `sk_` keys under `apikey:<sha256>` (ScanLake Store, Refinery,
 *     the Dashboard proxy) — `kind` is absent;
 *   - user `slk_` keys under `ukey:<sha256>`, written by ScanLake Auth for
 *     Discord-verified users — `kind` is "user".
 */
export interface ApiKeyMeta {
  /** "user" for keys issued by ScanLake Auth; absent on internal sk_ keys. */
  kind?: 'user'
  /** The userId this key is associated with (from the store worker), or Auth's owner id. */
  ownerId: string
  /** Discord account behind a user key; its rate limits are shared by all of the account's keys. */
  discordId?: string
  tier?: UserKeyTier
  active: boolean
  /** User keys: every window must have room for a request to pass. */
  limits?: RateWindow[]
  /** Max requests allowed in the rate-limit window (internal keys; fallback for user keys). */
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
   * Keys without scopes are read-only.  User keys carry "derived:public",
   * which is informational: their access is fixed by restrictUserKeys.
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
