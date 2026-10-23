import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

test.use({ viewport: { width: 390, height: 844 } })

test('the mobile landing page holds its layout while its reads land', async ({ page }) => {
  await page.goto(appUrl('/'))
  const heading = page.getByRole('heading', { name: /^Welcome to/ })
  await expect(heading).toBeVisible()
  const firstTop = (await heading.boundingBox())?.y

  // Top creators settles to its chips or its empty line, in the same footprint.
  const creators = page.getByRole('region', { name: 'Top creators' })
  await expect(creators.locator('[aria-hidden="true"] .animate-pulse')).toHaveCount(0, { timeout: 60_000 })

  // The election banner slot stops holding room once the answer is known,
  // and never leaves an empty band: it is as tall as the banner it holds.
  const slot = page.locator('[data-reserve-election-slot]')
  await expect(slot).toHaveAttribute('data-reserve-election-slot', 'released', { timeout: 60_000 })
  const banner = page.getByTestId('election-banner')
  const slotHeight = (await slot.boundingBox())?.height ?? 0
  const bannerHeight = (await banner.count()) > 0 ? (await banner.boundingBox())?.height ?? 0 : 0
  expect(slotHeight).toBe(bannerHeight)

  // With no banner due (this build elects no moderators), nothing above the hero moved.
  if (bannerHeight === 0) expect((await heading.boundingBox())?.y).toBe(firstTop)

  await page.goto(appUrl('/feed/'))
  await expect(page.locator('[data-reserve-election-slot]')).toHaveCount(0)
})
