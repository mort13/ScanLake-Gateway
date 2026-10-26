#!/usr/bin/env node
/**
 * Generates a new ScanLake API key and prints the wrangler command that
 * registers it in the shared API_KEYS KV namespace.
 *
 * The plaintext key is printed once and never stored; KV only holds its
 * SHA-256 hash.  The command is printed, not run, so you can review it first.
 *
 * Usage:
 *   node scripts/create-api-key.mjs [--owner <id>] [--scopes <a,b>] [--rate-limit <n>]
 *
 * Defaults create the ScanLake Refinery key:
 *   --owner scanlake-refinery  --scopes derived:write  --rate-limit 2000
 * Pass --scopes "" for a read-only key.
 */
import { randomBytes, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function parseArgs(argv) {
  const opts = { owner: 'scanlake-refinery', scopes: ['derived:write'], rateLimit: 2000 }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const value = inline ?? argv[++i]
    if (value === undefined) fail(`Missing value for ${flag}`)
    switch (flag) {
      case '--owner':
        // Restricted so the value cannot break the quoting of the printed shell command.
        if (!/^[\w.:@-]+$/.test(value)) fail('--owner may only contain letters, digits and _ . : @ -')
        opts.owner = value
        break
      case '--scopes':
        opts.scopes = value.split(',').map((s) => s.trim()).filter(Boolean)
        break
      case '--rate-limit':
        if (!/^\d+$/.test(value) || Number(value) < 1) fail('--rate-limit must be a positive integer')
        opts.rateLimit = Number(value)
        break
      default:
        fail(`Unknown option: ${flag}`)
    }
  }
  return opts
}

function fail(message) {
  console.error(message)
  console.error('Usage: node scripts/create-api-key.mjs [--owner <id>] [--scopes <a,b>] [--rate-limit <n>]')
  process.exit(1)
}

const opts = parseArgs(process.argv.slice(2))

const apiKey = 'sk_' + randomBytes(32).toString('hex')
const hash = createHash('sha256').update(apiKey).digest('hex')

const meta = {
  ownerId: opts.owner,
  active: true,
  rateLimit: opts.rateLimit,
  rateLimitWindowMs: 3_600_000,
  // API_KEYS is shared with the Store Worker, whose POST /api/external/upload
  // accepts any active key and caps each file at maxUploadBytes.  0 makes every
  // upload fail that check, so a Gateway key can never inject raw scan data.
  maxUploadBytes: 0,
  allowedOrigins: [],
  scopes: opts.scopes,
  createdAt: new Date().toISOString(),
}

// The metadata goes through a file: shells (PowerShell, MobaXterm, cmd) mangle
// inline JSON quoting in different ways, and a malformed entry makes every
// request with this key fail with 500.
const metaFile = join(tmpdir(), `apikey-${opts.owner.replace(/[^\w.-]/g, '_')}-${hash.slice(0, 8)}.json`)
writeFileSync(metaFile, JSON.stringify(meta))

console.log('API key (shown only once, store it now):')
console.log(`  ${apiKey}`)
console.log()
console.log('Register it in the shared API_KEYS namespace (works in any shell):')
// API_KEYS has both id and preview_id in wrangler.toml; "--preview false"
// selects the production namespace (wrangler refuses to guess otherwise).
console.log(
  `  npx wrangler kv key put --binding API_KEYS --remote --preview false "apikey:${hash}" --path "${metaFile}"`,
)
