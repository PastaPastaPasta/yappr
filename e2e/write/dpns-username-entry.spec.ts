import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

// Authentication opens the real registration entry UI, but these tests never
// check availability or submit a registration. No usernames or credits change.
test.describe('DPNS registration entry', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  const duplicateGroups = [
    { name: 'identical names', labels: ['qadup123', 'qadup123'] },
    { name: 'i/l/1 equivalents', labels: ['qaname1', 'qanamei', 'qanamel'] },
    { name: 'o/0 equivalents', labels: ['qaname0', 'qanameo'] },
  ]

  for (const { name, labels } of duplicateGroups) {
    test(`marks every row for ${name} and recovers after editing or removal`, async ({ page }) => {
      await page.goto(appUrl('/settings/?section=account'))
      await page.getByRole('button', { name: /^Register (More Usernames|Username)$/ }).click()

      const inputs = page.getByPlaceholder('username', { exact: true })
      const add = page.getByRole('button', { name: 'Add Another Username', exact: true })
      const check = page.getByRole('button', { name: 'Check Availability', exact: true })
      const errors = page.getByText('This username matches another entry', { exact: true })
      const row = (index: number) => inputs.nth(index).locator('xpath=../../..')

      await expect(inputs).toHaveCount(1)
      await inputs.first().fill(labels[0])
      // Enabled only after the real SDK, including its canonical normalizer, is ready.
      await expect(check).toBeEnabled({ timeout: 60_000 })
      for (const label of labels.slice(1)) {
        await add.click()
        await inputs.last().fill(label)
        await expect(inputs.last()).toHaveValue(label.toLowerCase())
      }
      await add.click()
      await inputs.last().fill('qadistinct789')
      await expect(errors).toHaveCount(labels.length)
      for (let index = 0; index < labels.length; index++) {
        await expect(row(index).getByText('This username matches another entry', { exact: true })).toBeVisible()
      }
      await expect(check).toBeDisabled()

      // Editing every conflicting row must restore the original row as well.
      for (let index = 1; index < labels.length; index++) {
        await inputs.nth(index).fill(`qarecovery${index}`)
      }
      await expect(errors).toHaveCount(0)
      await expect(check).toBeEnabled()

      await inputs.nth(1).fill(labels[1])
      await expect(errors).toHaveCount(2)
      await expect(check).toBeDisabled()
      await row(1).getByRole('button').click()
      await expect(inputs).toHaveCount(labels.length)
      await expect(inputs.first()).toHaveValue(labels[0])
      await expect(errors).toHaveCount(0)
      await expect(check).toBeEnabled()

      // Empty rows are not a duplicate group, and an entirely empty form stays disabled.
      await add.click()
      await add.click()
      await expect(errors).toHaveCount(0)
      await expect(check).toBeEnabled()
      for (const input of await inputs.all()) await input.fill('')
      await expect(errors).toHaveCount(0)
      await expect(check).toBeDisabled()
    })
  }
})
