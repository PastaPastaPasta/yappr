/**
 * The App Connect return page (/connect) exists on every build and must never
 * act on anything but a well-formed request hash. Read-only.
 */
import { expect, test } from '@playwright/test'
import { appUrl, appUrlPattern, scopedKey } from '../fixtures/app'

const REQUEST_HASH = 'ab'.repeat(20)

test('a malformed return link goes home', async ({ page }) => {
  await page.goto(appUrl('/connect/?r=not-a-hash'))
  await expect(page).not.toHaveURL(appUrlPattern('/connect'))
})

test('a declined sign-in says so', async ({ page }) => {
  await page.goto(appUrl(`/connect/?r=${REQUEST_HASH}&ac=declined`))
  await expect(page.getByText('Sign-in declined')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to Yappr' })).toBeVisible()
})

test('a return link with no tab waiting continues to sign-in', async ({ page }) => {
  await page.goto(appUrl(`/connect/?r=${REQUEST_HASH}&ac=ok`))
  await expect(page).toHaveURL(appUrlPattern('/login'))
})

test('the tab showing the code is told when the wallet returns', async ({ page, context }) => {
  // Stand in for the waiting tab: answer the page's message the way the login panel does.
  const waiting = await context.newPage()
  await waiting.goto(appUrl('/about/'))
  await waiting.evaluate(({ hash, name }) => {
    const channel = new BroadcastChannel(name)
    // Kept reachable so the channel is not collected before the message arrives.
    Object.assign(window, { appConnectTestChannel: channel })
    channel.onmessage = (event) => {
      if (event.data?.type === 'app-connect-callback' && event.data.requestHash === hash) {
        channel.postMessage({ type: 'app-connect-callback-ack', requestHash: hash })
      }
    }
  }, { hash: REQUEST_HASH, name: scopedKey('yappr-app-connect') })

  await page.goto(appUrl(`/connect/?r=${REQUEST_HASH}&ac=ok`))
  await expect(page.getByText('You\'re signing in on your other Yappr tab')).toBeVisible()
})
