/** Opening the dialog writes nothing, but requires a restored user session. */
import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

test.describe('create blog dialog accessibility', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  test('provides an accessible description for the creation form', async ({ page }) => {
    await page.goto(appUrl('/blog/'))
    await page.getByRole('button', { name: 'Create Blog', exact: true }).click()

    const dialog = page.getByRole('dialog', { name: 'Create Blog' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAccessibleDescription(
      'Give your blog a name, then add an optional description and images.'
    )
    await expect(dialog.getByText('Give your blog a name, then add an optional description and images.')).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
  })
})
