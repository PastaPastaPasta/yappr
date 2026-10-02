/**
 * session.* with the real platform-auth controller, lib's secret store and the
 * engine's storage shim, over a stubbed chain: identity lookups, the
 * key-exchange contract and the key-registration builder are replaced, nothing
 * touches the network. The wallet side of the key exchange is played here
 * with the same crypto as the test-wallet responder (mobile/tools): ECDH with
 * a wallet ephemeral key through `deriveYapprSharedSecret`, then AES-256-GCM,
 * `nonce(12) || ciphertext || tag(16)`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'

const chain = vi.hoisted(() => ({
  keysRegistered: (() => Promise.resolve(true)) as (identityId: string, auth: Uint8Array, enc: Uint8Array) => Promise<boolean>,
  transition: { transitionBytes: new Uint8Array([1, 2, 3]), authKeyId: 5, encryptionKeyId: 6 },
}))

vi.mock('@/lib/services/identity-update-builder', () => ({
  checkKeysRegistered: (identityId: string, auth: Uint8Array, enc: Uint8Array) => chain.keysRegistered(identityId, auth, enc),
  buildUnsignedKeyRegistrationTransition: async () => chain.transition,
}))
// Post-login tasks read the network; they are covered by web.
vi.mock('@/lib/services/block-service', () => ({ blockService: { initializeBlockData: async () => undefined } }))
vi.mock('@/lib/services/private-feed-follower-service', () => ({
  privateFeedFollowerService: { syncFollowedFeeds: async () => ({ synced: [], failed: [], upToDate: [] }) },
}))
vi.mock('@/lib/services/dashpay-contacts-service', () => ({ dashPayContactsService: { getUnfollowedContacts: async () => ({ contacts: [] }) } }))

// lib's secret and session stores need `window` and the engine's storage, before lib loads.
const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
const engineStorage = createEngineStorage()
installEngineStorage(engineStorage)
Object.assign(globalThis, { window: globalThis })
/** Write-through as the host sees it, one entry per op; secure batches are acknowledged unless `holdAcks`. */
const changes: { area: 'local' | 'secure'; key: string; value: string | null }[] = []
let holdAcks = false
const heldAcks: number[] = []
engineStorage.onBatch(batch => {
  for (const op of batch.ops) {
    if (op[0] === 'set') changes.push({ area: batch.area, key: op[1], value: op[2] })
    if (op[0] === 'del') changes.push({ area: batch.area, key: op[1], value: null })
  }
  if (batch.area !== 'secure') return
  if (holdAcks) heldAcks.push(batch.seq)
  else queueMicrotask(() => engineStorage.ack(batch.seq))
})

const auth = await import('platform-auth')
const { createSessionModule, createMobileAuthController, foregroundBalanceRefresh } = await import('../../src/api/session')
const { toNetworkWif, verifySignInKey } = await import('../../src/session/keys')
const { createKeyExchange, PENDING_REQUEST_KEY } = await import('../../src/session/key-exchange')
const { identityService } = await import('@/lib/services/identity-service')
const { dpnsService } = await import('@/lib/services/dpns-service')
const { evoSdkService } = await import('@/lib/services/evo-sdk-service')
const { keyExchangeService } = await import('@/lib/services/key-exchange-service')
const { privateKeyToWif } = await import('@/lib/crypto/wif')
const { hash160 } = await import('@/lib/crypto/hash')
const { bytesToHex } = await import('@/lib/bytes')
const { deriveEncryptionKey } = await import('@/lib/crypto/key-derivation')
const { useLoginModal } = await import('@/hooks/use-login-modal')
const { YAPPR_CONTRACT_ID } = await import('@/lib/constants')

type Session = ReturnType<typeof createSessionModule>
type IdentityInfo = NonNullable<Awaited<ReturnType<typeof identityService.getIdentity>>>

const AUTH = 0, ENCRYPTION = 1, MASTER = 0, HIGH = 2, MEDIUM = 3, SECP256K1 = 0

function randomId(): string {
  return bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
}

/** On-chain identities the stubs serve, by id, with their keys. */
const identities = new Map<string, IdentityInfo>()
function addIdentity(keys: { id: number; purpose: number; securityLevel: number; privateKey: Uint8Array; disabledAt?: number }[]): string {
  const id = randomId()
  identities.set(id, {
    id,
    balance: 120_000,
    publicKeys: keys.map(key => ({ id: key.id, type: SECP256K1, purpose: key.purpose, securityLevel: key.securityLevel, data: secp256k1.getPublicKey(key.privateKey, true), readOnly: false, disabledAt: key.disabledAt })),
  } as unknown as IdentityInfo)
  return id
}

let emitted: { event: string; payload: unknown }[] = []
const emit = (event: string, payload: unknown) => { emitted.push({ event, payload }) }

/** A fresh engine boot over the same storage: a new controller and module, as after a restart. */
function boot(): Session {
  const unhydrated = new Set<string>()
  return createSessionModule({
    emit,
    controller: createMobileAuthController({ unhydrated }),
    unhydrated,
    secureDurable: () => engineStorage.secureDurable(),
    holdSecure: matches => engineStorage.holdSecure(matches),
  })
}

