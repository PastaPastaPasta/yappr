/**
 * App Connect sign-in in the engine (docs/APP_CONNECT_PROFILE.md), with the
 * real lib flow, verifier, session manager, key ring and signing selector,
 * the real platform-auth controller and the engine's storage shim, over a
 * stubbed chain: `appConnectPlatformPort` and the identity reads are
 * replaced, nothing touches the network. The wallet side is played with the
 * profile's own crypto (`sealAppConnectPayload`); the first sign-in answers
 * the request of the test vectors (vendor/platform-auth/src/app-connect/vectors.json).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'

// Post-login tasks read the network; they are covered by web.
const syncFollowedFeeds = vi.hoisted(() => vi.fn<(identityId: string) => Promise<{ synced: string[]; failed: string[]; upToDate: string[] }>>(async () => ({ synced: [], failed: [], upToDate: [] })))
vi.mock('@/lib/services/block-service', () => ({ blockService: { initializeBlockData: async () => undefined } }))
vi.mock('@/lib/services/private-feed-follower-service', () => ({ privateFeedFollowerService: { syncFollowedFeeds } }))
vi.mock('@/lib/services/dashpay-contacts-service', () => ({ dashPayContactsService: { getUnfollowedContacts: async () => ({ contacts: [] }) } }))

const { createEngineStorage, installEngineStorage, isSecureStorageKey } = await import('../../src/shims/storage')
const engineStorage = createEngineStorage()
installEngineStorage(engineStorage)
Object.assign(globalThis, { window: globalThis })
/** Secure deletes as the host is asked for them. */
const secureDeletes: string[] = []
/** Secure batches the host has not acknowledged yet, while a test holds its acknowledgements back. */
let heldAcks: number[] | null = null
engineStorage.onBatch(batch => {
  if (batch.area !== 'secure') return
  for (const op of batch.ops) if (op[0] === 'del') secureDeletes.push(op[1])
  if (heldAcks) heldAcks.push(batch.seq)
  else queueMicrotask(() => engineStorage.ack(batch.seq))
})
function releaseAcks(): void {
  const held = heldAcks ?? []
  heldAcks = null
  for (const seq of held) engineStorage.ack(seq)
}

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
const { resolveSigningKey, SigningUnavailableError, RENEW_IN_WALLET_MESSAGE, NEEDS_WALLET_MESSAGE, SIGNED_OUT_MESSAGE } = await import('@/lib/auth/signing-keys')
const { getEncryptionKey } = await import('@/lib/secure-storage')
const { identityService } = await import('@/lib/services/identity-service')
const { dpnsService } = await import('@/lib/services/dpns-service')
const { evoSdkService } = await import('@/lib/services/evo-sdk-service')
const { bytesToHex, hexToBytes } = await import('@/lib/bytes')
const { privateKeyToWif } = await import('@/lib/crypto/wif')
const { YAPPR_CONTRACT_ID, DASHPAY_CONTRACT_ID, keyNetwork } = await import('@/lib/constants')
const { SESSION_STORAGE_KEY } = await import('@/lib/storage-scope')

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

