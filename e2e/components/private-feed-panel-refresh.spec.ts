import { test, expect, type Page } from '@playwright/test'

// Public scalar 1, not a QA credential.
const dummyHex = '0'.repeat(63) + '1'
const requesterId = 'component-test-requester'
const followerId = 'component-test-follower'

async function blockExternalRequests(page: Page, baseURL: string | undefined, sink: string[]) {
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

test('enabling the feed reloads the sibling Requests and Followers panels', async ({ page, baseURL }) => {
  const externalRequests: string[] = []
  await blockExternalRequests(page, baseURL, externalRequests)
  await page.goto('/?scenario=success&panels=1')

  // Both siblings start in their disabled state, driven by the same mocked chain.
  await expect(page.getByText('Enable your private feed to receive access requests')).toBeVisible()
  await expect(page.getByText('Enable your private feed to manage followers')).toBeVisible()

  await page.getByTestId('enable-private-feed-btn').click()
  await page.getByPlaceholder('WIF (cXyz...) or hex (64 chars)').fill(dummyHex)
  await page.getByRole('button', { name: 'Enable', exact: true }).click()

  // The enable handler only broadcasts a refresh; the siblings must pick it up themselves.
  await expect(page.getByTestId('private-feed-enabled')).toBeVisible()
  await expect(page.getByTestId(`request-card-${requesterId}`)).toBeVisible()
  await expect(page.getByTestId(`follower-card-${followerId}`)).toBeVisible()
  expect(externalRequests).toEqual([])
})

test('ignored requests and revoked followers stay hidden across a refresh', async ({ page, baseURL }) => {
  const externalRequests: string[] = []
  await blockExternalRequests(page, baseURL, externalRequests)
  await page.goto('/?panels=1&enabled=1')

  await expect(page.getByTestId(`request-card-${requesterId}`)).toBeVisible()
  await expect(page.getByTestId(`follower-card-${followerId}`)).toBeVisible()

  await page.getByTestId(`ignore-btn-${requesterId}`).click()
  await expect(page.getByTestId('no-pending-requests')).toBeVisible()

  const before = await page.evaluate(() => window.privateFeedTestSnapshot())

  // Revoking broadcasts a refresh to every panel while both records are still queryable.
  await page.getByTestId(`revoke-btn-${followerId}`).click()
  await page.getByTestId(`confirm-revoke-btn-${followerId}`).click()
  await expect(page.getByText('No private followers yet')).toBeVisible()

  // Wait for the refresh-driven reloads to actually complete before asserting absence.
  await expect
    .poll(() => page.evaluate(() => window.privateFeedTestSnapshot().requestLoads))
    .toBeGreaterThan(before.requestLoads)
  await expect
    .poll(() => page.evaluate(() => window.privateFeedTestSnapshot().followerLoads))
    .toBeGreaterThan(before.followerLoads)

  await expect(page.getByTestId(`request-card-${requesterId}`)).toHaveCount(0)
  await expect(page.getByTestId(`follower-card-${followerId}`)).toHaveCount(0)
  await expect(page.getByTestId('no-pending-requests')).toBeVisible()

  const result = await page.evaluate(() => window.privateFeedTestSnapshot())
  expect(result.revokeCalls).toBe(1)
  expect(externalRequests).toEqual([])
})
