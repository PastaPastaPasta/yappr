import { expect, test } from '@playwright/test'
import { appUrl, appUrlPattern } from '../fixtures/app'

test.use({ viewport: { width: 390, height: 844 } })

test('mobile navigation identifies its controls and opens its menu', async ({ page }) => {
  await page.goto(appUrl('/about/'))
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' })
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Explore', exact: true })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Messages', exact: true })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Sign in to post', exact: true })).toBeVisible()

  const menu = nav.getByRole('button', { name: 'Menu', exact: true })
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await menu.focus()
  await expect(page.getByRole('tooltip', { name: 'Menu', exact: true })).toBeVisible()
  await menu.press('Enter')
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toBeInViewport()
  await page.getByRole('button', { name: 'Close menu', exact: true }).click()
  await expect(menu).toHaveAttribute('aria-expanded', 'false')

  await nav.getByRole('link', { name: 'Explore', exact: true }).click()
  await expect(page).toHaveURL(appUrlPattern('/explore'))
  await nav.getByRole('button', { name: 'Sign in to post', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sign in to Yappr' })).toBeVisible()
})
