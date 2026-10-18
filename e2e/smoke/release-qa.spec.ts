import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { expectFocusContrast } from '../fixtures/focus-contrast'
import { appUrl, scopedKey } from '../fixtures/app'
import { expectedStorefrontTopology } from '../fixtures/contracts'

for (const theme of ['light', 'dark'] as const) {
  test(`Explore AA contrast in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
    await page.goto(appUrl('/explore/'))
    await expect(page.getByPlaceholder('Search posts and blog articles')).toBeVisible()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
}

for (const theme of ['light', 'dark']) {
  test(`a post permalink supports keyboard focus and contrast in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
    await page.goto(appUrl('/feed/'))
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
    else await expect(page.locator('html')).not.toHaveClass(/dark/)
    const post = page.locator('article').first()
    const thread = post.getByRole('link', { name: /^Read thread/ })
    await expect(thread).toBeVisible()
    await thread.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expectFocusContrast(thread)
    const href = await thread.getAttribute('href')
    const expected = new URL(href!, page.url()).toString()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(expected)
  })
}

for (const route of ['/terms/', '/privacy/', '/cookies/', '/about/', '/about/private-feeds/']) {
  test(`${route} stays readable without Platform initialization`, async ({ page }) => {
    const platform: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (/wasm|grpc|quorum|:1443|:2443|:26443/i.test(url)) platform.push(url)
    })
    await page.goto(appUrl(route))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    if (route === '/privacy/') {
      const sealed = await expectedStorefrontTopology() === 'v10'
      await expect(page.getByText(sealed
        ? /Tracking numbers, carrier details and seller notes are encrypted for you and the seller/
        : /Tracking numbers, carrier details and seller notes are public/)).toBeVisible()
    }
    await page.waitForTimeout(1500)
    expect(platform).toEqual([])
  })
}

test('store cart and product filters have accessible names after cache restoration', async ({ page }) => {
  await page.addInitScript((key) => sessionStorage.setItem(key, JSON.stringify({
    store: { id: 'qa-cached-store', ownerId: '', name: 'Cached shop', description: 'Regression fixture', status: 'active' },
    items: [{ id: 'qa-item', storeId: 'qa-cached-store', ownerId: '', title: 'Fixture item', category: 'Books', basePrice: 100, currency: 'USD', status: 'active', imageUrls: [], createdAt: { __date: 0 } }],
    reviews: [], ratingSummary: null, storePolicies: [], hasMoreItems: false, ownerDisplayName: null, ownerUsername: null, scrollY: 0, activeTab: 'items', searchQuery: '', categoryFilter: 'all', sortField: 'newest', timestamp: Date.now(),
  })), scopedKey('yappr_store_view_qa-cached-store'))
  await page.goto(appUrl('/store/view/?id=qa-cached-store'))
  await expect(page.getByRole('button', { name: 'View cart', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Product category', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Sort products', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).withRules(['button-name', 'select-name']).analyze()).violations).toEqual([])
})
