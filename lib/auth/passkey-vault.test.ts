/**
 * The enrolment rules of lib/auth/passkey-vault.ts that need no network: what
 * a pending enrolment restored from storage may and may not do, how an
 * unfinished enrolment is dropped, and the raw-key sign-in hooks. Platform,
 * the passkey provider and the stores are mocked.
 */
import bs58 from 'bs58'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recipientFromPrf } from '@/lib/crypto/passkey-vault'
import { bytesToBase64Url, bytesToHex } from '@/lib/bytes'
import { stubBrowserStorage } from '../test-storage'

const IDENTITY = bs58.encode(new Uint8Array(32).fill(4))
const CREDENTIAL = new Uint8Array([1, 2, 3, 4])
const prfOf = (seed: number) => new Uint8Array(32).fill(seed)

const VAULT = vi.hoisted(() => 'AwTMt9nEFgCwLcFNfJXpCRfKtrqHnkyR8hCWiTBm7HqJ')
const auth = vi.hoisted(() => ({
  getPasskeyPrf: vi.fn(),
  signalUnknownPasskey: vi.fn(async () => undefined),
  createPasskeyWithPrf: vi.fn(),
}))
const vault = vi.hoisted(() => ({
  find: vi.fn(async () => null),
  add: vi.fn(),
  settleAdd: vi.fn(),
  list: vi.fn(async () => []),
}))
const stores = vi.hoisted(() => ({
  expectPasskeyCriticalKey: vi.fn(),
  settlePasskeyCriticalKey: vi.fn(),
  storeEncryptionKey: vi.fn(),
  storeEncryptionKeyType: vi.fn(),
  getPrivateKey: vi.fn(() => null),
  getEncryptionKeyBytes: vi.fn(() => null),
}))

vi.mock('platform-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('platform-auth')>()),
  passkeysAvailable: () => true,
  getPasskeyPrf: auth.getPasskeyPrf,
  signalUnknownPasskey: auth.signalUnknownPasskey,
  createPasskeyWithPrf: auth.createPasskeyWithPrf,
}))
vi.mock('@/lib/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/constants')>()),
  YAPPR_PASSKEY_VAULT_CONTRACT_ID: VAULT,
}))
vi.mock('@/lib/services/passkey-vault-service', () => ({ passkeyVaultService: vault }))
vi.mock('@/lib/secure-storage', () => stores)
vi.mock('@/lib/app-connect/config', () => ({ appConnectPins: () => null, isAppConnectBuild: () => false }))
vi.mock('@/lib/app-connect/platform-port', () => ({ appConnectPlatformPort: {} }))
vi.mock('@/lib/app-connect/session-manager', () => ({ appConnectSessions: { current: () => null } }))
vi.mock('@/lib/app-connect/session-health', () => ({ primaryGroupKey: () => null }))
vi.mock('@/lib/app-connect/wallet-sign-in', () => ({ wipeGrant: () => undefined }))
vi.mock('@/lib/app-connect/yappr-request', () => ({ buildYapprAppConnectRequest: () => ({}) }))
vi.mock('@/lib/app-connect/anchor-key-mark', () => ({ rememberAnchorKey: vi.fn() }))
vi.mock('@/lib/crypto/encryption-key-lookup', () => ({ resolveEncryptionPublicKey: () => null }))

import { PasskeyCancelledError } from 'platform-auth'
import { rememberUnsettledPasskey, unsettledPasskey } from './passkey-device'
import {
  PasskeyVaultError,
  abandonPasskeyEnrolment,
  checkPendingEnrolment,
  confirmPendingEnrolment,
  finishPasskeyEnrolment,
  forgetPendingEnrolments,
  pendingEnrolmentFor,
  rawKeyStoreHooks,
  type PendingPasskey,
} from './passkey-vault'
import { lockOutCopy } from '@/components/auth/passkey-copy'

/** A record in this browser's storage claiming an unsettled enrolment sealed to `recipient` (no write sent). */
function plant(recipient: Uint8Array): void {
  rememberUnsettledPasskey(IDENTITY, { vault: VAULT, credentialId: bytesToBase64Url(CREDENTIAL), recipientKey: bytesToHex(recipient), receipts: [] })
}

/** Runs `promise` to completion through the read-back waits (6 reads, 3 s apart). */
async function settled<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then((value) => ({ value }), (error: unknown) => ({ error }))
  await vi.runAllTimersAsync()
  const outcome = await result
  if ('error' in outcome) throw outcome.error
  return outcome.value
}

