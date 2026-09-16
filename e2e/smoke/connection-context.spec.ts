import { expect, test } from '@playwright/test'
import { appUrl, appUrlPattern } from '../fixtures/app'

for (const kind of ['followers', 'following'] as const) {
  for (const query of ['', '?id=']) {
    test(`${kind} offers guest recovery without a target (${query || 'no query'})`, async ({ page }) => {
      await page.goto(appUrl(`/${kind}/${query}`))

      const content = page.getByRole('main')
      await expect(content.getByRole('heading', { name: `Sign in to view your ${kind}` })).toBeVisible()
      await expect(content.getByRole('heading', { name: /^@User's/ })).toHaveCount(0)
      await expect(content.getByText(/^0 (followers|users)$/)).toHaveCount(0)

      if (kind === 'followers') {
        await content.getByRole('button', { name: 'Sign In', exact: true }).click()
        await expect(page.getByRole('dialog', { name: /Sign in to Yappr/ })).toBeVisible()
      } else {
        await content.getByRole('button', { name: 'Explore Yappr' }).click()
        await expect(page).toHaveURL(appUrlPattern('/explore'))
        await expect(page.getByPlaceholder('Search posts and blog articles')).toBeVisible()
      }
    })
  }

  test(`${kind} remains public with an explicit target`, async ({ page }) => {
    // A valid identity identifier; its list may be empty on the test network.
    const identityId = 'AUcoNeieq1VNiyAkQrrn4XE8rpaRT3gSUCQsy7E2SN7x'
    await page.goto(appUrl(`/${kind}/?id=${identityId}`))

    const title = kind === 'followers' ? 'Followers' : 'Following'
    await expect(page.getByRole('heading', { name: new RegExp(`^@.+'s ${title}$`) })).toBeVisible()
    await expect(page.getByRole('heading', { name: `Sign in to view your ${kind}` })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: /Sign in to Yappr/ })).toHaveCount(0)
  })
}
