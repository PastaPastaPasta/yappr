/**
 * App Connect sign-in in the engine (docs/APP_CONNECT_PROFILE.md), with the
 * real lib flow, verifier, session manager, key ring and signing selector,
 * the real platform-auth controller and the engine's storage shim, over a
 * stubbed chain: `appConnectPlatformPort` and the identity reads are
 * replaced, nothing touches the network. The wallet side is played with the
 * profile's own crypto (`sealAppConnectPayload`); the first sign-in answers
 * the request of the test vectors (vendor/platform-auth/src/app-connect/vectors.json).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'

// Post-login tasks read the network; they are covered by web.
vi.mock('@/lib/services/block-service', () => ({ blockService: { initializeBlockData: async () => undefined } }))
vi.mock('@/lib/services/private-feed-follower-service', () => ({
  privateFeedFollowerService: { syncFollowedFeeds: async () => ({ synced: [], failed: [], upToDate: [] }) },
}))
vi.mock('@/lib/services/dashpay-contacts-service', () => ({ dashPayContactsService: { getUnfollowedContacts: async () => ({ contacts: [] }) } }))

const { createEngineStorage, installEngineStorage, isSecureStorageKey } = await import('../../src/shims/storage')
const engineStorage = createEngineStorage()
installEngineStorage(engineStorage)
Object.assign(globalThis, { window: globalThis })
engineStorage.onBatch(batch => {
  if (batch.area === 'secure') queueMicrotask(() => engineStorage.ack(batch.seq))
})

const auth = await import('platform-auth')
const { createSessionModule, createMobileAuthController } = await import('../../src/api/session')
const { engineKeyRingBackend } = await import('../../src/session/app-connect-store')
const { appConnectReturnUrl } = await import('../../src/session/app-connect')
const { classify } = await import('../../src/writes/classify')
const { appConnectPlatformPort } = await import('@/lib/app-connect/platform-port')
const { appConnectSessions, useAppConnectStatus } = await import('@/lib/app-connect/session-manager')
const { AppConnectKeyRingStore } = await import('@/lib/app-connect/key-ring-store')
const { requestRecordsFor } = await import('@/lib/app-connect/pending-request')
const { documentSigningRequest } = await import('@/lib/app-connect/signing-plan')
const { resolveSigningKey, SigningUnavailableError } = await import('@/lib/auth/signing-keys')
const { getEncryptionKey } = await import('@/lib/secure-storage')
const { identityService } = await import('@/lib/services/identity-service')
const { dpnsService } = await import('@/lib/services/dpns-service')
const { evoSdkService } = await import('@/lib/services/evo-sdk-service')
const { bytesToHex, hexToBytes } = await import('@/lib/bytes')
const { privateKeyToWif } = await import('@/lib/crypto/wif')
const { YAPPR_CONTRACT_ID, DASHPAY_CONTRACT_ID, keyNetwork } = await import('@/lib/constants')

type Session = ReturnType<typeof createSessionModule>
type ChainKey = import('platform-auth').AppConnectIdentityKey
type Flow = import('../../src/session/app-connect').AppConnectFlowDTO

const vectors = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../vendor/platform-auth/src/app-connect/vectors.json'), 'utf8')) as {
  inputs: Record<string, string | number | string[]> & { slotPrivateKeys: string[] }
  request: { bytes: string }
  response: { walletEphemeralPubKey: string; encryptedPayload: string; slotPublicKeys: string[] }
}

const { KeyPurpose, KeySecurityLevel, KeyType } = auth
const APP_ID = vectors.inputs.appId as string
const GROUP_ID = vectors.inputs.groupId as string
const OWNER = vectors.inputs.ownerId as string
const MAKER = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
const SOCIAL = YAPPR_CONTRACT_ID
const RETURN_TO = { webBasePath: '/devnet', scheme: 'yappr-dev' }
const EXPIRES_AT = vectors.inputs.expiresAt as number

/** The chain the port serves: each identity's keys, and each budgeted key's remaining credits. */
const chain = new Map<string, ChainKey[]>()
const budgets = new Map<string, bigint>()
/** Published `loginKeyResponse` entries, by request hash (hex). */
const responses = new Map<string, import('platform-auth').AppConnectCandidate[]>()

