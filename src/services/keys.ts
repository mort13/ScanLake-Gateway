/** Allowlist for R2 object key characters: alphanumerics, slashes, dots, hyphens, underscores. */
const SAFE_KEY_RE = /^[a-zA-Z0-9/_.\-]+$/

/** Rejects empty keys, disallowed characters, parent-directory traversal and absolute paths. */
export function isSafeKey(key: string): boolean {
  return (
    key.length > 0 &&
    SAFE_KEY_RE.test(key) &&
    !key.includes('..') && // no parent-directory traversal
    !key.startsWith('/') // no absolute paths
  )
}
