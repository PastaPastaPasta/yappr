/**
 * Deployment-scoped storage keys.
 *
 * Parallel deployments share an origin (yap.pr serves production at the root
 * and the staging branch under /staging), so every persistent key must carry
 * the deployment scope — otherwise the two apps, which target different
 * contract IDs, would read each other's sessions, caches, and stored keys.
 *
 * The scope is derived from BASE_PATH at build time (next.config.js). The
 * production build has no base path, so its keys keep their historical names.
 */
export const STORAGE_SCOPE = process.env.NEXT_PUBLIC_STORAGE_SCOPE || ''

export function scopedKey(key: string): string {
  return STORAGE_SCOPE ? `${STORAGE_SCOPE}:${key}` : key
}

/** Read a scoped localStorage value; `null` when absent, on the server, or when storage is blocked. */
export function readScoped(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(scopedKey(key))
  } catch {
    return null
  }
}

/**
 * Write a scoped localStorage value. Failures (privacy mode, blocked storage,
 * quota) are swallowed; the result says whether the value persisted, for the
 * callers that must not act as if it had.
 */
export function writeScoped(key: string, value: string): boolean {
  try {
    localStorage.setItem(scopedKey(key), value)
    return true
  } catch {
    // Storage unavailable — the value simply does not persist.
    return false
  }
}

/** Remove a scoped localStorage value; false when storage is blocked. */
export function removeScoped(key: string): boolean {
  try {
    localStorage.removeItem(scopedKey(key))
    return true
  } catch {
    return false
  }
}

/** The (unscoped) names of every scoped localStorage value starting with `prefix`; none when storage is blocked. */
export function scopedKeysWithPrefix(prefix: string): string[] {
  if (typeof window === 'undefined') return []
  const scopedPrefix = scopedKey(prefix)
  const unscope = scopedKey('').length
  const names: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(scopedPrefix)) names.push(key.slice(unscope))
    }
  } catch {
    return []
  }
  return names
}

/** localStorage key holding the persisted login session. */
export const SESSION_STORAGE_KEY = scopedKey('yappr_session')
