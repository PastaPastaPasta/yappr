import { test, expect } from '@playwright/test'

// The parent is localhost and the child is 127.0.0.1: distinct browser origins.
test('foreign framing never mounts sign-in or key inputs, including nested frames', async ({ page, baseURL }) => {
  await page.goto(baseURL!.replace('127.0.0.1', 'localhost') + '/security.html')
  await page.setContent(`<iframe src="${baseURL}/security.html"></iframe>`)
  const frame = page.frameLocator('iframe')
  await expect(frame.getByRole('link', { name: 'Open Yappr in a new tab' })).toHaveAttribute('target', '_top')
  await expect(frame.getByRole('button', { name: 'Sign In' })).toHaveCount(0)
  await expect(frame.locator('input')).toHaveCount(0)
  const child = page.frames().find(f => f.url().startsWith(baseURL!))!
  await child.evaluate(() => { document.body.innerHTML = '<iframe src="/security.html"></iframe>' })
  const nested = frame.frameLocator('iframe')
  await expect(nested.getByRole('link', { name: 'Open Yappr in a new tab' })).toBeVisible()
  await expect(nested.locator('input')).toHaveCount(0)
})

test('top-level and same-origin frames remain interactive', async ({ page, baseURL }) => {
  await page.goto('/security.html')
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Draft' }).fill('keep this draft')
  await page.getByRole('button', { name: 'Navigate', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('keep this draft')
  await page.setContent(`<iframe src="${baseURL}/security.html"></iframe>`)
  await expect(page.frameLocator('iframe').getByRole('button', { name: 'Sign In' })).toBeVisible()
})

test('embed routes remain frameable at root and deployment subpaths', async ({ page, baseURL }) => {
  await page.route(/\/((devnet|staging)\/)?embed\//, async route => {
    const response = await page.request.get(baseURL + '/security.html')
    await route.fulfill({ response })
  })
  await page.goto(baseURL!.replace('127.0.0.1', 'localhost') + '/security.html')
  for (const base of ['', '/devnet', '/staging']) {
    await page.setContent(`<iframe src="${baseURL}${base}/embed/?base=${base}"></iframe>`)
    await expect(page.frameLocator('iframe').getByRole('button', { name: 'Sign In' })).toBeVisible()
  }
  await page.frameLocator('iframe').getByRole('button', { name: 'Navigate', exact: true }).click()
  await expect(page.frameLocator('iframe').getByRole('link', { name: 'Open Yappr in a new tab' })).toBeVisible()
  await expect(page.frameLocator('iframe').locator('input')).toHaveCount(0)
})

test('checkout and QR sinks reject hostile records and derive currency metadata', async ({ page }) => {
  await page.goto('/security.html?payments')
  await expect(page.getByText('Bitcoin', { exact: true })).toBeVisible()
  await expect(page.getByText('Verified Dash payment')).toHaveCount(0)
  await expect(page.getByText(/javascript:|data:text/)).toHaveCount(0)
  await expect(page.locator('[data-testid="unsafe-qr"] svg')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Open in Wallet/i })).toHaveCount(0)
  await page.getByRole('button', { name: /Bitcoin bitcoin:/ }).click()
  await expect(page.getByRole('heading', { name: 'Bitcoin' })).toBeVisible()
  await expect(page.locator('svg[role="img"]')).toHaveCount(1)
  await page.evaluate(() => { window.open = (url) => { document.body.dataset.openedWallet = String(url); return null } })
  await page.getByRole('button', { name: /Open in Wallet/i }).click()
  await expect(page.locator('body')).toHaveAttribute('data-opened-wallet', 'bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT')
})
