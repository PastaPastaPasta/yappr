import { expect, test } from '@playwright/test'
import { appUrl, appUrlPattern } from '../fixtures/app'

test('the legal pages render with the community rules anchor', async ({ page }) => {
  await page.goto(appUrl('/terms/'))
  await expect(page.getByRole('heading', { name: 'Terms of Use' })).toBeVisible()
  await expect(page.locator('#community-rules')).toBeVisible()

  await page.goto(appUrl('/privacy/'))
  await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible()
  await expect(page.getByText('Cloudflare Web Analytics', { exact: true })).toBeVisible()

  await page.goto(appUrl('/cookies/'))
  await expect(page.getByRole('heading', { name: 'Cookies & Storage' })).toBeVisible()
})

test('the sign-in dialog links the terms, rules and privacy policy', async ({ page }) => {
  await page.goto(appUrl('/login/'))
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await expect(dialog.getByText(/By continuing, you agree to the/)).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Terms', exact: true })).toHaveAttribute('target', '_blank')
  await expect(dialog.getByRole('link', { name: 'Community Rules', exact: true })).toHaveAttribute('href', /\/terms\/?#community-rules$/)
  await expect(dialog.getByRole('link', { name: 'Privacy Policy', exact: true })).toBeVisible()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the menu reaches the legal pages', async ({ page }) => {
    await page.goto(appUrl('/explore/'))
    await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Menu', exact: true }).click()
    const legal = page.getByRole('navigation', { name: 'Legal' })
    await expect(legal.getByRole('link', { name: 'Contact', exact: true })).toHaveAttribute('href', /^mailto:/)
    await legal.getByRole('link', { name: 'Privacy', exact: true }).click()
    await expect(page).toHaveURL(appUrlPattern('/privacy'))
    await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible()
  })
})
