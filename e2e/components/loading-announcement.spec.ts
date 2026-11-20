import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('the status region is mounted before loading starts and announces it, while the skeleton stays decorative', async ({ page }) => {
  await page.goto('/loading-announcement.html')
  const status = page.getByRole('status')
  await expect(status).toHaveCount(1)
  await expect(status).toHaveText('')
  await expect(status).not.toHaveAttribute('aria-busy', /.*/)

  await page.getByRole('button', { name: 'Load' }).click()
  await expect(status).toHaveText('Loading trending tags')
  await expect(page.getByTestId('skeleton')).toHaveAttribute('aria-hidden', 'true')
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])

  await page.getByRole('button', { name: 'Finish' }).click()
  await expect(status).toHaveText('')
  await expect(page.getByText('Loaded')).toBeVisible()
})

test('a view that opens already loading mounts its status region empty, then announces', async ({ page }) => {
  // Records each status text as the region first appears and as it changes after.
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { statusTexts: string[] }).statusTexts = seen
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            for (const region of node.querySelectorAll('[role="status"]')) seen.push(`mounted:${region.textContent ?? ''}`)
          }
        }
        if (mutation.type === 'characterData' || (mutation.target instanceof HTMLElement && mutation.target.getAttribute('role') === 'status')) {
          const region = mutation.target instanceof HTMLElement ? mutation.target : mutation.target.parentElement
          if (region?.getAttribute('role') === 'status') seen.push(`changed:${region.textContent ?? ''}`)
        }
      }
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
  await page.goto('/loading-announcement.html?opens-loading')
  const region = page.getByRole('region', { name: 'Opens loading' }).getByRole('status')
  await expect(region).toHaveText('Loading creators')
  const seen = await page.evaluate(() => (window as unknown as { statusTexts: string[] }).statusTexts)
  expect(seen).toContain('mounted:')
  expect(seen).not.toContain('mounted:Loading creators')
  expect(seen).toContain('changed:Loading creators')
  await page.getByRole('button', { name: 'Settle' }).click()
  await expect(region).toHaveText('')
})

test('revealing a tab that is still loading changes the status outside its hidden panel', async ({ page }) => {
  await page.goto('/loading-announcement.html?kept-tabs')
  const region = page.getByRole('region', { name: 'Kept tabs' })
  const status = region.getByRole('status')
  await expect(region.getByText('Blogs')).toBeVisible()
  await expect(status).toHaveText('')
  await region.getByRole('button', { name: 'Trending' }).click()
  await expect(status).toHaveText('Loading trending tags')
})
