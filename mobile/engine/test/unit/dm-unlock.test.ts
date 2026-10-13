/**
 * `dm.unlock` with a typed key (PRD DM-02) on an identity that holds two
 * ENCRYPTION keys: only the one messages use (`findEncryptionKey`, the one
 * peers encrypt to) may unlock them (SR-07). On App Connect builds that is
 * the key bound to the `yappr-app` anchor, and `dm.setUpMessaging` adds it.
 */
import bs58 from 'bs58'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToHex } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import { ALICE_ID, ALICE_PRIV, BOB_ID, BOB_PRIV } from '@/lib/dm/test-fixtures'

const alice = bs58.encode(ALICE_ID)

/** Alice's identity: an auth key, then two encryption keys (ids 4 and 5). */
const identity = vi.hoisted(() => ({ publicKeys: [] as unknown[], reads: [] as { fresh?: boolean }[] }))
vi.mock('@/lib/services/identity-service', async (load) => {
  const actual = await load<typeof import('@/lib/services/identity-service')>()
  const getIdentity = async (id: string, options: { fresh?: boolean } = {}) => {
    identity.reads.push(options)
    return { id, balance: 0, revision: 1, publicKeys: identity.publicKeys }
  }
  return { ...actual, identityService: Object.assign(Object.create(actual.identityService), { getIdentity }) }
})

// The IdentityUpdate adding a bound key: what it was asked to add, refused (as lib does) when the anchor has a key.
const bound = vi.hoisted(() => ({ requests: [] as { identityId: string; contractId: string; encryptionPrivateKey: Uint8Array }[] }))
vi.mock('@/lib/services/identity-update-builder', async (load) => {
  const actual = await load<typeof import('@/lib/services/identity-update-builder')>()
  return {
    ...actual,
    buildUnsignedBoundEncryptionKeyTransition: async (request: { identityId: string; contractId: string; encryptionPrivateKey: Uint8Array }) => {
      // A copy: the caller zeroes its key once the link is built.
      bound.requests.push({ ...request, encryptionPrivateKey: request.encryptionPrivateKey.slice() })
      const keys = identity.publicKeys as { contractBounds?: unknown; disabledAt?: number; data: Uint8Array }[]
      if (keys.some(key => key.contractBounds && !key.disabledAt)) throw new actual.BoundKeyExistsError()
      const adding = getPublicKey(request.encryptionPrivateKey).join()
      if (keys.some(key => key.data.join() === adding)) throw new actual.KeyRetiredError()
      return { transitionBytes: new Uint8Array([1, 2, 3]), keyId: 7, identityRevision: BigInt(2) }
    },
  }
})

// Node has no browser secret store: record what would be stored.
const storeEncryptionKey = vi.hoisted(() => vi.fn())
vi.mock('@/lib/secure-storage', async (load) => ({ ...await load<object>(), storeEncryptionKey }))

const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())
const { createDmModule } = await import('../../src/api/dm')
const { storePrivateKey } = await import('@/lib/secure-storage')
const { privateKeyToWif } = await import('@/lib/crypto/wif')
const { deriveEncryptionKey } = await import('@/lib/crypto/derive-encryption-key')
const { stubAppConnectBuild } = await import('@/lib/test-storage')
const { parseYapprStateTransitionUri } = await import('platform-auth')
// lib's secret store keeps nothing without `window` (set after the imports: DM code listens on a real one).
Object.assign(globalThis, { window: globalThis })
const { createTicketStore } = await import('../../src/writes/tickets')

const encryptionKey = (id: number, priv: Uint8Array) => ({ id, purpose: 1, type: 0, securityLevel: 2, data: getPublicKey(priv) })
identity.publicKeys = [
  { id: 0, purpose: 0, type: 0, securityLevel: 0, data: getPublicKey(BOB_PRIV.map(b => b ^ 1)) },
  encryptionKey(4, ALICE_PRIV),
  encryptionKey(5, BOB_PRIV),
]

function unlocker(unhydrated?: ReadonlySet<string>) {
  const storage = { getItem: () => null, setItem: () => undefined }
  const tickets = createTicketStore({ storage, emit: () => undefined, currentIdentity: () => alice, documentExists: async () => true })
  const dm = createDmModule({
    emit: () => undefined,
    tickets,
    backend: 'v5',
    v5Source: { engineFor: () => null, release: () => undefined },
    viewer: () => alice,
    unhydrated,
  })
  return dm.api
}

describe('dm.unlock with a typed key on an identity with two encryption keys', () => {
  beforeEach(() => storeEncryptionKey.mockClear())

  it('refuses the key messages do not use, and stores nothing', async () => {
    const dm = unlocker()
    await expect(dm.unlock({ key: bytesToHex(BOB_PRIV) })).rejects.toMatchObject({ code: 'KEY_INVALID', message: expect.stringContaining('key 4') })
    expect(storeEncryptionKey).not.toHaveBeenCalled()
  })

  it('unlocks with the key messages use', async () => {
    const dm = unlocker()
    expect(await dm.unlock({ key: bytesToHex(ALICE_PRIV) })).toMatchObject({ unlocked: true })
    expect(storeEncryptionKey).toHaveBeenCalledWith(alice, bytesToHex(ALICE_PRIV))
  })
})

