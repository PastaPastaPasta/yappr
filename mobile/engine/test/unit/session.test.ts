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
const { createSessionModule, createMobileAuthController } = await import('../../src/api/session')
const { toNetworkWif, verifySignInKey } = await import('../../src/session/keys')
const { createKeyExchange, PENDING_REQUEST_KEY } = await import('../../src/session/key-exchange')
const { identityService } = await import('@/lib/services/identity-service')
const { dpnsService } = await import('@/lib/services/dpns-service')
const { evoSdkService } = await import('@/lib/services/evo-sdk-service')
const { keyExchangeService } = await import('@/lib/services/key-exchange-service')
const { privateKeyToWif } = await import('@/lib/crypto/wif')
const { hash160 } = await import('@/lib/crypto/hash')
const { bytesToHex } = await import('@/lib/bytes')
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
  return createSessionModule({ emit, controller: createMobileAuthController(), secureDurable: () => engineStorage.secureDurable() })
}

const secureKeys = () => Object.keys(engineStorage.snapshot().secure)

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
      complete: async () => 'signed-in',
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
