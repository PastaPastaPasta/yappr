import { test, expect } from './base'

test.describe('Accessibility basics', () => {
  test('homepage has correct page title', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/yappr/i)
  })

  test('html element has lang attribute', async ({ page }) => {
    await page.goto('/')
    const lang = await page.locator('html').getAttribute('lang')
    expect(lang).toBe('en')
  })

  test('about page headings have proper hierarchy', async ({ page }) => {
    await page.goto('/about')
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('About Yappr')
  })

  test('privacy page headings have proper hierarchy', async ({ page }) => {
    await page.goto('/privacy')
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Privacy Policy')
  })

  test('terms page headings have proper hierarchy', async ({ page }) => {
    await page.goto('/terms')
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)
    await expect(h1).toHaveText('Terms of Use')
  })

  test('images have alt text', async ({ page }) => {
    await page.goto('/')
    const images = page.locator('img')
    const count = await images.count()
    for (let i = 0; i < count; i++) {
      const alt = await images.nth(i).getAttribute('alt')
      expect(alt, `Image ${i} is missing alt text`).toBeTruthy()
    }
  })
})

test.describe('Responsive layout', () => {
  test('homepage renders without horizontal overflow', async ({ page }) => {
    await page.goto('/')
    const body = page.locator('body')
    const bodyWidth = await body.evaluate((el) => el.scrollWidth)
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1) // +1 for rounding
  })

  test('about page renders without horizontal overflow', async ({ page }) => {
    await page.goto('/about')
    const body = page.locator('body')
    const bodyWidth = await body.evaluate((el) => el.scrollWidth)
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1)
  })
})
