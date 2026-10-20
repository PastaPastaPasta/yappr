import { expect, test, type Page } from '@playwright/test'

// bg-white and dark:bg-gray-900 as Tailwind renders them.
const LIGHT = 'rgb(255, 255, 255)'
const DARK = 'rgb(17, 24, 39)'

const background = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((element) => getComputedStyle(element).backgroundColor)
const appTheme = (page: Page) => page.evaluate(() => ({
  stored: localStorage.getItem('theme'),
  htmlDark: document.documentElement.classList.contains('dark'),
}))

async function openWithAppTheme(page: Page, appThemeSetting: 'light' | 'dark', post: 'light' | 'dark') {
  await page.addInitScript((value) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('theme', value); sessionStorage.setItem('seeded', '1') } }, appThemeSetting)
  await page.goto(`/blog-theme.html?post=${post}`)
}

test('a dark post in a light app stays on the post, and leaving it keeps the light app', async ({ page }) => {
  await openWithAppTheme(page, 'light', 'dark')
  await page.getByRole('button', { name: 'Open post' }).click()
  await expect.poll(() => background(page, 'post-surface')).toBe(DARK)
  expect(await background(page, 'app-surface')).toBe(LIGHT)
  expect(await appTheme(page)).toEqual({ stored: 'light', htmlDark: false })

  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('post-surface')).toHaveCount(0)
  expect(await appTheme(page)).toEqual({ stored: 'light', htmlDark: false })
  // A reload or a closed tab never runs cleanup; nothing was written, so nothing is left behind.
  await page.reload()
  expect(await appTheme(page)).toEqual({ stored: 'light', htmlDark: false })
  expect(await background(page, 'app-surface')).toBe(LIGHT)
})

test('a light post in a dark app reads light, and the app stays dark', async ({ page }) => {
  await openWithAppTheme(page, 'dark', 'light')
  await expect.poll(() => background(page, 'app-surface')).toBe(DARK)
  await page.getByRole('button', { name: 'Open post' }).click()
  await expect.poll(() => background(page, 'post-surface')).toBe(LIGHT)
  // The light colour variables come back inside the post too.
  const insideVar = await page.getByTestId('post-surface').evaluate((element) => getComputedStyle(element).getPropertyValue('--background').trim())
  expect(insideVar).toBe('0 0% 100%')
  expect(await appTheme(page)).toEqual({ stored: 'dark', htmlDark: true })

  await page.getByRole('button', { name: 'Back' }).click()
  await page.reload()
  expect(await appTheme(page)).toEqual({ stored: 'dark', htmlDark: true })
})