let emitted: { event: string; payload: unknown }[] = []
const emit = (event: string, payload: unknown) => { emitted.push({ event, payload }) }
const flows = () => emitted.filter(e => e.event === 'session.appConnect').map(e => e.payload as Flow)

function boot(): Session {
  return createSessionModule({
    emit,
    controller: createMobileAuthController(),
    secureDurable: () => engineStorage.secureDurable(),
    holdSecure: matches => engineStorage.holdSecure(matches),
  })
}

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const lastFlow = () => flows().at(-1)
const waitForPhase = <P extends Flow['phase']>(phase: P) =>
  until(() => { const f = lastFlow(); return f?.phase === phase ? f as Extract<Flow, { phase: P }> : undefined }, phase)

/** A granted key on the chain, as the verifier reads it. */
function chainKey(id: number, privateKey: Uint8Array, shape: Omit<ChainKey, 'id' | 'type' | 'data'>): ChainKey {
  return { id, type: KeyType.ECDSA_SECP256K1, data: secp256k1.getPublicKey(privateKey, true), ...shape }
}

/** The keys a wallet registers for one grant: the group key, the DashPay profile key, the anchor encryption key. */
function grantKeys(ids: [number, number, number], slots: Uint8Array[], encryption: ChainKey | null = null): ChainKey[] {
  const keys = [
    chainKey(ids[0], slots[0], { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.CRITICAL, bounds: { kind: 'contractGroup', groupId: GROUP_ID }, totalBudget: 50_000_000_000n, expiresAt: EXPIRES_AT }),
    chainKey(ids[1], slots[1], { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.HIGH, bounds: { kind: 'documentType', contractId: DASHPAY_CONTRACT_ID, documentTypeName: 'profile' }, totalBudget: 1_000_000_000n, expiresAt: EXPIRES_AT }),
    encryption ?? chainKey(ids[2], slots[2], { purpose: KeyPurpose.ENCRYPTION, securityLevel: KeySecurityLevel.MEDIUM, bounds: { kind: 'singleContract', contractId: APP_ID } }),
  ]
  for (const key of keys) if (key.totalBudget !== undefined) budgets.set(`${OWNER}:${key.id}`, key.totalBudget)
  return keys
}

/** The key as the SDK's wasm IdentityPublicKey reads (what the signer matches against). */
function wasmKey(key: ChainKey) {
  const bounds = key.bounds
  return {
    keyId: key.id,
    keyTypeNumber: key.type,
    purposeNumber: key.purpose,
    securityLevelNumber: key.securityLevel,
    data: key.data,
    disabledAt: key.disabledAt ?? undefined,
    totalBudget: key.totalBudget ?? null,
    expiresAt: key.expiresAt ?? null,
    contractBounds: bounds ? {
      toJSON: () => bounds.kind === 'contractGroup'
        ? { $type: 'contractGroup', id: bounds.groupId }
        : { $type: bounds.kind, id: bounds.contractId, ...(bounds.kind === 'documentType' ? { documentTypeName: bounds.documentTypeName } : {}) },
    } : null,
  }
}

/** The wallet publishes its answer to `uri` for `owner`, carrying `slots`. */
async function walletAnswers(uri: string, owner: string, slots: Uint8Array[]): Promise<void> {
  const { request } = auth.parseAppConnectUri(uri)
  const sealed = await auth.sealAppConnectPayload({ appEphemeralPubKey: request.appEphemeralPubKey, ownerId: bs58.decode(owner), slots })
  const hash = bytesToHex(auth.appConnectRequestHash(request))
  responses.set(hash, [...(responses.get(hash) ?? []), { ownerId: owner, ...sealed }])
}

const randomKey = () => secp256k1.utils.randomSecretKey()

