import { test, expect } from './base'

test.describe('About page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/about')
  })

  test('renders the page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'About Yappr' })).toBeVisible()
  })

  test('has key content sections', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'What is Yappr?' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Key Features' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No Central Server' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Open Source' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Community Driven' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Technical Details' })).toBeVisible()
  })

  test('has a back link to homepage', async ({ page }) => {
    const backLink = page.getByRole('link', { name: /back to yappr/i })
    await expect(backLink).toBeVisible()
    await expect(backLink).toHaveAttribute('href', '/')
  })

  test('has GitHub link', async ({ page }) => {
    const githubLink = page.getByRole('link', { name: /view on github/i })
    await expect(githubLink).toBeVisible()
    await expect(githubLink).toHaveAttribute('href', /github\.com/)
  })

  test('shows feature cards', async ({ page }) => {
    await expect(page.getByText('Share your thoughts in up to 500 characters')).toBeVisible()
    await expect(page.getByText('Customize your name, bio, avatar, and banner')).toBeVisible()
    await expect(page.getByText('Private conversations, encrypted end-to-end')).toBeVisible()
  })

  test('shows technical details section with contract info', async ({ page }) => {
    await expect(page.getByText('Contract ID')).toBeVisible()
    await expect(page.getByText('Document Types')).toBeVisible()
    await expect(page.getByText('22 types across 2 contracts')).toBeVisible()
  })
})
