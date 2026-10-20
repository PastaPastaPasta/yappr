import { test, expect } from '@playwright/test'

test('an owner can retract a retained post after deleting its blog', async ({ page }) => {
  await page.goto('/?fixture=blog-management')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('posts will stop showing')
  await dialog.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Posts from deleted blogs' })).toBeVisible()
  await expect(page.getByText('Retained article', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Delete post', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete post', exact: true }).click()
  await expect(page.getByText('Retained article', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.blogManagementSnapshot())).toEqual({ blogDeleted: true, postDeleted: true })
})


test('retraction refreshes a paging cursor that has left the live index', async ({ page }) => {
  await page.goto('/?fixture=blog-management&scenario=paged')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Load more posts' })).toBeVisible()
  await page.getByRole('button', { name: 'Delete post', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete post', exact: true }).click()
  await expect(page.getByText('Next article', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('retraction waits for an in-flight page before changing the live index', async ({ page }) => {
  await page.goto('/?fixture=blog-management&scenario=slow-paged')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('button', { name: 'Load more posts' }).click()
  await expect(page.getByRole('button', { name: 'Delete post', exact: true })).toBeDisabled()
  await page.evaluate(() => window.releaseManagementPage())
  await expect(page.getByText('Next article', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete post', exact: true }).first()).toBeEnabled()
})

test('the section stays hidden when no post is left to manage', async ({ page }) => {
  await page.goto('/?fixture=blog-management')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('button', { name: 'Delete post', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete post', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Posts from deleted blogs' })).toHaveCount(0)
})

test('a first page of live-blog posts reads on to the retained post', async ({ page }) => {
  await page.goto('/?fixture=blog-management&scenario=live-first')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete blog', exact: true }).click()
  await expect(page.getByText('Retained article', { exact: true })).toBeVisible()
  await expect(page.getByText('Live article', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Load more posts' })).toHaveCount(0)
})

test('no empty section when every post is in a live blog', async ({ page }) => {
  await page.goto('/?fixture=blog-management&scenario=all-live')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete blog', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.blogManagementSnapshot().blogDeleted)).toBe(true)
  await page.waitForTimeout(300)
  await expect(page.getByRole('heading', { name: 'Posts from deleted blogs' })).toHaveCount(0)
})

test('deleting the last shown post keeps the section until the reload settles', async ({ page }) => {
  await page.goto('/?fixture=blog-management&scenario=slow-refresh')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('button', { name: 'Delete post', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete post', exact: true }).click()
  // The reload is held: the deleted post is gone but the section stays.
  await expect(page.getByText('Loading posts...')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Posts from deleted blogs' })).toBeVisible()
  await expect(page.getByText('Retained article', { exact: true })).toHaveCount(0)
  await page.evaluate(() => window.releaseManagementPage())
  await expect(page.getByText('Next article', { exact: true })).toBeVisible()
})

test('a read that runs out of pages before a retained post still offers Load more', async ({ page }) => {
  await page.goto('/?fixture=blog-management&scenario=capped')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete blog', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Posts from deleted blogs' })).toBeVisible()
  await expect(page.getByText('Retained article', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Load more posts' }).click()
  await expect(page.getByText('Retained article', { exact: true })).toBeVisible()
  await expect(page.getByText(/Live article/)).toHaveCount(0)
})

test('a failed first read shows the error and Try again', async ({ page }) => {
  await page.goto('/?fixture=blog-management&scenario=first-read-fails')
  await page.getByRole('button', { name: 'Delete blog', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete blog', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Could not load your posts.')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Retained article', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
