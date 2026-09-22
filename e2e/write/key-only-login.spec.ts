/**
 * Signing in with a private key alone: the identity field stays empty and the
 * app finds the identity from the key through Platform's public-key-hash
 * index. Drives the real login modal from a fresh, unseeded context, so it
 * uses the base Playwright `test` rather than the session-seeding fixture.
 */
import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'
import { hasSeedPhrase, NO_SEED_REASON, resolveBotIdentity } from '../fixtures/auth'

test('a private key alone signs in without a username', async ({ page }) => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)
  const bot = await resolveBotIdentity()

  await page.goto(appUrl('/login/'))
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await dialog.getByRole('button', { name: 'Sign in with a password or private key' }).click()

  await expect(dialog.locator('#loginIdentityInput')).toHaveValue('')
  await dialog.locator('#loginCredential').fill(bot.wif)

  await expect(dialog.getByText(/^Signing in as /)).toBeVisible()
  const submit = dialog.getByRole('button', { name: 'Sign In', exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(page.getByTestId('user-menu-trigger')).toBeVisible()
  await expect(page.locator('#loginIdentityInput')).toHaveCount(0)
})
