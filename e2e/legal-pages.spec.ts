import { test, expect } from './base'

test.describe('Privacy page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/privacy')
  })

  test('renders the page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible()
  })

  test('shows the testnet notice', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Testnet Notice' })).toBeVisible()
  })

  test('has key content sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Public by Design' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /what's public/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /what's encrypted/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No Tracking or Analytics' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Data Cannot Be Deleted' })).toBeVisible()
  })

  test('has a back link to homepage', async ({ page }) => {
    const backLink = page.getByRole('link', { name: /back to yappr/i })
    await expect(backLink).toBeVisible()
    await expect(backLink).toHaveAttribute('href', '/')
  })
})

test.describe('Terms page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/terms')
  })

  test('renders the page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Terms of Use' })).toBeVisible()
  })

  test('shows the testnet notice', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Testnet Notice' })).toBeVisible()
  })

  test('has key content sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'No Central Authority' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'You Are Responsible' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Data Is Permanent' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No Content Moderation' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Transaction Costs' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No Warranty' })).toBeVisible()
  })

  test('has a back link to homepage', async ({ page }) => {
    const backLink = page.getByRole('link', { name: /back to yappr/i })
    await expect(backLink).toBeVisible()
    await expect(backLink).toHaveAttribute('href', '/')
  })
})

test.describe('Cookies page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/cookies')
  })

  test('renders the page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Cookies & Storage' })).toBeVisible()
  })

  test('has key content sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'No Tracking Cookies' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What We Store Locally' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Why This Design?' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Clearing Your Data' })).toBeVisible()
  })

  test('explains session and local storage', async ({ page }) => {
    await expect(page.getByText('Session Storage').first()).toBeVisible()
    await expect(page.getByText('Local Storage').first()).toBeVisible()
  })

  test('has a back link to homepage', async ({ page }) => {
    const backLink = page.getByRole('link', { name: /back to yappr/i })
    await expect(backLink).toBeVisible()
    await expect(backLink).toHaveAttribute('href', '/')
  })
})
