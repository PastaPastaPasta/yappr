/**
 * "Anchor key only; prompt others" on App Connect builds (#742): an identity
 * without an anchor-bound encryption key shows as not set up to the people
 * who try to reach it, and its own owner is offered "Set up messaging": a
 * wallet or recovery-phrase sign-in, and under its developer options the
 * sign-in-key setup, whose wallet hand-off carries exactly one IdentityUpdate
 * adding that key.
 *
 * Pool slot 0 is the identity left WITHOUT a messaging key on sakura (the ops
 * script skips it on purpose); slots 1-8 have one. Nothing here writes to the
 * chain: the wallet request is decoded, never signed. Runs only against an
 * App Connect devnet build, and skips when slot 0 has a messaging key after all.
 */
import { expect, test, type Browser } from '@playwright/test'
import { appUrl } from '../fixtures/app'
import { hasSeedPhrase, NO_SEED_REASON } from '../fixtures/auth'
import {
  anchorKeysOf,
  APP_CONNECT_ANCHOR_ID,
  closeDevices,
  dmBot,
  DM_V5_BUILD,
  expectToast,
  gotoMessages,
  IS_DEVNET_RUN,
  NOT_DEVNET_REASON,
  NOT_V5_REASON,
  openDevice,
  poolTooSmall,
  POOL_REASON,
  SLOT,
  type DmBot,
  type Device,
} from '../fixtures/dm'
import { bytesEqual, normalizeBytes } from '../../lib/bytes'
import { getPublicKey } from '../../lib/crypto/keys'
import { wifToPrivateKey } from '../../lib/crypto/wif'
import { deriveEncryptionKey } from '../../lib/crypto/derive-encryption-key'
import { parseYapprStateTransitionUri } from '../../vendor/platform-auth/src/key-exchange/yappr-protocol'

/** The pool identity without a messaging key. */
const UNREACHABLE_SLOT = 0

test.describe.configure({ mode: 'serial' })

test.describe('Messaging setup (App Connect)', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(!APP_CONNECT_ANCHOR_ID, 'not an App Connect build (NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect with an anchor)')
  test.skip(!DM_V5_BUILD, NOT_V5_REASON)
  test.skip(!hasSeedPhrase, NO_SEED_REASON)
  test.skip(poolTooSmall(), POOL_REASON)

  let unreachable: DmBot
  const devices: Device[] = []
  const open = async (browser: Browser, bot: DmBot, label: string, messaging: boolean) => {
    const device = await openDevice(browser, bot, label, { messaging })
    devices.push(device)
    return device
  }

  test.beforeAll(async () => {
    unreachable = await dmBot(UNREACHABLE_SLOT)
    const keys = await anchorKeysOf(unreachable)
    test.skip(keys.length > 0, `pool slot ${UNREACHABLE_SLOT} has a messaging key, so nothing here is unreachable`)
  })

  test.afterAll(async () => {
    await closeDevices(devices)
  })

  test('someone without messaging reads as not set up, not as an error', async ({ browser }) => {
    test.setTimeout(300_000)
    const sender = await open(browser, await dmBot(SLOT.A), 'A', true)
    await gotoMessages(sender.page, `?startConversation=${unreachable.identityId}`)
    await expectToast(sender.page, /hasn't set up messaging yet/, 120_000)
    // Nothing to write to: no conversation opens.
    await expect(sender.page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0)
  })

  test('set up messaging hands the wallet one IdentityUpdate adding only the anchor key', async ({ browser }) => {
    test.setTimeout(300_000)
    const owner = await open(browser, unreachable, 'unreachable', false)
    const page = owner.page
    // No inbox without messaging: the page offers setup instead.
    await page.goto(appUrl('/messages/'), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Set up messaging' })).toBeVisible({ timeout: 90_000 })
    await page.getByRole('button', { name: 'Set up messaging' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Set up messaging' })).toBeVisible({ timeout: 60_000 })
    // D38: the way in is a wallet or recovery-phrase sign-in; a key made from the sign-in key is a developer option.
    await expect(dialog.getByRole('button', { name: 'Sign in with wallet or recovery phrase' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Advanced: developer options' }).click()
    await expect(dialog.getByText('For developers. Not for normal use.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Set up messaging with this sign-in key' }).click()
    await expect(dialog.getByRole('button', { name: 'Use your master key instead' })).toBeVisible({ timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Approve in your wallet' }).click()

    const link = dialog.getByRole('link', { name: 'Open in wallet app' })
    await expect(link).toBeVisible({ timeout: 60_000 })
    const uri = await link.getAttribute('href')
    const parsed = uri ? parseYapprStateTransitionUri(uri) : null
    expect(parsed, 'a dash-st: link').not.toBeNull()
    expect(parsed!.network).toBe('devnet')

    const { ensureInitialized, IdentityUpdateTransition } = await import('@dashevo/evo-sdk')
    await ensureInitialized()
    const update = IdentityUpdateTransition.fromBytes(parsed!.transitionBytes)
    try {
      expect(update.identityIdentifier.toBase58()).toBe(unreachable.identityId)
      expect(Array.from(update.publicKeyIdsToDisable)).toEqual([])
      const added = update.publicKeyIdsToAdd
      expect(added).toHaveLength(1)
      const key = added[0]
      expect(key.purpose.toUpperCase()).toBe('ENCRYPTION')
      expect(key.securityLevel.toUpperCase()).toBe('MEDIUM')
      expect(key.keyType.toUpperCase()).toBe('ECDSA_SECP256K1')
      const bounds = key.contractBounds
      expect(bounds?.contractBoundsType.toLowerCase()).toMatch(/single_?contract$/)
      expect(bounds?.identifier.toBase58()).toBe(APP_CONNECT_ANCHOR_ID)
      expect(bounds?.documentTypeName).toBeUndefined()
      // The key the app derives from this login key, so the same key recovers it on any device.
      const expected = getPublicKey(deriveEncryptionKey(wifToPrivateKey(unreachable.authWif).privateKey, unreachable.identityId, APP_CONNECT_ANCHOR_ID))
      const data = normalizeBytes(key.toJSON().data)
      expect(data !== null && bytesEqual(data, expected)).toBe(true)
    } finally {
      update.free()
    }

    await expect(dialog.getByText('Waiting for your wallet…')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
  })
})
