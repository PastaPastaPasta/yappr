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

  // The network pill lives in the always-mounted AppShell — the cheapest
  // "the app booted at all" probe there is. Its label follows
  // NEXT_PUBLIC_NETWORK, so this doubles as a build-targets-the-right-chain
  // check.
  await expect(page.getByText(network.toUpperCase()).first()).toBeVisible()

  // Home gates its body behind a hydration flag, so this only appears once the
  // client bundle has run.
  await expect(page.getByRole('heading', { name: /Welcome to Yappr/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Explore', exact: true })).toBeVisible()
})

test('about page renders and the network pill names the network', async ({ page }) => {
  const network = await expectedNetwork()
  await page.goto(appUrl('/about/'))

  await expect(page.getByRole('heading', { name: 'About Yappr' })).toBeVisible()
  // The build's network shows as a small pill (never on mainnet); the build's
  // contracts and topology moved to Settings > Developer > Build details.
  await expect(page.getByTestId('network-pill')).toContainText(new RegExp(`^${network}`, 'i'))
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
    // The heading carries the Store Beta pill while the build marks Store Beta.
    await expect(page.getByRole('heading', { name: /^Stores( Beta)?$/ })).toBeVisible()
  })
}

test('login page shows the login affordance', async ({ page }) => {
  await page.goto(appUrl('/login/'))

  // /login auto-opens the global login modal after hydration. Passkey sign-in
  // is also offered on supported deployments and browsers.
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('link', { name: /^Get the Dash wallet/ })).toHaveAttribute('href', 'https://www.dash.org/download/')
  await expect(dialog.getByText(/password/i)).toHaveCount(0)

  const walletButton = dialog.getByRole('button', { name: 'Sign in with your Dash wallet' })
  if (!isAppConnectBuild()) {
    // Other builds: private-key sign-in is the primary path, and there is no wallet option.
    await expect(dialog.locator('#loginCredential')).toBeVisible()
    await expect(dialog.locator('#loginIdentityInput')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
    await expect(walletButton).toHaveCount(0)
    return
  }

  // App Connect builds: the wallet first, then a passkey where offered; the
  // recovery phrase (not yet on mainnet) and a private key sit under Advanced.
  await expect(walletButton).toBeVisible()
  await expect(dialog.locator('#loginCredential')).toHaveCount(0)
  const phraseOption = dialog.getByRole('button', { name: 'Sign in with your recovery phrase' })
  const keyOption = dialog.getByRole('button', { name: 'Sign in with a private key' })
  await expect(phraseOption).toHaveCount(0)
  await expect(keyOption).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Advanced', exact: true }).click()
  if (await expectedNetwork() === 'mainnet') {
    await expect(phraseOption).toHaveCount(0)
  } else {
    await phraseOption.click()
    const phrase = dialog.getByLabel('Recovery phrase', { exact: true })
    // Masked, but not a password field (browsers would offer to save it), and in no form.
    await expect(phrase).toHaveAttribute('type', 'text')
    await expect(phrase).toHaveAttribute('autocomplete', 'off')
    await expect(phrase).toHaveCSS('-webkit-text-security', 'disc')
    await expect(dialog.locator('form').getByLabel('Recovery phrase', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('Your recovery phrase controls your Dash wallet. It stays on this device and is never saved. Only enter it on yap.pr.')).toBeVisible()
  }
  await keyOption.click()
  await expect(dialog.getByLabel('Recovery phrase', { exact: true })).toHaveCount(0)
  await expect(dialog.locator('#loginCredential')).toBeVisible()
  await expect(dialog.locator('#loginIdentityInput')).toBeVisible()

  // The wallet request is made only once the wallet option is chosen.
  await expect(dialog.getByRole('link', { name: 'Open in wallet app' })).toHaveCount(0)
  await walletButton.click()
  await expect(dialog.locator('#loginCredential')).toHaveCount(0)

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

  await page.getByRole('link', { name: /^Blog( Beta)?$/ }).click()
  await expect(page).toHaveURL(appUrlPattern('/blog'))
})
