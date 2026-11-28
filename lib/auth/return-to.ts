/**
 * Where a user goes back to after a detour: /login, when a signed-out visitor
 * opens a page that needs an account, and /dpns/register for a username.
 *
 * The route travels as the `next` query parameter. It is attacker-controllable
 * (anyone can link to `/login?next=...`), so it is only ever followed
 * after `sanitizeReturnTo` accepts it as an app-relative path.
 *
 * Paths are kept WITHOUT the deployment's `basePath` (/testing, /devnet):
 * `usePathname()` omits it and `router.push` adds it back.
 */

export const RETURN_TO_PARAM = 'next'
export const DEFAULT_RETURN_TO = '/feed'

const DPNS_REGISTER_ROUTE = '/dpns/register'
const LOGIN_ROUTE = '/login'
const CONNECT_ROUTE = '/connect'

/** The detour itself, the login page and the wallet's return page: returning to them would loop or strand the user. */
const NEVER_RETURN_TO = [DPNS_REGISTER_ROUTE, LOGIN_ROUTE, CONNECT_ROUTE]

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

/** `hash`, or nothing when it can't be decoded: navigating decodes the fragment, and would throw. */
function decodableFragment(hash: string): string {
  try {
    decodeURIComponent(hash)
    return hash
  } catch {
    return ''
  }
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

  const route = withoutBasePath(`${url.pathname}${url.search}${decodableFragment(url.hash)}`, basePath.replace(/\/+$/, ''))
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

/**
 * Where a sign-in made on /login goes: the page's own `next`, else what the
 * committing wallet sign-in's request carried to its callback tab (the
 * username step first, when it started there, carrying its page), else /feed.
 */
export function loginPageDestination(next: string | null | undefined, carried?: { returnTo?: string; registerUsername?: boolean }): string {
  const own = sanitizeReturnTo(next)
  if (own) return own
  const page = sanitizeReturnTo(carried?.returnTo, '')
  if (carried?.registerUsername === true) return page ? `${DPNS_REGISTER_ROUTE}?${RETURN_TO_PARAM}=${encodeURIComponent(page)}` : DPNS_REGISTER_ROUTE
  return page ?? DEFAULT_RETURN_TO
}

/**
 * Where the DPNS wizard's Continue goes: back to `next` only when the user now
 * has a username or goes on without one (a skip, or a name waiting for its
 * vote). After a failed registration, with no skip on record, they go to
 * /feed instead.
 */
export function afterRegistrationRoute(goesOn: boolean, next?: string | null): string {
  return goesOn ? returnToOrDefault(next) : DEFAULT_RETURN_TO
}

/**
 * The sign-in page, carrying `currentPath` (as `window.location` has it, with
 * its query) as `next` when it is a route worth returning to.
 */
export function loginRoute(currentPath: string, basePath?: string): string {
  const next = sanitizeReturnTo(currentPath, basePath)
  return next ? `/login?${RETURN_TO_PARAM}=${encodeURIComponent(next)}` : '/login'
}

/** The current page as `window.location` has it: path, query and fragment. Client-only. */
export function currentPagePath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

/**
 * Where a sign-in started here should return to: this page, or, on a detour
 * page (/login, /dpns/register), the `next` it carries. Null when neither is
 * a route worth returning to. Client-only.
 */
export function signInReturnRoute(): string | null {
  return sanitizeReturnTo(currentPagePath()) ?? sanitizeReturnTo(currentReturnToParam())
}

function onRoute(route: string): boolean {
  const path = window.location.pathname.replace(/\/+$/, '')
  return path === route || path.endsWith(route)
}

/** True on the sign-in page, which picks where a sign-in made on it goes next. Client-only. */
export function onLoginPage(): boolean {
  return onRoute(LOGIN_ROUTE)
}

/**
 * True on the username detour page, whose Skip and Continue go back to the
 * `next` it carries. Over any other page the username prompt just closes.
 * Client-only.
 */
export function onUsernameDetour(): boolean {
  return onRoute(DPNS_REGISTER_ROUTE)
}

/** The raw `next` parameter of the current page. Client-only; `null` during prerender. */
export function currentReturnToParam(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(RETURN_TO_PARAM)
}
