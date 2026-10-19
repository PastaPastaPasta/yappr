/**
 * Recovery-phrase sign-in (D38) end to end on an App Connect build: two
 * identities of one phrase (DIP-13 identity indexes, as a Dash wallet keeps
 * them) each sign in with the phrase in a fresh browser, and a direct message
 * sent by one decrypts for the other. Both messaging keys are the phrase's
 * DIP-13 7' keys for the anchor, so the recipient reads it on a device that
 * never held a key.
 *
 *   E2E_ENV_FILE=.env.staging E2E_LOGIN_PROTOCOL=app-connect \
 *   E2E_RECOVERY_PHRASE_FILE=<0600 file holding the phrase> \
 *   E2E_RECOVERY_PHRASE_SENDER=<username>:<identity id> E2E_RECOVERY_PHRASE_RECIPIENT=<username>:<identity id> \
 *   E2E_BASE_URL=http://localhost:<port>/staging npx playwright test e2e/write/recovery-phrase-login.spec.ts
 *
 * Writes one DM. The phrase is read from the file and typed into the page;
 * it is never logged. Self-skips without those variables.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { appUrl, isAppConnectBuild, scopedKey } from '../fixtures/app'
import { bubbles, gotoMessages, send, thread } from '../fixtures/dm'

const PHRASE_FILE = process.env.E2E_RECOVERY_PHRASE_FILE?.trim()

/** `<username>:<identity id>`, both of an identity the phrase holds. */
function account(variable: string): { username: string; identityId: string } | null {
  const [username, identityId] = (process.env[variable]?.trim() ?? '').split(':')
  return username && identityId ? { username, identityId } : null
}
const SENDER = account('E2E_RECOVERY_PHRASE_SENDER')
const RECIPIENT = account('E2E_RECOVERY_PHRASE_RECIPIENT')

test.setTimeout(600_000)

test.beforeEach(() => {
  test.skip(!isAppConnectBuild() || !PHRASE_FILE || !SENDER || !RECIPIENT,
    'needs an App Connect build and E2E_RECOVERY_PHRASE_FILE, E2E_RECOVERY_PHRASE_SENDER and E2E_RECOVERY_PHRASE_RECIPIENT')
})

/** A fresh browser (its own storage) signed in with the phrase as `username`. */
async function signInWithPhrase(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext()
  // DMs need no YAPP: keep the starter-grant prompt out of the way.
  await context.addInitScript((key) => window.localStorage.setItem(key, JSON.stringify([])), scopedKey('yappr_starter_grant_settled'))
  const page = await context.newPage()
  await page.goto(appUrl('/login/'))
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await dialog.getByRole('button', { name: 'Sign in with your recovery phrase' }).click()
  const field = dialog.getByLabel('Recovery phrase', { exact: true })
  await field.fill(readFileSync(PHRASE_FILE as string, 'utf8').trim())
  await dialog.getByRole('button', { name: 'Sign In', exact: true }).click()
  // Several identities share the phrase: pick one. The field is already empty.
  const accounts = dialog.getByTestId('recovery-phrase-accounts')
  await expect(accounts).toBeVisible({ timeout: 120_000 })
  await expect(field).toHaveCount(0)
  await accounts.getByRole('button', { name: new RegExp(`^${username}`) }).click()
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 180_000 })
  const offer = page.getByRole('dialog', { name: 'Sign in faster with a passkey' })
  if (await offer.isVisible().catch(() => false)) await offer.getByRole('button', { name: 'Not now' }).click()
  return page
}

test('a DM between two recovery-phrase sign-ins decrypts on a device that never held a key', async ({ browser }) => {
  const text = `D38 recovery phrase check ${Date.now()}`

  if (!SENDER || !RECIPIENT) return

  const sender = await signInWithPhrase(browser, SENDER.username)
  // The inbox opens straight away: the phrase brought the messaging key with it ("Set up messaging" never shows).
  await gotoMessages(sender, `?startConversation=${RECIPIENT.identityId}`)
  await expect(thread(sender)).toBeVisible({ timeout: 120_000 })
  await send(sender, text)
  await expect(bubbles(sender, text)).toBeVisible()

  const recipient = await signInWithPhrase(browser, RECIPIENT.username)
  await gotoMessages(recipient, `?startConversation=${SENDER.identityId}`)
  await expect(thread(recipient)).toBeVisible({ timeout: 120_000 })
  await expect(bubbles(recipient, text)).toBeVisible({ timeout: 300_000 })
})
