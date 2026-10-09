import { test, expect } from '@playwright/test'

/** The real VariantEditor: v7's per-field caps apply only where v7 stores the table. */
const LONG_SKU = 'SKU-'.padEnd(40, 'X')

for (const [fixture, expected] of [['variant-editor-legacy', LONG_SKU], ['variant-editor', LONG_SKU.slice(0, 32)]] as const) {
  test(`${fixture}: a combination SKU of 40 characters is ${expected.length === 40 ? 'kept whole' : 'cut to 32'}`, async ({ page }) => {
    await page.goto(`/?fixture=${fixture}`)
    const sku = page.getByLabel('SKU for M')
    await sku.fill(LONG_SKU)
    await sku.blur()
    await expect.poll(() => page.evaluate(() => window.variantEditorValue().combinations.find((combination) => combination.id === '2')?.sku)).toBe(expected)
  })
}

test('variant-editor-legacy: an empty stock entry stops tracking only that combination', async ({ page }) => {
  await page.goto('/?fixture=variant-editor-legacy')
  await page.getByLabel('Track inventory').check()
  await page.getByLabel('Stock for S').fill('4')
  await page.getByLabel('Stock for M').fill('')
  await page.getByLabel('Stock for M').blur()
  await expect.poll(() => page.evaluate(() => window.variantEditorValue().combinations.map((combination) => combination.stock))).toEqual([4, undefined])
})
