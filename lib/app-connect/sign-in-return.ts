import { sanitizeReturnTo } from '@/lib/auth/return-to'
import { scopedKey } from '@/lib/storage-scope'

/**
 * The page a wallet sign-in started from, kept with its request so the
 * wallet's return to /connect can carry it on to /login when no tab that
 * showed the request answers. One slot, like the pending sign-in request.
 * Everything read back is sanitised again: storage is not trusted.
 */
const KEY = scopedKey('yappr-app-connect-sign-in-return')

export function rememberSignInReturn(requestHash: string, route: string | null): void {
  const safe = sanitizeReturnTo(route)
  try {
    if (safe) localStorage.setItem(KEY, JSON.stringify({ requestHash, route: safe }))
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the callback falls back to the feed.
  }
}

/** The route the sign-in for `requestHash` started from, once; null for any other request. */
export function takeSignInReturn(requestHash: string): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const stored = JSON.parse(raw) as { requestHash?: unknown; route?: unknown }
    if (stored.requestHash !== requestHash || typeof stored.route !== 'string') return null
    localStorage.removeItem(KEY)
    return sanitizeReturnTo(stored.route)
  } catch {
    return null
  }
}
