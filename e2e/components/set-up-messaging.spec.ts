import { test, expect, type Page } from '@playwright/test'

const setup = (page: Page) => page.evaluate(() => ({ ...window.messagingSetup, ready: window.messagingReady }))

/** Signs the messaging key update with the login key; Platform then shows it only when the test confirms. */
async function sendHeldSetup(page: Page) {
  await page.goto('/?fixture=set-up-messaging')
  await page.getByRole('button', { name: 'Set up messaging' }).click()
  await expect.poll(() => setup(page)).toEqual({ sent: 1, adopted: 0, ready: 0 })
}

async function expectNothingSavedAfterConfirmation(page: Page) {
  await page.evaluate(() => window.confirmMessagingKey?.())
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
  expect(await setup(page)).toEqual({ sent: 1, adopted: 0, ready: 0 })
  expect(await page.evaluate(() => localStorage.getItem('fixture-adopted-messaging-key'))).toBeNull()
}

test('a confirmed messaging key is adopted while its setup is open', async ({ page }) => {
  await sendHeldSetup(page)
  await page.evaluate(() => window.confirmMessagingKey?.())
  await expect.poll(() => setup(page)).toEqual({ sent: 1, adopted: 1, ready: 1 })
})

test('closing the dialog while a sent messaging key awaits confirmation saves nothing', async ({ page }) => {
  await sendHeldSetup(page)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByTestId('modal-state')).toHaveText('closed')
  await expectNothingSavedAfterConfirmation(page)
})

test('signing out while a sent messaging key awaits confirmation saves nothing', async ({ page }) => {
  await sendHeldSetup(page)
  await page.evaluate(() => window.signOut?.())
  await expectNothingSavedAfterConfirmation(page)
})

test('closing the dialog while the wallet poll is under way saves nothing', async ({ page }) => {
  await page.goto('/?fixture=set-up-messaging&wallet')
  await page.getByRole('button', { name: 'Approve in your wallet' }).click()
  await expect.poll(() => page.evaluate(() => window.walletPolls), { timeout: 15_000 }).toBe(1)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByTestId('modal-state')).toHaveText('closed')
  await page.evaluate(() => window.confirmMessagingKey?.())
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
  expect(await setup(page)).toEqual({ sent: 0, adopted: 0, ready: 0 })
  expect(await page.evaluate(() => localStorage.getItem('fixture-adopted-messaging-key'))).toBeNull()
})

test('a draft the anchor shows but no identity read confirms yet is awaited, never offered again', async ({ page }) => {
  await page.goto('/?fixture=set-up-messaging&pending')
  await expect.poll(() => page.evaluate(() => window.anchorChecks), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  await expect(page.getByText('Checking your account…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up messaging' })).toHaveCount(0)
  await page.evaluate(() => window.confirmMessagingKey?.())
  await expect.poll(() => setup(page), { timeout: 15_000 }).toEqual({ sent: 0, adopted: 1, ready: 1 })
})
