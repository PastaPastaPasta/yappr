/**
 * Read-only smoke coverage of the public surfaces. Runs without an identity and
 * without `E2E_SEED_PHRASE`, so it is the whole of the signal available on fork
 * PRs. Nothing here writes to Dash Platform.
 */
import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test('home renders the app shell', async ({ page }) => {
  await page.goto(appUrl('/'))

  // The testnet banner lives in the always-mounted AppShell — the cheapest
  // "the app booted at all" probe there is.
  await expect(page.getByText('TESTNET').first()).toBeVisible()

  // Home gates its body behind a hydration flag, so this only appears once the
  // client bundle has run.
  await expect(page.getByRole('heading', { name: /Welcome to Yappr/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Explore', exact: true })).toBeVisible()
})

test('about page renders and reports the network', async ({ page }) => {
  await page.goto(appUrl('/about/'))

  await expect(page.getByRole('heading', { name: 'About Yappr' })).toBeVisible()
  await expect(page.getByText('Network', { exact: true })).toBeVisible()
  await expect(page.getByText('testnet', { exact: true })).toBeVisible()
})

test('explore page loads', async ({ page }) => {
  await page.goto(appUrl('/explore/'))

  await expect(page.getByPlaceholder('Search posts and blog articles')).toBeVisible()
  // The trending panel starts in its loading state and resolves to either real
  // hashtags or the empty state — both mean the page came up.
  await expect(page.getByRole('button', { name: /Trending/ })).toBeVisible()
})

test('login page shows the login affordance', async ({ page }) => {
  await page.goto(appUrl('/login/'))

  // /login auto-opens the global login modal after hydration.
  await expect(page.locator('#loginIdentityInput')).toBeVisible()
  await expect(page.locator('#loginCredential')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
})

test('primary navigation moves between sections', async ({ page }) => {
  await page.goto(appUrl('/'))
  await expect(page.getByRole('heading', { name: /Welcome to Yappr/ })).toBeVisible()

  await page.getByRole('link', { name: 'Explore', exact: true }).click()
  await expect(page).toHaveURL(/\/testing\/explore/)
  await expect(page.getByPlaceholder('Search posts and blog articles')).toBeVisible()

  await page.getByRole('link', { name: 'Blog', exact: true }).click()
  await expect(page).toHaveURL(/\/testing\/blog/)
})
