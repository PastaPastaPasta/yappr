/**
 * The first-login key registration (`dash-st:`) a wallet sign-in hands to the
 * wallet, built by lib's real builder with the real WASM over a stubbed
 * identity, then decoded from the URI the engine answers: which keys the
 * IdentityUpdate adds, at which purpose and level, bound to what, and with
 * which key data. Legacy builds add the auth key and an unbound encryption
 * key; App Connect builds sign in through App Connect and never build one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'

const chain = vi.hoisted(() => ({ keys: [] as unknown[] }))
vi.mock('@/lib/services/evo-sdk-service', async (load) => ({
  ...await load<object>(),
  getEvoSdk: async () => ({
    identities: {
      fetch: async () => ({ publicKeys: chain.keys, toJSON: () => ({ revision: 3 }) }),
      nonce: async () => BigInt(8),
    },
  }),
}))

const { createEngineStorage, installEngineStorage } = await import('../../src/shims/storage')
installEngineStorage(createEngineStorage())
Object.assign(globalThis, { window: globalThis })

const auth = await import('platform-auth')
const wasm = await import('@dashevo/wasm-sdk/compressed')
const { createMobileAuthController } = await import('../../src/api/session')
const { createKeyExchange } = await import('../../src/session/key-exchange')
const { evoSdkService } = await import('@/lib/services/evo-sdk-service')
const { keyExchangeService } = await import('@/lib/services/key-exchange-service')
const { deriveEncryptionKey } = await import('@/lib/crypto/derive-encryption-key')
const { hash160 } = await import('@/lib/crypto/hash')
const { stubAppConnectBuild } = await import('@/lib/test-storage')

const randomId = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
const ANCHOR = randomId()
const FILLER = randomId()

/** A key on the stubbed identity, as the SDK's fetch returns it. */
type KeyOptions = Omit<ConstructorParameters<typeof wasm.IdentityPublicKeyInCreation>[0], 'contractBounds'>
function onChain(options: KeyOptions & { boundTo?: string }) {
  const { boundTo, ...rest } = options
  const created = new wasm.IdentityPublicKeyInCreation({
    ...rest,
    ...(boundTo ? { contractBounds: wasm.ContractBounds.SingleContract(boundTo) } : {}),
  })
  return created.toIdentityPublicKey()
}

const master = () => onChain({ keyId: 0, purpose: 'authentication', securityLevel: 'master', keyType: 'ecdsa_secp256k1', data: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true) })

/** The sign-in's keys, as the engine derives them from the wallet's login key. */
function signInKeys(identityId: string, loginKey: Uint8Array) {
  const authKey = auth.deriveYapprAuthKeyFromLogin(loginKey, auth.decodeYapprIdentityId(identityId))
  return { authKey, authPublic: auth.getYapprPublicKey(authKey), anchorKey: deriveEncryptionKey(authKey, identityId, ANCHOR) }
}

/**
 * Every key the IdentityUpdate in a `dash-st:` URI adds. `proved`: the key
 * carries a valid ownership proof, its signature over the transition's
 * signable bytes (double SHA-256, compact) by the key itself, as Platform checks.
 */
function addedKeys(uri: string) {
  const parsed = auth.parseYapprStateTransitionUri(uri)
  if (!parsed) throw new Error('unparseable dash-st: URI')
  const update = wasm.IdentityUpdateTransition.fromBytes(parsed.transitionBytes)
  try {
    expect(update.publicKeyIdsToDisable).toHaveLength(0)
    const stateTransition = update.toStateTransition()
    const digest = sha256(sha256(stateTransition.getSignableBytes()))
    stateTransition.free()
    return update.publicKeyIdsToAdd.map(key => ({
      keyId: key.keyId,
      purpose: key.purpose.toLowerCase(),
      securityLevel: key.securityLevel.toLowerCase(),
      keyType: key.keyType.toLowerCase(),
      data: bs58.encode(key.data),
      bounds: key.contractBounds?.toJSON() ?? null,
      proved: key.signature.length === 65 && secp256k1.verify(key.signature.slice(1), digest, key.data, { prehash: false }),
    }))
  } finally {
    update.free()
  }
}

let response: Awaited<ReturnType<typeof keyExchangeService.getResponse>> = null

/** Play the wallet: approve `uri` for `identityId` with `loginKey` (as session.test.ts does). */
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
    keyIndex: 0,
  }
}

const complete = vi.fn(async (identityId: string) => ({ status: 'switch' as const, identityId }))

/** A wallet sign-in for `identityId`, up to the engine's answer after the wallet approved. */
async function signIn(identityId: string, loginKey: Uint8Array) {
  const kx = createKeyExchange({ controller: createMobileAuthController(), storage: localStorage, complete })
  const request = kx.start()
  await walletApproves(request.uri, identityId, loginKey)
  return kx.await(request.requestId, 1)
}

beforeAll(async () => {
  await wasm.default()
  vi.spyOn(evoSdkService, 'initialize').mockResolvedValue(undefined)
  vi.spyOn(keyExchangeService, 'getResponse').mockImplementation(async () => response)
})

beforeEach(() => {
  response = null
  complete.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('first-login key registration on legacy builds', () => {
  it('adds the auth key and the unbound encryption key of the key exchange', async () => {
    const identityId = randomId()
    const loginKey = crypto.getRandomValues(new Uint8Array(32))
    chain.keys = [master()]
    const step = await signIn(identityId, loginKey)
    if (step.status !== 'needs-registration') throw new Error(`expected a registration, got ${step.status}`)

    const { authPublic } = signInKeys(identityId, loginKey)
    const legacyKey = auth.deriveYapprEncryptionKeyFromLogin(loginKey, auth.decodeYapprIdentityId(identityId))
    expect(step.keys).toEqual([
      { keyId: 1, purpose: 'authentication', securityLevel: 'high' },
      { keyId: 2, purpose: 'encryption', securityLevel: 'medium' },
    ])
    expect(addedKeys(step.uri)).toEqual([
      { keyId: 1, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_hash160', data: bs58.encode(hash160(authPublic)), bounds: null, proved: false },
      { keyId: 2, purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1', data: bs58.encode(auth.getYapprPublicKey(legacyKey)), bounds: null, proved: true },
    ])
  })
})

describe('first-login key registration on App Connect builds', () => {
  beforeEach(() => stubAppConnectBuild(ANCHOR, FILLER))

  it('is refused: the wallet grants the keys there, and an unbound encryption key would read messages no peer can match', async () => {
    const { buildUnsignedKeyRegistrationTransition } = await import('@/lib/services/identity-update-builder')
    const identityId = randomId()
    const { authKey, authPublic, anchorKey } = signInKeys(identityId, crypto.getRandomValues(new Uint8Array(32)))
    chain.keys = [master()]
    await expect(buildUnsignedKeyRegistrationTransition({
      identityId,
      authPrivateKey: authKey,
      authPublicKey: authPublic,
      encryptionPrivateKey: anchorKey,
      encryptionPublicKey: auth.getYapprPublicKey(anchorKey),
    })).rejects.toThrow(/App Connect/)
  })
})
