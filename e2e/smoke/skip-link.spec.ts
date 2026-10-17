/**
 * The "Skip to content" link is the first Tab stop on every page and moves
 * focus into the page's main content, on the app frame (PageShell) and on the
 * standalone InfoPage routes alike.
 */
import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

for (const path of ['/explore/', '/about/', '/terms/']) {
  test(`skip link moves focus into the main content on ${path}`, async ({ page }) => {
    await page.goto(appUrl(path))
    const main = page.locator('main').first()
    await expect(main).toBeVisible()

    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to content' })
    await expect(skip).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(main).toBeFocused()
  })
}