let session: Session
let refresh: () => Promise<void>

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', 'app-connect')
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_APP_ID', APP_ID)
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_ID', GROUP_ID)
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER', MAKER)
  vi.stubEnv('NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS', `${APP_ID},${SOCIAL}`)

  vi.spyOn(evoSdkService, 'initialize').mockResolvedValue(undefined)
  vi.spyOn(dpnsService, 'resolveUsername').mockImplementation(async id => (id === OWNER ? 'alice' : null))
  vi.spyOn(identityService, 'getIdentity').mockImplementation(async id => {
    const keys = chain.get(id)
    if (!keys) return null
    return {
      id,
      balance: 500_000,
      revision: 1,
      publicKeys: keys.map(key => ({ id: key.id, type: key.type, purpose: key.purpose, securityLevel: key.securityLevel, readOnly: false, disabledAt: key.disabledAt, data: key.data })),
    } as never
  })

  const port = appConnectPlatformPort
  vi.spyOn(port, 'chainStatus').mockImplementation(async () => ({ protocolVersion: 14, blockTimeMs: Date.now() }))
  vi.spyOn(port, 'groupInfo').mockImplementation(async id => (id === GROUP_ID
    ? { ownerId: MAKER, adminIds: [], members: [{ kind: 'contract', contractId: APP_ID }, { kind: 'contract', contractId: SOCIAL }] }
    : null))
  vi.spyOn(port, 'memberContract').mockImplementation(async () => ({ version: 1, ownerId: MAKER }))
  vi.spyOn(port, 'listCandidates').mockImplementation(async (hash, hint, startAfter) => {
    if (startAfter !== undefined) return []
    return (responses.get(bytesToHex(hash)) ?? []).filter(candidate => hint === undefined || candidate.ownerId === hint)
  })
  vi.spyOn(port, 'getIdentityFresh').mockImplementation(async id => {
    const keys = chain.get(id)
    return keys ? { id, publicKeys: keys.map(key => ({ ...key })) } : null
  })
  vi.spyOn(port, 'remainingBudgets').mockImplementation(async (id, keyIds) => new Map(keyIds.map(keyId => [keyId, budgets.get(`${id}:${keyId}`)])))
  vi.spyOn(port, 'contractKeys').mockImplementation(async (id, contractId, purpose) => (chain.get(id) ?? [])
    .filter(key => key.purpose === purpose && key.disabledAt === undefined && key.bounds?.kind === 'singleContract' && key.bounds.contractId === contractId)
    .slice(-1))

  // The session manager re-reads the chain 5 s after a sign-in and every hour; the revoke test runs it itself.
  refresh = appConnectSessions.refresh.bind(appConnectSessions)
  vi.spyOn(appConnectSessions, 'refresh').mockResolvedValue(undefined)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  emitted = []
})

describe('the key ring in the engine storage', () => {
  const network = 'testnet'
  const ringSession = (identityId: string, keyId: number) => ({
    v: 1 as const,
    network: network as 'testnet',
    identityId,
    appId: APP_ID,
    groupId: GROUP_ID,
    connectionId: '00'.repeat(16),
    grantedAt: Date.now(),
    authKeys: [{ keyId, securityLevel: 1, bounds: { kind: 'contractGroup' as const, groupId: GROUP_ID }, totalBudget: 5n, remainingBudget: 4n, expiresAt: EXPIRES_AT, keyRef: 'key-1' }],
    encKeys: [],
  })

  it('keeps the ring in the secure area under its identity, wrapped, and unwraps it after a restart', async () => {
    const identityId = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
    const privateKey = randomKey()
    const store = new AppConnectKeyRingStore(engineKeyRingBackend(localStorage))
    const saved = ringSession(identityId, 3)
    expect(await store.save(saved, new Map([['key-1', privateKey]]))).toBe(true)

    const { local, secure } = engineStorage.snapshot()
    const ringKey = `yappr_secure_ac_ring_${network}_${identityId}`
    expect(Object.keys(secure)).toContain(ringKey)
    expect(isSecureStorageKey(ringKey)).toBe(true)
    // The wrapping key and the connection id are device-wide; no private key is anywhere in plain.
    expect(Object.keys(local)).toContain('yappr_ac_device_key')
    expect(JSON.stringify({ local, secure })).not.toContain(bytesToHex(privateKey))

    // A restarted engine: a new backend over the same storage reads the same wrapping key.
    const restarted = new AppConnectKeyRingStore(engineKeyRingBackend(localStorage))
    const loaded = await restarted.load(network)
    expect(loaded).toEqual(saved)
    expect(loaded?.authKeys[0].totalBudget).toBe(5n)
    expect(await restarted.privateKey(saved, 'key-1')).toEqual(privateKey)
    expect(await restarted.connectionId(network)).toBe(await store.connectionId(network))
    await restarted.clear(network, { identityId })
  })

  it('holds one ring per network: a later grant replaces it, and a clear only takes the grant it names', async () => {
    const store = new AppConnectKeyRingStore(engineKeyRingBackend(localStorage))
    const first = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
    const second = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
    const a = ringSession(first, 3)
    const b = ringSession(second, 4)
    await store.save(a, new Map([['key-1', randomKey()]]))
    await store.save(b, new Map([['key-1', randomKey()]]))
    const rings = () => Object.keys(engineStorage.snapshot().secure).filter(key => key.startsWith('yappr_secure_ac_ring_'))
    expect(rings()).toEqual([`yappr_secure_ac_ring_${network}_${second}`])
    // The first grant is gone: its exact clear changes nothing.
    expect(await store.clear(network, { identityId: first, grantedAt: a.grantedAt, grantKeyId: 3 })).toBe(false)
    expect(rings()).toHaveLength(1)
    expect(await store.clear(network, { identityId: second, grantedAt: b.grantedAt, grantKeyId: 4 })).toBe(true)
    expect(rings()).toEqual([])
  })
})

