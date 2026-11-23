# ScanLake Gateway

A secure, high-performance Cloudflare Workers gateway for accessing data stored in Cloudflare R2 buckets. The gateway provides authenticated file listing and download capabilities with built-in rate limiting, CORS support, and comprehensive access logging. Keys with the `derived:write` scope (ScanLake Refinery) can also upload consolidated data and results into a separate `scanlake-derived` bucket.

## Overview

ScanLake Gateway acts as an intelligent proxy between clients and your data stored in Cloudflare R2, protecting your data with:

- **API key authentication** – Secure key-based access control with per-key configuration
- **User API keys** – Keys that Discord-verified users create in ScanLake Auth, limited to the public derived files (see [User API Keys](#user-api-keys))
- **Layered rate limiting** – Per-key or per-account limits, a hard per-IP ceiling and a global budget
- **Usage counting** – One Workers Analytics Engine data point per authenticated request
- **CORS support** – Enable browser-based clients (e.g., DuckDB-WASM)
- **Access logging** – Structured event logging for audit trails
- **Path traversal protection** – Safe key validation prevents security issues

## Features

- 📡 **File Listing** – Browse objects in your R2 bucket with optional prefix filtering and pagination
- 📥 **File Download** – Stream files with proper HTTP headers (ETag, Content-Length, etc.)
- 📤 **Derived Data Upload** – Checksum-verified writes into `scanlake-derived` for keys with the `derived:write` scope
- 📐 **Parquet Format** – Public `GET /api/format` serves the column format uploads must match
- 🔐 **API Key Authentication** – SHA-256 hashed keys stored in Cloudflare KV
- 🚦 **Rate Limiting** – Configurable per-key limits + 5000 req/hr hard IP ceiling
- 🌐 **CORS Ready** – Supports browser-based clients with origin restrictions per API key
- 📊 **Audit Logging** – All file access events logged to R2 for compliance
- 🚀 **Serverless** – Built on Cloudflare Workers with Durable Objects for state

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Cloudflare account with R2 buckets
- Wrangler CLI (`npm install -g wrangler`)

### Installation

1. **Clone or set up the project**
   ```bash
   cd "ScanLake Gateway"
   npm install
   ```

2. **Configure Cloudflare bindings**
   
   Update `wrangler.toml` with your R2 bucket names and KV namespace IDs:
   ```toml
   [[r2_buckets]]
   binding = "SCANLAKE_BUCKET"
   bucket_name = "your-data-bucket"  # Read-only access

   [[r2_buckets]]
   binding = "SCANLAKE_LOGS"
   bucket_name = "your-logs-bucket"  # Write access for logs

   [[r2_buckets]]
   binding = "SCANLAKE_DERIVED"
   bucket_name = "scanlake-derived"  # Derived data, writable with "derived:write"

   [[kv_namespaces]]
   binding = "API_KEYS"
   id = "your-kv-namespace-id"
   ```

3. **Development**
   ```bash
   npm run dev
   # Gateway runs on localhost:8787
   ```

4. **Deploy** – see [Deployment](#deployment) for the required order (the `scanlake-derived` bucket must exist first)
   ```bash
   npm run deploy
   ```

## API Endpoints

### List Files

**Endpoint:** `GET /api/files`

Lists objects in the configured R2 bucket with optional filtering and pagination.

**Headers:**
- `X-API-Key` *(required)* – Your API key
- `Origin` *(optional)* – Required if API key has origin restrictions

**Query Parameters:**
- `prefix` *(optional)* – Filter objects by key prefix (e.g., `2026/04/`)
- `limit` *(optional)* – Number of results per page (1–1000, default 100)
- `cursor` *(optional)* – Pagination cursor from a previous response

**Response (200 OK):**
```json
{
  "objects": [
    {
      "key": "2026/04/16/user/file.parquet",
      "size": 1048576,
      "uploaded": "2026-04-16T10:30:00Z",
      "etag": "5d41402abc4b2a76b9719d911017c592"
    },
    {
      "key": "2026/04/16/user/metadata.json",
      "size": 2048,
      "uploaded": "2026-04-16T10:31:00Z",
      "etag": "7d793037a0760186574b0282f2f435e7"
    }
  ],
  "truncated": false
}
```

`etag` is the R2 object ETag (unquoted). It changes whenever the object is rewritten, so clients can use it to detect new or changed files without downloading them.

**Error Responses:**
- `401 Unauthorized` – Missing or invalid API key
- `403 Forbidden` – API key revoked or origin not permitted
- `429 Too Many Requests` – Rate limit exceeded

**Example Request:**
```bash
curl -H "X-API-Key: sk_1234567890abcdef" \
  "https://gateway.example.com/api/files?prefix=2026/04&limit=50"
```

---

### Download File

**Endpoint:** `GET /api/files/:key`

Streams a single file from the R2 bucket. The `:key` path supports slashes and can include subdirectories.

**Headers:**
- `X-API-Key` *(required)* – Your API key
- `Range` *(optional)* – HTTP Range request for partial downloads

**Response (200 OK):**
- File content streamed with proper HTTP headers:
  - `Content-Type` – MIME type
  - `Content-Length` – File size in bytes
  - `ETag` – Entity tag for caching
  - `Last-Modified` – Upload timestamp

**Error Responses:**
- `400 Bad Request` – Unsafe file key (e.g., path traversal attempt)
- `401 Unauthorized` – Missing or invalid API key
- `403 Forbidden` – API key revoked or origin not permitted
- `404 Not Found` – File does not exist
- `429 Too Many Requests` – Rate limit exceeded

**Example Requests:**
```bash
# Download entire file
curl -H "X-API-Key: sk_1234567890abcdef" \
  "https://gateway.example.com/api/files/2026/04/16/user/file.parquet" \
  -o file.parquet

# Stream with Range header (first 1MB)
curl -H "X-API-Key: sk_1234567890abcdef" \
  -H "Range: bytes=0-1048575" \
  "https://gateway.example.com/api/files/2026/04/16/user/file.parquet"
```

---

### Derived Data

Consolidated datasets and results produced by ScanLake Refinery live in their own R2 bucket, `scanlake-derived` (binding `SCANLAKE_DERIVED`). They are kept out of `scanlake-data` because the Dashboard lists the entire raw bucket and would otherwise merge derived parquet files into its catch-all view.

| Endpoint | Access | Behaviour |
|---|---|---|
| `GET /api/derived` | any valid key | Same as `GET /api/files` (query params, response shape incl. `etag`), for `scanlake-derived`; user keys see only the public files |
| `GET /api/derived/:key` | any valid key | Same as `GET /api/files/:key`, for `scanlake-derived`; user keys only the public files |
| `PUT /api/derived/:key` | internal keys with the `derived:write` scope | Writes one object (see below) |

All three run through the same API-key and rate-limit middleware as `/api/files`. What user keys may read is listed under [User API Keys](#user-api-keys).

#### Upload Derived File

**Endpoint:** `PUT /api/derived/:key`

Creates the object, or replaces it if the key already exists. The body is the raw file content (not multipart).

**Headers:**
- `X-API-Key` *(required)* – a key whose metadata contains `"scopes": ["derived:write"]`
- `Content-Length` *(required)* – body size in bytes, at most 50 MB (52 428 800)
- `X-Content-SHA256` *(required)* – hex SHA-256 of the body (64 characters). R2 recomputes the digest and refuses to store the object if it differs, so a corrupted body is never written.
- `Content-Type` *(optional)* – stored with the object and returned on download (default `application/octet-stream`)

**Response (200 OK):**
```json
{
  "key": "consolidated/2026/10/26/scans_part001.parquet",
  "size": 1048576,
  "etag": "5d41402abc4b2a76b9719d911017c592"
}
```

The `etag` matches the `etag` reported by `GET /api/derived` for that key.

**Error Responses:**
- `400 Bad Request` – unsafe key (e.g. contains `..`), malformed `Content-Length` or missing/malformed `X-Content-SHA256`
- `401 Unauthorized` – missing or invalid API key
- `403 Forbidden` – key revoked, origin not permitted, or key lacks the `derived:write` scope
- `411 Length Required` – no `Content-Length` (e.g. chunked transfer encoding)
- `413 Payload Too Large` – `Content-Length` above 50 MB
- `422 Unprocessable Entity` – body does not match `X-Content-SHA256`; nothing was stored
- `429 Too Many Requests` – rate limit exceeded

Browsers cannot call this route: CORS only allows `GET` and `OPTIONS`, so a cross-origin `PUT` fails its preflight.

**Example Request:**
```bash
curl -X PUT \
  -H "X-API-Key: sk_..." \
  -H "Content-Type: application/vnd.apache.parquet" \
  -H "X-Content-SHA256: $(sha256sum result.parquet | cut -d' ' -f1)" \
  --data-binary @result.parquet \
  "https://gateway.scanlake.rocks/api/derived/consolidated/2026/10/26/scans_part001.parquet"
```

---

### Parquet Format

**Endpoint:** `GET /api/format`

Returns the parquet format uploads must match: for each of `scans`, `compositions` and `confidences`, the required columns and their types. ScanLake Store rejects uploads that deviate from it with `422`. The file lives in the public [ScanLake-Format](https://github.com/mort13/ScanLake-Format) repository (`FORMAT_URL` in `wrangler.toml`), whose README describes its structure; this route proxies it.

No API key needed and no rate-limit slot consumed. Cached at the edge and by clients for 5 minutes.

**Error Responses:**
- `502 Bad Gateway` – the format repository could not be reached

**Example Request:**
```bash
curl "https://gateway.scanlake.rocks/api/format"
```

---

## Authentication

### API Key Format

There are two kinds of key:

| Kind | Format | KV entry | Issued by |
|---|---|---|---|
| Internal | `sk_` + 32–64 hex characters | `apikey:<sha256>` | `scripts/create-api-key.mjs` (Store, Refinery, Dashboard proxy) |
| User | `slk_` + 64 lowercase hex characters | `ukey:<sha256>` | ScanLake Auth, for Discord-verified users (see [User API Keys](#user-api-keys)) |

```
sk_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

Send the key as `X-API-Key: <key>` or `Authorization: Bearer <key>`. When both are present, `X-API-Key` wins.

### How It Works

1. **Key Storage:** API keys are **never stored in plaintext**. Only SHA-256 hashes (of the whole key, prefix included) are stored in KV, under `apikey:<hash>` or `ukey:<hash>`.

2. **Validation:** On each request:
   - Read `X-API-Key`, else `Authorization: Bearer`
   - Validate format (`sk_[a-f0-9]{32,64}` or `slk_[0-9a-f]{64}`)
   - Hash with SHA-256
   - Look up metadata in KV namespace (`apikey:` for `sk_`, `ukey:` for `slk_`)
   - Check if key is active and origin is allowed

3. **Metadata:** Each API key has associated metadata (JSON):
   ```json
   {
     "ownerId": "user-123",
     "active": true,
     "rateLimit": 1000,
     "rateLimitWindowMs": 3600000,
     "maxUploadBytes": 0,
     "allowedOrigins": ["https://app.example.com"],
     "scopes": [],
     "createdAt": "2026-04-01T00:00:00Z"
   }
   ```

   The `API_KEYS` namespace is shared with the Store Worker. Keys meant only for the Gateway must have `"maxUploadBytes": 0`: the Store Worker's `POST /api/external/upload` accepts any active key and only limits file size by `maxUploadBytes`, so `0` keeps a Gateway key from uploading raw scan data.

### Scopes

Every valid internal key can read (`GET /api/files…`, `GET /api/derived…`); user keys read only the public derived files, whatever their `scopes`. Write access is granted per internal key through the optional `scopes` array:

| Scope | Grants |
|---|---|
| `derived:write` | `PUT /api/derived/:key` |

Keys without a `scopes` field (all keys created before this feature) are read-only and get `403` on write routes.

### Creating an API Key

`scripts/create-api-key.mjs` (Node, no dependencies) generates a key, prints the plaintext once, and prints, without running it, the `wrangler kv key put` command that stores its hash and metadata:

```bash
# ScanLake Refinery key (defaults: owner scanlake-refinery, scopes derived:write, 2000 req/h)
node scripts/create-api-key.mjs

# Other keys
node scripts/create-api-key.mjs --owner my-tool --scopes "" --rate-limit 500
```

| Option | Default | Meaning |
|---|---|---|
| `--owner` | `scanlake-refinery` | `ownerId` written to logs |
| `--scopes` | `derived:write` | Comma-separated scopes; `""` for a read-only key |
| `--rate-limit` | `2000` | Requests per hour (`rateLimitWindowMs` is fixed at 3 600 000) |

Every key it creates has `active: true`, `allowedOrigins: []` and `maxUploadBytes: 0`. Review the printed command, then run it yourself. It targets the production namespace (`--remote --preview false`; wrangler requires the `--preview` flag because `API_KEYS` has both an `id` and a `preview_id`). The metadata is written to a temp JSON file and passed with `--path`, because shells mangle inline JSON quoting differently, and a malformed entry makes every request with that key fail with 500.

To revoke a key, set `"active": false` in its KV entry (or delete the entry).

---

## User API Keys

Discord-verified users create their own keys in ScanLake Auth (`auth.scanlake.rocks`). Auth is the source of truth: it keeps the keys in D1 and writes one KV entry per key into `API_KEYS`. The Gateway only reads those entries and enforces what a key may do, its rate limits, and usage counting.

The `slk_` prefix and the `ukey:` KV prefix keep user keys away from ScanLake Store, which shares `API_KEYS` but accepts any `apikey:` entry for uploads.

### KV entry

`ukey:<sha256 hex of the full token>`:

```json
{
  "kind": "user",
  "ownerId": "…",
  "discordId": "…",
  "tier": "verified",
  "active": true,
  "limits": [{ "limit": 60, "windowMs": 60000 }, { "limit": 2000, "windowMs": 86400000 }],
  "rateLimit": 2000,
  "rateLimitWindowMs": 86400000,
  "maxUploadBytes": 0,
  "allowedOrigins": [],
  "scopes": ["derived:public"],
  "createdAt": "2026-11-23T00:00:00.000Z"
}
```

Revoking a key deletes its entry, so a revoked key gets `401`; an entry with `"active": false` gets `403`. Anything found under `ukey:` is treated as a user key, whatever its `kind` or `scopes` say.

### What a user key may do

Only reads of the public derived files, the same ones the Dashboard proxy forwards (`src/lib/publicDerived.ts`, kept in sync with `ScanLake Dashboard/functions/lib/proxy-paths.js`):

| Request | Result |
|---|---|
| `GET /api/derived/manifest.json` | served |
| `GET /api/derived/consolidated/scans.parquet`, `…/compositions.parquet` | served |
| `GET /api/derived/results/<name>.parquet` (`name` = `[a-z0-9_]+`) | served |
| `GET /api/derived` | listing of the files above only |
| any other `/api/derived/…` path (`consolidated/positions.parquet`, `monthly/…`, encoded paths) | `404 {"error":"File not found"}`, whether the file exists or not |
| `/api/files…`, `/api/admin/…` | `403` |
| any method other than `GET`/`HEAD` (e.g. `PUT`) | `403` |

The listing scans only the prefixes that hold public files and returns them in one response: `prefix` and `limit` work as usual, but there is never a `cursor` (`truncated: true` only means more than `limit` public files exist).

### Kill switch

KV entry `config:user-keys` = `{"issuing": bool, "serving": bool}`; a missing entry means both are `true`. Auth reads `issuing`; while `serving` is `false`, every user-key request gets `403 {"error":"API access for user keys is paused"}`. The Gateway caches the entry for 60 s, so a change takes up to a minute to reach every edge location. An entry that is not valid JSON counts as paused. Internal keys are never affected.

To flip it by hand (the JSON goes through a file, as shells mangle inline JSON quoting):

```bash
# user-keys.json: {"issuing":true,"serving":false}
npx wrangler kv key put --binding API_KEYS --remote --preview false "config:user-keys" --path user-keys.json
```

### Rate limits

All keys of one Discord account share the account's limits (Durable Object `gw-acct:<discordId>`), taken from the entry's `limits` (each window must have room). Auth issues two tiers:

| Tier | Per minute | Per day |
|---|---|---|
| `verified` | 60 | 2,000 |
| `trusted` | 600 | 20,000 |

Every user-key response carries the state of the account's most constrained window:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | that window's limit |
| `X-RateLimit-Remaining` | requests left in it |
| `X-RateLimit-Reset` | seconds until it resets (a delay, not a timestamp) |

A `429` also has `Retry-After` (seconds). Requests refused with `403`/`404` cost no rate-limit slot.

### Usage counting

Every authenticated request (internal and user keys, whatever the outcome, including `403` and `429`) writes one data point to the Analytics Engine dataset `scanlake_gateway_usage` (binding `USAGE`). Requests refused before the key is known (`401`, or `403` for an inactive key or wrong origin) are not counted. ScanLake Auth's admin panel reads the columns by position:

| Column | Value |
|---|---|
| `index1` | key hash (SHA-256 hex) |
| `blob1` | `user` or `internal` |
| `blob2` | `ownerId` |
| `blob3` | `discordId` (`''` for internal keys) |
| `blob4` | `tier` (`''` for internal keys) |
| `blob5` | HTTP method |
| `blob6` | raw path, at most 256 characters |
| `blob7` | status code, as a string |
| `double1` | `1` |
| `double2` | response bytes (`Content-Length`, or `0`) |

Analytics Engine samples at high volume, so sum `_sample_interval * double1` rather than counting rows. Without a `USAGE` binding nothing is written.

---

## Rate Limiting

The gateway enforces three rate-limit checks, in this order. A request refused by one check is not counted by the later ones, so a throttled key burns no IP or global budget.

### 1. Per Key or Account

- **Internal keys** (`gw-key:<hash>`): the key's `rateLimit` requests per `rateLimitWindowMs`.
- **User keys** (`gw-acct:<discordId>`): every window in the entry's `limits`, shared by all keys of the account (see [User API Keys](#rate-limits)).

**Example:** 1000 requests per hour
```json
{
  "rateLimit": 1000,
  "rateLimitWindowMs": 3600000
}
```

### 2. Per-IP Hard Ceiling

All requests from the same IP address are limited to **5000 requests per hour**, regardless of API key limits. This protects the gateway from abuse.

### 3. Global Budget

**10,000,000 requests per 30-day window** across all traffic, a cost-control backstop. Exhaustion returns `503 Service temporarily unavailable` with `Retry-After`. `GET /api/admin/budget` (internal keys only, consumes no slot) reports its use: `used`, `limit`, `remaining`, `usedPercent`, `windowMs`, `windowLabel` (`"30-day window"`) and `resetsAt`.

### Rate Limit Responses

When a limit is exceeded, the gateway returns:

```
HTTP 429 Too Many Requests
Retry-After: 300
Content-Type: application/json

{
  "error": "Rate limit exceeded"
}
```

The `Retry-After` header indicates how many seconds to wait before retrying. User-key responses also carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.

### Implementation Details

Rate limiting uses one Durable Object (`RateLimiter`) per counter name: `gw-acct:<discordId>`, `gw-key:<hash>`, `gw-ip:<ip>` and `gw-global`.
- Windows are **fixed** and aligned to the Unix epoch (a 1-minute window resets on the minute, a day window at 00:00 UTC, the 30-day window every 30 days since 1970). Up to twice the limit can therefore pass around a window boundary.
- Each window is one counter in DO storage (`w:<windowMs>:<windowIndex>`), so storage stays a few small keys however much traffic arrives. Counters of ended windows are deleted when the next window starts.
- One check covers several windows: it counts the request in all of them only if every window has room.
- The first check after this storage format was deployed deletes the old `timestamps` array, so counts restart from zero then.

---

## CORS Support

The gateway supports Cross-Origin Resource Sharing (CORS), allowing browser-based clients such as:
- DuckDB-WASM
- Frontend JavaScript applications
- WebAssembly modules

### CORS Headers

**Allow:** Any origin (`*`)

**Allowed Methods:** `GET`, `OPTIONS` (deliberately no `PUT`: derived uploads are server-to-server only, and browsers cannot pass the preflight)

**Allowed Headers:**
- `X-API-Key`
- `Authorization`
- `Content-Type`
- `Range`

**Exposed Headers:**
- `Content-Length`
- `Content-Disposition`
- `ETag`
- `Content-Range`
- `Retry-After`
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

### Per-Key Origin Restrictions

For additional security, you can restrict an API key to specific origins via the `allowedOrigins` array in the key's metadata:

```json
{
  "allowedOrigins": ["https://app.example.com", "https://web.example.com"]
}
```

Requests from other origins will receive a `403 Forbidden` response.

---

## Usage Examples

### JavaScript/TypeScript

```typescript
// List files
async function listFiles() {
  const response = await fetch('https://gateway.example.com/api/files?prefix=2026/04', {
    headers: {
      'X-API-Key': 'sk_1234567890abcdef'
    }
  });
  const data = await response.json();
  console.log(data.objects);
}

// Download a file
async function downloadFile(key: string) {
  const response = await fetch(`https://gateway.example.com/api/files/${key}`, {
    headers: {
      'X-API-Key': 'sk_1234567890abcdef'
    }
  });
  const blob = await response.blob();
  return blob;
}
```

### Python

```python
import requests

api_key = 'sk_1234567890abcdef'
headers = {'X-API-Key': api_key}

# List files
response = requests.get(
    'https://gateway.example.com/api/files?prefix=2026/04',
    headers=headers
)
files = response.json()['objects']

# Download a file
response = requests.get(
    f'https://gateway.example.com/api/files/{files[0]["key"]}',
    headers=headers
)
with open('downloaded.parquet', 'wb') as f:
    f.write(response.content)
```

### cURL

```bash
# List files with prefix
curl -H "X-API-Key: sk_1234567890abcdef" \
  "https://gateway.example.com/api/files?prefix=2026/04&limit=50"

# Download with pagination
curl -H "X-API-Key: sk_1234567890abcdef" \
  "https://gateway.example.com/api/files/2026/04/16/data.parquet" \
  -o data.parquet

# Partial download (Range request)
curl -H "X-API-Key: sk_1234567890abcdef" \
  -H "Range: bytes=0-1048575" \
  "https://gateway.example.com/api/files/2026/04/16/data.parquet"
```

### DuckDB-WASM

```javascript
import * as duckdb from '@duckdb/wasm';

const db = new duckdb.Database();
const conn = db.connect();

const result = await conn.query(`
  SELECT * FROM read_parquet('https://gateway.example.com/api/files/data.parquet', 
    {
      http_headers: {
        'X-API-Key': 'sk_1234567890abcdef'
      }
    }
  )
`);
```

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────┐
│                  Client Application                      │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP/HTTPS
                           ▼
┌─────────────────────────────────────────────────────────┐
│           Cloudflare Workers (Gateway)                   │
│ ┌────────────────────────────────────────────────────┐  │
│ │ Router (Hono.js)                                   │  │
│ ├────────────────────────────────────────────────────┤  │
│ │ CORS Middleware                                    │  │
│ ├────────────────────────────────────────────────────┤  │
│ │ API Key Authentication Middleware                  │  │
│ ├────────────────────────────────────────────────────┤  │
│ │ Rate Limiting Middleware (Durable Objects)         │  │
│ ├────────────────────────────────────────────────────┤  │
│ │ Scope Check (write routes only)                    │  │
│ ├────────────────────────────────────────────────────┤  │
│ │ File Routes (List, Download, Derived Upload)       │  │
│ └────────────────────────────────────────────────────┘  │
│          │                        │                      │
└──────────┼────────────────────────┼──────────────────────┘
           │                        │
           ▼                        ▼
    ┌─────────────┐         ┌──────────────┐
    │   KV Store  │         │ Durable      │
    │  (API Keys) │         │ Objects      │
    │             │         │ (Rate Limit) │
    └─────────────┘         └──────────────┘
                                   │
                                   ▼
                            ┌──────────────┐
                            │   SQLite DB  │
                            │ (Rate Limit  │
                            │  State)      │
                            └──────────────┘

    ┌──────────────────────────────────────┐
    │     Cloudflare R2 Buckets            │
    ├──────────────────────────────────────┤
    │ SCANLAKE_BUCKET (Read-only data)     │
    │ SCANLAKE_LOGS (Write-only logs)      │
    │ SCANLAKE_DERIVED (Derived data,      │
    │   write needs derived:write)         │
    └──────────────────────────────────────┘
```

### Key Technologies

- **Framework:** Hono.js for lightweight HTTP routing
- **Authentication:** SHA-256 hashing, KV namespaces
- **Rate Limiting:** Cloudflare Durable Objects with SQLite
- **Storage:** R2 buckets for data and logs
- **Deployment:** Cloudflare Workers

---

## Development

### Project Structure

```
src/
├── index.ts                 # Main app, route definitions
├── types.ts                 # TypeScript interfaces
├── lib/
│   ├── publicDerived.ts    # Derived files user keys may read (sync with the Dashboard proxy)
│   └── limits.ts           # IP / global limits, per-key and per-account windows
├── middleware/
│   ├── apiKey.ts           # API key validation (sk_ and slk_)
│   ├── usage.ts            # Analytics Engine data point per authenticated request
│   ├── restrictUserKeys.ts # User keys: kill switch + public derived files only
│   ├── cors.ts             # CORS headers
│   ├── rateLimit.ts        # Rate limiting
│   └── requireScope.ts     # Per-key scope check for write routes
├── routes/
│   ├── files.ts            # List & download route factories (per bucket)
│   ├── derived.ts          # PUT /api/derived/:key
│   ├── publicAssets.ts     # Unauthenticated public/ assets
│   ├── format.ts           # GET /api/format (proxied from ScanLake-Format)
│   └── admin.ts            # Budget status
├── services/
│   ├── r2.ts               # R2 bucket operations
│   ├── keys.ts             # Object key validation (isSafeKey)
│   ├── rate-limit.ts       # Calls the RateLimiter DO
│   └── logger.ts           # Audit logging
└── durable-objects/
    ├── RateLimiter.ts      # Fixed-window counters, several windows per check
    └── LogBuffer.ts        # Durable Object for log buffering
scripts/
└── create-api-key.mjs      # Generates a key + prints the KV command
test/                       # Vitest suites, run inside workerd (@cloudflare/vitest-plugin)
```

### Running Tests

```bash
npm test            # vitest run: user keys, rate limiter, usage data points
npm run typecheck   # tsc for src and test
```

The tests run inside the Workers runtime with in-memory KV, R2 and Durable Objects; nothing touches Cloudflare.

To try requests by hand, start a dev server:

```bash
npm run dev
# Make test requests to http://localhost:8787/api/files with X-API-Key header
```

From the ScanLake folder, the `gateway` entry in `.claude/launch.json` runs it on port 8791 with its local state in `O:/Regolith/ScanLake/.wrangler/apikeys` (`--persist-to`). A dev server of another Worker that binds the same `API_KEYS` namespace and persists to the same folder sees the same local keys.

`wrangler dev` reads the `preview_id` KV namespace locally, so register a local test key with `--local --preview` instead of `--remote --preview false`:

```bash
node scripts/create-api-key.mjs --owner local-test
# then run the printed command with "--remote --preview false" replaced by "--local --preview"
```

On Windows, keep the `--persist-to` folder short: Durable Object SQLite files under a long path exceed the 260-character limit and every rate-limited request then fails with `internal error`.

### Type Generation

```bash
npm run types
# Generates types from wrangler.toml bindings
```

---

## Deployment

### Prerequisites

1. Cloudflare account with billing enabled
2. R2 buckets created (`scanlake-data`, `scanlake-logs`, `scanlake-derived`)
3. KV namespace created for API key storage

### Deploy to Cloudflare

Order matters: a deploy fails while a bound bucket does not exist, so create `scanlake-derived` first.

```bash
# 1. Create the derived-data bucket (once)
npx wrangler r2 bucket create scanlake-derived

# 2. Deploy the Worker
npm run deploy

# 3. Create the Refinery key and run the printed "wrangler kv key put" command
node scripts/create-api-key.mjs
```

The new routes are additive: `/api/files` behaves as before (its list entries gain an `etag` field), and existing keys keep read-only access.

The `scanlake_gateway_usage` Analytics Engine dataset needs no setup: it is created by the first data point written after the deploy that adds the `USAGE` binding. That deploy also switches the `RateLimiter` storage to fixed-window counters, so every rate-limit and budget count restarts from zero.

The gateway will be deployed to a URL like:
```
https://scanlake-gateway.your-account.workers.dev
```

### Custom Domain

To use a custom domain:
1. Go to Cloudflare Dashboard → Workers
2. Click "Triggers" → "Routes"
3. Add a route: `your-domain.com/*` → `scanlake-gateway`

---

## Monitoring & Logging

### Access Logs

All file access is logged to the `scanlake-logs` R2 bucket with the following event structure:

```json
{
  "ts": 1702000000000,
  "apiKey": "3a4b5c6d...",
  "userId": "user-123",
  "action": "read",
  "dataset": "file.parquet",
  "bytes": 1048576
}
```

**Logged Actions:**
- `read` – File list or download request (`/api/files…` and `/api/derived…`)
- `write` – Derived upload (`PUT /api/derived/:key`); `dataset` is the full object key
- `query` – (Reserved for future use)
- `ingest` – (Reserved for future use)

### Metrics

The gateway tracks:
- Requests per API key or Discord account (rate limiting)
- Requests per IP address (hard ceiling)
- File access events (audit trail)
- One Analytics Engine data point per authenticated request (dataset `scanlake_gateway_usage`, see [Usage counting](#usage-counting))

---

## Security Considerations

### ✅ Best Practices

1. **API Keys:** Treat API keys as secrets. Never commit them to version control.
2. **HTTPS Only:** Always use HTTPS in production.
3. **Origin Restrictions:** For browser-based clients, use `allowedOrigins` to restrict access.
4. **Key Rotation:** Regularly rotate API keys and revoke unused ones.
5. **Audit Logs:** Review access logs regularly for suspicious activity.

### ⚠️ Security Features

- **Path Traversal Protection:** File keys are validated (no `..`, absolute paths).
- **Key Hashing:** API keys are hashed with SHA-256 before storage.
- **Rate Limiting:** Protects against DoS attacks.
- **CORS:** Prevents browser-based requests from other origins (unless configured).
- **Origin Restrictions:** Per-key origin allowlists for additional security.

---

## Troubleshooting

### API Key Rejected (401)

**Possible Causes:**
- API key header missing → Add `X-API-Key` (or `Authorization: Bearer`) header
- Invalid format → Ensure format is `sk_[hex]{32,64}` or `slk_[0-9a-f]{64}`
- Key not in KV → Create the key in API_KEYS namespace (user keys: revoked keys are deleted, so they get 401)
- Key hash mismatch → Verify correct plaintext key

**Solution:**
```bash
curl -H "X-API-Key: sk_1234567890abcdef" https://gateway.example.com/api/files
```

### Rate Limit Exceeded (429)

**Possible Causes:**
- Too many requests in the window
- IP hard ceiling hit (5000 req/hr)

**Solution:**
- Wait for the time specified in `Retry-After` header
- Request a higher `rateLimit` for your API key
- Batch requests more efficiently

### File Not Found (404)

**Possible Causes:**
- File key is incorrect
- File was deleted from R2
- Bucket misconfigured

**Solution:**
1. List files to verify the exact key: `GET /api/files?prefix=...`
2. Verify bucket name in `wrangler.toml`
3. Check R2 console

### CORS Errors

**Possible Causes:**
- `Origin` header mismatch with `allowedOrigins`
- OPTIONS preflight not allowed

**Solution:**
1. Verify origin in request matches `allowedOrigins` metadata
2. Ensure `allowedOrigins` is populated for browser-based apps
3. Browser should automatically handle OPTIONS preflight

---

## Performance Tips

1. **Use Pagination:** For large buckets, use the `limit` and `cursor` parameters.
2. **Filter with Prefix:** Narrow down results with the `prefix` parameter.
3. **HTTP Caching:** Use `If-None-Match` with the `ETag` header for caching.
4. **Range Requests:** Download only needed bytes using `Range` header.
5. **Batch Operations:** Group multiple requests if possible.

---

## License

[Add your license here]

## Support

For issues or questions, please contact the development team.
