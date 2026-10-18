import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
// Every fixture fails closed at the network boundary: these are rendered component tests, not chain writes.
test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin === baseURL) await route.continue()
    else await route.abort()
  })
})
test('DM-001: member removal describes the consequence without key implementation details', async ({ page }) => {
  await page.goto('/qa-round1.html?fixture=group')
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText('Jakub Rahman will not be able to read new messages.', { exact: true })).toBeVisible()
  await expect(page.getByText('This writes a new group key', { exact: false })).toHaveCount(0)
})
test('DM-002: the mobile network label has space above the conversation header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/qa-round1.html?fixture=messages')
  const pill = page.getByTestId('network-pill')
  const title = page.getByText('DM QA friends — café ☕', { exact: true })
  await expect(pill).toBeVisible()
  await expect(title).toBeVisible()
  const pillBox = await pill.boundingBox()
  const titleBox = await title.boundingBox()
  if (!pillBox || !titleBox) throw new Error('The visible label and title must have layout boxes')
  expect(titleBox.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height)
  await page.getByRole('button', { name: 'Hide the Testnet label' }).click()
  await expect(pill).toHaveCount(0)
  await expect.poll(async () => (await title.boundingBox())?.y ?? Infinity).toBeLessThan(titleBox.y)
})
test('DM-003: deleting the last conversation keeps accurate copy and the restore action', async ({ page }) => {
  await page.goto('/qa-round1.html?fixture=inbox')
  await page.getByRole('button', { name: 'Delete fixture conversation' }).click()
  await expect(page.getByText('Your conversations will appear here')).toBeVisible()
  await expect(page.getByText('No conversations match your search')).toHaveCount(0)
  await page.getByPlaceholder('Search messages').fill('   ')
  await expect(page.getByText('Your conversations will appear here')).toBeVisible()
  await page.getByPlaceholder('Search messages').fill('missing')
  await expect(page.getByText('No conversations match your search')).toBeVisible()
  await page.getByPlaceholder('Search messages').fill('')
  await page.getByRole('button', { name: 'Show 1 deleted conversation' }).click()
  await expect(page.getByTestId('dm-row')).toBeVisible()
})
test('PFQA-02: removal activity uses a consumer-facing label', async ({ page }) => {
  await page.goto('/qa-round1.html?fixture=private-activity')
  await expect(page.getByText('Follower removed', { exact: true })).toBeVisible()
  await expect(page.getByText(/Leaf \d+ revoked/)).toHaveCount(0)
})
for (const count of [0, 1, 2]) {
  test(`SOC-001: ${count} post count`, async ({ page }) => {
    await page.goto(`/qa-round1.html?fixture=profile-page&count=${count}`)
    await expect(page.getByText(`${count} ${count === 1 ? 'post' : 'posts'}`, { exact: true })).toBeVisible()
  })
  test(`SOC-001: ${count} follower count`, async ({ page }) => {
    await page.goto(`/qa-round1.html?fixture=profile&count=${count}`)
    await expect(page.getByRole('button', { name: `${count} ${count === 1 ? 'Follower' : 'Followers'}`, exact: true })).toBeVisible()
  })
  test(`STORE-03: ${count} store review count`, async ({ page }) => {
    await page.goto(`/qa-round1.html?fixture=store&count=${count}`)
    if (count) await expect(page.getByText(`4.0 (${count} ${count === 1 ? 'review' : 'reviews'})`, { exact: true })).toBeVisible()
    else await expect(page.getByText(/4.0 \(0 reviews\)/)).toHaveCount(0)
  })
}
test('SOC-002: deleted threads have a neutral empty state, live threads invite replies', async ({ page }) => {
  await page.goto('/qa-round1.html?fixture=post')
  await expect(page.getByText("This post was deleted, so it can't be replied to.", { exact: true })).toBeVisible()
  await expect(page.getByText('No replies yet.', { exact: true })).toBeVisible()
  await expect(page.getByText('Be the first to reply!', { exact: false })).toHaveCount(0)
  await page.goto('/qa-round1.html?fixture=post&state=live')
  await expect(page.getByText('No replies yet. Be the first to reply!', { exact: true })).toBeVisible()
})
test('STORE-02: checkout controls can be found and filled by their visible labels', async ({ page }) => {
  await page.goto('/qa-round1.html?fixture=checkout')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to Review', exact: true }).click()
  await page.getByRole('button', { name: /Bitcoin bitcoin:mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn/ }).click()
  for (const label of ['Transaction ID (optional)', 'Refund Address (optional)', 'Order Notes (optional)']) {
    const field = page.getByLabel(label, { exact: false })
    await expect(field).toBeVisible()
    await field.fill('QA label regression')
    await expect(field).toHaveValue('QA label regression')
  }
})
test('STORE-02: shipping zone icon actions name the zone', async ({ page }) => {
  await page.goto('/qa-round1.html?fixture=shipping')
  await page.getByRole('button', { name: /^Shipping/ }).click()
  await expect(page.getByRole('button', { name: 'Edit QA US', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete QA US', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Delete QA US', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})
test('STORE-04: inventory and its expanded combinations use the item currency, with a store fallback', async ({ page }) => {
  await page.goto('/qa-round1.html?fixture=inventory')
  await expect(page.getByText('€3.25 - €4.75', { exact: true })).toBeVisible()
  await expect(page.getByText('$6.00', { exact: true })).toBeVisible()
  await page.getByRole('row').filter({ hasText: 'Euro variants' }).getByRole('button').first().click()
  await expect(page.getByText('€3.25', { exact: true })).toBeVisible()
  await expect(page.getByText('€4.75', { exact: true })).toBeVisible()
})

for (const state of ['mixed', 'archived', 'digital-only']) {
  test(`STORE-01: export discloses digital omissions and never downloads a physical replacement (${state})`, async ({ page }) => {
    const downloads: string[] = []
    page.on('download', download => downloads.push(download.suggestedFilename()))
    await page.goto(`/qa-round1.html?fixture=export&state=${state}`)
    await expect(page.getByText('CSV includes physical products only. Digital products and their delivery content are left out.', { exact: true })).toBeVisible()
    if (state === 'digital-only') {
      await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
      await expect(page.getByText('Nothing to export. CSV includes physical products with readable options only.', { exact: true })).toBeVisible()
      expect(downloads).toEqual([])
    } else {
      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
      const download = await downloadPromise
      const file = await download.path()
      if (!file) throw new Error('The export must produce a local CSV download')
      const csv = await readFile(file, 'utf8')
      expect(csv).toContain('Euro variants')
      expect(csv).not.toContain('Download')
    }
    await expect(page.getByText("1 digital product was left out. CSV can't include digital products or their delivery content.", { exact: true })).toBeVisible()
  })
}
