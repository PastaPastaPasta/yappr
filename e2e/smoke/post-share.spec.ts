import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test('copied post link opens the same post in the current deployment', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(appUrl('/feed/'))
  const card = page.locator('[data-testid^="post-card-"]').first()
  const emptyFeed = page.getByText('No posts yet', { exact: true })
  await expect(card.or(emptyFeed)).toBeVisible()
  test.skip(await emptyFeed.isVisible(), 'The deployment has no public post to share.')
  await expect(card).toBeVisible()
  const postId = (await card.getAttribute('data-testid'))!.slice('post-card-'.length)

  // The Share control is the last button in a card's action bar. Confirm its
  // tooltip before using it so a layout change cannot select another action.
  const share = card.getByRole('button').last()
  await share.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Share')
  await share.click()
  await expect(page.getByText('Link copied to clipboard', { exact: true })).toBeVisible()

  const copiedUrl = await page.evaluate(() => navigator.clipboard.readText())
  expect(copiedUrl).toBe(appUrl(`/post/?id=${postId}`))
  const destination = await context.newPage()
  const response = await destination.goto(copiedUrl)
  expect(response?.ok()).toBe(true)
  await expect(destination.getByTestId(`post-card-${postId}`)).toBeVisible()
})
