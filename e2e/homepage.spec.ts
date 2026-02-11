import { test, expect } from './base'

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('renders the hero section with branding', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /welcome to yappr/i })).toBeVisible()
    await expect(page.getByText('The decentralized social platform where you own your data')).toBeVisible()
  })

  test('has Get Started and Explore Public Posts buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: /get started/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /explore public posts/i })).toBeVisible()
  })

  test('has CTA section at the bottom', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /ready to join the conversation/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /create account/i })).toBeVisible()
  })

  test('Explore Public Posts link points to /feed', async ({ page }) => {
    const link = page.getByRole('link', { name: /explore public posts/i })
    await expect(link).toHaveAttribute('href', /\/feed/)
  })

  test('shows Powered by Dash Evolution image', async ({ page }) => {
    await expect(page.getByAltText('Powered by Dash Evolution').first()).toBeVisible()
  })
})
