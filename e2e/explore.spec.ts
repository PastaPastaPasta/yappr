import { test, expect } from './base'

test.describe('Explore page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/explore')
  })

  test('renders the search input', async ({ page }) => {
    await expect(page.getByPlaceholder('Search posts')).toBeVisible()
  })

  test('shows trending hashtags section', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Trending Hashtags' })).toBeVisible()
    await expect(page.getByText('Based on recent post activity')).toBeVisible()
  })

  test('search input is focusable', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search posts')
    await searchInput.click()
    await expect(searchInput).toBeFocused()
  })
})
