import { createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { appUrl, BASE_URL } from '../fixtures/app'

const postId = process.env.E2E_BLOG_POST_ID

test('a script embed opens the article when the reader clicks View on Yappr', async ({ page }) => {
  test.skip(!postId, 'E2E_BLOG_POST_ID must identify a published post on this deployment')
  // Serve a real host page on a different origin. The product script creates
  // the iframe, which reads the published article from the real deployment.
  const host = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><html lang="en"><title>External embed host</title>
      <h1>External embed host</h1>
      <div data-yappr-post="${postId}" data-yappr-theme="light"></div>
      <script src="${appUrl('/embed.js')}"></script></html>`)
  })
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve))

  try {
    const address = host.address()
    if (!address || typeof address === 'string') throw new Error('No embed host port')
    await page.goto(`http://127.0.0.1:${address.port}`)
    const frame = page.frameLocator('iframe[title="Yappr embedded post"]')
    const heading = frame.getByRole('heading', { level: 1 })
    await expect(heading).toBeVisible()
    const title = await heading.innerText()
    const link = frame.getByRole('link', { name: 'View on Yappr' })
    const destination = new URL(await link.getAttribute('href') || '', BASE_URL)

    await link.click()
    await expect(page).toHaveURL(destination.href)
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  } finally {
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()))
  }
})
