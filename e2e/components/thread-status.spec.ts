import { test, expect } from '@playwright/test'

/** A thread holding only earlier messages, before and after the inbox knows whether the person can be messaged. */
const composer = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Message', exact: true })
const notSetUp = (page: import('@playwright/test').Page) => page.getByTestId('dm-unreachable')

test('while checking, nothing can be sent and no status is claimed yet', async ({ page }) => {
  await page.goto('/?fixture=thread-checking')
  await expect(page.getByText('hello from before')).toBeVisible()
  await expect(composer(page)).toBeDisabled()
  await expect(notSetUp(page)).toHaveCount(0)
})

test('someone who has not set up messaging: named status, composer off, history kept', async ({ page }) => {
  await page.goto('/?fixture=thread-unreachable')
  await expect(page.getByText('hello from before')).toBeVisible()
  await expect(notSetUp(page)).toHaveText("@carol hasn't set up messaging yet. You can message them once they do.")
  await expect(composer(page)).toBeDisabled()
})

test('someone who can be messaged: the composer is on', async ({ page }) => {
  await page.goto('/?fixture=thread-reachable')
  await expect(composer(page)).toBeEnabled()
  await expect(notSetUp(page)).toHaveCount(0)
})

test('a check that fails is retried while the thread stays open, then the composer comes on', async ({ page }) => {
  await page.goto('/?fixture=thread-live-failed-then-ok')
  await expect(composer(page)).toBeDisabled()
  await expect(notSetUp(page)).toHaveCount(0)
  await expect(composer(page)).toBeEnabled()
  expect(await page.evaluate(() => window.readinessChecks)).toBe(3)
})

test('"not set up" stays shown through a failed re-check, and clears once they set up', async ({ page }) => {
  await page.goto('/?fixture=thread-live-not-set-up-then-ok')
  await expect(notSetUp(page)).toBeVisible()
  await expect(composer(page)).toBeDisabled()
  await expect.poll(() => page.evaluate(() => window.readinessChecks)).toBeGreaterThanOrEqual(2)
  await expect(composer(page)).toBeEnabled()
  await expect(notSetUp(page)).toHaveCount(0)
})
