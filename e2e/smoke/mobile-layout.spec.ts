import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test.use({ viewport: { width: 390, height: 844 } })

test('mobile menu traps keyboard focus, locks the feed, and restores its trigger', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  const trigger = page.getByRole('button', { name: 'Menu', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Menu', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog.getByRole('button', { name: 'Close menu' })).toBeFocused()
  await expect.poll(() => page.locator('main').evaluate((node) => !!node.closest('[inert]'))).toBe(true)
  await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', '1')

  const scrollY = await page.evaluate(() => window.scrollY)
  for (const key of ['Shift+Tab', ...Array<string>(15).fill('Tab')]) {
    await page.keyboard.press(key)
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  }
  await page.mouse.move(10, 100)
  await page.mouse.wheel(0, 500)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
  await expect.poll(() => page.locator('main').evaluate((node) => !!node.closest('[inert]'))).toBe(false)

  await trigger.click()
  await dialog.getByRole('button', { name: 'Close menu' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await page.mouse.click(10, 100)
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('changing to desktop closes the mobile menu and releases the page', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1024, height: 844 })
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
  await expect.poll(() => page.locator('main').evaluate((node) => !!node.closest('[inert]'))).toBe(false)
})

test('sign-in takes focus after the menu closes and returns to Menu', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  const trigger = page.getByRole('button', { name: 'Menu', exact: true })
  await trigger.click()
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true })
  await menu.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(menu).toHaveCount(0)
  const login = page.getByRole('dialog')
  await expect(login).toBeVisible()
  await expect.poll(() => login.evaluate((node) => !node.closest('[inert]') && node.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(login).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('only the landing page reserves space for its asynchronous election notice', async ({ page }) => {
  await page.goto(appUrl('/'))
  const slot = page.locator('[data-reserve-election-slot]')
  await expect(slot).toHaveCSS('height', '137px')
  await expect(page.getByRole('heading', { name: 'Welcome to Yappr' })).toBeVisible()
  await page.goto(appUrl('/feed/'))
  await expect(page.locator('[data-reserve-election-slot]')).toHaveCount(0)
})