const secureKeys = () => Object.keys(engineStorage.snapshot().secure)

/** Restart the engine without `identityId`'s secrets, as the host hydrates a boot with that account parked. */
function bootWithout(identityId: string): Session {
  const { local, secure } = engineStorage.snapshot()
  engineStorage.hydrate({ local, secure: Object.fromEntries(Object.entries(secure).filter(([key]) => !key.endsWith(identityId))) })
  return boot()
}

/** What the host was asked to write or delete for `identityId`'s secrets. */
const secureChangesOf = (identityId: string) => changes.filter(c => c.area === 'secure' && c.key.endsWith(identityId))

/** Lets lib's background tasks after a login (the encryption-key auto-derive) run, then waits for the host. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
  await engineStorage.secureDurable()
}

beforeAll(() => {
  vi.spyOn(evoSdkService, 'initialize').mockResolvedValue(undefined)
  vi.spyOn(identityService, 'getIdentity').mockImplementation(async id => identities.get(id) ?? null)
  vi.spyOn(identityService, 'getBalance').mockImplementation(async id => ({ confirmed: identities.get(id)?.balance ?? 0, total: 0 }) as never)
  vi.spyOn(identityService, 'getIdentityIdByPublicKeyHash').mockImplementation(async hash => {
    for (const identity of identities.values()) {
      for (const key of identity.publicKeys) {
        if (bytesToHex(hash160(key.data as Uint8Array)) === bytesToHex(hash)) return identity.id
      }
    }
    return null
  })
  vi.spyOn(dpnsService, 'resolveUsername').mockResolvedValue(null)
})

beforeEach(() => {
  emitted = []
  changes.length = 0
})

describe('private keys', () => {
  const privateKey = secp256k1.utils.randomSecretKey()

  it('takes WIF or hex, and stores a WIF for this network', () => {
    const wif = privateKeyToWif(privateKey, 'testnet')
    expect(toNetworkWif(bytesToHex(privateKey))).toBe(wif)
    expect(toNetworkWif(`0x${bytesToHex(privateKey)}`)).toBe(wif)
    expect(toNetworkWif(`  ${wif}\n`)).toBe(wif)
  })

  it('refuses another network and garbage without echoing the input', () => {
    const mainnet = privateKeyToWif(privateKey, 'mainnet')
    expect(() => toNetworkWif(mainnet)).toThrow(expect.objectContaining({ code: 'KEY_WRONG_NETWORK' }))
    for (const input of ['hunter2', bytesToHex(privateKey).slice(2), `${mainnet}x`]) {
      expect(() => toNetworkWif(input)).toThrow(expect.objectContaining({ code: 'KEY_INVALID', message: 'Invalid private key' }))
    }
  })

  it('finds the identity by public key hash and requires a HIGH or CRITICAL auth key', async () => {
    const master = secp256k1.utils.randomSecretKey()
    const high = secp256k1.utils.randomSecretKey()
    const encryption = secp256k1.utils.randomSecretKey()
    const id = addIdentity([
      { id: 0, purpose: AUTH, securityLevel: MASTER, privateKey: master },
      { id: 2, purpose: AUTH, securityLevel: HIGH, privateKey: high },
      { id: 4, purpose: ENCRYPTION, securityLevel: MEDIUM, privateKey: encryption },
    ])
    expect(await verifySignInKey(bytesToHex(high))).toMatchObject({ identityId: id, keyId: 2, securityLevel: HIGH })
    await expect(verifySignInKey(bytesToHex(master))).rejects.toMatchObject({ code: 'KEY_NOT_ON_IDENTITY', message: expect.stringMatching(/MASTER/) })
    await expect(verifySignInKey(bytesToHex(encryption))).rejects.toMatchObject({ code: 'KEY_NOT_ON_IDENTITY' })
    await expect(verifySignInKey(bytesToHex(secp256k1.utils.randomSecretKey()))).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND', message: 'No identity uses this key' })
  })

  it('refuses a disabled auth key (lib\'s validatePrivateKey would accept it: #616)', async () => {
    const disabled = secp256k1.utils.randomSecretKey()
    addIdentity([{ id: 3, purpose: AUTH, securityLevel: HIGH, privateKey: disabled, disabledAt: 1_790_000_000_000 }])
    await expect(verifySignInKey(bytesToHex(disabled))).rejects.toMatchObject({ code: 'KEY_NOT_ON_IDENTITY', message: 'This key has been disabled on this identity' })
  })
})

describe('accounts: sign in, add, switch, restore, sign out', () => {
  const keyA = secp256k1.utils.randomSecretKey()
  const keyB = secp256k1.utils.randomSecretKey()
  let idA = ''
  let idB = ''
  let session: Session

  beforeAll(() => {
    idA = addIdentity([{ id: 2, purpose: AUTH, securityLevel: HIGH, privateKey: keyA }])
    idB = addIdentity([{ id: 2, purpose: AUTH, securityLevel: HIGH, privateKey: keyB }])
  })

  it('signs in with a hex key and stores the key in the secure area', async () => {
    session = boot()
    expect(await session.restore()).toBeNull()
    const signedIn = await session.signInWithKey({ key: bytesToHex(keyA) })
    expect(signedIn).toEqual({ identityId: idA, network: 'testnet', username: null, credits: 120_000n, hasEncryptionKey: false, method: 'key' })
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: signedIn, reason: 'signed-in' } })
    expect(secureKeys()).toContain(`yappr_secure_pk_${idA}`)
    // Never in the plain area, and never the raw hex anywhere.
    expect(changes.filter(c => c.area === 'local').map(c => c.value ?? '').join()).not.toContain(bytesToHex(keyA))
    expect(await session.current()).toEqual(signedIn)
  })

  it('reports a sign-in only once the host has acknowledged its keys', async () => {
    await session.signOut()
    holdAcks = true
    let settled = false
    const signingIn = session.signInWithKey({ key: bytesToHex(keyA) }).then(result => { settled = true; return result })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(heldAcks.length).toBeGreaterThan(0)
    expect(settled).toBe(false)
    holdAcks = false
    heldAcks.splice(0).forEach(seq => engineStorage.ack(seq))
    expect((await signingIn).identityId).toBe(idA)
  })

  it('refuses to sign in again as the active identity', async () => {
    await expect(session.signInWithKey({ key: bytesToHex(keyA) })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This account is already signed in' })
  })

  it('refuses a second identity while one is active', async () => {
    await expect(session.signInWithKey({ key: bytesToHex(keyB) })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('adds a second account through a restart, refusing calls until then', async () => {
    await session.prepareAddAccount()
    expect(localStorage.getItem('yappr_session')).toBeNull()
    await expect(session.current()).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
    await expect(session.signInWithKey({ key: bytesToHex(keyB) })).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
    session = boot()
    expect(await session.restore()).toBeNull()
    expect((await session.signInWithKey({ key: privateKeyToWif(keyB, 'testnet') })).identityId).toBe(idB)
    expect((await session.accounts()).map(a => [a.identityId, a.active])).toEqual([[idB, true], [idA, false]])
  })

  it('switches back with a restart, which restores the other session and reports `switched`', async () => {
    await session.switchAccount(idA)
    expect(JSON.parse(localStorage.getItem('yappr_session') ?? '{}').user.identityId).toBe(idA)
    session = boot()
    const restored = await session.restore()
    expect(restored?.identityId).toBe(idA)
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: restored, reason: 'switched' } })
    await expect(session.switchAccount(randomId())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('reports `key-invalid` when the stored key no longer signs for the session identity', async () => {
    const saved = localStorage.getItem(`yappr_secure_pk_${idA}`)
    localStorage.setItem(`yappr_secure_pk_${idA}`, JSON.stringify(privateKeyToWif(secp256k1.utils.randomSecretKey(), 'testnet')))
    const before = localStorage.getItem('yappr_session')
    session = boot()
    expect(await session.restore()).toBeNull()
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: null, reason: 'key-invalid' } })
    // Put A back for the sign-out cases.
    localStorage.setItem(`yappr_secure_pk_${idA}`, saved ?? '')
    localStorage.setItem('yappr_session', before ?? '')
    session = boot()
    expect((await session.restore())?.identityId).toBe(idA)
  })

  it('signs another account out by clearing its secrets by name, even ones the engine does not hold', async () => {
    localStorage.removeItem(`yappr_secure_pk_${idB}`)
    changes.length = 0
    await session.signOut({ identityId: idB })
    const deleted = changes.filter(c => c.area === 'secure' && c.value === null).map(c => c.key)
    expect(deleted).toEqual(expect.arrayContaining([`yappr_secure_pk_${idB}`, `yappr_secure_ek_${idB}`, `yappr_secure_lk_${idB}`]))
    expect((await session.accounts()).map(a => a.identityId)).toEqual([idA])
    expect((await session.current())?.identityId).toBe(idA)
  })

  it('signs the active account out offline: keys, session and registry gone', async () => {
    await session.signOut()
    expect(secureKeys().filter(key => key.endsWith(idA))).toEqual([])
    expect(localStorage.getItem('yappr_session')).toBeNull()
    expect(await session.accounts()).toEqual([])
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: null, reason: 'signed-out' } })
  })

  it('lets only one of two concurrent sign-ins take the session slot', async () => {
    const results = await Promise.allSettled([
      session.signInWithKey({ key: bytesToHex(keyA) }),
      session.signInWithKey({ key: bytesToHex(keyB) }),
    ])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(results[1]).toMatchObject({ reason: { code: 'BAD_REQUEST' } })
    expect((await session.current())?.identityId).toBe(idA)
    expect((await session.accounts()).map(a => a.identityId)).toEqual([idA])
    await session.signOut()
  })

  it('signing a parked account in again by key keeps its stored encryption key (AUTH-14)', async () => {
    // The new key derives the identity's on-chain encryption key, so lib's auto-derive would store it.
    const oldKey = secp256k1.utils.randomSecretKey()
    const newKey = secp256k1.utils.randomSecretKey()
    const withKeys = (id: string, auth: Uint8Array[]) => {
      const encryption = deriveEncryptionKey(auth[auth.length - 1], id)
      identities.set(id, {
        id,
        balance: 1,
        publicKeys: [
          ...auth.map((key, i) => ({ id: 2 + i, type: SECP256K1, purpose: AUTH, securityLevel: HIGH, data: secp256k1.getPublicKey(key, true), readOnly: false })),
          { id: 9, type: SECP256K1, purpose: ENCRYPTION, securityLevel: MEDIUM, data: secp256k1.getPublicKey(encryption, true), readOnly: false },
        ],
      } as unknown as IdentityInfo)
    }
    // Control: a first sign-in with such a key does store the derived key.
    const freshKey = secp256k1.utils.randomSecretKey()
    const fresh = randomId()
    withKeys(fresh, [freshKey])
    session = boot()
    await session.restore()
    await session.signInWithKey({ key: bytesToHex(freshKey) })
    await settle()
    expect(secureKeys()).toContain(`yappr_secure_ek_${fresh}`)
    await session.signOut()

    const id = randomId()
    withKeys(id, [oldKey, newKey])
    await session.signInWithKey({ key: bytesToHex(oldKey) })
    // An imported encryption key (for legacy messages), which the engine will not be given while A is parked.
    localStorage.setItem(`yappr_secure_ek_${id}`, JSON.stringify(privateKeyToWif(secp256k1.utils.randomSecretKey(), 'testnet')))
    localStorage.setItem(`yappr_secure_ekt_${id}`, '"imported"')
    await settle()
    await session.prepareAddAccount()
    session = bootWithout(id)
    expect(await session.restore()).toBeNull()
    changes.length = 0

    const signedIn = await session.signInWithKey({ key: bytesToHex(newKey) })
    await settle()
    expect(signedIn).toMatchObject({ identityId: id, hasEncryptionKey: false })
    // The new auth key is stored; the encryption key and its type are left to the stored ones.
    expect(secureChangesOf(id).map(c => c.key)).toEqual([`yappr_secure_pk_${id}`])
    await session.signOut()
  })

  it('turns lib\'s login-modal prompt into session.keyRequired', () => {
    useLoginModal.getState().open()
    expect(emitted).toContainEqual({ event: 'session.keyRequired', payload: { identityId: null, purpose: 'auth' } })
    expect(useLoginModal.getState().isOpen).toBe(false)
  })
})

describe('key exchange (dash-key:) with a stubbed chain', () => {
  let session: Session
  /** The wallet's answer, served once the app polls for the right hash. */
  let response: Awaited<ReturnType<typeof keyExchangeService.getResponse>> = null
  let polledHash: Uint8Array | null = null

  /** Play the wallet: approve `uri` for `identityId` with `loginKey`. */
  async function walletApproves(uri: string, identityId: string, loginKey: Uint8Array): Promise<void> {
    const parsed = auth.parseYapprKeyExchangeUri(uri)
    if (!parsed) throw new Error('unparseable dash-key: URI')
    const wallet = auth.generateYapprEphemeralKeyPair()
    const shared = auth.deriveYapprSharedSecret(wallet.privateKey, parsed.request.appEphemeralPubKey)
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const key = await crypto.subtle.importKey('raw', shared.slice().buffer, { name: 'AES-GCM' }, false, ['encrypt'])
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, loginKey.slice().buffer))
    const payload = new Uint8Array(12 + sealed.length)
    payload.set(nonce)
    payload.set(sealed, 12)
    response = {
      $id: randomId(),
      $ownerId: identityId,
      $revision: 1,
      contractId: parsed.request.contractId,
      appEphemeralPubKeyHash: auth.hash160(parsed.request.appEphemeralPubKey),
      walletEphemeralPubKey: wallet.publicKey,
      encryptedPayload: payload,
      keyIndex: 3,
    }
  }

  /** Put the auth key a login key derives for `id` on chain (what the wallet's IdentityUpdate does). */
  function registerKeys(id: string, loginKey: Uint8Array): void {
    const authKey = auth.deriveYapprAuthKeyFromLogin(loginKey, auth.decodeYapprIdentityId(id))
    const publicKeys = [{ id: 5, type: SECP256K1, purpose: AUTH, securityLevel: HIGH, data: auth.getYapprPublicKey(authKey), readOnly: false }]
    identities.set(id, { id, balance: 7, publicKeys } as unknown as IdentityInfo)
  }

  /** An identity the wallet answers for, with Yappr's keys on chain or not. */
  function walletIdentity(loginKey: Uint8Array, registered: boolean): string {
    const id = randomId()
    if (registered) registerKeys(id, loginKey)
    else identities.set(id, { id, balance: 7, publicKeys: [] } as unknown as IdentityInfo)
    return id
  }

  beforeAll(() => {
    vi.spyOn(keyExchangeService, 'getResponse').mockImplementation(async (contractIdBytes, hash) => {
      polledHash = hash
      expect(bs58.encode(contractIdBytes)).toBe(YAPPR_CONTRACT_ID)
      return response && bytesToHex(response.appEphemeralPubKeyHash) === bytesToHex(hash) ? response : null
    })
  })

  beforeEach(() => {
    response = null
    polledHash = null
    chain.keysRegistered = async (identityId, authPub) => {
      const keys = identities.get(identityId)?.publicKeys ?? []
      return keys.some(key => bytesToHex(key.data as Uint8Array) === bytesToHex(authPub))
    }
    session = boot()
  })

  afterEach(async () => {
    await session.signOut()
  })

  it('builds a dash-key: request for this app and network, and keeps the ephemeral key secret', async () => {
    const request = await session.startKeyExchange()
    const parsed = auth.parseYapprKeyExchangeUri(request.uri)
    expect(parsed).toMatchObject({ network: 'testnet', version: 1, request: { label: 'Login to Yappr' } })
    expect(bs58.encode(parsed?.request.contractId ?? new Uint8Array())).toBe(YAPPR_CONTRACT_ID)
    expect(request.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000)
    // Persisted only in the secure area, for resuming after the app is killed.
    expect(secureKeys()).toContain(PENDING_REQUEST_KEY)
    expect(engineStorage.snapshot().local[PENDING_REQUEST_KEY]).toBeUndefined()
    await session.cancelKeyExchange(request.requestId)
    expect(secureKeys()).not.toContain(PENDING_REQUEST_KEY)
  })

  it('answers pending until the wallet responds, then decrypts and signs in', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const request = await session.startKeyExchange()
    expect(await session.awaitKeyExchange(request.requestId, { waitMs: 1 })).toMatchObject({ status: 'pending', requestId: request.requestId })
    expect(polledHash).not.toBeNull()

    await walletApproves(request.uri, identityId, loginKey)
    const result = await session.awaitKeyExchange(request.requestId, { waitMs: 1 })
    expect(result).toMatchObject({ status: 'signed-in', session: { identityId, method: 'key-exchange', hasEncryptionKey: true } })

    // lib stored the keys derived from the login key, as web does.
    const idBytes = auth.decodeYapprIdentityId(identityId)
    const expectedWif = privateKeyToWif(auth.deriveYapprAuthKeyFromLogin(loginKey, idBytes), 'testnet')
    expect(JSON.parse(localStorage.getItem(`yappr_secure_pk_${identityId}`) ?? 'null')).toBe(expectedWif)
    expect(secureKeys()).toEqual(expect.arrayContaining([`yappr_secure_lk_${identityId}`, `yappr_secure_ek_${identityId}`]))
    expect(secureKeys()).not.toContain(PENDING_REQUEST_KEY)
    // The request is spent.
    await expect(session.awaitKeyExchange(request.requestId)).rejects.toMatchObject({ code: 'KEY_EXCHANGE_TIMEOUT' })
  })

  it('returns the dash-st: key registration for a first login, then signs in once the keys land', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, false)
    const request = await session.startKeyExchange()
    await walletApproves(request.uri, identityId, loginKey)

    const step = await session.awaitKeyExchange(request.requestId, { waitMs: 1 })
    expect(step).toMatchObject({
      status: 'needs-registration',
      requestId: request.requestId,
      keys: [
        { keyId: 5, purpose: 'authentication', securityLevel: 'high' },
        { keyId: 6, purpose: 'encryption', securityLevel: 'medium' },
      ],
    })
    if (step.status !== 'needs-registration') throw new Error('expected a registration')
    expect(auth.parseYapprStateTransitionUri(step.uri)).toMatchObject({ network: 'testnet', transitionBytes: new Uint8Array([1, 2, 3]) })

    expect(await session.awaitKeyRegistration(request.requestId, { waitMs: 1 })).toMatchObject({ status: 'pending' })
    registerKeys(identityId, loginKey)
    expect(await session.awaitKeyRegistration(request.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in', session: { identityId } })
  })

  it('signs in once when two calls race to complete the same approval', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, false)
    const request = await session.startKeyExchange()
    await walletApproves(request.uri, identityId, loginKey)
    expect((await session.awaitKeyExchange(request.requestId, { waitMs: 1 })).status).toBe('needs-registration')
    registerKeys(identityId, loginKey)
    const complete = vi.spyOn(auth.PlatformAuthController.prototype, 'completeYapprKeyExchangeLogin')
    const [first, second] = await Promise.all([
      session.awaitKeyExchange(request.requestId, { waitMs: 1 }),
      session.awaitKeyExchange(request.requestId, { waitMs: 1 }),
    ])
    expect(complete).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ status: 'signed-in', session: { identityId } })
    // The stored login key is the real one, not a zeroed buffer.
    expect(JSON.parse(localStorage.getItem(`yappr_secure_lk_${identityId}`) ?? '""')).not.toMatch(/^A+=*$/)
    complete.mockRestore()
  })

  it('drops the answer of a poll that a newer call superseded, and zeroes its key', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const request = await session.startKeyExchange()
    await walletApproves(request.uri, identityId, loginKey)
    // The first poll's read is still in flight when the host calls again.
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const getResponse = keyExchangeService.getResponse
    const spy = vi.spyOn(keyExchangeService, 'getResponse').mockImplementationOnce(async (...args) => { await gate; return getResponse.call(keyExchangeService, ...args) })
    const first = session.awaitKeyExchange(request.requestId, { waitMs: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = await session.awaitKeyExchange(request.requestId, { waitMs: 1 })
    expect(second).toMatchObject({ status: 'signed-in', session: { identityId } })
    release()
    await expect(first).rejects.toMatchObject({ code: 'KEY_EXCHANGE_CANCELLED' })
    expect(spy).toHaveBeenCalled()
  })

  it('resumes a request after the engine restarts', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const request = await session.startKeyExchange()
    session = boot()
    expect(await session.pendingKeyExchange()).toEqual(request)
    await walletApproves(request.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(request.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in' })
  })

  it('switches to an account parked by "Add account" instead of logging it in again', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const first = await session.startKeyExchange()
    await walletApproves(first.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(first.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in' })
    const savedKey = localStorage.getItem(`yappr_secure_pk_${identityId}`)

    await session.prepareAddAccount()
    session = boot()
    expect(await session.restore()).toBeNull()
    const login = vi.spyOn(auth.PlatformAuthController.prototype, 'completeYapprKeyExchangeLogin')
    changes.length = 0
    // Only the accounts the host names as signed in again log in afresh.
    const request = await session.startKeyExchange({ reauth: [randomId()] })
    await walletApproves(request.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(request.requestId, { waitMs: 1 })).toEqual({ status: 'switch', identityId })
    // No login ran, so nothing could clear the parked account's keys, and the engine waits for its restart.
    expect(login).not.toHaveBeenCalled()
    login.mockRestore()
    expect(changes.filter(c => c.area === 'secure' && c.key.endsWith(identityId))).toEqual([])
    await expect(session.current()).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
    await expect(session.awaitKeyExchange(request.requestId)).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })

    session = boot()
    const restored = await session.restore()
    expect(restored?.identityId).toBe(identityId)
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: restored, reason: 'switched' } })
    expect(localStorage.getItem(`yappr_secure_pk_${identityId}`)).toBe(savedKey)
  })

  it('logs a parked account in again when the host is signing it in again (AUTH-14)', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const first = await session.startKeyExchange()
    await walletApproves(first.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(first.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in' })
    // Its stored key stopped working; the host parks it and asks the wallet again.
    localStorage.setItem(`yappr_secure_pk_${identityId}`, 'broken')

    await session.prepareAddAccount()
    session = boot()
    expect(await session.restore()).toBeNull()
    const login = vi.spyOn(auth.PlatformAuthController.prototype, 'completeYapprKeyExchangeLogin')
    const request = await session.startKeyExchange({ reauth: [identityId] })
    await walletApproves(request.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(request.requestId, { waitMs: 1 })).toMatchObject({
      status: 'signed-in',
      session: { identityId },
    })
    expect(login).toHaveBeenCalledTimes(1)
    login.mockRestore()
    expect(localStorage.getItem(`yappr_secure_pk_${identityId}`)).not.toBe('broken')
    expect(await session.accounts()).toEqual([expect.objectContaining({ identityId, active: true })])
    for (const reauth of [identityId, [42]] as unknown as string[][]) {
      await expect(session.startKeyExchange({ reauth })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
  })

  it('keeps the parked account\'s stored secrets when signing it in again fails (AUTH-14)', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const first = await session.startKeyExchange()
    await walletApproves(first.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(first.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in' })
    // An imported encryption key, which a wallet login cannot derive again.
    localStorage.setItem(`yappr_secure_ek_${identityId}`, 'imported-ek')
    localStorage.setItem(`yappr_secure_ekt_${identityId}`, '"imported"')
    await engineStorage.secureDurable()

    await session.prepareAddAccount()
    // The restarted engine is not given the parked account's secrets.
    session = bootWithout(identityId)
    expect(await session.restore()).toBeNull()
    changes.length = 0
    const login = vi.spyOn(auth.PlatformAuthController.prototype, 'loginWithAuthKey').mockRejectedValueOnce(new Error('Network error'))
    const request = await session.startKeyExchange({ reauth: [identityId] })
    await walletApproves(request.uri, identityId, loginKey)
    await expect(session.awaitKeyExchange(request.requestId, { waitMs: 1 })).rejects.toThrow()
    login.mockRestore()
    await engineStorage.secureDurable()
    // lib cleared the identity's keys by name, but the host heard nothing: its stored secrets stay.
    expect(changes.filter(c => c.area === 'secure' && c.key.endsWith(identityId))).toEqual([])
    expect(secureKeys().filter(key => key.endsWith(identityId))).toEqual([])
  })

  /** An account signed in by wallet, then parked by "Add account", with the engine restarted signed out. */
  async function parkedWalletAccount(): Promise<{ identityId: string; loginKey: Uint8Array }> {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const first = await session.startKeyExchange()
    await walletApproves(first.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(first.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in' })
    await session.prepareAddAccount()
    session = bootWithout(identityId)
    expect(await session.restore()).toBeNull()
    return { identityId, loginKey }
  }

  it('still signs the account in again when the engine restarts while the wallet is out (AUTH-14)', async () => {
    const { identityId, loginKey } = await parkedWalletAccount()
    const request = await session.startKeyExchange({ reauth: [identityId] })
    // The engine restarts; the host polls the same persisted request on the new one.
    session = boot()
    expect(await session.pendingKeyExchange()).toEqual(request)
    const login = vi.spyOn(auth.PlatformAuthController.prototype, 'completeYapprKeyExchangeLogin')
    await walletApproves(request.uri, identityId, loginKey)
    expect(await session.awaitKeyExchange(request.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in', session: { identityId } })
    expect(login).toHaveBeenCalledTimes(1)
    login.mockRestore()
  })

  it('refuses a wallet sign-in whose key is disabled on the identity, keeping the parked account (AUTH-14)', async () => {
    const { identityId, loginKey } = await parkedWalletAccount()
    // Platform disabled the key the wallet's login key derives; the wallet answers with it again.
    const identity = identities.get(identityId)
    if (!identity) throw new Error('no identity')
    identities.set(identityId, { ...identity, publicKeys: identity.publicKeys.map(key => ({ ...key, disabledAt: 1_790_000_000_000 })) } as IdentityInfo)
    changes.length = 0
    const login = vi.spyOn(auth.PlatformAuthController.prototype, 'completeYapprKeyExchangeLogin')
    const request = await session.startKeyExchange({ reauth: [identityId] })
    await walletApproves(request.uri, identityId, loginKey)
    await expect(session.awaitKeyExchange(request.requestId, { waitMs: 1 })).rejects.toMatchObject({
      code: 'KEY_DISABLED',
      message: 'The key this wallet uses for Yappr has been disabled on this identity',
    })
    expect(login).not.toHaveBeenCalled()
    login.mockRestore()
    await engineStorage.secureDurable()
    expect(secureChangesOf(identityId)).toEqual([])
    expect(await session.current()).toBeNull()
    expect(await session.accounts()).toContainEqual(expect.objectContaining({ identityId, active: false }))
    // Nothing to retry with that approval: the request is gone.
    await expect(session.awaitKeyExchange(request.requestId, { waitMs: 1 })).rejects.toMatchObject({ code: 'KEY_EXCHANGE_TIMEOUT' })
  })

  it('keeps the approval for a retry when the key check cannot read the identity', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const request = await session.startKeyExchange()
    await walletApproves(request.uri, identityId, loginKey)
    vi.mocked(identityService.getIdentity).mockRejectedValueOnce(new Error('Network error'))
    await expect(session.awaitKeyExchange(request.requestId, { waitMs: 1 })).rejects.toThrow('Network error')
    expect(await session.current()).toBeNull()
    expect(await session.awaitKeyExchange(request.requestId, { waitMs: 1 })).toMatchObject({ status: 'signed-in', session: { identityId } })
  })

  it('refuses a first wallet sign-in with a disabled key too', async () => {
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    const identityId = walletIdentity(loginKey, true)
    const identity = identities.get(identityId)
    if (!identity) throw new Error('no identity')
    identities.set(identityId, { ...identity, publicKeys: identity.publicKeys.map(key => ({ ...key, disabledAt: 1 })) } as IdentityInfo)
    const request = await session.startKeyExchange()
    await walletApproves(request.uri, identityId, loginKey)
    await expect(session.awaitKeyExchange(request.requestId, { waitMs: 1 })).rejects.toMatchObject({ code: 'KEY_DISABLED' })
    expect(await session.current()).toBeNull()
  })

  it('cancels a waiting poll', async () => {
    const request = await session.startKeyExchange()
    const waiting = session.awaitKeyExchange(request.requestId, { waitMs: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 10))
    await session.cancelKeyExchange(request.requestId)
    await expect(waiting).rejects.toMatchObject({ code: 'KEY_EXCHANGE_CANCELLED' })
    expect(await session.pendingKeyExchange()).toBeNull()
  })
})

describe('key exchange request lifetime', () => {
  it('expires a request after 10 minutes', async () => {
    let clock = Date.now()
    const kx = createKeyExchange({
      controller: createMobileAuthController(),
      storage: localStorage,
      complete: async () => ({ status: 'signed-in' as const, session: 'signed-in' }),
      now: () => clock,
    })
    const request = kx.start()
    clock += 10 * 60 * 1000 + 1
    expect(kx.pending()).toBeNull()
    await expect(kx.await(request.requestId)).rejects.toMatchObject({ code: 'KEY_EXCHANGE_TIMEOUT' })
  })
})

describe('direct messages around sign-out and account changes', () => {
  it('runs account changes one at a time: a sign-out queued behind a switch finds the engine waiting for its restart', async () => {
    const key = secp256k1.utils.randomSecretKey()
    const id = addIdentity([{ id: 2, purpose: AUTH, securityLevel: HIGH, privateKey: key }])
    let stopping = 0
    const stopDm = async () => {
      stopping++
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const session = createSessionModule({ emit, controller: createMobileAuthController(), secureDurable: () => engineStorage.secureDurable(), stopDm })
    await session.restore()
    await session.signInWithKey({ key: bytesToHex(key) })
    const parking = session.prepareAddAccount()
    const signingOut = session.signOut()
    await parking
    await expect(signingOut).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
    // The sign-out never ran: it did not stop messages a second time or log the parked account out.
    expect(stopping).toBe(1)
    expect(localStorage.getItem(`yappr_secure_pk_${id}`)).not.toBeNull()
    // Clean up for the next case: a restarted engine signs the account out.
    const restarted = createSessionModule({ emit, controller: createMobileAuthController(), secureDurable: () => engineStorage.secureDurable() })
    await restarted.restore()
    await restarted.signOut({ identityId: id })
  })

  it('forgets what DMs keep on the device for every account that signs out (SR-10)', async () => {
    const keyA = secp256k1.utils.randomSecretKey()
    const keyB = secp256k1.utils.randomSecretKey()
    const idA = addIdentity([{ id: 2, purpose: AUTH, securityLevel: HIGH, privateKey: keyA }])
    const idB = addIdentity([{ id: 2, purpose: AUTH, securityLevel: HIGH, privateKey: keyB }])
    const forgetDm = vi.fn()
    const open = () => createSessionModule({ emit, controller: createMobileAuthController(), secureDurable: () => engineStorage.secureDurable(), forgetDm })
    const session = open()
    await session.restore()
    await session.signInWithKey({ key: bytesToHex(keyA) })
    await session.prepareAddAccount()
    const next = open()
    await next.restore()
    await next.signInWithKey({ key: bytesToHex(keyB) })
    // B is active: signing A out from the switcher, then B itself.
    await next.signOut({ identityId: idA })
    expect(forgetDm).toHaveBeenLastCalledWith(idA)
    await next.signOut()
    expect(forgetDm).toHaveBeenLastCalledWith(idB)
    expect(forgetDm).toHaveBeenCalledTimes(2)
  })

  it('stops DMs, and waits for their save, while the keys are still there', async () => {
    const key = secp256k1.utils.randomSecretKey()
    const id = addIdentity([{ id: 2, purpose: AUTH, securityLevel: HIGH, privateKey: key }])
    const stops: string[] = []
    const stopDm = async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      stops.push(localStorage.getItem(`yappr_secure_pk_${id}`) ? 'key held' : 'key gone')
    }
    const open = () => createSessionModule({ emit, controller: createMobileAuthController(), secureDurable: () => engineStorage.secureDurable(), stopDm })
    const session = open()
    await session.restore()
    await session.signInWithKey({ key: bytesToHex(key) })
    await session.prepareAddAccount()
    expect(stops).toEqual(['key held'])

    const next = open()
    await next.restore()
    await next.switchAccount(id)
    const restored = open()
    expect((await restored.restore())?.identityId).toBe(id)
    await restored.signOut()
    expect(stops).toEqual(['key held', 'key held', 'key held'])
    expect(localStorage.getItem(`yappr_secure_pk_${id}`)).toBeNull()
  })
})

describe('foregroundBalanceRefresh (SR-30, NET-08)', () => {
  afterEach(() => vi.useRealTimers())

  it('reads the balance on a timer only while signed in and in the foreground', async () => {
    vi.useFakeTimers()
    let user: { identityId: string } | null = null
    const listeners = new Set<() => void>()
    const refreshBalance = vi.fn(async () => undefined)
    const controller = {
      getState: () => ({ user }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        listener()
        return () => listeners.delete(listener)
      },
      refreshBalance,
    }
    const balance = foregroundBalanceRefresh(controller, 1000)

    await vi.advanceTimersByTimeAsync(5000)
    expect(refreshBalance).not.toHaveBeenCalled()

    user = { identityId: 'alice' }
    listeners.forEach(listener => listener())
    await vi.advanceTimersByTimeAsync(2000)
    expect(refreshBalance).toHaveBeenCalledTimes(2)

    balance.lifecycle('background')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refreshBalance).toHaveBeenCalledTimes(2)

    // Back after longer than the interval: read at once, then on the timer again.
    balance.lifecycle('inactive')
    balance.lifecycle('active')
    expect(refreshBalance).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(refreshBalance).toHaveBeenCalledTimes(4)

    // Back after a moment: the last read is recent enough, so the timer decides.
    balance.lifecycle('background')
    await vi.advanceTimersByTimeAsync(500)
    balance.lifecycle('active')
    expect(refreshBalance).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(refreshBalance).toHaveBeenCalledTimes(5)

    user = null
    listeners.forEach(listener => listener())
    await vi.advanceTimersByTimeAsync(5000)
    balance.lifecycle('background')
    balance.lifecycle('active')
    expect(refreshBalance).toHaveBeenCalledTimes(5)
  })
})
