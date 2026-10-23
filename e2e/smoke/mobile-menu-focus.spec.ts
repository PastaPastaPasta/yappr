import { expect, test, type Page } from '@playwright/test'
import { appUrl, appUrlPattern } from '../fixtures/app'

test.use({ viewport: { width: 390, height: 844 } })

/** Whether the page's main column is hidden from assistive technology (the modal menu hides everything else). */
const mainHidden = (page: Page) => page.locator('main').evaluate((node) => !!node.closest('[aria-hidden="true"]'))

test('closed mobile menu is absent from navigation and opens with usable focus', async ({ page }) => {
  await page.goto(appUrl('/explore/'))
  const sheet = page.getByRole('dialog', { name: 'Menu', exact: true })
  const menuButton = page.getByRole('button', { name: 'Menu', exact: true })
  const closeButton = sheet.getByRole('button', { name: 'Close menu' })

  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toHaveCount(0)
  await expect(sheet).toHaveCount(0)
  await expect(menuButton).toHaveAttribute('aria-haspopup', 'dialog')
  await menuButton.focus()
  await page.keyboard.press('Tab')
  await expect(sheet.locator(':focus')).toHaveCount(0)

  await menuButton.focus()
  await menuButton.press('Enter')
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toBeVisible()
  await expect(sheet).toHaveAttribute('aria-modal', 'true')
  await expect(closeButton).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(sheet.getByRole('link', { name: /^Store( Beta)?$/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toHaveCount(0)
  await expect(menuButton).toBeFocused()

  await menuButton.press('Enter')
  await expect(closeButton).toBeFocused()
  await closeButton.press('Enter')
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toHaveCount(0)
  await expect(menuButton).toBeFocused()
})

test('open mobile menu keeps keyboard focus inside and locks the page behind it', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  const trigger = page.getByRole('button', { name: 'Menu', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Menu', exact: true })
  await expect(dialog.getByRole('button', { name: 'Close menu' })).toBeFocused()
  await expect.poll(() => mainHidden(page)).toBe(true)
  await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', '1')

  for (const key of ['Shift+Tab', ...Array<string>(15).fill('Tab'), ...Array<string>(15).fill('Shift+Tab')]) {
    await page.keyboard.press(key)
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  }

  // A tap on the dimmed page closes the menu and hands the page back.
  await page.mouse.click(10, 100)
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
  await expect.poll(() => mainHidden(page)).toBe(false)
})

test('a menu link leaves the page with the menu closed and unlocked', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Menu', exact: true })
  await dialog.getByRole('link', { name: /^Store( Beta)?$/ }).click()
  await expect(page).toHaveURL(appUrlPattern('/store'))
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
  await expect.poll(() => mainHidden(page)).toBe(false)
  // Focus is not pulled back to Menu, which would float its tooltip over the new page.
  await expect(page.getByRole('tooltip', { name: 'Menu', exact: true })).toHaveCount(0)
})

test('changing to desktop closes the mobile menu and releases the page', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1024, height: 844 })
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
  await expect.poll(() => mainHidden(page)).toBe(false)
})

test('sign-in takes focus after the menu closes and returns to Menu', async ({ page }) => {
  await page.goto(appUrl('/feed/'))
  const trigger = page.getByRole('button', { name: 'Menu', exact: true })
  await trigger.click()
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true })
  await menu.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(menu).toHaveCount(0)
  const login = page.getByRole('dialog', { name: 'Sign in to Yappr' })
  await expect(login).toBeVisible()
  await expect.poll(() => login.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(login).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
