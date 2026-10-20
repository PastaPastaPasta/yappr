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
