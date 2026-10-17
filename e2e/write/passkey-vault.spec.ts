/**
 * Passkey vault end to end (docs/PASSKEY_VAULT.md): a key or wallet sign-in
 * adds a passkey from the one-time offer, signs out, and the passkey alone
 * signs back in to the same session; the passkey is then removed and stops
 * working. Chromium's virtual authenticator (CDP WebAuthn, with PRF) stands in
 * for Face ID, Touch ID or a phone.
 *
 * Needs a build with NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID, served on
 * localhost (the relying party Yappr allows besides yap.pr), on a devnet:
 *
 *   E2E_PASSKEY_VAULT=1 E2E_BASE_PATH=/devnet E2E_PASSKEY_KEY_WIF=<a devnet HIGH key> \
 *     npx playwright test e2e/write/passkey-vault.spec.ts --project write
 *
 * The wallet case also needs an App Connect build whose group has the vault as
 * a member, and the mobile/tools responder (see app-connect-login.spec.ts):
 *
 *   E2E_LOGIN_PROTOCOL=app-connect E2E_APP_CONNECT_RESPONDER_URL=http://127.0.0.1:8789 \
 *     E2E_APP_CONNECT_PERSONA=92 E2E_APP_CONNECT_APP_ID=<the build's anchor id>
 *
 * With E2E_PASSKEY_FEES_IDENTITY=<identity id> NETWORK=devnet it also prints
 * what each write cost that identity. Self-skips otherwise, like the rest of
 * the write project.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { appUrl } from '../fixtures/app'

const ENABLED = process.env.E2E_PASSKEY_VAULT === '1'
const KEY_WIF = process.env.E2E_PASSKEY_KEY_WIF?.trim()
const RESPONDER_URL = process.env.E2E_APP_CONNECT_RESPONDER_URL?.replace(/\/+$/, '')
const WALLET_BUILD = process.env.E2E_LOGIN_PROTOCOL === 'app-connect'
const PERSONA = Number(process.env.E2E_APP_CONNECT_PERSONA ?? 92)
/** The build's App Connect anchor (NEXT_PUBLIC_APP_CONNECT_APP_ID), whose grants the revoke turns off. */
const APP_ID = process.env.E2E_APP_CONNECT_APP_ID?.trim() ?? ''
const FEES_IDENTITY = process.env.E2E_PASSKEY_FEES_IDENTITY?.trim()

test.setTimeout(420_000)

/** A platform authenticator with PRF, user verification and resident keys, that approves every prompt. */
interface Authenticator {
  /** The passkeys it still holds (the app tells the provider to drop removed ones). */
  credentialCount(): Promise<number>
}

async function addAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  })
  return {
    credentialCount: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length,
  }
}

interface Balances {
  read(): Promise<bigint | null>
}

/** Optional fee probe: the identity's credit balance from chain (scripts/sdk-env.mjs, the env file's network). */
async function balances(): Promise<Balances> {
  if (!FEES_IDENTITY) return { read: async () => null }
  const { connectSdk } = await import('../../scripts/sdk-env.mjs') as { connectSdk: () => Promise<{ identities: { balance: (id: string) => Promise<bigint | number | null> } }> }
  const sdk = await connectSdk()
  return { read: async () => BigInt((await sdk.identities.balance(FEES_IDENTITY)) ?? 0) }
}

async function measure(label: string, probe: Balances, step: () => Promise<void>): Promise<void> {
  const before = await probe.read()
  await step()
  if (before === null) return
  // Fees settle with the block; wait for the balance to stop moving.
  let after = before
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const now: bigint = (await probe.read()) ?? before
    if (now !== before && now === after) break
    after = now
  }
  const spent = before - after
  console.log(`FEE ${label}: ${spent} credits (${(Number(spent) / 1e6 * 0.06).toFixed(2)}¢)`)
}

