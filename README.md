# ScanLake Gateway

A secure, high-performance Cloudflare Workers gateway for accessing data stored in Cloudflare R2 buckets. The gateway provides authenticated file listing and download capabilities with built-in rate limiting, CORS support, and comprehensive access logging. Keys with the `derived:write` scope (ScanLake Refinery) can also upload consolidated data and results into a separate `scanlake-derived` bucket.

## Overview

ScanLake Gateway acts as an intelligent proxy between clients and your data stored in Cloudflare R2, protecting your data with:

- **API key authentication** – Secure key-based access control with per-key configuration
- **Dual rate limiting** – Per-API-key limits plus hard per-IP ceiling
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
| `GET /api/derived` | any valid key | Same as `GET /api/files` (query params, response shape incl. `etag`), for `scanlake-derived` |
| `GET /api/derived/:key` | any valid key | Same as `GET /api/files/:key`, for `scanlake-derived` |
| `PUT /api/derived/:key` | keys with the `derived:write` scope | Writes one object (see below) |

All three run through the same API-key and rate-limit middleware as `/api/files`.

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

API keys follow the pattern `sk_` followed by 32–64 lowercase hexadecimal characters:
```
sk_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

### How It Works

1. **Key Storage:** API keys are **never stored in plaintext**. Only SHA-256 hashes are stored in KV under the key prefix `apikey:<hash>`.

2. **Validation:** On each request:
   - Extract `X-API-Key` header
   - Validate format (`sk_[a-f0-9]{32,64}`)
   - Hash with SHA-256
   - Look up metadata in KV namespace
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

Every valid key can read (`GET /api/files…`, `GET /api/derived…`). Write access is granted per key through the optional `scopes` array:

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

## Rate Limiting

The gateway enforces two independent rate-limit checks:

### 1. Per-API-Key Limit

Each API key has its own configurable rate limit defined in its metadata:
- `rateLimit` – Maximum requests allowed
- `rateLimitWindowMs` – Time window in milliseconds

**Example:** 1000 requests per hour
```json
{
  "rateLimit": 1000,
  "rateLimitWindowMs": 3600000
}
```

### 2. Per-IP Hard Ceiling

All requests from the same IP address are limited to **5000 requests per hour**, regardless of API key limits. This protects the gateway from abuse.

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

The `Retry-After` header indicates how many seconds to wait before retrying.

### Implementation Details

Rate limiting uses Cloudflare Durable Objects with SQLite storage for distributed, consistent state:
- Keys are tracked per API key hash: `gw-key:<hash>`
- IPs are tracked per client IP: `gw-ip:<ip>`
- Counters reset after the window expires

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
- `Content-Type`
- `Range`

**Exposed Headers:**
- `Content-Length`
- `Content-Disposition`
- `ETag`
- `Content-Range`

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
├── middleware/
│   ├── apiKey.ts           # API key validation
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
│   ├── rate-limit.ts       # Rate limit logic
│   └── logger.ts           # Audit logging
└── durable-objects/
    ├── RateLimiter.ts      # Durable Object for rate limiting
    └── LogBuffer.ts        # Durable Object for log buffering
scripts/
└── create-api-key.mjs      # Generates a key + prints the KV command
```

### Running Tests

```bash
npm run dev
# Make test requests to http://localhost:8787/api/files with X-API-Key header
```

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
- Requests per API key (rate limiting)
- Requests per IP address (hard ceiling)
- File access events (audit trail)

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
- API key header missing → Add `X-API-Key` header
- Invalid format → Ensure format is `sk_[hex]{32,64}`
- Key not in KV → Create the key in API_KEYS namespace
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
