import { expect, test } from '@playwright/test'
import { appUrl } from '../fixtures/app'

for (const query of ['', '?post=']) {
  test(`embed without a post has a recovery link even when Platform is offline (${query || 'no query'})`, async ({ page }) => {
    await page.route('https://**/*', (route) => route.abort())
    await page.goto(appUrl(`/embed/${query}`))

    const alert = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'Post unavailable' }) })
    await expect(alert.getByRole('heading', { name: 'Post unavailable' })).toBeVisible()
    await expect(alert).toContainText('This embed link is missing its post.')
    const recovery = alert.getByRole('link', { name: 'Browse blogs on Yappr' })
    await expect(recovery).toHaveAttribute('href', new RegExp(`${new URL(appUrl('/blog')).pathname}/?$`))
    await expect(recovery).toHaveAttribute('target', '_top')
  })
}
