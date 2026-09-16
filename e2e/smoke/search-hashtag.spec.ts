import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

for (const action of ['click', 'keyboard'] as const) {
  test(`hashtag suggestions open the deployed hashtag page by ${action}`, async ({ page }) => {
    await page.goto(appUrl('/'))
    // Home's welcome heading appears after hydration; follow the normal
    // navigation so the search input is interactive before typing.
    await expect(page.getByRole('heading', { name: /Welcome to Yappr/ })).toBeVisible()
    await page.getByRole('link', { name: 'Explore', exact: true }).click()
    const input = page.getByPlaceholder('Search users & hashtags')
    await input.fill('#masternodes')
    const suggestion = page.getByRole('button', { name: /masternodes.*View hashtag/ })
    await expect(suggestion).toBeVisible()

    if (action === 'click') await suggestion.click()
    else await input.press('Enter')

    await expect(page).toHaveURL((url) =>
      url.pathname.replace(/\/$/, '') === new URL(appUrl('/hashtag')).pathname &&
      url.searchParams.get('tag') === 'masternodes'
    )
    await expect(page.getByRole('heading', { name: 'masternodes', exact: true })).toBeVisible()
  })
}
