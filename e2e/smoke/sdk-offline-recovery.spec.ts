import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test('feed reads recover after offline requests exhaust the SDK endpoint pool', async ({ page, context }) => {
  await page.goto(appUrl('/feed/'))
  await expect(page.getByRole('button', { name: 'For You', exact: true })).toBeVisible()
  const top = page.getByRole('button', { name: 'Top', exact: true })
  test.skip(await top.count() === 0, 'Top ranking requires a v4+ deployment')
  await top.click()
  const list = page.getByTestId('feed-top-list')
  const empty = page.getByTestId('feed-top-empty')
  await expect(list.or(empty)).toBeVisible()
  test.skip(await list.count() === 0, 'Requires public ranked posts')
  const refresh = page.getByRole('button', { name: 'Refresh feed', exact: true })

  // The requests use the real SDK. Only browser connectivity changes; no
  // response, application state, or endpoint-pool internals are replaced.
  await context.setOffline(true)
  try {
    let exhausted = false
    for (let attempt = 0; attempt < 10 && !exhausted; attempt++) {
      const failure = page.waitForEvent('console', {
        predicate: message => message.text().includes('topLikedPosts: ranked query failed:'),
      })
      await refresh.click()
      exhausted = (await failure).text().toLowerCase().includes('no available addresses')
      await expect(empty).toBeVisible()
    }
    test.skip(!exhausted, 'Configured SDK pool did not exhaust within ten offline reads')
  } finally {
    await context.setOffline(false)
  }

  // Recover in the same page and session, using the ordinary Refresh button.
  await refresh.click()
  await expect(list).toBeVisible()
  await expect(list.locator('article').first()).toBeVisible()
})

test('feed reads recover from exhausted addresses while the browser stays online', async ({ page, context }) => {
  await page.goto(appUrl('/feed/'))
  await expect(page.getByRole('button', { name: 'For You', exact: true })).toBeVisible()
  const top = page.getByRole('button', { name: 'Top', exact: true })
  test.skip(await top.count() === 0, 'Top ranking requires a v4+ deployment')
  await top.click()
  const list = page.getByTestId('feed-top-list')
  const empty = page.getByTestId('feed-top-empty')
  await expect(list.or(empty)).toBeVisible()
  test.skip(await list.count() === 0, 'Requires public ranked posts')
  const refresh = page.getByRole('button', { name: 'Refresh feed', exact: true })

  // Abort real DAPI requests before delivery. Do not alter navigator.onLine,
  // response bodies, application state or the SDK's endpoint pool.
  const dapi = /\/org\.dash\.platform\.dapi\.v0\.Platform\//
  await context.route(dapi, route => route.abort('connectionfailed'))
  try {
    const failure = page.waitForEvent('console', {
      predicate: message => message.text().includes('topLikedPosts: ranked query failed:'),
    })
    await refresh.click()
    expect((await failure).text().toLowerCase()).toContain('no available addresses')
    await expect(empty).toBeVisible()
  } finally {
    await context.unroute(dapi)
  }

  expect(await page.evaluate(() => navigator.onLine)).toBe(true)
  await refresh.click()
  await expect(list).toBeVisible()
  await expect(list.locator('article').first()).toBeVisible()
})
