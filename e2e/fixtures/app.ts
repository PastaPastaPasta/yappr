/**
 * Shared knowledge about the app under test: where it is mounted and how it
 * namespaces browser storage.
 */

/**
 * `baseURL` in playwright.config.ts has no trailing slash, so `page.goto('/x')`
 * would resolve against the origin and drop the `/testing` base path. Every
 * navigation therefore goes through `appUrl()`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3000)
const BASE_PATH = process.env.E2E_BASE_PATH ?? '/testing'

export const BASE_URL = (
  process.env.E2E_BASE_URL ?? `http://localhost:${PORT}${BASE_PATH}`
).replace(/\/+$/, '')

/**
 * `lib/storage-scope.ts` prefixes every persisted key with the deployment's
 * base path, so the `/testing` build's keys live under `testing:`.
 */
export const STORAGE_SCOPE = process.env.E2E_STORAGE_SCOPE ?? new URL(BASE_URL).pathname.replace(/^\/+|\/+$/g, '')

export function appUrl(path: string): string {
  return `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

export function scopedKey(key: string): string {
  return STORAGE_SCOPE ? `${STORAGE_SCOPE}:${key}` : key
}
