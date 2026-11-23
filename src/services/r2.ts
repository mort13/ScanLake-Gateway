export type ListedObject = Pick<R2Object, 'key' | 'size' | 'uploaded' | 'etag'>

export interface ListResult {
  objects: ListedObject[]
  truncated: boolean
  cursor?: string
}

/** Restricts a listing to some keys (used for user keys on /api/derived). */
export interface ListingFilter {
  /** Bucket prefixes that hold every allowed key; nothing outside them is listed. */
  prefixes: string[]
  /** Final check on each listed key. */
  allow: (key: string) => boolean
}

/** R2's maximum page size. */
const R2_MAX_PAGE = 1000
/** Pages scanned per prefix in a filtered listing before it reports truncated. */
const FILTERED_MAX_PAGES_PER_PREFIX = 10

function toListed(o: R2Object): ListedObject {
  return { key: o.key, size: o.size, uploaded: o.uploaded, etag: o.etag }
}

export async function listFiles(
  bucket: R2Bucket,
  prefix?: string,
  limit = 100,
  cursor?: string,
): Promise<ListResult> {
  const options: R2ListOptions = { limit }
  if (prefix) options.prefix = prefix
  if (cursor) options.cursor = cursor

  const result = await bucket.list(options)

  return {
    objects: result.objects.map(toListed),
    truncated: result.truncated,
    ...(result.truncated ? { cursor: result.cursor } : {}),
  }
}

/**
 * The prefixes to scan for a filtered listing narrowed by the client's
 * `prefix`: a scan prefix inside the requested one is scanned whole, a
 * requested prefix inside a scan prefix replaces it, anything else is skipped.
 */
function narrowPrefixes(scanPrefixes: string[], requested?: string): string[] {
  const sorted = [...scanPrefixes].sort()
  if (!requested) return sorted
  const out: string[] = []
  for (const p of sorted) {
    if (p.startsWith(requested)) out.push(p)
    else if (requested.startsWith(p)) out.push(requested)
  }
  return [...new Set(out)]
}

/**
 * Lists the keys `filter` allows, in key order, at most `limit` of them.
 *
 * Scans only `filter.prefixes` (page by page, internally) and never returns a
 * cursor: an R2 cursor would sit among keys the caller may not see, and paging
 * through private prefixes would hand back empty pages.  `truncated` is true
 * when more allowed keys exist than were returned.
 */
export async function listFilteredFiles(
  bucket: R2Bucket,
  filter: ListingFilter,
  prefix: string | undefined,
  limit: number,
): Promise<ListResult> {
  const objects: ListedObject[] = []
  let truncated = false

  scan: for (const scanPrefix of narrowPrefixes(filter.prefixes, prefix)) {
    let cursor: string | undefined
    for (let page = 0; ; page++) {
      if (page === FILTERED_MAX_PAGES_PER_PREFIX) {
        truncated = true
        break
      }
      const result = await bucket.list({ prefix: scanPrefix, limit: R2_MAX_PAGE, ...(cursor ? { cursor } : {}) })
      for (const o of result.objects) {
        if (filter.allow(o.key)) objects.push(toListed(o))
      }
      // Prefixes are scanned in key order, so once past `limit` the rest can only be cut.
      if (objects.length > limit) break scan
      if (!result.truncated) break
      cursor = result.cursor
    }
  }

  if (objects.length > limit) {
    objects.length = limit
    truncated = true
  }
  return { objects, truncated }
}

export async function getFile(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key)
}
