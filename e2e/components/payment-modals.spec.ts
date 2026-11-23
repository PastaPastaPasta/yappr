import { test, expect, type Page } from '@playwright/test'

/**
 * Wallet payment QRs (#929): a QR this modal session showed is shown again while it can
 * execute; once it can't and its payment hasn't shown up, nothing else is built or signed.
 */
const POLL_MS = 5_000
const QR_BUDGET_MS = 300_000

const paymentState = (page: Page) => page.evaluate(() => {
  const { builds, localPayments } = window.paymentTest.state
  return { builds: builds.map(build => build.ownerId), localPayments }
})
const setTest = (page: Page, values: { balance?: number; live?: boolean }) => page.evaluate(({ balance, live }) => {
  if (balance !== undefined) window.paymentTest.state.balance = BigInt(balance)
  if (live !== undefined) window.paymentTest.state.live = live
}, values)
/** Lets answers already released reach the screen without moving the faked clock past a poll. */
const settle = async (page: Page) => {
  await page.clock.runFor(1)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))))
}
const waitingForWallet = (page: Page) => page.getByText('Waiting for the wallet to sign', { exact: false })

async function showPurchaseQr(page: Page) {
  await page.clock.install()
  await page.goto('/?fixture=buy-yapp')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Approve in wallet' }).click()
  await expect(waitingForWallet(page)).toBeVisible()
}

test.describe('buy YAPP with a wallet', () => {
  test('detects a purchase against the lowest balance seen while its QR was up, after showing that QR again', async ({ page }) => {
    await showPurchaseQr(page)
    await setTest(page, { balance: 900 })
    await page.clock.runFor(POLL_MS)
    await page.clock.runFor(QR_BUDGET_MS)
    await expect(page.getByText("Haven't seen the purchase land yet")).toBeVisible()
    await setTest(page, { balance: 1000 })
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(waitingForWallet(page)).toBeVisible()
    await page.clock.runFor(POLL_MS)
    await expect(page.getByText('Purchased 100 YAPP')).toBeVisible()
    expect((await paymentState(page)).builds).toHaveLength(1)
  })

  test('builds no second request once its QR can no longer execute and the purchase has not shown up', async ({ page }) => {
    await showPurchaseQr(page)
    await page.clock.runFor(QR_BUDGET_MS)
    await setTest(page, { live: false })
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByText("Couldn't confirm your purchase")).toBeVisible()
    expect((await paymentState(page)).builds).toHaveLength(1)
  })

  test('reports a purchase its balance shows once its QR can no longer execute', async ({ page }) => {
    await showPurchaseQr(page)
    await page.clock.runFor(QR_BUDGET_MS)
    await setTest(page, { live: false, balance: 1100 })
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByText('Purchased 100 YAPP')).toBeVisible()
    expect((await paymentState(page)).builds).toHaveLength(1)
  })

  test('ignores a balance read that answers after its QR screen was left', async ({ page }) => {
    await showPurchaseQr(page)
    await page.evaluate(() => window.paymentTest.holdNextBalance())
    await page.clock.runFor(POLL_MS)
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('button', { name: 'Approve in wallet' })).toBeVisible()
    await page.evaluate(() => window.paymentTest.releaseBalance(1100))
    await settle(page)
    await expect(page.getByText('Purchased 100 YAPP')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Approve in wallet' })).toBeVisible()
  })

  test('signs nothing locally after showing a QR this session', async ({ page }) => {
    await page.clock.install()
    await page.goto('/?fixture=buy-yapp&signing=local')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Confirm & Buy' }).click()
    await page.getByRole('button', { name: 'Approve in wallet' }).click()
    await expect(waitingForWallet(page)).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()
    await page.getByRole('button', { name: 'Use your highest-security key instead' }).click()
    await expect(page.getByText("Couldn't confirm your purchase")).toBeVisible()
    expect(await paymentState(page)).toEqual({ builds: ['component-test-identity'], localPayments: 1 })
  })
})

async function showTipQr(page: Page) {
  await page.clock.install()
  await page.goto('/?fixture=tip')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Sign with wallet' }).click()
  await expect(waitingForWallet(page)).toBeVisible()
  await page.clock.runFor(QR_BUDGET_MS)
  await expect(page.getByText("Haven't seen the tip land yet")).toBeVisible()
}

test.describe('tip YAPP with a wallet', () => {
  test('builds nothing for the old account when it switches while the tip is being looked up', async ({ page }) => {
    await showTipQr(page)
    await setTest(page, { live: false })
    await page.evaluate(() => window.paymentTest.holdNextTipCheck())
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByText('Checking whether your tip landed')).toBeVisible()
    await page.evaluate(() => window.switchAuthUser?.('component-test-other-identity'))
    await expect(page.getByText('Checking whether your tip landed')).toHaveCount(0)
    await page.evaluate(() => window.openTipModal?.())
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
    await page.evaluate(() => window.paymentTest.releaseTipCheck(false))
    await settle(page)
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
    await expect(waitingForWallet(page)).toHaveCount(0)
    expect((await paymentState(page)).builds).toEqual(['component-test-identity'])
  })

  test('builds no second request once its QR can no longer execute and the tip has not shown up', async ({ page }) => {
    await showTipQr(page)
    await setTest(page, { live: false })
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByText("Couldn't confirm your tip")).toBeVisible()
    expect((await paymentState(page)).builds).toHaveLength(1)
  })
})
