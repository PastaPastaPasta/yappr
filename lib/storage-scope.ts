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

/** Write a scoped localStorage value, ignoring failures (privacy mode / blocked storage). */
export function writeScoped(key: string, value: string): void {
  try {
    localStorage.setItem(scopedKey(key), value)
  } catch {
    // Storage unavailable — the preference simply does not persist.
  }
}

/** localStorage key holding the persisted login session. */
export const SESSION_STORAGE_KEY = scopedKey('yappr_session')
