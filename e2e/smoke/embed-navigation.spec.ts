import { expect, test } from '@playwright/test'
import { appUrl, BASE_URL } from '../fixtures/app'
import { expectedNetwork } from '../fixtures/contracts'

// Supply a real published post from the deployment under test. No document is
// created or mocked here; deployments without a fixture skip this read-only case.
const postId = process.env.E2E_BLOG_POST_ID

test('published embed and generated snippets stay on the same deployment', async ({ page }) => {
  test.skip(!postId, 'E2E_BLOG_POST_ID must identify a published post on this deployment')
  const basePath = new URL(BASE_URL).pathname.replace(/\/$/, '')
  await page.goto(appUrl(`/embed/?post=${encodeURIComponent(postId!)}`))

  const title = page.getByRole('heading', { level: 1 })
  await expect(title).toBeVisible()
  const postTitle = await title.innerText()
  const link = page.getByRole('link', { name: 'View on Yappr' })
  const destination = new URL(await link.getAttribute('href') || '', BASE_URL)
  expect(destination.pathname.replace(/\/$/, '')).toBe(`${basePath}/blog`)
  expect(destination.searchParams.get('blog')).toBeTruthy()
  expect(destination.searchParams.get('post')).toBeTruthy()

  await link.click()
  await expect(page.getByRole('heading', { name: postTitle, exact: true })).toBeVisible()
  await expect(page.getByText((await expectedNetwork()).toUpperCase(), { exact: true }).first()).toBeVisible()
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe(`${basePath}/blog`)

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Embed', exact: true }).click()
  const snippets = page.getByRole('dialog').locator('pre')
  const iframeSnippet = await snippets.nth(0).innerText()
  const scriptSnippet = await snippets.nth(1).innerText()
  const iframeUrl = new URL(iframeSnippet.match(/src="([^"]+)"/)![1])
  const scriptUrl = new URL(scriptSnippet.match(/src="([^"]+)"/)![1])
  expect(iframeUrl.pathname).toBe(`${basePath}/embed/`)
  expect(iframeUrl.searchParams.get('post')).toBe(postId)
  expect(scriptUrl.pathname).toBe(`${basePath}/embed.js`)
})
