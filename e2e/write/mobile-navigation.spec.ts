import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

test.use({ viewport: { width: 390, height: 844 } })

test.describe('authenticated mobile navigation', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  test('identifies the compose action after sign-in', async ({ page }) => {
    await page.goto(appUrl('/about/'))
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' })
    await nav.getByRole('button', { name: 'Create post', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Create a new post' })).toBeVisible()
  })
})
