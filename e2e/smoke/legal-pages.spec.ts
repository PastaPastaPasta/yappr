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

test('legal and support copy explains the independent moderation model', async ({ page }) => {
  for (const route of ['/terms/', '/privacy/', '/cookies/', '/about/']) {
    await page.goto(appUrl(route))
    const body = page.locator('body')
    await expect(body).not.toContainText('support@yap' + '.pr')
    await expect(body).not.toContainText(/we (review|will explain|can also stop showing|pass requests)/i)
    if (route !== '/cookies/') {
      await expect(body).toContainText('masternode votes')
      await expect(body).toContainText('independent of Yappr')
      await expect(page.getByRole('link', { name: 'support@dash.org', exact: true }).first()).toHaveAttribute('href', 'mailto:support@dash.org')
    }
  }

  await page.goto(appUrl('/terms/'))
  const body = page.locator('body')
  await expect(body).toContainText('Yappr has no centralized moderation')
  await expect(body).toContainText('Its authors cannot change, remove or recover your data on Dash Platform')
  await expect(body).toContainText('at least 18 years old')
  await expect(body).toContainText('without any warranty')
  await expect(body).toContainText('authors and contributors are not liable')
  await expect(body).toContainText('Yappr is not a party to any sale')
  await expect(body).toContainText('You pay the seller directly')
  await expect(body).not.toContainText('The Yappr app may not display some media')
})

test('the sign-in dialog links the terms and rules', async ({ page }) => {
  await page.goto(appUrl('/login/'))
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await expect(dialog.getByText(/By continuing you agree to the/)).toBeVisible()
  // Sign-in carries no age or moderation copy; the Terms say both.
  await expect(dialog).not.toContainText('centralized moderation')
  await expect(dialog).not.toContainText('18 or older')
  await expect(dialog.getByRole('link', { name: /^Terms/ })).toHaveAttribute('target', '_blank')
  await expect(dialog.getByRole('link', { name: /^Community Rules/ })).toHaveAttribute('href', /\/terms\/?#community-rules$/)
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
