import { test, expect, type Page } from '@playwright/test'

/** The passkey offer takes two passkey prompts; the dialog must visibly move on after the first. */
const progress = (page: Page) => page.getByTestId('passkey-progress')
const release = (page: Page) => page.evaluate(() => window.releasePasskeySheet?.())

test('adding a passkey shows both prompts up front and ticks off the first before asking again', async ({ page }) => {
  await page.goto('/?fixture=passkey-enrol')
  const dialog = page.getByRole('dialog', { name: 'Sign in faster with a passkey' })
  await expect(progress(page).getByRole('listitem')).toHaveText(['1Create your passkey', '2Confirm it to save your sign-in'])
  await expect(dialog.getByText('Your device will ask twice.', { exact: false })).toBeVisible()
  await expect(progress(page).locator('[aria-current="step"]')).toHaveText('1Create your passkey')

  await page.getByTestId('passkey-add').click()
  await expect(page.getByTestId('passkey-add')).toHaveText('Waiting for your passkey…')

  await release(page)
  await expect(progress(page).getByRole('listitem').first()).toHaveText('Passkey created')
  await expect(progress(page).locator('[aria-current="step"]')).toHaveText('2Confirm it to save your sign-in')
  await expect(page.getByTestId('passkey-confirm')).toHaveText('Confirm passkey')

  await page.getByTestId('passkey-confirm').click()
  await expect(page.getByTestId('passkey-add')).toHaveText('Saving…')
  await release(page)
  await expect(page.getByRole('dialog', { name: 'Passkey added' })).toBeVisible()
})
