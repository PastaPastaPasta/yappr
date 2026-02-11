import { test, expect } from './base'

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
  })

  test('renders the Yappr branding', async ({ page }) => {
    await expect(page.locator('h1.text-6xl')).toHaveText('Yappr')
  })

  test('shows the tagline', async ({ page }) => {
    await expect(page.getByText('Decentralized social media on Dash Platform')).toBeVisible()
  })

  test('shows key value propositions', async ({ page }) => {
    await expect(page.getByText('Own your data')).toBeVisible()
    await expect(page.getByText('No algorithms')).toBeVisible()
    await expect(page.getByText('Censorship resistant')).toBeVisible()
  })
})