describe('dm.unlock deriving the key from the sign-in key', () => {
  const authKey = BOB_PRIV.map(b => b ^ 7)
  beforeEach(() => {
    storeEncryptionKey.mockClear()
    storePrivateKey(alice, privateKeyToWif(authKey, 'testnet'))
    identity.publicKeys = [encryptionKey(4, deriveEncryptionKey(authKey, alice))]
  })

  it('derives and stores it when it matches the identity', async () => {
    expect(await unlocker().unlock()).toMatchObject({ unlocked: true })
    expect(storeEncryptionKey).toHaveBeenCalledTimes(1)
  })

  it('never derives for an account whose stored secrets this engine was not given (AUTH-14)', async () => {
    expect(await unlocker(new Set([alice])).unlock()).toEqual({ unlocked: false, reason: 'not-derivable' })
    expect(storeEncryptionKey).not.toHaveBeenCalled()
  })
})

describe('App Connect builds: the messaging key bound to the anchor', () => {
  const anchor = bs58.encode(new Uint8Array(32).fill(1))
  const authKey = BOB_PRIV.map(b => b ^ 9)
  const anchorKey = deriveEncryptionKey(authKey, alice, anchor)
  const boundKey = (id: number, priv: Uint8Array) => ({ ...encryptionKey(id, priv), contractBounds: { $type: 'singleContract', id: anchor } })
  // Signed up before messaging keys were bound: the unbound key the old first login registered.
  const unbound = encryptionKey(5, deriveEncryptionKey(authKey, alice, null))

  beforeEach(() => {
    stubAppConnectBuild(anchor, bs58.encode(new Uint8Array(32).fill(3)))
    storeEncryptionKey.mockClear()
    bound.requests.length = 0
    identity.reads.length = 0
    storePrivateKey(alice, privateKeyToWif(authKey, 'testnet'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('needs setup when the identity has no anchor key: an unbound key does not count', async () => {
    identity.publicKeys = [unbound]
    expect(await unlocker().unlock()).toEqual({ unlocked: false, reason: 'needs-setup' })
    // Read afresh, so a key that just landed counts.
    expect(identity.reads[0]).toEqual({ fresh: true })
    expect(storeEncryptionKey).not.toHaveBeenCalled()
  })

  it('unlocks with the anchor key derived from the sign-in key', async () => {
    identity.publicKeys = [unbound, boundKey(6, anchorKey)]
    expect(await unlocker().unlock()).toMatchObject({ unlocked: true })
    expect(storeEncryptionKey).toHaveBeenCalledWith(alice, privateKeyToWif(anchorKey, 'testnet'))
  })

  it('sets messaging up with a wallet link adding that key, bound to the anchor', async () => {
    identity.publicKeys = [unbound]
    const result = await unlocker().setUpMessaging()
    if (result.unlocked || result.reason !== 'approve-in-wallet') throw new Error(`expected a wallet link, got ${JSON.stringify(result)}`)
    expect(parseYapprStateTransitionUri(result.uri)?.transitionBytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(bound.requests).toEqual([{ identityId: alice, contractId: anchor, encryptionPrivateKey: anchorKey }])
    expect(storeEncryptionKey).not.toHaveBeenCalled()
  })

  it('never adds a second anchor key: with one there, setup answers what unlock does', async () => {
    identity.publicKeys = [boundKey(6, anchorKey)]
    expect(await unlocker().setUpMessaging()).toMatchObject({ unlocked: true })

    // Another key is the anchor's: it must be entered, never replaced.
    storeEncryptionKey.mockClear()
    identity.publicKeys = [boundKey(6, ALICE_PRIV)]
    expect(await unlocker().setUpMessaging()).toEqual({ unlocked: false, reason: 'not-derivable' })
    expect(storeEncryptionKey).not.toHaveBeenCalled()

    // This sign-in's own key, disabled: Platform will not add it back, so messaging is set up on the web.
    identity.publicKeys = [{ ...boundKey(6, anchorKey), disabledAt: 1 }]
    expect(await unlocker().unlock()).toEqual({ unlocked: false, reason: 'needs-setup' })
    expect(await unlocker().setUpMessaging()).toEqual({ unlocked: false, reason: 'no-key-on-identity' })

    // One messages cannot use (not secp256k1) is not replaced either.
    identity.publicKeys = [{ ...boundKey(6, anchorKey), type: 2 }]
    expect(await unlocker().unlock()).toEqual({ unlocked: false, reason: 'needs-setup' })
    expect(await unlocker().setUpMessaging()).toEqual({ unlocked: false, reason: 'not-derivable' })
  })

  it('starts messages when lib confirms a stored key as the anchor key later (a wallet sign-in\'s)', async () => {
    const { rememberAnchorKey } = await import('@/lib/app-connect/anchor-key-mark')
    const engineFor = vi.fn(() => null)
    const tickets = createTicketStore({ storage: { getItem: () => null, setItem: () => undefined }, emit: () => undefined, currentIdentity: () => alice, documentExists: async () => true })
    createDmModule({ emit: () => undefined, tickets, backend: 'v5', v5Source: { engineFor, release: () => undefined }, viewer: () => alice })
    rememberAnchorKey(bs58.encode(BOB_ID), getPublicKey(anchorKey))
    expect(engineFor).not.toHaveBeenCalled()
    rememberAnchorKey(alice, getPublicKey(anchorKey))
    expect(engineFor).toHaveBeenCalledWith(alice)
  })
})

describe('legacy builds', () => {
  it('have no messaging setup: an identity without an encryption key has none', async () => {
    identity.publicKeys = []
    expect(await unlocker().unlock()).toEqual({ unlocked: false, reason: 'no-key-on-identity' })
    await expect(unlocker().setUpMessaging()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})