beforeEach(() => {
  stubBrowserStorage()
  vi.stubGlobal('window', { location: { hostname: 'localhost' } })
  vi.clearAllMocks()
  vi.useFakeTimers()
  forgetPendingEnrolments()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a pending enrolment restored from storage', () => {
  it('is never sealed to before its passkey vouches for the recipient key on record', async () => {
    // Planted (or damaged): it claims an unsettled passkey sealed to someone else's key.
    plant(recipientFromPrf(prfOf(66)).publicKey)
    const pending = pendingEnrolmentFor(IDENTITY)
    expect(pending).not.toBeNull()

    expect(await settled(checkPendingEnrolment(pending as PendingPasskey))).toBe('confirm')
    expect(vault.add).not.toHaveBeenCalled()
    expect(stores.getPrivateKey).not.toHaveBeenCalled()
  })

  it('is dropped, with nothing sealed, when its passkey opens something else', async () => {
    plant(recipientFromPrf(prfOf(66)).publicKey)
    const pending = pendingEnrolmentFor(IDENTITY) as PendingPasskey
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: null, prfOutput: prfOf(7) })

    await expect(settled(confirmPendingEnrolment(pending))).rejects.toBeInstanceOf(PasskeyVaultError)
    // The one sign-in asked was restricted to this passkey.
    expect(auth.getPasskeyPrf).toHaveBeenCalledWith(expect.objectContaining({ allowCredentialIds: [CREDENTIAL] }))
    expect(vault.add).not.toHaveBeenCalled()
    expect(stores.getPrivateKey).not.toHaveBeenCalled()
    expect(unsettledPasskey(IDENTITY)).toBeNull()
    // The passkey itself may well be the user's: it is not dropped from the provider.
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
  })

  it('is saved again once its passkey gives exactly the recipient key on record', async () => {
    plant(recipientFromPrf(prfOf(7)).publicKey)
    const pending = pendingEnrolmentFor(IDENTITY) as PendingPasskey
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: null, prfOutput: prfOf(7) })

    // Sealing starts (it reads the session's keys; none here, so it stops there).
    await expect(settled(confirmPendingEnrolment(pending))).rejects.toThrow()
    expect(pending.verified).toBe(true)
    expect(stores.getPrivateKey).toHaveBeenCalledWith(IDENTITY)
    expect(unsettledPasskey(IDENTITY)).not.toBeNull()
  })
})

describe('an enrolment left unfinished', () => {
  const made = (): PendingPasskey => ({ identityId: IDENTITY, credentialId: CREDENTIAL, createPrf: prfOf(5) })

  it('keeps its PRF output for another tap when the sheet is closed', async () => {
    const pending = made()
    auth.getPasskeyPrf.mockRejectedValue(new PasskeyCancelledError())
    await expect(finishPasskeyEnrolment(pending)).rejects.toMatchObject({ code: 'cancelled' })
    expect(pending.createPrf).toEqual(prfOf(5))
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
  })

  it('wipes its PRF output and drops the never-sent passkey when the confirming sign-in fails', async () => {
    const pending = made()
    auth.getPasskeyPrf.mockRejectedValue(new Error('NotAllowedError'))
    await expect(finishPasskeyEnrolment(pending)).rejects.toThrow()
    expect(pending.createPrf).toEqual(new Uint8Array(32))
    expect(auth.signalUnknownPasskey).toHaveBeenCalledWith('localhost', CREDENTIAL)
  })

  it('wipes and drops a passkey made but never sent; one still settling is kept', async () => {
    const unsent = made()
    await abandonPasskeyEnrolment(unsent)
    expect(unsent.createPrf).toEqual(new Uint8Array(32))
    expect(auth.signalUnknownPasskey).toHaveBeenCalledTimes(1)

    plant(recipientFromPrf(prfOf(7)).publicKey)
    await abandonPasskeyEnrolment(made())
    expect(auth.signalUnknownPasskey).toHaveBeenCalledTimes(1)
  })
})

describe('a raw-key passkey sign-in', () => {
  const unlocked = { kind: 'raw-key' as const, identityId: IDENTITY, signInWif: 'sign-in', messagingWif: null, critical: true }

  it('stores nothing until the commit runs its hooks, and the messaging key only once the sign-in key is stored', () => {
    const hooks = rawKeyStoreHooks({ ...unlocked, messagingWif: 'cMessagingKeyIsCheckedEarlier' })
    // A sign-out before the commit runs neither hook: nothing of this sign-in is stored.
    expect(stores.expectPasskeyCriticalKey).not.toHaveBeenCalled()
    expect(stores.storeEncryptionKey).not.toHaveBeenCalled()
    hooks.beforeStore()
    expect(stores.expectPasskeyCriticalKey).toHaveBeenCalledWith(IDENTITY, 'sign-in')
    expect(stores.storeEncryptionKey).not.toHaveBeenCalled()
    expect(() => hooks.afterStore()).toThrow()
    expect(stores.settlePasskeyCriticalKey).toHaveBeenCalledWith(IDENTITY)
    expect(stores.storeEncryptionKey).toHaveBeenCalledWith(IDENTITY, 'cMessagingKeyIsCheckedEarlier')
  })

  it('expects a tagged record only for a CRITICAL key', () => {
    rawKeyStoreHooks({ ...unlocked, critical: false }).beforeStore()
    expect(stores.expectPasskeyCriticalKey).not.toHaveBeenCalled()
  })
})

describe('removal copy', () => {
  it('tells both wallet and key users to change the messaging key too', () => {
    for (const wallet of [true, false]) expect(lockOutCopy(wallet)).toMatch(/messaging key/)
    expect(lockOutCopy(false)).toMatch(/usually made from your key/)
  })
})