function boot(controller?: ReturnType<typeof createMobileAuthController>, awaitingReload?: Set<string>): Session {
  return createSessionModule({
    emit,
    controller,
    awaitingReload,
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
/** The key rings the engine holds in its secure area. */
const rings = () => Object.keys(engineStorage.snapshot().secure).filter(key => key.startsWith('yappr_secure_ac_ring_'))

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

      // The flow reports every carrier the build offers, the default's URI first (one here: no `both` in this env).
      expect(started.uris).toEqual([{ carrier: 'dash-key', uri: started.uri }])
      const parsed = auth.parseAppConnectUri(started.uri)
      expect(bytesToHex(parsed.requestBytes)).toBe(vectors.request.bytes)
      expect(started.requestHash).toBe(bytesToHex(auth.appConnectRequestHash(parsed.request)))
      expect(parsed.callbackUrl).toBe(`https://yap.pr/devnet/connect/?r=${started.requestHash}&app=yappr-dev`)
      for (const [webBasePath, scheme] of [['', 'yappr-beta'], ['/staging', 'yappr-staging'], ['/devnet', 'yappr-dev'], ['', 'yappr']]) {
        expect(appConnectReturnUrl({ webBasePath, scheme }, started.requestHash)).toBe(`https://yap.pr${webBasePath}/connect/?r=${started.requestHash}&app=${scheme}`)
      }
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
    // Kept for the app to resume, should it be killed while the wallet answers.
    expect(await session.appConnectPending({ renew: true })).toBe(true)
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
    // The wallet superseded the old keys as it answered: a check now finds them revoked, but the renewal stands.
    await refresh()
    expect(await session.current()).toMatchObject({ identityId: OWNER })
    expect(emitted.some(e => e.event === 'session.appConnectStatus' && (e.payload as { signedOutByWallet: unknown }).signedOutByWallet !== null)).toBe(false)
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

  it('signs out after all when a renewal the revoke waited for is abandoned', async () => {
    const started = await session.appConnectStart({ renew: true, returnTo: RETURN_TO })
    if (started.phase !== 'waiting') throw new Error('not waiting')
    const keys = chain.get(OWNER) ?? []
    // The wallet superseded the keys (another device's renewal, say), and a check finds them revoked.
    chain.set(OWNER, keys.map(key => ({ ...key, disabledAt: key.purpose === KeyPurpose.AUTHENTICATION ? Date.now() : key.disabledAt })))
    await refresh()
    expect(await session.current()).toMatchObject({ identityId: OWNER })
    await session.appConnectCancel()
    await until(() => emitted.find(e => e.event === 'session.changed' && (e.payload as { reason: string }).reason === 'signed-out'), 'the sign-out')
    expect(await session.appConnectStatus()).toMatchObject({ signedOutByWallet: OWNER })
    await session.appConnectDismiss({ signedOut: true })

    // Signed back in with a fresh grant for the tests that follow.
    const again = await session.appConnectStart({ returnTo: RETURN_TO })
    if (again.phase !== 'waiting') throw new Error('not waiting')
    const granted = [randomKey(), randomKey(), slots[2]]
    chain.set(OWNER, [...keys.map(key => ({ ...key, disabledAt: key.purpose === KeyPurpose.AUTHENTICATION ? Date.now() : key.disabledAt })).filter(key => key.id !== 7), ...grantKeys([12, 13, 7], granted, keys.find(key => key.id === 7))])
    await walletAnswers(again.uri, OWNER, granted)
    await session.appConnectPollNow()
    await waitForPhase('confirm')
    expect(await session.appConnectAccept({ identityId: OWNER })).toMatchObject({ status: 'signed-in' })
  })

  it('reads a signing refusal from the message lib\'s write services pass on', () => {
    expect(classify(new Error(RENEW_IN_WALLET_MESSAGE))).toMatchObject({ code: 'RENEW_REQUIRED' })
    expect(classify(new Error(NEEDS_WALLET_MESSAGE))).toMatchObject({ code: 'NEEDS_WALLET' })
    expect(classify(new Error(SIGNED_OUT_MESSAGE))).toMatchObject({ code: 'KEY_REVOKED' })
  })

  it('refuses a renewal answered by another account, an answer already taken, and a sign-in beside this one', async () => {
    await expect(session.appConnectStart({ returnTo: RETURN_TO })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
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
    expect(await session.appConnectStatus()).toMatchObject({ identityId: null, signedOutByWallet: OWNER })
    expect(rings()).toEqual([])
    // Reported once the sign-out is done, never before it.
    const reports = emitted.filter(e => e.event === 'session.appConnectStatus').map(e => (e.payload as { signedOutByWallet: unknown }).signedOutByWallet)
    const signedOutAt = emitted.findIndex(e => e.event === 'session.changed' && (e.payload as { reason: string }).reason === 'signed-out')
    const reportedAt = emitted.findIndex(e => e.event === 'session.appConnectStatus' && (e.payload as { signedOutByWallet: unknown }).signedOutByWallet === OWNER)
    expect(reports).toContain(OWNER)
    expect(reportedAt).toBeGreaterThan(signedOutAt)
    await session.appConnectDismiss({ signedOut: true })
    expect(await session.appConnectStatus()).toMatchObject({ signedOutByWallet: null })
  })

  it('refuses a renewal with nobody signed in through a wallet, and a request that cannot reach the app', async () => {
    await expect(session.appConnectStart({ renew: true, returnTo: RETURN_TO })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(session.appConnectStart({ returnTo: { webBasePath: '/devnet', scheme: 'evil' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
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
    expect(rings()).toEqual([])
  })

  it('drops a parked account\'s wallet grant when its key signs it in, so the next boot cannot restore the grant', async () => {
    const parkedKey = randomKey()
    const parkedId = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
    chain.set(parkedId, [chainKey(2, parkedKey, { purpose: KeyPurpose.AUTHENTICATION, securityLevel: KeySecurityLevel.HIGH })])
    const byHash = vi.spyOn(identityService, 'getIdentityIdByPublicKeyHash').mockResolvedValue(parkedId)
    try {
      // Its ring sits in its own bucket on the device, not in this engine.
      expect(rings()).not.toContain(`yappr_secure_ac_ring_testnet_${parkedId}`)
      await session.signInWithKey({ key: bytesToHex(parkedKey) })
      await engineStorage.secureDurable()
      expect(secureDeletes).toContain(`yappr_secure_ac_ring_testnet_${parkedId}`)
      await session.signOut()
    } finally {
      byHash.mockRestore()
    }
  })

  it('signs an account in again only as that account', async () => {
    await expect(session.appConnectStart({ reauth: 'not-an-id', returnTo: RETURN_TO })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const started = await session.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    if (started.phase !== 'waiting') throw new Error('not waiting')
    expect(started.renew).toBe(false)
    const { request } = auth.parseAppConnectUri(started.uri)
    expect(bs58.encode(request.identityHint ?? new Uint8Array())).toBe(OWNER)
    await expect(session.appConnectAccept({ identityId: MAKER })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await session.appConnectCancel()
  })

  it('makes no request for a start cancelled while it waited for the restore', async () => {
    const fresh = boot()
    const starting = fresh.appConnectStart({ returnTo: RETURN_TO })
    await fresh.appConnectCancel()
    expect(await starting).toMatchObject({ phase: 'idle' })
    expect(await fresh.appConnectPending()).toBe(false)
    session = fresh
  })

  it('forgets the stored request a start cancelled during its checks would have resumed', async () => {
    const createdAt = vectors.inputs.createdAt as number
    vi.useFakeTimers({ toFake: ['Date'], now: createdAt + 60_000 })
    try {
      const fresh = boot()
      session = fresh
      await fresh.restore()
      await requestRecordsFor(undefined).save({
        ephemeralPrivateKey: vectors.inputs.appEphemeralPrivateKey as string,
        createdAt,
        connectionId: vectors.inputs.connectionId as string,
      })
      // The start holds at its first check until released.
      const hold: { release?: () => void } = {}
      const status = { protocolVersion: 14, blockTimeMs: Date.now() }
      vi.mocked(appConnectPlatformPort.chainStatus).mockImplementationOnce(() => new Promise(resolve => { hold.release = () => resolve(status) }))
      const starting = fresh.appConnectStart({ returnTo: RETURN_TO })
      await until(() => hold.release, 'the chain check')
      await fresh.appConnectCancel()
      hold.release?.()
      expect(await starting).toMatchObject({ phase: 'idle' })
      expect(await fresh.appConnectPending()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets the stored request a start cancelled during the restore would have resumed', async () => {
    const createdAt = vectors.inputs.createdAt as number
    vi.useFakeTimers({ toFake: ['Date'], now: createdAt + 60_000 })
    try {
      const fresh = boot()
      session = fresh
      await requestRecordsFor(undefined).save({
        ephemeralPrivateKey: vectors.inputs.appEphemeralPrivateKey as string,
        createdAt,
        connectionId: vectors.inputs.connectionId as string,
      })
      expect(await fresh.appConnectPending()).toBe(true)
      const starting = fresh.appConnectStart({ returnTo: RETURN_TO })
      await fresh.appConnectCancel()
      expect(await starting).toMatchObject({ phase: 'idle' })
      expect(await fresh.appConnectPending()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('App Connect requests across kills and engine restarts', () => {
  const LOGIN_SLOT = 'yappr_secure_ac_secret_testnet_pending_request_login'
  const REAUTH_SLOT = 'yappr_secure_ac_secret_testnet_pending_request_reauth'
  const RENEWAL_SLOT = `yappr_secure_ac_secret_testnet_pending_request_${OWNER}`
  const ACTIVE_SLOT = 'yappr_secure_ac_secret_testnet_pending_request_active_sign_in'
  const stored = () => Object.keys(engineStorage.snapshot().secure)
  const settle = () => new Promise(resolve => setTimeout(resolve, 50))

  afterEach(() => {
    releaseAcks()
  })

  /** A launch with nobody signed in and no request stored: only the shared bucket is loaded. */
  async function signedOut(): Promise<Session> {
    const before = boot()
    if (await before.restore()) await before.signOut()
    for (const slot of [LOGIN_SLOT, REAUTH_SLOT, RENEWAL_SLOT, ACTIVE_SLOT]) localStorage.removeItem(slot)
    await engineStorage.secureDurable()
    const engine = boot()
    session = engine
    await engine.restore()
    return engine
  }

  async function untilPhase(engine: Session, phase: Flow['phase']): Promise<Flow> {
    for (let i = 0; i < 500; i++) {
      const flow = await engine.appConnectState()
      if (flow.phase === phase) return flow
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${phase}`)
  }

  /** The wallet answers `uri` for OWNER with fresh keys, superseding its earlier auth keys. */
  async function walletGrants(uri: string, ids: [number, number]): Promise<void> {
    const granted = [randomKey(), randomKey(), vectors.inputs.slotPrivateKeys.map(hex => hexToBytes(hex))[2]]
    const previous = chain.get(OWNER) ?? []
    const anchor = previous.find(key => key.id === 7)
    chain.set(OWNER, [
      ...previous.filter(key => key.id !== 7).map(key => ({ ...key, disabledAt: key.disabledAt ?? Date.now() })),
      ...grantKeys([ids[0], ids[1], 7], granted, anchor),
    ])
    await walletAnswers(uri, OWNER, granted)
  }

  /** Starts a request on `on` and has the wallet answer it for OWNER, up to "Continue as". */
  async function answered(on: Session, ids: [number, number], start: { reauth?: string; renew?: boolean } = {}): Promise<void> {
    const started = await on.appConnectStart({ returnTo: RETURN_TO, fresh: true, ...start })
    if (started.phase !== 'waiting') throw new Error('not waiting')
    await walletGrants(started.uri, ids)
    await on.appConnectPollNow()
    await untilPhase(on, 'confirm')
  }

  /** Signs OWNER in through the wallet, with fresh key ids; the engine the host restarts into, if it must. */
  async function walletSignIn(on: Session, ids: [number, number]): Promise<Session> {
    await answered(on, ids)
    const result = await on.appConnectAccept({ identityId: OWNER })
    if (result.status !== 'signed-in') throw new Error('not signed in')
    if (!result.reload) return on
    const next = boot()
    session = next
    expect(await next.restore()).toMatchObject({ identityId: OWNER })
    return next
  }

  it('keeps a parked account listed until its renewal is deleted from the bucket this boot did not load', async () => {
    const engine = await walletSignIn(await signedOut(), [58, 59])
    await engine.prepareAddAccount()
    const next = boot()
    session = next
    expect(await next.restore()).toBeNull()
    secureDeletes.length = 0
    heldAcks = []
    const signingOut = next.signOut({ identityId: OWNER })
    await until(() => secureDeletes.includes(RENEWAL_SLOT), 'the parked renewal deletion on its way to the host')
    await settle()
    expect((await next.accounts()).map(account => account.identityId)).toContain(OWNER)
    releaseAcks()
    await signingOut
    expect((await next.accounts()).map(account => account.identityId)).not.toContain(OWNER)
  })

  it('reloads the account\'s secrets after "Sign in again" on a launch that loaded only the shared ones', async () => {
    await walletSignIn(await signedOut(), [44, 45])
    // Its session no longer restores: the slot is freed and the account kept, to be signed in again.
    const controller = createMobileAuthController()
    vi.spyOn(controller, 'restoreSession').mockResolvedValueOnce(null)
    const failed = boot(controller)
    expect(await failed.restore()).toBeNull()
    expect((await failed.accounts()).map(account => account.identityId)).toContain(OWNER)
    // Killed while the wallet was open: the next launch has nobody signed in, so it loads only the shared bucket.
    const next = boot()
    session = next
    expect(await next.restore()).toBeNull()
    await answered(next, [46, 47], { reauth: OWNER })
    expect(await next.appConnectAccept({ identityId: OWNER })).toMatchObject({ status: 'signed-in', reload: true })
    const reloaded = boot()
    session = reloaded
    expect(await reloaded.restore()).toMatchObject({ identityId: OWNER })
    await reloaded.signOut()
  })

  /** A launch whose session slot names a new account that does not restore: the host stays bound to its bucket. */
  async function failedRestore(): Promise<{ engine: Session; alice: string }> {
    await signedOut()
    const alice = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ user: { identityId: alice } }))
    const awaitingReload = new Set<string>()
    const controller = createMobileAuthController({ awaitingReload })
    vi.spyOn(controller, 'restoreSession').mockResolvedValueOnce(null)
    const engine = boot(controller, awaitingReload)
    session = engine
    expect(await engine.restore()).toBeNull()
    return { engine, alice }
  }

  it('reloads a new account signed in on a launch still bound to another account whose session did not restore', async () => {
    const { engine } = await failedRestore()
    await answered(engine, [60, 61])
    expect(await engine.appConnectAccept({ identityId: OWNER })).toMatchObject({ status: 'signed-in', reload: true })
    const reloaded = boot()
    session = reloaded
    expect(await reloaded.restore()).toMatchObject({ identityId: OWNER })
    await reloaded.signOut()
  })

  it('asks the host to reload once the sign-in is durable, even if the accept reply never reaches it', async () => {
    const { engine } = await failedRestore()
    await answered(engine, [70, 71])
    heldAcks = []
    emitted = []
    const accepting = engine.appConnectAccept({ identityId: OWNER })
    await until(() => heldAcks?.length, 'the sign-in on its way to the host')
    await settle()
    expect(emitted.some(e => e.event === 'session.changed')).toBe(false)
    releaseAcks()
    const result = await accepting
    expect(emitted).toContainEqual({ event: 'session.changed', payload: { session: result.status === 'signed-in' ? result.session : null, reason: 'signed-in', reload: true } })
    await expect(engine.signOut()).rejects.toMatchObject({ code: 'RESTART_REQUIRED' })
    const reloaded = boot()
    session = reloaded
    expect(await reloaded.restore()).toMatchObject({ identityId: OWNER })
    await reloaded.signOut()
  })

  it('leaves the post-login tasks of an account it must reload into to the reloaded engine', async () => {
    const { engine } = await failedRestore()
    await answered(engine, [66, 67])
    syncFollowedFeeds.mockClear()
    heldAcks = []
    const accepting = engine.appConnectAccept({ identityId: OWNER })
    await until(() => heldAcks?.length, 'the sign-in on its way to the host')
    await settle()
    releaseAcks()
    expect(await accepting).toMatchObject({ status: 'signed-in', reload: true })
    await settle()
    expect(syncFollowedFeeds).not.toHaveBeenCalled()
    const reloaded = boot()
    session = reloaded
    expect(await reloaded.restore()).toMatchObject({ identityId: OWNER })
    await until(() => syncFollowedFeeds.mock.calls.some(([id]) => id === OWNER), 'the private-feed sync on restore')
    await reloaded.signOut()
  })

  it('signs a new account in without a reload on a launch bound to nobody, or whose account signed out', async () => {
    const engine = await signedOut()
    await answered(engine, [62, 63])
    syncFollowedFeeds.mockClear()
    expect(await engine.appConnectAccept({ identityId: OWNER })).toMatchObject({ status: 'signed-in', reload: false })
    await until(() => syncFollowedFeeds.mock.calls.some(([id]) => id === OWNER), 'the private-feed sync after sign-in')
    await engine.signOut()

    const { engine: next, alice } = await failedRestore()
    await next.signOut({ identityId: alice })
    await answered(next, [64, 65])
    expect(await next.appConnectAccept({ identityId: OWNER })).toMatchObject({ status: 'signed-in', reload: false })
    await next.signOut()
  })

  it('keeps "Sign in again" where a signed-out launch finds it, and a cancel of the resumed request forgets it', async () => {
    const engine = await walletSignIn(await signedOut(), [56, 57])
    await engine.signOut()
    const started = await engine.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    if (started.phase !== 'waiting') throw new Error('not waiting')
    expect(stored()).toContain(REAUTH_SLOT)
    expect(stored()).not.toContain(RENEWAL_SLOT)

    // Killed: a signed-out launch finds it, resumes it, and a cancel then forgets it.
    const next = boot()
    session = next
    expect(await next.appConnectPendingSignIn()).toEqual({ reauth: OWNER })
    await next.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    await next.appConnectCancel()
    expect(await next.appConnectPendingSignIn()).toBeNull()
    expect(stored()).not.toContain(REAUTH_SLOT)
  })

  it('resumes the signed-out request opened last, not the one made last', async () => {
    const engine = await signedOut()
    const plain = await engine.appConnectStart({ returnTo: RETURN_TO })
    if (plain.phase !== 'waiting') throw new Error('not waiting')
    const again = await engine.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    if (again.phase !== 'waiting') throw new Error('not waiting')
    const reopened = await engine.appConnectStart({ returnTo: RETURN_TO })
    if (reopened.phase !== 'waiting') throw new Error('not waiting')
    expect(reopened.requestHash).toBe(plain.requestHash)
    expect(stored()).toEqual(expect.arrayContaining([LOGIN_SLOT, REAUTH_SLOT]))

    // Killed while the wallet answered the reopened plain request.
    const next = boot()
    session = next
    expect(await next.appConnectPendingSignIn()).toEqual({ reauth: null })
    const resumed = await next.appConnectStart({ returnTo: RETURN_TO })
    if (resumed.phase !== 'waiting') throw new Error('not waiting')
    expect(resumed.requestHash).toBe(plain.requestHash)
  })

  it('hands a reopened request out only once the mark that it was opened last is on the host', async () => {
    const engine = await signedOut()
    const plain = await engine.appConnectStart({ returnTo: RETURN_TO })
    if (plain.phase !== 'waiting') throw new Error('not waiting')
    await engine.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    heldAcks = []
    emitted = []
    const reopening = engine.appConnectStart({ returnTo: RETURN_TO })
    await until(() => heldAcks?.length, 'the mark on its way to the host')
    await settle()
    expect(flows().some(flow => flow.phase === 'waiting')).toBe(false)
    releaseAcks()
    const reopened = await reopening
    if (reopened.phase !== 'waiting') throw new Error('not waiting')
    expect(reopened.requestHash).toBe(plain.requestHash)
  })

  const activeMark = async () => {
    const mark = await appConnectSessions.keyStore().loadSecret(appConnectSessions.network(), 'pending-request:active-sign-in')
    return mark && new TextDecoder().decode(mark)
  }

  it('leaves the mark on the request opened last when another start fails before it has a request', async () => {
    const engine = await signedOut()
    await engine.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    const plain = await engine.appConnectStart({ returnTo: RETURN_TO })
    if (plain.phase !== 'waiting') throw new Error('not waiting')
    expect(await activeMark()).toBe('login')
    vi.mocked(appConnectPlatformPort.chainStatus).mockRejectedValueOnce(new Error('offline'))
    expect(await engine.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })).toMatchObject({ phase: 'unavailable', reason: 'offline' })
    expect(await activeMark()).toBe('login')
    const next = boot()
    session = next
    expect(await next.appConnectPendingSignIn()).toEqual({ reauth: null })
  })

  it('hands out no request whose mark it could not save, leaving the other one marked', async () => {
    const engine = await signedOut()
    const plain = await engine.appConnectStart({ returnTo: RETURN_TO })
    if (plain.phase !== 'waiting') throw new Error('not waiting')
    await engine.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    const store = appConnectSessions.keyStore()
    const save = store.saveSecret.bind(store)
    const saves = vi.spyOn(store, 'saveSecret').mockImplementation(async (network, name, bytes) => {
      if (name === 'pending-request:active-sign-in') throw new Error('storage failed')
      await save(network, name, bytes)
    })
    emitted = []
    try {
      expect(await engine.appConnectStart({ returnTo: RETURN_TO })).toMatchObject({ phase: 'unavailable', reason: 'storage' })
      expect(flows().some(flow => flow.phase === 'waiting')).toBe(false)
    } finally {
      saves.mockRestore()
    }
    expect(await activeMark()).toBe('reauth')
    const next = boot()
    session = next
    expect(await next.appConnectPendingSignIn()).toEqual({ reauth: OWNER })
  })

  it('answers a launch whose pending sign-in read failed with an error, not an empty slot, and finds it on the next read', async () => {
    const engine = await signedOut()
    await engine.appConnectStart({ reauth: OWNER, returnTo: RETURN_TO })
    const next = boot()
    session = next
    const store = appConnectSessions.keyStore()
    const load = vi.spyOn(store, 'loadSecret').mockRejectedValueOnce(new Error('storage failed'))
    try {
      await expect(next.appConnectPendingSignIn()).rejects.toThrow('storage failed')
    } finally {
      load.mockRestore()
    }
    const decrypt = vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockRejectedValueOnce(new Error('device key unavailable'))
    try {
      await expect(next.appConnectPendingSignIn()).rejects.toThrow('device key unavailable')
    } finally {
      decrypt.mockRestore()
    }
    expect(await next.appConnectPendingSignIn()).toEqual({ reauth: OWNER })
    expect(stored()).toContain(REAUTH_SLOT)
  })

  it('keeps the account signed in when its pending request cannot be deleted at sign-out', async () => {
    const engine = await walletSignIn(await signedOut(), [32, 33])
    const renewal = await engine.appConnectStart({ renew: true, returnTo: RETURN_TO })
    if (renewal.phase !== 'waiting') throw new Error('not waiting')
    const deletes = vi.spyOn(appConnectSessions.keyStore(), 'deleteSecret').mockRejectedValue(new Error('storage failed'))
    try {
      await expect(engine.signOut()).rejects.toThrow('storage failed')
    } finally {
      deletes.mockRestore()
    }
    expect(await engine.current()).toMatchObject({ identityId: OWNER })
    expect(stored()).toContain(RENEWAL_SLOT)
    // Signed out only once the host has deleted the request.
    heldAcks = []
    const signingOut = engine.signOut()
    await until(() => heldAcks?.length, 'the request deletion on its way to the host')
    await settle()
    expect(await engine.current()).toMatchObject({ identityId: OWNER })
    releaseAcks()
    await signingOut
    expect(await engine.current()).toBeNull()
    expect(stored()).not.toContain(RENEWAL_SLOT)
  })

  it('deletes a plain sign-in request left over from an accepted sign-in when the account signs out', async () => {
    const engine = await signedOut()
    await answered(engine, [68, 69])
    const leftover = localStorage.getItem(LOGIN_SLOT)
    expect(leftover).not.toBeNull()
    expect(await engine.appConnectAccept({ identityId: OWNER })).toMatchObject({ status: 'signed-in', reload: false })
    localStorage.setItem(LOGIN_SLOT, leftover ?? '')
    const next = boot()
    session = next
    expect(await next.restore()).toMatchObject({ identityId: OWNER })
    expect(stored()).toContain(LOGIN_SLOT)
    await next.signOut()
    expect(stored()).not.toContain(LOGIN_SLOT)
    expect(await next.appConnectPendingSignIn()).toBeNull()
  })

  it('restores a wallet session killed before it recorded its method as a wallet session', async () => {
    const engine = await signedOut()
    await answered(engine, [24, 25])
    expect(await engine.appConnectAccept({ identityId: OWNER })).toMatchObject({ status: 'signed-in' })
    // Killed after the session and its ring were stored, before the registry heard how it signed in.
    localStorage.removeItem('yappr_engine_accounts')
    const next = boot()
    session = next
    expect(await next.restore()).toMatchObject({ identityId: OWNER, method: 'app-connect' })
    await next.signOut()
  })
})
