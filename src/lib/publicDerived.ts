/**
 * The derived files user API keys (slk_) may read.
 *
 * KEEP IN SYNC with ScanLake Dashboard/functions/lib/proxy-paths.js: the
 * Dashboard proxy and user keys expose exactly the same files, with the same
 * regexes.
 *
 * Positions are opt-in and never public: consolidated/positions.parquet and
 * everything under monthly/ (per-user files) stay out of this list on purpose.
 *
 * The patterns run on the raw, still percent-encoded URL pathname. Their
 * character classes have no '%', so encoded slashes or dots (%2F, %2E) and any
 * other escape fail to match. URL parsing has already resolved '..' and '.'
 * segments; a path that resolves outside derived/ fails to match as well.
 */
const PUBLIC_DERIVED_PATHS = [
  /^\/api\/derived\/manifest\.json$/,
  /^\/api\/derived\/consolidated\/(?:scans|compositions)\.parquet$/,
  /^\/api\/derived\/results\/[a-z0-9_]+\.parquet$/,
]

const DERIVED_ROUTE_PREFIX = '/api/derived/'

/** True if `pathname` (URL#pathname, e.g. "/api/derived/manifest.json") is a public derived file. */
export function isPublicDerivedPath(pathname: string): boolean {
  return PUBLIC_DERIVED_PATHS.some((re) => re.test(pathname))
}

/** True if the scanlake-derived object key (e.g. "results/foo.parquet") is a public derived file. */
export function isPublicDerivedKey(key: string): boolean {
  return isPublicDerivedPath(DERIVED_ROUTE_PREFIX + key)
}

/**
 * Bucket prefixes that hold every public derived key.  A user-key listing
 * scans only these, so it never walks (or pages through) monthly/ and never
 * hands out an R2 cursor positioned among private keys.
 */
export const PUBLIC_DERIVED_LIST_PREFIXES = ['consolidated/', 'manifest.json', 'results/']
