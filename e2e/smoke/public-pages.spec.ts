/**
 * Read-only smoke coverage of the public surfaces. Runs without an identity and
 * without `E2E_SEED_PHRASE`, so it is the whole of the signal available on fork
 * PRs. Nothing here writes to Dash Platform.
 */
import { expect, test } from '@playwright/test'
import { appUrl, appUrlPattern, isAppConnectBuild } from '../fixtures/app'
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

for (const route of ['/store/view/', '/store/view/?id=']) {
  test(`store detail without an id explains how to recover: ${route}`, async ({ page }) => {
    await page.goto(appUrl(route))

    await expect(page.getByRole('heading', { name: 'Store link is missing an ID' })).toBeVisible()
    await expect(page.getByText('This store link is incomplete.')).toBeVisible()
    await page.getByRole('button', { name: 'Browse Stores' }).click()
    await expect(page).toHaveURL(appUrlPattern('/store'))
    await expect(page.getByRole('heading', { name: 'Stores', exact: true })).toBeVisible()
  })
}

test('login page shows the login affordance', async ({ page }) => {
  await page.goto(appUrl('/login/'))

  // /login auto-opens the global login modal after hydration. Private-key
  // sign-in is the primary path, with the way to create an identity under it.
  // There is no password or passkey sign-in.
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#loginCredential')).toBeVisible()
  await expect(dialog.locator('#loginIdentityInput')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
  await expect(dialog.getByRole('link', { name: /Create a Dash identity|Get the Dash wallet/ })).toBeVisible()
  await expect(dialog.getByText(/passkey|password/i)).toHaveCount(0)

  // Wallet sign-in is a collapsed secondary option, offered on App Connect builds only.
  const walletToggle = dialog.getByRole('button', { name: 'Sign in with a Dash wallet app' })
  if (!isAppConnectBuild()) {
    await expect(walletToggle).toHaveCount(0)
    return
  }
  await expect(dialog.getByRole('link', { name: 'Open in wallet app' })).toHaveCount(0)
  await walletToggle.click()

  // The deep link is offered on desktop too (Dash Evo Tool runs on the same
  // machine), with copy-the-link as the manual fallback.
  const openWallet = dialog.getByRole('link', { name: 'Open in wallet app' })
  await expect(openWallet).toHaveAttribute('href', /^dash-key:/)
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await expect(dialog.getByText(/Nothing opened\?/)).toHaveCount(0)

  // No wallet is registered for dash-key: in the test browser. Keep the page
  // from navigating to the custom scheme while the app still sees the click,
  // then check the desktop fallback hint appears.
  await page.evaluate(() => {
    window.addEventListener(
      'click',
      (event) => {
        const target = event.target
        if (target instanceof Element && target.closest('a[href^="dash-key:"]')) {
          event.preventDefault()
        }
      },
      { capture: true },
    )
  })
  await openWallet.click()
  await expect(dialog.getByText(/Nothing opened\? No wallet on this computer/)).toBeVisible()
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
