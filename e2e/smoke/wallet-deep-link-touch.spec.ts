/**
 * Touch-device layout of the wallet QR (KeyExchangeQR). On a coarse pointer the
 * "Open in wallet app" deep link is the primary action and Copy link stays out
 * of the way, until a launch attempt suggests no wallet handled the link. A
 * phone cannot scan its own screen, so Copy link must then come back as the
 * same-device fallback. Read-only: generating the request writes nothing.
 */
import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('touch login reveals Copy link after an attempted wallet launch', async ({ page }) => {
  await page.goto(appUrl('/login/'))

  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  const openWallet = dialog.getByRole('link', { name: 'Open in wallet app' })
  await expect(openWallet).toHaveAttribute('href', /^dash-key:/)
  await expect(dialog.getByText('Open in a wallet on this device')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toHaveCount(0)

  // No wallet is registered for dash-key: in the test browser. Keep the page
  // from navigating to the custom scheme while the app still sees the click.
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
  await openWallet.tap()

  await expect(dialog.getByText(/Nothing opened\?/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible()
})
