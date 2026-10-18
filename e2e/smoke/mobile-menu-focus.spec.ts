import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test.use({ viewport: { width: 390, height: 844 } })

test('closed mobile menu is absent from navigation and opens with usable focus', async ({ page }) => {
  await page.goto(appUrl('/explore/'))
  const sheet = page.locator('div.fixed.bottom-14')
  const nav = page.getByRole('navigation').filter({ has: page.locator('a[href$="/messages/"]') })
  const menuButton = nav.getByRole('button').last()
  const closeButton = sheet.locator('button').first()

  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toHaveCount(0)
  await expect(sheet).toHaveAttribute('inert', '')
  await menuButton.focus()
  await page.keyboard.press('Tab')
  await expect(sheet.locator(':focus')).toHaveCount(0)

  await menuButton.focus()
  await menuButton.press('Enter')
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toBeVisible()
  await expect(sheet).not.toHaveAttribute('inert')
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
