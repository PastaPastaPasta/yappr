import { test, expect } from './base'

test.describe('Navigation - Desktop', () => {
  test('sidebar shows unauthenticated navigation links', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/')
    const sidebar = page.locator('.hidden.md\\:flex')
    await expect(sidebar).toBeVisible()

    await expect(sidebar.getByRole('link', { name: 'Home' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Explore' })).toBeVisible()
    await expect(sidebar.getByRole('link', { name: 'Store' })).toBeVisible()
  })

  test('sidebar has Yappr logo', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/')
    await expect(page.getByText('Yappr').first()).toBeVisible()
  })

  test('sidebar shows Sign In button when not authenticated', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/')
    const sidebar = page.locator('.hidden.md\\:flex')
    await expect(sidebar.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('clicking Explore navigates to explore page', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/')
    const sidebar = page.locator('.hidden.md\\:flex')
    await sidebar.getByRole('link', { name: 'Explore' }).click()
    await expect(page).toHaveURL(/\/explore/)
  })
})

test.describe('Navigation - Mobile', () => {
  test('bottom navigation bar is visible on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const bottomNav = page.locator('nav.fixed.bottom-0')
    await expect(bottomNav).toBeVisible()
  })

  test('sidebar is hidden on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const sidebar = page.locator('.hidden.md\\:flex').first()
    await expect(sidebar).not.toBeVisible()
  })
})

test.describe('Development banner', () => {
  test('shows TESTNET banner', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/')
    await expect(page.locator('text=TESTNET').first()).toBeVisible()
  })
})

test.describe('Cross-page navigation', () => {
  test('about page back link navigates to homepage', async ({ page }) => {
    await page.goto('/about')
    await page.getByRole('link', { name: /back to yappr/i }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('privacy page back link navigates to homepage', async ({ page }) => {
    await page.goto('/privacy')
    await page.getByRole('link', { name: /back to yappr/i }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('terms page back link navigates to homepage', async ({ page }) => {
    await page.goto('/terms')
    await page.getByRole('link', { name: /back to yappr/i }).click()
    await expect(page).toHaveURL(/\/$/)
  })
})
