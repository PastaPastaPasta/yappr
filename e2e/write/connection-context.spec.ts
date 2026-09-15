import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

test.describe('restored own connection lists', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  for (const kind of ['followers', 'following'] as const) {
    test(`${kind} without an id restores the viewer instead of showing guest recovery`, async ({ page }) => {
      await page.addInitScript(() => {
        const observations: string[] = []
        Object.assign(window, { connectionGuestPrompts: observations })
        new MutationObserver(() => {
          const prompt = document.getElementById('connection-sign-in-title')
          if (prompt) observations.push(prompt.textContent || '')
        }).observe(document, { subtree: true, childList: true })
      })

      await page.goto(appUrl(`/${kind}/`))
      const title = kind === 'followers' ? 'Followers' : 'Following'
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: `Sign in to view your ${kind}` })).toHaveCount(0)
      expect(await page.evaluate(() => Reflect.get(window, 'connectionGuestPrompts'))).toEqual([])
    })
  }
})
