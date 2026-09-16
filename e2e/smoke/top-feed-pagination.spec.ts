import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test('Top Load More preserves the loaded cards and reading position', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  const top = page.getByRole('button', { name: 'Top', exact: true })
  await expect(page.getByRole('button', { name: 'For You', exact: true })).toBeVisible()
  test.skip(await top.count() === 0, 'Top ranking requires a v4+ deployment')
  await top.click()

  const list = page.getByTestId('feed-top-list')
  await expect(list.or(page.getByTestId('feed-top-empty'))).toBeVisible()
  const more = page.getByRole('button', { name: 'Load More', exact: true })
  test.skip(await more.count() === 0, 'Requires at least one full page of public ranked posts')

  // PostCard is a direct article today; use the top-level cards independently
  // of error-boundary wrappers, which do not add DOM elements.
  const ids = () => list.locator('article[data-testid^="post-card-"]').evaluateAll(elements =>
    elements.filter(element => !element.parentElement?.closest('article'))
      .map(element => element.getAttribute('data-testid'))
  )
  const beforeIds = await ids()
  expect(beforeIds.length).toBeGreaterThan(0)
  await more.scrollIntoViewIfNeeded()
  const beforeY = await page.evaluate(() => window.scrollY)
  expect(beforeY).toBeGreaterThan(0)
  await more.click()

  await expect(page.getByText('Loading top posts...', { exact: true })).toHaveCount(0)
  await expect.poll(async () => {
    const button = page.getByRole('button', { name: 'Loading...', exact: true })
    return await button.count()
  }).toBe(0)
  await expect.poll(async () => (await ids()).length).toBeGreaterThan(beforeIds.length)
  expect((await ids()).slice(0, beforeIds.length)).toEqual(beforeIds)
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeY - 100)

  // Changing the ranking window starts a fresh first page, not the expanded
  // limit from the previous view.
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(list.or(page.getByTestId('feed-top-empty'))).toBeVisible()
  expect((await ids()).length).toBeLessThanOrEqual(20)
})

test('Top Load More retains the page and retry control on connection failures', async ({ page, context }) => {
  await page.goto(appUrl('/feed/'))
  const top = page.getByRole('button', { name: 'Top', exact: true })
  await expect(page.getByRole('button', { name: 'For You', exact: true })).toBeVisible()
  test.skip(await top.count() === 0, 'Top ranking requires a v4+ deployment')
  await top.click()
  const list = page.getByTestId('feed-top-list')
  await expect(list.or(page.getByTestId('feed-top-empty'))).toBeVisible()
  const more = page.getByRole('button', { name: 'Load More', exact: true })
  test.skip(await more.count() === 0, 'Requires at least one full page of public ranked posts')

  const ids = () => list.locator('article[data-testid^="post-card-"]').evaluateAll(elements =>
    elements.filter(element => !element.parentElement?.closest('article'))
      .map(element => element.getAttribute('data-testid'))
  )
  const beforeIds = await ids()
  await more.scrollIntoViewIfNeeded()
  const beforeY = await page.evaluate(() => window.scrollY)

  // Exercise real transport failure, without replacing SDK or server results.
  await context.setOffline(true)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const failedExpansion = page.waitForEvent('console', {
        predicate: message => message.text().includes('Feed: Failed to load top posts:'),
      })
      await more.click()
      await failedExpansion
      await expect(page.getByRole('button', { name: 'Loading...', exact: true })).toHaveCount(0)
      await expect(more).toBeVisible()
      expect(await ids()).toEqual(beforeIds)
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeY - 100)
    }
  } finally {
    await context.setOffline(false)
  }
})
