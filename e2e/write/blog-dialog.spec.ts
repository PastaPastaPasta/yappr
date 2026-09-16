/** Opening the dialog writes nothing, but requires a restored user session. */
import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

test.describe('create blog dialog accessibility', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  test('describes the creation form and restores focus when dismissed', async ({ page }) => {
    await page.goto(appUrl('/blog/'))
    const trigger = page.getByRole('button', { name: 'Create Blog', exact: true })
    await trigger.focus()
    await trigger.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Create Blog' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAccessibleDescription(
      'Give your blog a name, then add an optional description and images.'
    )
    await expect(dialog.getByText('Give your blog a name, then add an optional description and images.')).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.press('Enter')
    await expect(dialog).toBeVisible()
    await dialog.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  })
})
