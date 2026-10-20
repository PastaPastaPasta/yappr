/**
 * App Connect sign-in end to end: the app shows a v2 `dash-key:` request, the
 * mobile/tools test-wallet responder answers it on chain (registering bound
 * keys and publishing a loginKeyResponse), and the app verifies the answer
 * and asks who is signing in.
 *
 * Needs an App Connect build (NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect, a PV14
 * devnet with the anchor set registered) and a running responder:
 *
 *   node mobile/tools/test-wallet-responder.mjs --serve 127.0.0.1:8789
 *   E2E_LOGIN_PROTOCOL=app-connect E2E_APP_CONNECT_RESPONDER_URL=http://127.0.0.1:8789 \
 *     E2E_BASE_PATH=/devnet npx playwright test e2e/write/app-connect-login.spec.ts
 *
 * Self-skips otherwise, like the rest of the write project.
 */
import { expect, test, type Page } from '@playwright/test'
import { appUrl } from '../fixtures/app'

const RESPONDER_URL = process.env.E2E_APP_CONNECT_RESPONDER_URL?.replace(/\/+$/, '')
const IS_APP_CONNECT_BUILD = process.env.E2E_LOGIN_PROTOCOL === 'app-connect'
const PERSONA = Number(process.env.E2E_APP_CONNECT_PERSONA ?? 90)
const OTHER_PERSONA = Number(process.env.E2E_APP_CONNECT_OTHER_PERSONA ?? 91)

const SKIP_REASON = 'App Connect e2e needs E2E_LOGIN_PROTOCOL=app-connect and E2E_APP_CONNECT_RESPONDER_URL (a mobile/tools responder)'

// Each answer is a MASTER-signed identity update plus a document batch on chain.
test.setTimeout(300_000)

test.beforeEach(() => {
  test.skip(!RESPONDER_URL || !IS_APP_CONNECT_BUILD, SKIP_REASON)
})

async function requestUri(page: Page): Promise<string> {
  await page.goto(appUrl('/login/'))
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  // The wallet request is made once the wallet option is chosen.
  await dialog.getByRole('button', { name: 'Sign in with Dash Wallet' }).click()
  const link = dialog.getByRole('link', { name: 'Open in wallet app' })
  await expect(link).toBeVisible({ timeout: 60_000 })
  const uri = await link.getAttribute('href')
  expect(uri).toMatch(/^dash-key:[1-9A-HJ-NP-Za-km-z]+\?n=[mtd]&v=2/)
  return uri as string
}

async function respond(uri: string, body: Record<string, unknown> = {}): Promise<void> {
  const response = await fetch(`${RESPONDER_URL}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri, persona: PERSONA, ...body }),
  })
  expect(response.ok, await response.clone().text()).toBe(true)
}

test('a wallet answer is confirmed, then signs in and survives a reload', async ({ page }) => {
  const uri = await requestUri(page)
  await respond(uri)

  const confirm = page.getByTestId('app-connect-confirm')
  await expect(confirm).toBeVisible({ timeout: 120_000 })
  await confirm.getByRole('button', { name: /^Continue as / }).click()
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 60_000 })

  // The key ring restores from this browser alone.
  await page.reload()
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 60_000 })

  // Settings lists this browser's wallet keys from chain.
  await page.goto(appUrl('/settings/?section=privacy'))
  const connections = page.getByTestId('wallet-connections')
  await expect(connections.getByText('This browser').first()).toBeVisible({ timeout: 60_000 })
  await expect(connections.getByText('Post, like, follow and message').first()).toBeVisible()
})

test('"That\'s not me" throws the answer away and shows a new code', async ({ page }) => {
  const uri = await requestUri(page)
  await respond(uri)

  const confirm = page.getByTestId('app-connect-confirm')
  await expect(confirm).toBeVisible({ timeout: 120_000 })
  await confirm.getByRole('button', { name: 'That\'s not me' }).click()

  await expect(page.getByText(/Someone else may have scanned your code/)).toBeVisible()
  const fresh = await page.getByRole('link', { name: 'Open in wallet app' }).getAttribute('href')
  expect(fresh).not.toBe(uri)
  await expect(page.getByTestId('user-menu-trigger')).toHaveCount(0)
})

test('two accounts answering get a chooser', async ({ page }) => {
  const uri = await requestUri(page)
  await respond(uri, { faults: ['second-identity'], otherPersona: OTHER_PERSONA })

  const chooser = page.getByTestId('app-connect-chooser')
  await expect(chooser).toBeVisible({ timeout: 180_000 })
  await expect(chooser.getByTestId('identity-confirm-card')).toHaveCount(2)
})

test('an answer sealed for another identity is never offered', async ({ page }) => {
  const uri = await requestUri(page)
  await respond(uri, { faults: ['wrong-owner'], otherPersona: OTHER_PERSONA })

  // The poll keeps waiting: the bad answer never reaches the confirm step.
  await page.waitForTimeout(20_000)
  await expect(page.getByTestId('app-connect-confirm')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open in wallet app' })).toBeVisible()
})
