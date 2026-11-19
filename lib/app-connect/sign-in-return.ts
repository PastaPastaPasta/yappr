import { sanitizeReturnTo } from '@/lib/auth/return-to'
import { scopedKey } from '@/lib/storage-scope'

/**
 * The page a wallet sign-in started from, kept with its request so the
 * wallet's return to /connect can carry it on to /login when no tab that
 * showed the request answers. One slot, like the pending sign-in request.
 * Everything read back is sanitised again: storage is not trusted.
 */
const KEY = scopedKey('yappr-app-connect-sign-in-return')

function stored(): { requestHash: string; route: string } | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { requestHash?: unknown; route?: unknown }
    return typeof parsed.requestHash === 'string' && typeof parsed.route === 'string' ? { requestHash: parsed.requestHash, route: parsed.route } : null
  } catch {
    return null
  }
}

/**
 * Files `route` as the page the sign-in of request `requestHash` returns to,
 * when the browser's pending request is created. A request already filed
 * (resumed, perhaps by a panel on another page) keeps its page, and one that
 * replaces `previousHash` ("Check again", "That's not me") keeps that one's.
 */
export function fileSignInReturn(requestHash: string, previousHash: string | null, route: string | null): void {
  const filed = stored()
  if (filed?.requestHash === requestHash) return
  remember(requestHash, filed && previousHash !== null && filed.requestHash === previousHash ? filed.route : route)
}

function remember(requestHash: string, route: string | null): void {
  const safe = sanitizeReturnTo(route)
  try {
    if (safe) localStorage.setItem(KEY, JSON.stringify({ requestHash, route: safe }))
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked: the callback falls back to the feed.
  }
}

/** The route the sign-in for `requestHash` started from; null for any other request. Kept until another request is filed. */
export function signInReturnFor(requestHash: string): string | null {
  const filed = stored()
  return filed?.requestHash === requestHash ? sanitizeReturnTo(filed.route) : null
}

/** Forgets the route of `requestHash` once its sign-in is accepted, so a later visit to its callback carries nothing. */
export function retireSignInReturn(requestHash: string): void {
  if (stored()?.requestHash !== requestHash) return
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Storage blocked: nothing was kept either.
  }
}
