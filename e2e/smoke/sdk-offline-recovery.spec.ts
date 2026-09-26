import { expect, test, type Page } from '@playwright/test'
import { appUrl } from '../fixtures/app'

/**
 * Failed DAPI requests ban endpoints inside the SDK instance. Once every
 * endpoint is banned the instance is dead ("no available addresses") until the
 * app replaces it. These specs exhaust a real instance through the ordinary
 * feed refresh, then check that the same page recovers without a reload.
 * Nothing about the SDK's endpoint pool or the responses is faked: only the
 * browser's connectivity or the transport to the DAPI gateways changes.
 */

const FEED_FAILURE = 'Feed: Failed to load posts from platform:'
const dapi = /\/org\.dash\.platform\.dapi\.v0\.Platform\//

const feed = (page: Page) => page.getByTestId('feed-post-list').locator('article').first()
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh feed', exact: true })
const failed = (page: Page) => page.getByRole('button', { name: 'Try Again', exact: true })

/**
 * Endpoint pools differ between networks, so by default a pool that survives
 * ten failed reads skips the spec. Set E2E_REQUIRE_SDK_EXHAUSTION=1 on a
 * configuration known to exhaust (the moutai devnet build) to make that a
 * failure instead, so a green run proves recovery was actually exercised.
 */
const REQUIRE_EXHAUSTION = Boolean(process.env.E2E_REQUIRE_SDK_EXHAUSTION?.trim())

function requireExhausted(exhausted: boolean, reason: string) {
  if (REQUIRE_EXHAUSTION) expect(exhausted, reason).toBe(true)
  test.skip(!exhausted, reason)
}

async function openFeed(page: Page) {
  await page.goto(appUrl('/feed/'))
  await expect(page.getByRole('button', { name: 'For You', exact: true })).toBeVisible()
  await expect(feed(page)).toBeVisible()
}

/**
 * Refresh until some SDK call reports the exhausted address pool. That need not
 * be the feed read: the posts' background enrichment shares the instance and
 * can exhaust it first. The rebuild that failure starts cannot connect while
 * offline, so later feed reads fail on the rebuild instead and never name the
 * pool themselves. Every failed refresh must keep its posts and show the
 * error banner with its Try Again button.
 */
async function exhaustAddressPool(page: Page): Promise<boolean> {
  let exhausted = false
  const onConsole = (message: { text(): string }) => {
    if (message.text().toLowerCase().includes('no available addresses')) exhausted = true
  }
  page.on('console', onConsole)
  try {
    for (let attempt = 0; attempt < 10 && !exhausted; attempt++) {
      const failure = page.waitForEvent('console', {
        predicate: message => message.text().includes(FEED_FAILURE),
      })
      await refresh(page).click()
      await failure
      await expect(failed(page)).toBeVisible()
      await expect(feed(page)).toBeVisible()
    }
  } finally {
    page.off('console', onConsole)
  }
  return exhausted
}

/**
 * Retry through the feed's own button and prove the read went to the network
 * and came back clean. The posts from the first load stay on screen during a
 * failed refresh and the banner is cleared when a load starts, so neither the
 * list nor the banner alone shows that the retry succeeded: a DAPI response
 * must arrive (an exhausted instance issues no requests at all), the load must
 * finish, and no feed failure may be logged while it runs.
 */
async function retrySucceeds(page: Page) {
  const failures: string[] = []
  const onConsole = (message: { text(): string }) => {
    if (message.text().includes(FEED_FAILURE)) failures.push(message.text())
  }
  page.on('console', onConsole)
  try {
    const answered = page.waitForResponse(response => dapi.test(response.url()))
    await failed(page).click()
    await answered
    await expect(refresh(page)).toBeEnabled()
    await expect(failed(page)).toHaveCount(0)
    expect(failures).toEqual([])
    await expect(feed(page)).toBeVisible()
  } finally {
    page.off('console', onConsole)
  }
}

test('feed reads recover after offline requests exhaust the SDK endpoint pool', async ({ page, context }) => {
  await openFeed(page)

  await context.setOffline(true)
  let exhausted = false
  try {
    exhausted = await exhaustAddressPool(page)
  } finally {
    await context.setOffline(false)
  }
  requireExhausted(exhausted, 'Configured SDK pool did not exhaust within ten offline reads')

  // The online event has already started replacing the instance; a read
  // issued now waits for the replacement instead of failing on the old one.
  await retrySucceeds(page)
})

test('feed reads recover from exhausted addresses while the browser stays online', async ({ page, context }) => {
  await openFeed(page)

  // Abort real DAPI requests before delivery. navigator.onLine stays true, so
  // no online event fires and only the failure observer can drive recovery.
  await context.route(dapi, route => route.abort('connectionfailed'))
  let exhausted = false
  try {
    exhausted = await exhaustAddressPool(page)
  } finally {
    await context.unroute(dapi)
  }
  requireExhausted(exhausted, 'Configured SDK pool did not exhaust within ten failed reads')
  expect(await page.evaluate(() => navigator.onLine)).toBe(true)

  // The read that observed the exhaustion failed at once and started the
  // rebuild in the background; the retry waits for the new instance.
  await retrySucceeds(page)
})
