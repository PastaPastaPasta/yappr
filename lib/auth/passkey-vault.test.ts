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
import { keyNetwork } from '@/lib/constants'
import { getPublicKey } from '@/lib/crypto/keys'
import { privateKeyToWif } from '@/lib/crypto/wif'
import { stubBrowserStorage } from '../test-storage'

const IDENTITY = bs58.encode(new Uint8Array(32).fill(4))
const CREDENTIAL = new Uint8Array(16).fill(1)
const prfOf = (seed: number) => new Uint8Array(32).fill(seed)
/** The user handle a passkey of IDENTITY carries in this vault (identity ‖ vault contract). */
const handleOf = (identityId: string) => new Uint8Array([...bs58.decode(identityId), ...bs58.decode(VAULT)])
const HANDLE = handleOf(IDENTITY)

const VAULT = vi.hoisted(() => 'AwTMt9nEFgCwLcFNfJXpCRfKtrqHnkyR8hCWiTBm7HqJ')
const auth = vi.hoisted(() => ({
  getPasskeyPrf: vi.fn(),
  signalUnknownPasskey: vi.fn(async () => undefined),
  createPasskeyWithPrf: vi.fn(),
}))
const port = vi.hoisted(() => ({ getIdentityFresh: vi.fn() }))
const vault = vi.hoisted(() => ({
  find: vi.fn(async (): Promise<unknown> => null),
  add: vi.fn(),
  settleAdd: vi.fn(),
  list: vi.fn(async () => []),
}))
const stores = vi.hoisted(() => ({
  expectPasskeyCriticalKey: vi.fn(),
  settlePasskeyCriticalKey: vi.fn(),
  storeEncryptionKey: vi.fn(),
  storeEncryptionKeyType: vi.fn(),
  getPrivateKey: vi.fn((): string | null => null),
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
vi.mock('@/lib/app-connect/platform-port', () => ({ appConnectPlatformPort: port }))
vi.mock('@/lib/app-connect/session-manager', () => ({ appConnectSessions: { current: () => null } }))
vi.mock('@/lib/app-connect/session-health', () => ({ primaryGroupKey: () => null }))
vi.mock('@/lib/app-connect/wallet-sign-in', () => ({ wipeGrant: () => undefined }))
vi.mock('@/lib/app-connect/yappr-request', () => ({ buildYapprAppConnectRequest: () => ({}) }))
vi.mock('@/lib/app-connect/anchor-key-mark', () => ({ rememberAnchorKey: vi.fn() }))
vi.mock('@/lib/crypto/encryption-key-lookup', () => ({ resolveEncryptionPublicKey: () => null }))

import { PasskeyCancelledError } from 'platform-auth'
import { forgetUnsettledPasskey, rememberUnsettledPasskey, unsettledPasskey } from './passkey-device'
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

/** A key session that can keep a passkey: its HIGH sign-in key, on chain. */
function keySession(): void {
  const signIn = new Uint8Array(32).fill(11)
  stores.getPrivateKey.mockReturnValue(privateKeyToWif(signIn, keyNetwork(), true))
  port.getIdentityFresh.mockResolvedValue({ publicKeys: [{ id: 2, type: 0, purpose: 0, securityLevel: 2, data: getPublicKey(signIn) }] })
}

const receipt = (documentId: string) => ({ contractId: VAULT, documentType: 'vaultEntry', ownerId: IDENTITY, documentId, nonce: BigInt(5), transition: new Uint8Array([1]) })
const storedReceipt = (documentId: string) => ({ contractId: VAULT, documentType: 'vaultEntry', ownerId: IDENTITY, documentId, nonce: '5', transition: 'AQ' })

/** The enrolment the planted record restores to. */
function restored(seed: number): PendingPasskey {
  plant(recipientFromPrf(prfOf(seed)).publicKey)
  const pending = pendingEnrolmentFor(IDENTITY)
  if (!pending) throw new Error('not restored')
  return pending
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
    const pending = restored(66)
    expect(await settled(checkPendingEnrolment(pending))).toBe('confirm')
    expect(vault.add).not.toHaveBeenCalled()
    expect(stores.getPrivateKey).not.toHaveBeenCalled()
  })

  it('is dropped, with nothing sealed, when its passkey opens something else', async () => {
    const pending = restored(66)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(7) })

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
    const pending = restored(7)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(7) })

    // Sealing starts (it reads the session's keys; none here, so it stops there).
    await expect(settled(confirmPendingEnrolment(pending))).rejects.toThrow()
    expect(pending.vouchedFor).toEqual(recipientFromPrf(prfOf(7)).publicKey)
    expect(stores.getPrivateKey).toHaveBeenCalledWith(IDENTITY)
    expect(unsettledPasskey(IDENTITY)).not.toBeNull()
  })
})

