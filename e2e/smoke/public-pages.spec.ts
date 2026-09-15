/**
 * Read-only smoke coverage of the public surfaces. Runs without an identity and
 * without `E2E_SEED_PHRASE`, so it is the whole of the signal available on fork
 * PRs. Nothing here writes to Dash Platform.
 */
import { expect, test } from '@playwright/test'
import { appUrl, appUrlPattern } from '../fixtures/app'
import { expectedNetwork } from '../fixtures/contracts'

test('home renders the app shell', async ({ page }) => {
  const network = await expectedNetwork()
  await page.goto(appUrl('/'))

  // The network banner lives in the always-mounted AppShell — the cheapest
  // "the app booted at all" probe there is. Its label follows
  // NEXT_PUBLIC_NETWORK, so this doubles as a build-targets-the-right-chain
  // check.
  await expect(page.getByText(network.toUpperCase()).first()).toBeVisible()

  // Home gates its body behind a hydration flag, so this only appears once the
  // client bundle has run.
  await expect(page.getByRole('heading', { name: /Welcome to Yappr/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Explore', exact: true })).toBeVisible()
})

test('about page renders and reports the network', async ({ page }) => {
  const network = await expectedNetwork()
  await page.goto(appUrl('/about/'))

  await expect(page.getByRole('heading', { name: 'About Yappr' })).toBeVisible()
  await expect(page.getByText('Network', { exact: true })).toBeVisible()
  await expect(page.getByText(network, { exact: true })).toBeVisible()
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

  // /login auto-opens the global login modal after hydration. Wallet sign-in
  // is the primary path, so the dialog leads with a QR code; password and
  // private-key entry sit behind a disclosure.
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible()
  await expect(dialog.locator('#loginIdentityInput')).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Sign in with a password or private key' }).click()
  await expect(dialog.locator('#loginIdentityInput')).toBeVisible()
  await expect(dialog.locator('#loginCredential')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
})

test('primary navigation moves between sections', async ({ page }) => {
  await page.goto(appUrl('/'))
  await expect(page.getByRole('heading', { name: /Welcome to Yappr/ })).toBeVisible()

  await page.getByRole('link', { name: 'Explore', exact: true }).click()
  await expect(page).toHaveURL(appUrlPattern('/explore'))
  await expect(page.getByPlaceholder('Search posts and blog articles')).toBeVisible()

  await page.getByRole('link', { name: 'Blog', exact: true }).click()
  await expect(page).toHaveURL(appUrlPattern('/blog'))
})
