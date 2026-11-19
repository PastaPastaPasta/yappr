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
