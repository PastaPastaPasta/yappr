/**
 * Where a user goes back to after the DPNS username gate detoured them through
 * /dpns/register.
 *
 * The route travels as the `next` query parameter. It is attacker-controllable
 * (anyone can link to `/dpns/register?next=...`), so it is only ever followed
 * after `sanitizeReturnTo` accepts it as an app-relative path.
 *
 * Paths are kept WITHOUT the deployment's `basePath` (/testing, /devnet):
 * `usePathname()` omits it and `router.push` adds it back.
 */

export const RETURN_TO_PARAM = 'next'
export const DEFAULT_RETURN_TO = '/feed'

const DPNS_REGISTER_ROUTE = '/dpns/register'

/** The detour itself and the login page: returning to them would loop or strand the user. */
const NEVER_RETURN_TO = [DPNS_REGISTER_ROUTE, '/login']

const MAX_RETURN_TO_LENGTH = 2048
// Any whitespace or control character. The URL parser silently drops tabs and
// newlines, which would turn `/\t/evil.example` into `//evil.example`.
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f]/
const PARSE_ORIGIN = 'https://return-to.invalid'

function configuredBasePath(): string {
  return (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/+$/, '')
}

function withoutBasePath(path: string, basePath: string): string {
  if (!basePath) return path
  if (path === basePath) return '/'
  const rest = path.slice(basePath.length)
  if (path.startsWith(basePath) && /^[/?#]/.test(rest)) return rest.startsWith('/') ? rest : `/${rest}`
  return path
}

/**
 * The app-relative route in `value`, or `null` when it is not safe to follow.
 *
 * Accepts only a path that starts with exactly one `/`: no scheme, no
 * protocol-relative `//host`, no backslash, no whitespace or control
 * characters. A leading `basePath` is stripped so `router.push` does not
 * double it. The detour routes and /login are refused.
 */
export function sanitizeReturnTo(value: string | null | undefined, basePath: string = configuredBasePath()): string | null {
  if (!value || value.length > MAX_RETURN_TO_LENGTH) return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('\\') || UNSAFE_CHARS.test(value)) return null

  let url: URL
  try {
    url = new URL(value, PARSE_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== PARSE_ORIGIN) return null

  const route = withoutBasePath(`${url.pathname}${url.search}${url.hash}`, basePath.replace(/\/+$/, ''))
  // Re-check after normalisation: `/./evil` style dot segments or a stripped
  // basePath must not leave a protocol-relative path behind.
  if (!route.startsWith('/') || route.startsWith('//')) return null

  const pathname = route.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/'
  if (NEVER_RETURN_TO.some((blocked) => pathname === blocked || pathname.startsWith(`${blocked}/`))) return null

  return route
}

/** The sanitised `next` route, or /feed. */
export function returnToOrDefault(value: string | null | undefined, basePath?: string): string {
  return sanitizeReturnTo(value, basePath) ?? DEFAULT_RETURN_TO
}

function withReturnTo(route: string, next: string | null | undefined): string {
  const safe = sanitizeReturnTo(next)
  return safe ? `${route}?${RETURN_TO_PARAM}=${encodeURIComponent(safe)}` : route
}

/**
 * Where the DPNS wizard's Continue goes: back to `next` only when the user now
 * has a username. After a failed registration they still have none, and `next`
 * is usually a username-gated page, so returning there would send them straight
 * back to /dpns/register; they go to /feed instead.
 */
export function afterRegistrationRoute(hasUsername: boolean, next?: string | null): string {
  return hasUsername ? returnToOrDefault(next) : DEFAULT_RETURN_TO
}

/** /dpns/register, carrying `next` when it is a route worth returning to. */
export function dpnsRegisterHref(next?: string | null): string {
  return withReturnTo(DPNS_REGISTER_ROUTE, next)
}

/** The route the user is on now: `pathname` (basePath-free) plus the live query string. */
export function currentRoute(pathname: string): string {
  const search = typeof window === 'undefined' ? '' : window.location.search
  return `${pathname}${search}`
}

/** The raw `next` parameter of the current page. Client-only; `null` during prerender. */
export function currentReturnToParam(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(RETURN_TO_PARAM)
}