async function responder(route: string, body: Record<string, unknown>): Promise<void> {
  const answer = await fetch(`${RESPONDER_URL}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(answer.ok, await answer.clone().text()).toBe(true)
}

/** The test wallet answers the App Connect request shown inside `scope`. */
async function walletApproves(scope: Locator): Promise<void> {
  const link = scope.getByRole('link', { name: 'Open in wallet app' })
  await expect(link).toBeVisible({ timeout: 60_000 })
  await responder('/respond', { uri: await link.getAttribute('href'), persona: PERSONA })
}

async function addPasskeyFromOffer(page: Page): Promise<void> {
  const offer = page.getByRole('dialog', { name: 'Sign in faster with a passkey' })
  await expect(offer).toBeVisible({ timeout: 90_000 })
  await offer.getByTestId('passkey-add').click()
  await offer.getByTestId('passkey-confirm').click()
  await expect(page.getByRole('dialog', { name: 'Passkey added' })).toBeVisible({ timeout: 120_000 })
  await page.getByRole('dialog', { name: 'Passkey added' }).getByRole('button', { name: 'Done' }).click()
}

async function signOut(page: Page): Promise<void> {
  await page.getByTestId('user-menu-trigger').click()
  await page.getByRole('menuitem', { name: /Sign out|Log out/ }).click()
  await expect(page.getByTestId('user-menu-trigger')).toHaveCount(0, { timeout: 60_000 })
}

async function signInWithPasskey(page: Page): Promise<void> {
  await page.goto(appUrl('/login/'))
  const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
  await dialog.getByTestId('passkey-sign-in').click()
}

async function removeOnlyPasskey(page: Page): Promise<void> {
  await page.goto(appUrl('/settings/?section=privacy'))
  const settings = page.getByTestId('passkey-settings')
  const row = settings.getByTestId('passkey-row').filter({ hasText: 'This device' })
  await expect(row).toHaveCount(1, { timeout: 60_000 })
  await row.getByRole('button', { name: 'Remove' }).click()
  await page.getByTestId('passkey-remove-confirm').click()
  await expect(settings.getByTestId('passkey-row')).toHaveCount(0, { timeout: 120_000 })
}

test.describe('passkey vault', () => {
  test.beforeEach(() => {
    test.skip(!ENABLED, 'Passkey e2e needs E2E_PASSKEY_VAULT=1 and a localhost build with the vault contract')
  })

  test('a key sign-in adds a passkey that signs back in, until it is removed', async ({ page }) => {
    test.skip(!KEY_WIF, 'needs E2E_PASSKEY_KEY_WIF (a devnet HIGH sign-in key)')
    const probe = await balances()
    const authenticator = await addAuthenticator(page)

    await page.goto(appUrl('/login/'))
    const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
    await dialog.locator('#loginCredential').fill(KEY_WIF as string)
    await expect(dialog.getByText(/^Signing in as /)).toBeVisible({ timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Sign In', exact: true }).click()
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 60_000 })

    await measure('add a passkey (key sign-in)', probe, () => addPasskeyFromOffer(page))

    await signOut(page)
    await signInWithPasskey(page)
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 90_000 })
    // A key sign-in from a passkey keeps the HIGH key like a typed one: it survives a reload.
    await page.reload()
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 60_000 })

    // Updating from Settings goes through the review, and re-seals with no passkey prompt.
    await page.goto(appUrl('/settings/?section=privacy'))
    await page.getByTestId('passkey-settings').getByRole('button', { name: 'Update passkeys' }).click()
    const review = page.getByRole('dialog', { name: 'Update your passkeys' })
    await review.getByRole('checkbox').first().check()
    await measure('update a passkey (re-seal)', probe, async () => {
      await review.getByTestId('passkey-update').click()
      await expect(review).toHaveCount(0, { timeout: 120_000 })
    })

    await measure('remove a passkey (refund)', probe, () => removeOnlyPasskey(page))
    // The provider was told: the removed passkey is gone from the authenticator, so it is never offered again.
    await expect.poll(() => authenticator.credentialCount(), { timeout: 30_000 }).toBe(0)
  })

  test('a wallet sign-in adds a passkey that brings the wallet session back, and renews it when the wallet turned it off', async ({ page }) => {
    test.skip(!RESPONDER_URL || !WALLET_BUILD || !APP_ID, 'needs E2E_LOGIN_PROTOCOL=app-connect, E2E_APP_CONNECT_RESPONDER_URL and E2E_APP_CONNECT_APP_ID')
    const probe = await balances()
    const authenticator = await addAuthenticator(page)

    await page.goto(appUrl('/login/'))
    const dialog = page.getByRole('dialog', { name: /Sign in to Yappr/ })
    await dialog.getByRole('button', { name: 'Sign in with a Dash wallet app' }).click()
    await walletApproves(dialog)
    const confirm = page.getByTestId('app-connect-confirm')
    await expect(confirm).toBeVisible({ timeout: 180_000 })
    await confirm.getByRole('button', { name: /^Continue as / }).click()
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 60_000 })

    // Signed with the wallet's group key: the vault is a group member.
    await measure('add a passkey (wallet sign-in)', probe, () => addPasskeyFromOffer(page))

    await signOut(page)
    await signInWithPasskey(page)
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 90_000 })
    // The wallet's key ring came back: Settings shows this browser's wallet connection.
    await page.goto(appUrl('/settings/?section=privacy'))
    await expect(page.getByTestId('wallet-connections').getByText('This browser').first()).toBeVisible({ timeout: 60_000 })

    // The wallet turns Yappr off: the passkey's keys stop working, and signing in with it asks the wallet again.
    await signOut(page)
    await responder('/revoke', { persona: PERSONA, appId: APP_ID })
    await signInWithPasskey(page)
    const renew = page.getByTestId('passkey-renew')
    await expect(renew).toBeVisible({ timeout: 90_000 })
    await walletApproves(renew)
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 180_000 })
    // The new wallet keys are not in the passkey yet: the review asks to update it.
    const review = page.getByRole('dialog', { name: 'Update your passkeys' })
    await expect(review).toBeVisible({ timeout: 90_000 })
    await expect(review.getByText('Needs update')).toBeVisible()
    await measure('update a passkey (wallet key, re-seal)', probe, async () => {
      await review.getByTestId('passkey-update').click()
      await expect(review).toHaveCount(0, { timeout: 120_000 })
    })
    await signOut(page)
    await signInWithPasskey(page)
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 90_000 })

    await measure('remove a passkey (wallet key)', probe, () => removeOnlyPasskey(page))
    await expect.poll(() => authenticator.credentialCount(), { timeout: 30_000 }).toBe(0)
  })
})
