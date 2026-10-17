/**
 * Shared knowledge about the app under test: where it is mounted and how it
 * namespaces browser storage.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

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

/**
 * URL assertion pattern for an in-app path, anchored to the deployment's base
 * path (`/testing` locally, `/devnet` on the moutai deployment, …). Specs must
 * use this instead of hardcoding the base path into their regexes.
 */
export function appUrlPattern(path: string): RegExp {
  const pathname = new URL(BASE_URL).pathname
  const full = `${pathname}${path.startsWith('/') ? path : `/${path}`}`
  return new RegExp(full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/**
 * Whether the build under test offers wallet sign-in (App Connect). Read from
 * the env file the build used, like the other build-shape fixtures.
 */
export function isAppConnectBuild(): boolean {
  if (process.env.E2E_LOGIN_PROTOCOL) return process.env.E2E_LOGIN_PROTOCOL === 'app-connect'
  const file = process.env.E2E_ENV_FILE?.trim() || '.env.testing'
  try {
    return /^NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect\s*$/m.test(readFileSync(join(process.cwd(), file), 'utf8'))
  } catch {
    return false
  }
}

export function scopedKey(key: string): string {
  return STORAGE_SCOPE ? `${STORAGE_SCOPE}:${key}` : key
}

/**
 * Open Settings > Developer > Build details, which print the commit, the
 * compiled-in topology and the contract ids. The settings page is auth-gated,
 * so callers need a signed-in page.
 */
export async function openBuildDetails(page: Page): Promise<void> {
  await page.goto(appUrl('/settings/?section=developer'))
  const details = page.getByTestId('build-details')
  await expect(details).toBeVisible({ timeout: 60_000 })
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator('summary').click()
  }
}
