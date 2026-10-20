import { expect, test } from '@playwright/test'

test('arrow keys, Home and End move focus and selection with roving tabindex', async ({ page }) => {
  await page.goto('/scroll-tabs.html')
  const tabs = page.getByRole('tablist', { name: 'Filter' }).getByRole('tab')
  await expect(tabs).toHaveCount(5)
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0')
  await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1')

  await tabs.nth(0).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.nth(1)).toBeFocused()
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(1)).toHaveAttribute('tabindex', '0')
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '-1')
  await expect(page.getByRole('tabpanel')).toHaveText('Showing reposts')

  await page.keyboard.press('End')
  await expect(tabs.nth(4)).toBeFocused()
  await expect(tabs.nth(4)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(tabs.nth(0)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(tabs.nth(4)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(tabs.nth(0)).toBeFocused()
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
})

test('only the selected tab is in the tab order, and the panel is labelled by it', async ({ page }) => {
  await page.goto('/scroll-tabs.html')
  const tabs = page.getByRole('tablist', { name: 'Filter' }).getByRole('tab')
  await tabs.nth(0).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: 'New' })).toBeFocused()
  await expect(tabs.nth(1)).toHaveAttribute('aria-controls', 'demo-panel')
  await expect(page.getByRole('tabpanel', { name: 'Reposts' })).toBeVisible()
})

test('the focused tab scrolls into view in a narrow bar', async ({ page }) => {
  await page.goto('/scroll-tabs.html')
  const bar = page.getByRole('tablist', { name: 'Filter' })
  const tabs = bar.getByRole('tab')
  await tabs.nth(0).focus()
  await page.keyboard.press('End')
  await expect(tabs.nth(4)).toBeFocused()
  await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await expect.poll(async () => {
    const tab = await tabs.nth(4).boundingBox()
    const box = await bar.boundingBox()
    return !!tab && !!box && tab.x >= box.x - 1 && tab.x + tab.width <= box.x + box.width + 1
  }).toBe(true)
})

test('pill tabs share the keyboard model', async ({ page }) => {
  await page.goto('/scroll-tabs.html')
  const pills = page.getByRole('tablist', { name: 'Sort' }).getByRole('tab')
  await pills.nth(0).focus()
  await page.keyboard.press('ArrowRight')
  await expect(pills.nth(1)).toBeFocused()
  await expect(page.getByTestId('sort')).toHaveText('top')
  await page.keyboard.press('End')
  await expect(page.getByTestId('sort')).toHaveText('rising')
  await expect(pills.nth(2)).toHaveAttribute('tabindex', '0')
})