describe('a pending enrolment restored from storage, settled', () => {
  it('keeps a record its passkey gives no PRF for: that proves nothing', async () => {
    const pending = restored(66)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: null })
    await expect(settled(confirmPendingEnrolment(pending))).rejects.toMatchObject({ code: 'no-prf' })
    expect(unsettledPasskey(IDENTITY)).not.toBeNull()
  })

  it('never drops an unvouched passkey from the provider when its writes are proved never recorded', async () => {
    // A planted record naming someone's real (public) credential id, with a write that was never recorded.
    rememberUnsettledPasskey(IDENTITY, {
      vault: VAULT,
      credentialId: bytesToBase64Url(CREDENTIAL),
      recipientKey: bytesToHex(recipientFromPrf(prfOf(66)).publicKey),
      receipts: [{ contractId: VAULT, documentType: 'vaultEntry', ownerId: IDENTITY, documentId: 'doc-1', nonce: '5', transition: 'AQ' }],
    })
    vault.settleAdd.mockResolvedValue('not-recorded')
    const pending = pendingEnrolmentFor(IDENTITY) as PendingPasskey

    expect(await settled(checkPendingEnrolment(pending))).toBe('not-saved')
    expect(unsettledPasskey(IDENTITY)).toBeNull()
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
  })

  it('drops, with nothing sealed, a record whose passkey belongs to another account', async () => {
    // Another account's real passkey: its public credential id and recipient key, and the same PRF.
    const pending = restored(7)
    const other = bs58.encode(new Uint8Array(32).fill(8))
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: handleOf(other), prfOutput: prfOf(7) })
    await expect(settled(confirmPendingEnrolment(pending))).rejects.toBeInstanceOf(PasskeyVaultError)
    expect(pending.vouchedFor).toBeUndefined()
    expect(stores.getPrivateKey).not.toHaveBeenCalled()
    expect(unsettledPasskey(IDENTITY)).toBeNull()
    // That passkey is the other account's: never dropped from the provider.
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
  })

  it('keeps a record whose passkey gives no user handle: that proves nothing, and nothing is sealed', async () => {
    const pending = restored(7)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: null, prfOutput: prfOf(7) })
    await expect(settled(confirmPendingEnrolment(pending))).rejects.toMatchObject({ code: 'not-yappr' })
    expect(pending.vouchedFor).toBeUndefined()
    expect(stores.getPrivateKey).not.toHaveBeenCalled()
    expect(unsettledPasskey(IDENTITY)).not.toBeNull()
  })

  it('never drops the passkey when another tab ended the enrolment while these writes were being proved', async () => {
    const pending = restored(7)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(7) })
    await settled(confirmPendingEnrolment(pending)).catch(() => undefined)
    expect(pending.vouchedFor).toEqual(recipientFromPrf(prfOf(7)).publicKey)
    // This tab holds write R1; another tab saved a later write and retired the record while R1 was being proved.
    pending.receipts = [{ contractId: VAULT, documentType: 'vaultEntry', ownerId: IDENTITY, documentId: 'doc-1', nonce: BigInt(5), transition: new Uint8Array([1]) }]
    vault.settleAdd.mockImplementation(async () => {
      forgetUnsettledPasskey(IDENTITY, bytesToBase64Url(CREDENTIAL))
      return 'not-recorded'
    })
    vi.clearAllMocks()
    // Refreshed before settling: put the record back so this tab reaches the proof.
    rememberUnsettledPasskey(IDENTITY, { vault: VAULT, credentialId: bytesToBase64Url(CREDENTIAL), recipientKey: bytesToHex(recipientFromPrf(prfOf(7)).publicKey), receipts: [{ contractId: VAULT, documentType: 'vaultEntry', ownerId: IDENTITY, documentId: 'doc-1', nonce: '5', transition: 'AQ' }] })
    await settled(checkPendingEnrolment(pending))
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
  })

  it('sends nothing, and drops nothing, when the record went before a later write could be held', async () => {
    keySession()
    const pending = restored(7)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(7) })
    vault.settleAdd.mockResolvedValue('stalled')
    pending.receipts = [receipt('doc-1')]
    rememberUnsettledPasskey(IDENTITY, { vault: VAULT, credentialId: bytesToBase64Url(CREDENTIAL), recipientKey: bytesToHex(recipientFromPrf(prfOf(7)).publicKey), receipts: [storedReceipt('doc-1')] })
    vault.add.mockImplementation(async (_owner: string, _entry: unknown, options: { beforeBroadcast?: (sent: unknown) => void }) => {
      // Another tab settled it (and may have dropped the passkey) just before this write's hold.
      forgetUnsettledPasskey(IDENTITY, bytesToBase64Url(CREDENTIAL))
      try {
        options.beforeBroadcast?.(receipt('doc-2'))
      } catch (refusal) {
        throw new Error(String(refusal))
      }
      return { confirmed: true }
    })

    expect(await settled(confirmPendingEnrolment(pending))).toBe('not-saved')
    expect(unsettledPasskey(IDENTITY)).toBeNull()
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
  })

  it('never seals to a recipient key storage swapped in during a refused re-save', async () => {
    keySession()
    const pending = restored(7)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(7) })
    pending.receipts = [receipt('doc-1')]
    rememberUnsettledPasskey(IDENTITY, { vault: VAULT, credentialId: bytesToBase64Url(CREDENTIAL), recipientKey: bytesToHex(recipientFromPrf(prfOf(7)).publicKey), receipts: [storedReceipt('doc-1')] })
    vault.settleAdd.mockResolvedValue('stalled')
    const attacker = recipientFromPrf(prfOf(66)).publicKey
    const sealedTo: Uint8Array[] = []
    vault.add.mockImplementation(async (_owner: string, entry: { recipientKey: Uint8Array }, options: { beforeBroadcast?: (sent: unknown) => void }) => {
      sealedTo.push(entry.recipientKey)
      options.beforeBroadcast?.(receipt(`doc-${sealedTo.length + 1}`))
      // Someone able to write this site's storage swaps the record's recipient key, then the write is refused.
      rememberUnsettledPasskey(IDENTITY, { vault: VAULT, credentialId: bytesToBase64Url(CREDENTIAL), recipientKey: bytesToHex(attacker), receipts: [storedReceipt('doc-1'), storedReceipt(`doc-${sealedTo.length + 1}`)] })
      throw new Error('refused')
    })
    await expect(settled(confirmPendingEnrolment(pending))).rejects.toThrow('refused')

    // The next check never seals to the swapped key: the passkey has to vouch again.
    expect(await settled(checkPendingEnrolment(pending))).toBe('confirm')
    expect(sealedTo).toEqual([recipientFromPrf(prfOf(7)).publicKey])
  })

  it('treats a recipient key changed under the tab as unvouched again', async () => {
    const pending = restored(7)
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(7) })
    await settled(confirmPendingEnrolment(pending)).catch(() => undefined)
    expect(pending.vouchedFor).toEqual(recipientFromPrf(prfOf(7)).publicKey)
    // Another tab (or anyone with this site's storage) rewrites the record's recipient key.
    plant(recipientFromPrf(prfOf(66)).publicKey)
    vi.clearAllMocks()
    expect(await settled(checkPendingEnrolment(pending))).toBe('confirm')
    expect(stores.getPrivateKey).not.toHaveBeenCalled()
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

  it('drops it when the sheet is closed after the dialog went (say, a sign-out meanwhile)', async () => {
    const pending = made()
    let dialogOpen = true
    auth.getPasskeyPrf.mockImplementation(async () => {
      // The session ends while the confirming sheet is open; then the sheet is closed.
      dialogOpen = false
      throw new PasskeyCancelledError()
    })
    await expect(finishPasskeyEnrolment(pending, () => dialogOpen)).rejects.toMatchObject({ code: 'cancelled' })
    expect(pending.createPrf).toEqual(new Uint8Array(32))
    expect(auth.signalUnknownPasskey).toHaveBeenCalledWith('localhost', CREDENTIAL)
  })

  it('never drops a passkey whose first write went out unconfirmed, even once another tab saw it saved', async () => {
    keySession()
    // The create goes out with no verdict; the hold before it stored the record.
    vault.add.mockImplementation(async (_owner: string, _entry: unknown, options: { beforeBroadcast?: (sent: unknown) => void }) => {
      options.beforeBroadcast?.(receipt('doc-1'))
      return { confirmed: false }
    })
    // While this tab reads back, the user signs out here and another tab sees the entry and retires the record.
    vault.find.mockImplementation(async () => {
      forgetPendingEnrolments()
      forgetUnsettledPasskey(IDENTITY, bytesToBase64Url(CREDENTIAL))
      return null
    })
    const pending = made()
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(5) })

    await expect(settled(finishPasskeyEnrolment(pending))).rejects.toMatchObject({ code: 'pending' })
    expect(vault.add).toHaveBeenCalledTimes(1)
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
    expect(pending.createPrf).toEqual(new Uint8Array(32))
  })

  it('keeps a passkey whose first write was refused while another tab\'s later write for it is still out', async () => {
    keySession()
    vault.add.mockImplementation(async (_owner: string, _entry: unknown, options: { beforeBroadcast?: (sent: unknown) => void }) => {
      options.beforeBroadcast?.(receipt('doc-1'))
      // Another tab resumed it and sent a later write, which may land.
      rememberUnsettledPasskey(IDENTITY, { vault: VAULT, credentialId: bytesToBase64Url(CREDENTIAL), recipientKey: bytesToHex(recipientFromPrf(prfOf(5)).publicKey), receipts: [storedReceipt('doc-1'), storedReceipt('doc-2')] })
      throw new Error('refused')
    })
    const pending = made()
    auth.getPasskeyPrf.mockResolvedValue({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(5) })

    await expect(settled(finishPasskeyEnrolment(pending))).rejects.toMatchObject({ code: 'pending' })
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()
    expect(unsettledPasskey(IDENTITY)?.receipts.map((sent) => sent.documentId)).toEqual(['doc-2'])
  })

  it('never drops a passkey whose refused first write was overtaken by another tab saving it', async () => {
    keySession()
    const recipient = recipientFromPrf(prfOf(5)).publicKey
    vault.add.mockImplementation(async (_owner: string, _entry: unknown, options: { beforeBroadcast?: (sent: unknown) => void }) => {
      options.beforeBroadcast?.(receipt('doc-1'))
      // Another tab resumed it, saved a later write, and retired the record before this refusal is cleaned up.
      forgetUnsettledPasskey(IDENTITY, bytesToBase64Url(CREDENTIAL))
      throw new Error('refused')
    })
    vault.find.mockResolvedValue({ recipientKey: recipient })
    // A fresh PRF output each sign-in (each is wiped once used).
    auth.getPasskeyPrf.mockImplementation(async () => ({ credentialId: CREDENTIAL, userHandle: HANDLE, prfOutput: prfOf(5) }))

    await expect(settled(finishPasskeyEnrolment(made()))).resolves.toBeUndefined()
    expect(auth.signalUnknownPasskey).not.toHaveBeenCalled()

    // Not visible here yet: still never dropped.
    vault.find.mockResolvedValue(null)
    await expect(settled(finishPasskeyEnrolment(made()))).rejects.toBeInstanceOf(PasskeyVaultError)
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
    // A messaging key that cannot be kept never throws into the commit, which has already stored the session.
    expect(() => hooks.afterStore()).not.toThrow()
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