describe('App Connect sign-in', () => {
  const slots = vectors.inputs.slotPrivateKeys.map(hex => hexToBytes(hex))

  it('makes the profile\'s request, returning through yap.pr to the app', async () => {
    // Resume the vectors' request (their ephemeral key, connection id and time), as after a relaunch.
    const createdAt = vectors.inputs.createdAt as number
    vi.useFakeTimers({ toFake: ['Date'], now: createdAt + 60_000 })
    try {
      session = boot()
      await requestRecordsFor(undefined).save({
        ephemeralPrivateKey: vectors.inputs.appEphemeralPrivateKey as string,
        createdAt,
        connectionId: vectors.inputs.connectionId as string,
      })
      chain.set(OWNER, grantKeys([5, 6, 7], slots))
      responses.set(bytesToHex(auth.appConnectRequestHash(auth.decodeAppConnectRequest(hexToBytes(vectors.request.bytes)))), [{
        ownerId: OWNER,
        walletEphemeralPubKey: hexToBytes(vectors.response.walletEphemeralPubKey),
        encryptedPayload: hexToBytes(vectors.response.encryptedPayload),
      }])

      expect(await session.restore()).toBeNull()
      expect(await session.appConnectPending()).toBe(true)
      const started = await session.appConnectStart({ returnTo: RETURN_TO })
      expect(started).toMatchObject({ phase: 'waiting', renew: false })
      if (started.phase !== 'waiting') throw new Error('not waiting')

      const parsed = auth.parseAppConnectUri(started.uri)
      expect(bytesToHex(parsed.requestBytes)).toBe(vectors.request.bytes)
      expect(started.requestHash).toBe(bytesToHex(auth.appConnectRequestHash(parsed.request)))
      expect(parsed.callbackUrl).toBe(`https://yap.pr/devnet/connect/?r=${started.requestHash}&app=yappr-dev`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('verifies the wallet\'s answer and asks who it is before signing in', async () => {
    const confirm = await waitForPhase('confirm')
    expect(confirm.candidates).toEqual([{ identityId: OWNER, username: 'alice' }])
    expect(await session.current()).toBeNull()
  })

  it('signs in with the grant: the ring is stored and messaging works at once', async () => {
    const result = await session.appConnectAccept({ identityId: OWNER })
    expect(result).toMatchObject({ status: 'signed-in', reload: false, session: { identityId: OWNER, method: 'app-connect', hasEncryptionKey: true } })
    expect(lastFlow()).toMatchObject({ phase: 'idle' })
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: result.session, reason: 'signed-in' } })
    expect(emitted.filter(e => e.event === 'session.appConnectStatus').at(-1)?.payload).toMatchObject({ identityId: OWNER, health: 'ok' })

    // The anchor key the wallet granted is the messaging key, in memory; nothing derived or typed.
    expect(getEncryptionKey(OWNER)).toBe(privateKeyToWif(slots[2], keyNetwork(), true))
    expect(Object.keys(engineStorage.snapshot().secure)).toContain(`yappr_secure_ac_ring_testnet_${OWNER}`)
    // The request is spent and forgotten.
    expect(await session.appConnectPending()).toBe(false)
  })

  it('signs each write with the narrowest granted key, and never outside the grant', async () => {
    const keys = (chain.get(OWNER) ?? []).map(wasmKey) as never[]
    const post = await resolveSigningKey(OWNER, keys, documentSigningRequest(SOCIAL, 'post'))
    expect(post).toMatchObject({ appConnect: true, identityKey: { keyId: 5 } })
    const profile = await resolveSigningKey(OWNER, keys, documentSigningRequest(DASHPAY_CONTRACT_ID, 'profile'))
    expect(profile).toMatchObject({ appConnect: true, identityKey: { keyId: 6 } })
    // A contract outside the group, and a transfer-like write, go to the wallet.
    await expect(resolveSigningKey(OWNER, keys, documentSigningRequest(MAKER, 'note'))).rejects.toMatchObject({ reason: 'wallet' })
    await expect(resolveSigningKey(OWNER, keys, { transition: 'non-batch', requiredSecurityLevel: KeySecurityLevel.HIGH })).rejects.toMatchObject({ reason: 'wallet' })
    await expect(resolveSigningKey(OWNER, keys, documentSigningRequest(SOCIAL, 'post'), { rawOnly: true })).rejects.toMatchObject({ reason: 'wallet' })
  })

  it('asks to renew once the allowance runs out, and says so to the host', async () => {
    const ring = appConnectSessions.current(OWNER)
    if (!ring) throw new Error('no session')
    const spent = { ...ring, authKeys: ring.authKeys.map(key => ({ ...key, remainingBudget: 0n })) }
    Object.assign(ring, spent)
    const keys = (chain.get(OWNER) ?? []).map(wasmKey) as never[]
    let error: unknown
    try {
      await resolveSigningKey(OWNER, keys, documentSigningRequest(SOCIAL, 'post'))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SigningUnavailableError)
    expect(classify(error)).toMatchObject({ code: 'RENEW_REQUIRED', retryable: false })
    expect(await session.appConnectStatus()).toMatchObject({ renewRequired: 'allowance-spent' })
    expect(emitted.some(e => e.event === 'session.appConnectStatus' && (e.payload as { renewRequired: unknown }).renewRequired === 'allowance-spent')).toBe(true)
    // A consensus refusal for the allowance reads the same.
    expect(classify(Object.assign(new Error('budget exhausted'), { code: 20015 }))).toMatchObject({ code: 'RENEW_REQUIRED' })
  })

  it('renews in place: only this account may answer, and its new keys replace the old ones', async () => {
    const started = await session.appConnectStart({ renew: true, returnTo: RETURN_TO })
    if (started.phase !== 'waiting') throw new Error(`expected waiting, got ${started.phase}`)
    expect(started.renew).toBe(true)
    const { request } = auth.parseAppConnectUri(started.uri)
    expect(bs58.encode(request.identityHint ?? new Uint8Array())).toBe(OWNER)
    // This device's connection id: the wallet supersedes this device's grant, no other.
    expect(bytesToHex(request.connectionId ?? new Uint8Array())).toBe(await appConnectSessions.connectionId())

    // Someone else answers too: the hint keeps them out. The wallet re-sends the anchor key and disables the old auth keys.
    const stranger = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
    await walletAnswers(started.uri, stranger, [randomKey()])
    const renewed = [randomKey(), randomKey()]
    const previous = chain.get(OWNER) ?? []
    const encryption = previous[2]
    chain.set(OWNER, [
      ...previous.slice(0, 2).map(key => ({ ...key, disabledAt: Date.now() })),
      ...grantKeys([8, 9, 7], [...renewed, slots[2]], encryption),
    ])
    await walletAnswers(started.uri, OWNER, [...renewed, slots[2]])
    await session.appConnectPollNow({ requestHash: started.requestHash })
    const confirm = await waitForPhase('confirm')
    expect(confirm.candidates.map(c => c.identityId)).toEqual([OWNER])

    const result = await session.appConnectAccept({ identityId: OWNER })
    expect(result).toMatchObject({ status: 'renewed', session: { identityId: OWNER } })
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: result.session, reason: 'renewed' } })
    expect(appConnectSessions.current(OWNER)?.authKeys.map(key => key.keyId).sort()).toEqual([8, 9])
    expect(useAppConnectStatus.getState().renewRequired).toBeNull()
    const keys = (chain.get(OWNER) ?? []).map(wasmKey) as never[]
    expect(await resolveSigningKey(OWNER, keys, documentSigningRequest(SOCIAL, 'post'))).toMatchObject({ identityKey: { keyId: 8 } })
  })

  it('refuses a renewal answered by another account, and an answer already taken', async () => {
    const started = await session.appConnectStart({ renew: true, returnTo: RETURN_TO })
    if (started.phase !== 'waiting') throw new Error('not waiting')
    await expect(session.appConnectAccept({ identityId: MAKER })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await session.appConnectCancel()
    expect(lastFlow()).toMatchObject({ phase: 'idle' })
    await expect(session.appConnectAccept({ identityId: OWNER })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('signs out when the wallet revokes this device\'s keys', async () => {
    chain.set(OWNER, (chain.get(OWNER) ?? []).map(key => ({ ...key, disabledAt: key.purpose === KeyPurpose.AUTHENTICATION ? Date.now() : key.disabledAt })))
    await refresh()
    await until(() => emitted.find(e => e.event === 'session.changed' && (e.payload as { reason: string }).reason === 'signed-out'), 'the sign-out')
    expect(await session.current()).toBeNull()
    expect(await session.appConnectStatus()).toMatchObject({ identityId: null, signedOutByWallet: true })
    expect(Object.keys(engineStorage.snapshot().secure).filter(key => key.startsWith('yappr_secure_ac_ring_'))).toEqual([])
    await session.appConnectDismiss({ signedOut: true })
    expect(useAppConnectStatus.getState().signedOutByWallet).toBe(false)
  })

  it('refuses a renewal with nobody signed in through a wallet, and a request that cannot reach the app', async () => {
    await expect(session.appConnectStart({ renew: true, returnTo: RETURN_TO })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(session.appConnectStart({ returnTo: { webBasePath: '/devnet', scheme: 'evil' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(appConnectReturnUrl(RETURN_TO, 'ab'.repeat(20))).toBe(`https://yap.pr/devnet/connect/?r=${'ab'.repeat(20)}&app=yappr-dev`)
  })

  it('signs in once when two confirmations of the same answer race', async () => {
    const started = await session.appConnectStart({ returnTo: RETURN_TO, fresh: true })
    if (started.phase !== 'waiting') throw new Error('not waiting')
    const granted = [randomKey(), randomKey(), slots[2]]
    const previous = chain.get(OWNER) ?? []
    chain.set(OWNER, [...previous.filter(key => key.id !== 7), ...grantKeys([10, 11, 7], granted, previous.find(key => key.id === 7))])
    await walletAnswers(started.uri, OWNER, granted)
    await session.appConnectPollNow()
    await waitForPhase('confirm')
    const results = await Promise.allSettled([
      session.appConnectAccept({ identityId: OWNER }),
      session.appConnectAccept({ identityId: OWNER }),
    ])
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(emitted.filter(e => e.event === 'session.changed' && (e.payload as { reason: string }).reason === 'signed-in')).toHaveLength(1)
    expect(appConnectSessions.current(OWNER)?.authKeys.map(key => key.keyId).sort()).toEqual([10, 11])
    await session.signOut()
    expect(appConnectSessions.current(OWNER)).toBeNull()
    expect(Object.keys(engineStorage.snapshot().secure).filter(key => key.startsWith('yappr_secure_ac_ring_'))).toEqual([])
  })
})
