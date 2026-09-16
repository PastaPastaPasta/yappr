import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

test.describe('profile field accessibility', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  test('visible labels name and focus each profile text field', async ({ page, bot }) => {
    await page.goto(appUrl(`/user/?id=${bot.identityId}`))
    await page.getByRole('button', { name: 'Edit profile', exact: true }).click()

    for (const name of ['Name', 'Pronouns', 'Bio', 'Location', 'Website']) {
      const field = page.getByRole('textbox', { name, exact: true })
      await expect(field).toBeVisible()
      await expect(field).toHaveAccessibleName(name)
      await page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
      await expect(field).toBeFocused()
    }

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit profile', exact: true })).toBeVisible()
  })
})
