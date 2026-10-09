/**
 * Storefront v7 (docs/STOREFRONT_V7.md) against a real chain: a variant
 * listing renders with one picker per option type, the price, stock and SKU
 * follow the chosen combination, a combination that is not offered cannot be
 * bought, and an order for one combination lands carrying its id, label and
 * SKU, which the seller reads decrypted.
 *
 * The seller's store and listing are made in Node (with the action fees the
 * app agrees to), so the spec signs nothing it does not assert; the purchase is
 * the buyer's, in the browser. The listing is digital, so checkout needs no
 * shipping zone. Runs on a v7 build only and self-skips elsewhere:
 *
 *   npm run build:devnet
 *   E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet npx playwright test storefront-variants
 *
 * The whole file runs serially: the buyer's steps use the seller's listing.
 */
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import { dmBot, openDevice, type Device } from '../fixtures/dm'
import { appUrl } from '../fixtures/app'
import { reloadUntilVisible } from '../fixtures/eventual'
import { uniqueTag } from '../fixtures/run-tag'
import { ensureVariantListing, STOREFRONT_V7_BUILD, NOT_V7_REASON, type VariantListing } from '../fixtures/storefront'

test.describe.configure({ mode: 'serial' })

/**
 * Pool slots: the seller keeps one store across runs; the buyer is another
 * bot. E2E_STOREFRONT_SLOTS=<seller>,<buyer> picks others in a smaller pool.
 */
const [SELLER_SLOT, BUYER_SLOT] = (process.env.E2E_STOREFRONT_SLOTS ?? '7,8').split(',').map(Number)
const WRITE_TIMEOUT = 180_000

test.skip(!hasSeedPhrase, NO_SEED_REASON)
test.skip(!STOREFRONT_V7_BUILD, NOT_V7_REASON)

let listing: VariantListing
let buyer: Device
let seller: Device

test.beforeAll(async ({ browser }) => {
  test.setTimeout(WRITE_TIMEOUT * 2)
  const sellerBot = await dmBot(SELLER_SLOT)
  listing = await ensureVariantListing(sellerBot, uniqueTag(SELLER_SLOT))
  buyer = await openDevice(browser, await dmBot(BUYER_SLOT), 'buyer')
  seller = await openDevice(browser, sellerBot, 'seller')
})

test.afterAll(async () => {
  await buyer?.context.close()
  await seller?.context.close()
})

test('a variant listing shows its price range and one picker per option type', async () => {
  test.setTimeout(WRITE_TIMEOUT)
  const { page } = buyer
  await reloadUntilVisible(page, appUrl(`/item/?id=${listing.itemId}`), (p) => p.getByRole('heading', { name: listing.title }))
  await expect(page.getByText('$1.00 – $3.53')).toBeVisible()
  const colors = page.getByRole('group', { name: 'Primary color' })
  const packs = page.getByRole('group', { name: 'Pack Size' })
  await expect(colors.getByRole('button')).toHaveCount(3)
  await expect(packs.getByRole('button')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Choose Primary color' })).toBeDisabled()
})

test('the price, stock and SKU follow the chosen combination; a missing one is not offered', async () => {
  const { page } = buyer
  const colors = page.getByRole('group', { name: 'Primary color' })
  const packs = page.getByRole('group', { name: 'Pack Size' })
  // Blue is offered as a single piece only, so its 4 pack is never selectable.
  await colors.getByRole('button', { name: 'Blue' }).click()
  await expect(packs.getByRole('button', { name: /4 Pack/ })).toBeDisabled()
  await colors.getByRole('button', { name: 'Blue' }).click()
  await colors.getByRole('button', { name: 'Red' }).click()
  await packs.getByRole('button', { name: '4 Pack' }).click()
  await expect(page.getByText('$3.53', { exact: true })).toBeVisible()
  await expect(page.getByText('SKU SQ-RED-4')).toBeVisible()
  await expect(page.getByText('4 in stock')).toBeVisible()
  await page.getByRole('button', { name: 'Add to Cart' }).click()
  await expect(page.getByText('Added to Cart')).toBeVisible()
})

test('the order carries the combination, and the seller reads it with its SKU', async () => {
  test.setTimeout(WRITE_TIMEOUT)
  const { page } = buyer
  await page.goto(appUrl(`/cart/`))
  await expect(page.getByText('Red / 4 Pack')).toBeVisible({ timeout: 30_000 })
  await page.goto(appUrl(`/checkout/?storeId=${listing.storeId}`))
  await page.getByLabel('Email').fill('buyer@example.com')
  await page.getByRole('button', { name: /continue/i }).click()
  await page.getByRole('button', { name: /continue/i }).click()
  await page.getByText(listing.paymentLabel).click()
  await expect(page.getByText('Red / 4 Pack')).toBeVisible()
  await page.getByRole('button', { name: 'Place Order' }).click()
  await expect(page.getByRole('heading', { name: 'Order Placed!' })).toBeVisible({ timeout: WRITE_TIMEOUT })

  const sellerPage = seller.page
  // The store is reused across runs, so open pending orders one at a time (a row opens by its status, not the
  // buyer link in it; one row is open at a time) until the decrypted lines name THIS run's listing.
  const openThisRunsOrder = async (): Promise<boolean> => {
    await sellerPage.goto(appUrl('/orders/seller/'))
    const pending = sellerPage.getByText('Pending', { exact: true })
    await pending.first().waitFor({ timeout: 15_000 }).catch(() => undefined)
    for (let i = 0; i < await pending.count(); i++) {
      await pending.nth(i).click()
      // Rows render already decrypted: once the open order's lines mount, the title is there or not at all.
      await sellerPage.getByText('Items', { exact: true }).first().waitFor({ timeout: 10_000 }).catch(() => undefined)
      if (await sellerPage.getByText(listing.title).count() > 0) return true
    }
    return false
  }
  await expect.poll(openThisRunsOrder, { timeout: WRITE_TIMEOUT, intervals: [5_000] }).toBe(true)
  await expect(sellerPage.getByText('SKU SQ-RED-4')).toBeVisible()
  await expect(sellerPage.getByText('(Red / 4 Pack)')).toBeVisible()
})
