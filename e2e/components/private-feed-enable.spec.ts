import { test, expect, type Page } from '@playwright/test'

// Public scalar 1, not a QA credential. Whitespace also exercises normalization.
const dummyHex = '0'.repeat(63) + '1'
const successMessage = 'Private feed enabled successfully!'
const storageWarning = 'Private feed enabled, but your key could not be saved. Enter it again to manage your feed.'
const backupWarning = 'Private feed enabled, but key backup failed. Your key is available for this session.'

async function blockExternalRequests(page: Page, baseURL: string | undefined, sink: string[]) {
  // Fail closed if a future fixture change accidentally imports live services.
  await page.route('**/*', async route => {
    const url = route.request().url()
    if (new URL(url).origin !== baseURL) {
      sink.push(url)
      await route.abort()
      return
    }
    await route.continue()
  })
}

for (const scenario of ['success', 'storage-failure', 'vault-failure'] as const) {
  test(`successful chain enable: ${scenario}`, async ({ page, baseURL }) => {
    const externalRequests: string[] = []
    await blockExternalRequests(page, baseURL, externalRequests)
    await page.goto(`/?scenario=${scenario}`)
    await page.getByTestId('enable-private-feed-btn').click()
    const initial = await page.evaluate(() => window.privateFeedTestSnapshot())
    expect(initial.keyAbsent).toBe(true)
    expect(initial.statusReads).toBe(1)
    await page.getByPlaceholder('WIF (cXyz...) or hex (64 chars)').fill(`  ${dummyHex}  `)
    await page.getByRole('button', { name: 'Enable', exact: true }).click()

    await expect(page.getByTestId('private-feed-enabled')).toBeVisible()
    await expect(page.getByText(successMessage, { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.privateFeedTestSnapshot().statusReads)).toBe(2)
    const result = await page.evaluate(() => window.privateFeedTestSnapshot())
    expect(result.enableCalls).toBe(1)
    expect(result.enabled).toBe(true)
    await expect(page.getByText('Failed to enable private feed', { exact: true })).toHaveCount(0)

    if (scenario === 'storage-failure') {
      expect(result.storageWriteFailures).toBe(1)
      expect(result.keyAbsent).toBe(true)
      expect(result.hasPersistedCanonicalKey).toBe(false)
      expect(result.vaultCalls).toBe(0)
      expect(result.keyType).toBeNull()
      await expect(page.getByText(storageWarning, { exact: true })).toBeVisible()
      await expect(page.getByText(backupWarning, { exact: true })).toHaveCount(0)
      await expect(page.getByText('Key not entered for this session', { exact: true })).toBeVisible()
    } else {
      expect(result.storageWriteFailures).toBe(0)
      expect(result.hasCanonicalLocalKey).toBe(true)
      expect(result.hasPersistedCanonicalKey).toBe(true)
      expect(result.vaultCalls).toBe(1)
      expect(result.vaultHadLocalKey).toBe(true)
      expect(result.vaultReceivedCanonicalKey).toBe(true)
      expect(result.keyType).toBe('external')
      await expect(page.getByText('Key stored for this session', { exact: true })).toBeVisible()
      await expect(page.getByText(storageWarning, { exact: true })).toHaveCount(0)
      if (scenario === 'vault-failure') {
        await expect(page.getByText(backupWarning, { exact: true })).toBeVisible()
      } else {
        await expect(page.getByText(backupWarning, { exact: true })).toHaveCount(0)
      }
    }
    expect(externalRequests).toEqual([])
  })
}

// A stale key for the same identity plus a swallowed write failure makes the readback
// non-null while holding the wrong secret. Nothing may be backed up in that state, and
// the stale key must be dropped so later operations cannot use it.
test('successful chain enable: stale key readback is not backed up', async ({ page, baseURL }) => {
  const externalRequests: string[] = []
  await blockExternalRequests(page, baseURL, externalRequests)
  await page.goto('/?scenario=stale-key')
  await page.getByTestId('enable-private-feed-btn').click()
  const initial = await page.evaluate(() => window.privateFeedTestSnapshot())
  expect(initial.hasStaleLocalKey).toBe(true)
  await page.getByPlaceholder('WIF (cXyz...) or hex (64 chars)').fill(`  ${dummyHex}  `)
  await page.getByRole('button', { name: 'Enable', exact: true }).click()

  await expect(page.getByTestId('private-feed-enabled')).toBeVisible()
  await expect(page.getByText(successMessage, { exact: true })).toBeVisible()
  await expect(page.getByText(storageWarning, { exact: true })).toBeVisible()
  await expect(page.getByText(backupWarning, { exact: true })).toHaveCount(0)
  await expect(page.getByText('Failed to enable private feed', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Key not entered for this session', { exact: true })).toBeVisible()

  await expect.poll(() => page.evaluate(() => window.privateFeedTestSnapshot().statusReads)).toBe(2)
  const result = await page.evaluate(() => window.privateFeedTestSnapshot())
  expect(result.enableCalls).toBe(1)
  expect(result.storageWriteFailures).toBe(1)
  expect(result.keyAbsent).toBe(true)
  expect(result.hasStaleLocalKey).toBe(false)
  expect(result.hasCanonicalLocalKey).toBe(false)
  expect(result.keyType).toBeNull()
  expect(result.vaultCalls).toBe(0)
  expect(externalRequests).toEqual([])
})
