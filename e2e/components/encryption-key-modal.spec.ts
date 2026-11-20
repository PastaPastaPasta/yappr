import { test, expect, type Page } from '@playwright/test'

// WIF for public scalar 2, typed in as the MASTER key. Never use with an actual identity or funds.
const MASTER_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87K7XCyj5v'
const updates = (page: Page) => page.evaluate(() => ({ ...window.identityUpdates }))
const releaseLock = (page: Page) => page.evaluate(() => window.releaseIdentityUpdateLock?.())

/** Submits a new encryption key; its update then waits behind another tab's identity update. */
async function submitHeldUpdate(page: Page) {
  await page.goto('/?fixture=encryption-key-modal')
  await page.getByRole('button', { name: 'Create Encryption Key' }).click()
  await page.getByLabel('I have securely saved this encryption key', { exact: false }).check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByPlaceholder('Enter your Master key...').fill(MASTER_WIF)
  await page.getByRole('button', { name: 'Add Encryption Key' }).click()
  await expect(page.getByText('Broadcasting identity update transaction...')).toBeVisible()
}

test('a key update held behind another update is sent once the lock frees', async ({ page }) => {
  await submitHeldUpdate(page)
  await releaseLock(page)
  await expect.poll(() => updates(page)).toEqual({ sent: 1, cancelled: 0 })
})

test('closing the dialog while its key update is held behind another update sends nothing', async ({ page }) => {
  await submitHeldUpdate(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('modal-state')).toHaveText('closed')
  // Released at once, while the dialog may still be animating out.
  await releaseLock(page)
  await expect.poll(() => updates(page)).toEqual({ sent: 0, cancelled: 1 })
})

test('closing the dialog while a sent key update awaits confirmation stores no key', async ({ page }) => {
  const storedKeys = () => page.evaluate(() => Object.keys(localStorage).sort())
  await submitHeldUpdate(page)
  await releaseLock(page)
  await expect.poll(() => updates(page)).toEqual({ sent: 1, cancelled: 0 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('modal-state')).toHaveText('closed')
  const before = await storedKeys()
  await page.evaluate(() => window.confirmIdentityUpdate?.())
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
  expect(await storedKeys()).toEqual(before)
})
