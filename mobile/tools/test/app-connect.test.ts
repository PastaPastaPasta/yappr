/**
 * App Connect request v2 end to end, with Platform replaced by MemoryChain:
 * the app builds the request with the shared codec, the responder answers it,
 * and the shared verifier (`verifyAppConnectCandidate`) judges every response
 * the app's poll would find. Fault flags must make it reject for the reason
 * the README promises.
 */
import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import {
  buildAppConnectUri,
  appConnectRequestHash,
  type AppConnectRequest,
} from '../../../vendor/platform-auth/src/app-connect/request'
import { KeyPurpose, KeySecurityLevel, KeyType } from '../../../vendor/platform-auth/src/app-connect/types'
import { verifyAppConnectCandidate, type AppConnectVerification } from '../../../vendor/platform-auth/src/app-connect/verify'
import { getYapprPublicKey } from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import { parseFaults } from '../src/app-connect/faults'
import {
  AppConnectRefusal,
  AppConnectUsageError,
  isAppConnectUri,
  respondToAppConnect,
  revokeAppConnect,
  type AppConnectResult,
} from '../src/app-connect/wallet'
import { respond, type ResponderPorts } from '../src/responder'
import type { Persona } from '../src/pool'
import {
  APP_ID,
  CALLBACK,
  DASHPAY_CONTRACT_ID,
  DAY_MS,
  EXPIRES_AT,
  FOREIGN_CONTRACT,
  FOREIGN_GROUP,
  GROUP_ID,
  NOW,
  newChain,
  newRequest,
  type MemoryChain,
} from './app-connect-chain'
import { testPersona } from './fixtures'

const alice = testPersona(90)
const bob = testPersona(91)
const APP = bs58.encode(APP_ID)
const CONNECTION = '0c'.repeat(16)

interface AnswerOptions {
  persona?: Persona
  faults?: string[]
  otherPersona?: Persona
  spamPersonas?: Persona[]
}

function answer(chain: MemoryChain, uri: string, options: AnswerOptions = {}): Promise<AppConnectResult> {
  return respondToAppConnect({
    uri,
    persona: options.persona ?? alice,
    faults: parseFaults(options.faults ?? []),
    otherPersona: options.otherPersona,
    spamPersonas: options.spamPersonas,
  }, chain.ports())
}

/** What the app concludes about each response to its request. */
async function verifyAll(chain: MemoryChain, request: AppConnectRequest, appPrivateKey: Uint8Array) {
  const results: Array<{ ownerId: string; verification: AppConnectVerification }> = []
  for (const candidate of chain.candidates(appConnectRequestHash(request))) {
    const verification = await verifyAppConnectCandidate({
      request,
      appEphemeralPrivateKey: appPrivateKey,
      candidate,
      identity: chain.identityPort(),
      now: chain.now,
    })
    results.push({ ownerId: candidate.ownerId, verification })
  }
  return results
}

async function verdictFor(chain: MemoryChain, request: AppConnectRequest, appPrivateKey: Uint8Array, persona = alice) {
  const found = (await verifyAll(chain, request, appPrivateKey)).find((entry) => entry.ownerId === persona.identityId)
  if (!found) throw new Error(`no response from persona ${persona.personaIdx}`)
  return found.verification
}

function reason(verification: AppConnectVerification): string {
  return verification.ok ? 'ok' : verification.reason
}

async function refusalOf(promise: Promise<unknown>): Promise<AppConnectRefusal> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(AppConnectRefusal)
  return error as AppConnectRefusal
}

describe('App Connect login', () => {
  it('registers the requested keys in one update and publishes a response the app verifies', async () => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    const result = await answer(chain, uri)

    expect(chain.calls).toEqual(['update 90 +3 -[]', 'create 90'])
    expect(result.answer).toMatchObject({
      mode: 'login',
      addedKeyIds: [5, 6, 7],
      disabledKeyIds: [],
      deletedResponses: 0,
      slots: [
        { role: 'contractGroup', bindingIndex: 0, keyId: 5 },
        { role: 'documentType', bindingIndex: 1, keyId: 6 },
        { role: 'encryption', bindingIndex: 0, keyId: 7 },
      ],
    })
    expect(result.callbackUrl).toBe(`${CALLBACK}&ac=ok`)

    const verification = await verdictFor(chain, request, appPrivateKey)
    expect(verification.ok).toBe(true)
    if (!verification.ok) return
    const [groupKey, profileKey] = verification.grant.authKeys.map((granted) => granted.key)
    expect(groupKey).toMatchObject({ securityLevel: KeySecurityLevel.CRITICAL, totalBudget: 50_000_000_000n, expiresAt: EXPIRES_AT })
    expect(profileKey).toMatchObject({ securityLevel: KeySecurityLevel.HIGH, totalBudget: 1_000_000_000n })
    expect(verification.grant.encryptionKeys[0].key).toMatchObject({ securityLevel: KeySecurityLevel.MEDIUM, bounds: { kind: 'singleContract' } })
  })

  it('clamps the limits to the wallet caps and gives an unlimited binding the 90-day preset', async () => {
    const chain = newChain()
    const { uri } = newRequest({
      authBindings: [
        { kind: 'contractGroup', id: GROUP_ID, securityLevel: KeySecurityLevel.HIGH, totalBudget: 10n ** 13n, expiresAt: NOW + 900 * DAY_MS },
        { kind: 'documentType', id: bs58.decode(DASHPAY_CONTRACT_ID), documentTypeName: 'profile', securityLevel: KeySecurityLevel.HIGH },
      ],
    })
    await answer(chain, uri)
    const [group, profile] = chain.keysOf(alice).slice(5)
    expect(group).toMatchObject({ securityLevel: KeySecurityLevel.HIGH, totalBudget: 500_000_000_000n, expiresAt: NOW + 365 * DAY_MS })
    expect(profile).toMatchObject({ totalBudget: undefined, expiresAt: NOW + 90 * DAY_MS })
  })

  it('on a re-login from the same connection disables the old keys, re-sends the encryption key and replaces the response', async () => {
    const chain = newChain()
    const first = newRequest()
    await answer(chain, first.uri)
    chain.calls.length = 0

    const second = newRequest()
    const result = await answer(chain, second.uri)
    expect(chain.calls).toEqual(['update 90 +2 -[5,6]', 'delete 90', 'create 90'])
    expect(result.answer).toMatchObject({ addedKeyIds: [8, 9], disabledKeyIds: [5, 6], deletedResponses: 1 })
    expect(result.answer.slots[2]).toEqual({ role: 'encryption', bindingIndex: 0, keyId: 7 })

    expect(chain.candidates(appConnectRequestHash(first.request))).toEqual([])
    expect((await verdictFor(chain, second.request, second.appPrivateKey)).ok).toBe(true)
  })

  it('answers a retry of the same request after a failed publish without registering anything twice', async () => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    const ports = chain.ports()
    const create = ports.createResponse
    ports.createResponse = () => Promise.reject(new Error('gateway hiccup'))
    expect(await refusalOf(respondToAppConnect({ uri, persona: alice }, ports))).toMatchObject({ status: 'failed' })
    ports.createResponse = create
    chain.calls.length = 0

    const result = await respondToAppConnect({ uri, persona: alice }, ports)
    // The attempted response is still recorded; its delete finds nothing and it is forgotten.
    expect(chain.calls).toEqual(['delete 90', 'create 90'])
    expect(chain.grants.get(alice.identityId, APP).responses).toHaveLength(1)
    expect(result.answer).toMatchObject({ addedKeyIds: [], disabledKeyIds: [] })
    expect(result.answer.slots.map((slot) => slot.keyId)).toEqual([5, 6, 7])
    expect((await verdictFor(chain, request, appPrivateKey)).ok).toBe(true)
  })

  it('keeps the values of a create whose outcome is unknown, so a retry can delete it', async () => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    const ports = chain.ports()
    const create = ports.createResponse
    // The entry lands, then the connection drops before the answer arrives.
    ports.createResponse = async (persona, values) => {
      await create(persona, values)
      throw new Error('socket hang up')
    }
    await refusalOf(respondToAppConnect({ uri, persona: alice }, ports))
    ports.createResponse = create

    const result = await respondToAppConnect({ uri, persona: alice }, ports)
    expect(result.answer.deletedResponses).toBe(1)
    expect(chain.candidates(appConnectRequestHash(request))).toHaveLength(1)
    expect(reason(await verdictFor(chain, request, appPrivateKey))).toBe('ok')
  })

  it('forgets an attempted create that Platform refused', async () => {
    const chain = newChain()
    const ports = chain.ports()
    ports.createResponse = () => Promise.reject(Object.assign(new Error('refused'), { code: 40105 }))
    await refusalOf(respondToAppConnect({ uri: newRequest().uri, persona: alice }, ports))
    expect(chain.grants.get(alice.identityId, APP).responses).toEqual([])
  })

  it('forgets a previous response only when Platform says it is gone', async () => {
    const chain = newChain()
    await answer(chain, newRequest().uri)
    const ports = chain.ports()
    const remove = ports.deleteResponse
    ports.deleteResponse = () => Promise.reject(Object.assign(new Error('nonce conflict'), { code: 40204 }))
    await respondToAppConnect({ uri: newRequest().uri, persona: alice }, ports)
    expect(chain.grants.get(alice.identityId, APP).responses).toHaveLength(2)

    ports.deleteResponse = remove
    const result = await respondToAppConnect({ uri: newRequest().uri, persona: alice }, ports)
    expect(result.answer.deletedResponses).toBe(2)
    expect(chain.grants.get(alice.identityId, APP).responses).toHaveLength(1)

    ports.deleteResponse = () => Promise.reject(Object.assign(new Error('DocumentNotFoundError'), { code: 40101 }))
    await respondToAppConnect({ uri: newRequest().uri, persona: alice }, ports)
    expect(chain.grants.get(alice.identityId, APP).responses).toHaveLength(1)
  })

  it('without a connection id supersedes nothing', async () => {
    const chain = newChain()
    await answer(chain, newRequest({ connectionId: undefined }).uri)
    const result = await answer(chain, newRequest({ connectionId: undefined }).uri)
    expect(result.answer.disabledKeyIds).toEqual([])
    expect(chain.keysOf(alice).filter((key) => key.disabledAt !== undefined)).toEqual([])
  })

  it('omits the encryption slot when another wallet made the current key, and never rotates it', async () => {
    const chain = newChain()
    chain.keysOf(alice).push({
      id: 5,
      type: KeyType.ECDSA_SECP256K1,
      purpose: KeyPurpose.ENCRYPTION,
      securityLevel: KeySecurityLevel.MEDIUM,
      data: getYapprPublicKey(secp256k1.utils.randomSecretKey()),
      bounds: { kind: 'singleContract', contractId: APP },
    })
    const { request, appPrivateKey, uri } = newRequest()
    const result = await answer(chain, uri)
    expect(result.answer.slots.map((slot) => slot.role)).toEqual(['contractGroup', 'documentType'])
    expect(result.answer.addedKeyIds).toHaveLength(2)
    expect((await verdictFor(chain, request, appPrivateKey)).ok).toBe(true)
  })

  it('is routed from respond() by v=2, and refuses fault flags on other URIs', async () => {
    const chain = newChain()
    const { uri } = newRequest()
    expect(isAppConnectUri(uri)).toBe(true)
    expect(isAppConnectUri(uri.replace('v=2', 'v=1'))).toBe(false)
    const ports = { appConnect: chain.ports() } as unknown as ResponderPorts
    await expect(respond({ uri, persona: alice }, ports)).resolves.toMatchObject({ kind: 'app-connect' })
    await expect(respond({ uri: 'dash-st:abc?n=d&v=1', persona: alice, faults: parseFaults(['bad-tag']) }, ports))
      .rejects.toThrow(/App Connect/)
  })
})

describe('App Connect wallet rules', () => {
  it('refuses a request for another network without touching the chain', async () => {
    const chain = newChain()
    const { request } = newRequest()
    const refusal = await refusalOf(answer(chain, buildAppConnectUri(request, 'testnet', CALLBACK)))
    expect(refusal).toMatchObject({ status: 'invalid', callbackUrl: `${CALLBACK}&ac=invalid` })
    expect(refusal.message).toMatch(/testnet/)
    expect(chain.calls).toEqual([])
  })

  it('refuses a request older than 10 minutes or more than 2 minutes ahead (stale)', async () => {
    const chain = newChain()
    for (const createdAt of [NOW - 11 * 60_000, NOW + 3 * 60_000]) {
      const refusal = await refusalOf(answer(chain, newRequest({ createdAt }).uri))
      expect(refusal).toMatchObject({ status: 'stale', callbackUrl: `${CALLBACK}&ac=stale` })
    }
    expect(chain.calls).toEqual([])
  })

  it('maps codec errors to unsupported and invalid', async () => {
    const chain = newChain()
    const { uri } = newRequest()
    expect(await refusalOf(answer(chain, uri.replace('v=2', 'v=2&v=2')))).toMatchObject({ status: 'invalid' })
    const body = bs58.decode(uri.slice('dash-key:'.length, uri.indexOf('?')))
    body[0] = 3
    expect(await refusalOf(answer(chain, `dash-key:${bs58.encode(body)}?n=d&v=2`))).toMatchObject({ status: 'unsupported' })
  })

  it('answers only as the hinted identity', async () => {
    const chain = newChain()
    const hinted = newRequest({ identityHint: bob.identityIdBytes })
    expect(await refusalOf(answer(chain, hinted.uri))).toMatchObject({ status: 'invalid' })
    await expect(answer(chain, hinted.uri, { persona: bob })).resolves.toMatchObject({ kind: 'app-connect' })
  })

  it('enforces owner consistency and the encryption opt-in', async () => {
    const chain = newChain()
    const cases: Array<Partial<AppConnectRequest>> = [
      { authBindings: [{ kind: 'contractGroup', id: bs58.decode(FOREIGN_GROUP), securityLevel: KeySecurityLevel.HIGH, totalBudget: 1n }] },
      { authBindings: [{ kind: 'contractGroup', id: new Uint8Array(32).fill(0xa9), securityLevel: KeySecurityLevel.HIGH, totalBudget: 1n }] },
      { authBindings: [{ kind: 'singleContract', id: FOREIGN_CONTRACT, securityLevel: KeySecurityLevel.HIGH }] },
      // A foreign document type that is not the allowlisted DashPay profile.
      { authBindings: [{ kind: 'documentType', id: bs58.decode(DASHPAY_CONTRACT_ID), documentTypeName: 'contactRequest', securityLevel: KeySecurityLevel.HIGH }] },
      { encBindings: [{ contractId: FOREIGN_CONTRACT, purpose: KeyPurpose.ENCRYPTION }] },
      { encBindings: [{ contractId: APP_ID, purpose: KeyPurpose.DECRYPTION }] },
      { appId: new Uint8Array(32).fill(0xaf) },
    ]
    for (const overrides of cases) {
      expect(await refusalOf(answer(chain, newRequest(overrides).uri))).toMatchObject({ status: 'invalid' })
    }
    expect(chain.calls).toEqual([])
  })

  it('refuses a binding whose proposed expiry has passed', async () => {
    const chain = newChain()
    const { uri } = newRequest({
      authBindings: [{ kind: 'contractGroup', id: GROUP_ID, securityLevel: KeySecurityLevel.HIGH, totalBudget: 1n, expiresAt: NOW - 1 }],
    })
    expect(await refusalOf(answer(chain, uri))).toMatchObject({ status: 'invalid' })
  })

  it('reports a failed write as failed, with the callback', async () => {
    const chain = newChain()
    const ports = chain.ports()
    ports.createResponse = () => Promise.reject(new Error('broadcast refused'))
    const refusal = await refusalOf(respondToAppConnect({ uri: newRequest().uri, persona: alice }, ports))
    expect(refusal).toMatchObject({ status: 'failed', callbackUrl: `${CALLBACK}&ac=failed` })
  })
})

describe('App Connect renew', () => {
  function renewRequest(chain: MemoryChain, totalBudget: bigint) {
    return newRequest({
      identityHint: alice.identityIdBytes,
      mode: 'renew',
      createdAt: chain.now - 1_000,
      authBindings: [{ kind: 'contractGroup', id: GROUP_ID, securityLevel: KeySecurityLevel.CRITICAL, totalBudget, expiresAt: chain.now + 90 * DAY_MS }],
      encBindings: [],
    })
  }

  it('raises the limits of the existing keys in place and republishes them', async () => {
    const chain = newChain()
    await answer(chain, newRequest({ identityHint: alice.identityIdBytes }).uri)
    chain.calls.length = 0
    chain.now += 30 * DAY_MS

    const renew = renewRequest(chain, 20_000_000_000n)
    const result = await answer(chain, renew.uri)
    expect(result.answer).toMatchObject({ mode: 'renew', addedKeyIds: [], disabledKeyIds: [], raisedKeyIds: [5] })
    expect(chain.calls).toEqual(['limits 90 5', 'delete 90', 'create 90'])
    expect(chain.keysOf(alice)[5]).toMatchObject({ totalBudget: 70_000_000_000n, expiresAt: chain.now + 90 * DAY_MS })

    const verification = await verdictFor(chain, renew.request, renew.appPrivateKey)
    expect(verification.ok && verification.grant.authKeys.map((granted) => granted.key.id)).toEqual([5])
  })

  it('never raises a budget past the 5 DASH cap', async () => {
    const chain = newChain()
    await answer(chain, newRequest().uri)
    chain.now += DAY_MS
    await answer(chain, renewRequest(chain, 490_000_000_000n).uri)
    expect(chain.keysOf(alice)[5].totalBudget).toBe(500_000_000_000n)
  })

  it('applies a renewal once, even when the same request is retried after a failed publish', async () => {
    const chain = newChain()
    await answer(chain, newRequest().uri)
    chain.now += DAY_MS
    const renew = renewRequest(chain, 20_000_000_000n)
    const ports = chain.ports()
    const create = ports.createResponse
    ports.createResponse = () => Promise.reject(new Error('gateway hiccup'))
    await refusalOf(respondToAppConnect({ uri: renew.uri, persona: alice }, ports))
    ports.createResponse = create
    const result = await respondToAppConnect({ uri: renew.uri, persona: alice }, ports)
    expect(result.answer.raisedKeyIds).toEqual([])
    expect(chain.keysOf(alice)[5].totalBudget).toBe(70_000_000_000n)
    expect(reason(await verdictFor(chain, renew.request, renew.appPrivateKey))).toBe('ok')
  })

  it('does not raise the keys a renewal created when it fell back to a login and is retried', async () => {
    const chain = newChain()
    await answer(chain, newRequest().uri)
    const renew = newRequest({
      identityHint: alice.identityIdBytes,
      mode: 'renew',
      authBindings: [{ kind: 'contractGroup', id: GROUP_ID, securityLevel: KeySecurityLevel.HIGH, totalBudget: 1_000n, expiresAt: EXPIRES_AT }],
      encBindings: [],
    })
    const ports = chain.ports()
    const create = ports.createResponse
    ports.createResponse = () => Promise.reject(new Error('gateway hiccup'))
    await refusalOf(respondToAppConnect({ uri: renew.uri, persona: alice }, ports))
    ports.createResponse = create
    chain.calls.length = 0

    const result = await respondToAppConnect({ uri: renew.uri, persona: alice }, ports)
    expect(result.answer).toMatchObject({ mode: 'login', addedKeyIds: [], raisedKeyIds: [] })
    expect(chain.calls.some((call) => call.startsWith('limits'))).toBe(false)
    expect(chain.keysOf(alice).at(-1)?.totalBudget).toBe(1_000n)
    expect(reason(await verdictFor(chain, renew.request, renew.appPrivateKey))).toBe('ok')
  })

  it.each([
    ['unregistered-key', 'key-not-found'],
    ['unbound-key', 'key-unbound'],
    [`foreign-group=${FOREIGN_GROUP}`, 'key-unmatched'],
    ['expired', 'key-expired'],
    ['expires-in=120', 'key-expired'],
  ])('honours %s on a renewal by answering with fresh keys', async (fault, expected) => {
    const chain = newChain()
    await answer(chain, newRequest().uri)
    chain.now += DAY_MS
    const renew = renewRequest(chain, 1_000n)
    const result = await answer(chain, renew.uri, { faults: [fault] })
    expect(result.answer.mode).toBe('login')
    expect(reason(await verdictFor(chain, renew.request, renew.appPrivateKey))).toBe(expected)
  })

  it('honours budget=<n> on a renewal with fresh keys of exactly n credits', async () => {
    const chain = newChain()
    await answer(chain, newRequest().uri)
    chain.now += DAY_MS
    const result = await answer(chain, renewRequest(chain, 1_000n).uri, { faults: ['budget=500'] })
    expect(result.answer.mode).toBe('login')
    expect(chain.keysOf(alice).at(-1)?.totalBudget).toBe(500n)
  })

  it('answers as a new login when the old key cannot serve the renewal', async () => {
    // A CRITICAL group key cannot answer a request for HIGH.
    const chain = newChain()
    await answer(chain, newRequest().uri)
    const high = newRequest({
      identityHint: alice.identityIdBytes,
      mode: 'renew',
      authBindings: [{ kind: 'contractGroup', id: GROUP_ID, securityLevel: KeySecurityLevel.HIGH, totalBudget: 1n, expiresAt: EXPIRES_AT }],
      encBindings: [],
    })
    expect((await answer(chain, high.uri)).answer.mode).toBe('login')
    expect(reason(await verdictFor(chain, high.request, high.appPrivateKey))).toBe('ok')

    // A key granted without a budget cannot gain one.
    const noBudget = newChain()
    const profileOnly = (budget?: bigint) => newRequest({
      identityHint: alice.identityIdBytes,
      mode: budget === undefined ? undefined : 'renew',
      authBindings: [{ kind: 'documentType', id: bs58.decode(DASHPAY_CONTRACT_ID), documentTypeName: 'profile', securityLevel: KeySecurityLevel.HIGH, totalBudget: budget }],
      encBindings: [],
    })
    await answer(noBudget, profileOnly().uri)
    const renew = profileOnly(1_000n)
    expect((await answer(noBudget, renew.uri)).answer.mode).toBe('login')
    expect(reason(await verdictFor(noBudget, renew.request, renew.appPrivateKey))).toBe('ok')
  })

  it('answers as a new login when an exhausted key cannot regain budget within the cap', async () => {
    const chain = newChain()
    await answer(chain, newRequest({ authBindings: [{ ...newRequest().request.authBindings[0], totalBudget: 500_000_000_000n }] }).uri)
    chain.spend(alice, 5, 500_000_000_000n)
    const renew = renewRequest(chain, 1_000n)
    const result = await answer(chain, renew.uri)
    expect(result.answer.mode).toBe('login')
    expect(reason(await verdictFor(chain, renew.request, renew.appPrivateKey))).toBe('ok')
  })

  it('falls back to a new login when there is no live grant to renew', async () => {
    const chain = newChain()
    const result = await answer(chain, newRequest({ identityHint: alice.identityIdBytes, mode: 'renew' }).uri)
    expect(result.answer.mode).toBe('login')
    expect(chain.logs.join('\n')).toMatch(/no live grant to renew/)
  })
})

describe('App Connect revoke', () => {
  it('disables the grant keys of a connection in one update and forgets them', async () => {
    const chain = newChain()
    await answer(chain, newRequest().uri)
    const result = await revokeAppConnect({ persona: alice, appId: APP }, chain.ports())
    expect(result).toMatchObject({ disabledKeyIds: [5, 6], connections: [CONNECTION] })
    expect(chain.calls.at(-1)).toBe('update 90 +0 -[5,6]')
    // The shared encryption key stays.
    expect(chain.keysOf(alice)[7].disabledAt).toBeUndefined()
    expect(chain.grants.get(alice.identityId, APP).connections).toEqual({})
  })

  it('disables at most ten keys per update', async () => {
    const chain = newChain()
    for (const byte of [1, 2, 3, 4, 5, 6]) await answer(chain, newRequest({ connectionId: new Uint8Array(16).fill(byte) }).uri)
    const result = await revokeAppConnect({ persona: alice, appId: APP }, chain.ports())
    expect(result.disabledKeyIds).toHaveLength(12)
    expect(chain.calls.filter((call) => call.startsWith('update 90 +0'))).toHaveLength(2)
  })

  it('never disables a key it cannot prove it made, whatever the state file says', async () => {
    const chain = newChain()
    // A bounded, limited auth key from another wallet, next to the pool keys 0-4.
    chain.keysOf(alice).push({
      id: 5,
      type: KeyType.ECDSA_SECP256K1,
      purpose: KeyPurpose.AUTHENTICATION,
      securityLevel: KeySecurityLevel.HIGH,
      data: getYapprPublicKey(secp256k1.utils.randomSecretKey()),
      bounds: { kind: 'singleContract', contractId: APP },
      totalBudget: 1n,
    })
    chain.grants.put(alice.identityId, APP, {
      responses: [],
      connections: { [CONNECTION]: { keys: [0, 1, 2, 3, 4, 5].map((keyId) => ({ keyId, bindingIndex: 0, derivationTag: '00'.repeat(32) })), grantedAt: '' } },
    })
    const result = await revokeAppConnect({ persona: alice, appId: APP }, chain.ports())
    expect(result.disabledKeyIds).toEqual([])
    expect(chain.calls).toEqual([])

    // The same record on a re-login: nothing disabled either.
    const login = await answer(chain, newRequest().uri)
    expect(login.answer.disabledKeyIds).toEqual([])
    expect(chain.keysOf(alice).every((key) => key.disabledAt === undefined)).toBe(true)
  })
})

describe('App Connect fault flags', () => {
  const rejectedAs: Array<[string, string]> = [
    ['wrong-owner', 'decrypt'],
    ['unregistered-key', 'key-not-found'],
    ['unbound-key', 'key-unbound'],
    ['critical', 'key-level'],
    [`foreign-group=${FOREIGN_GROUP}`, 'key-unmatched'],
    ['expired', 'key-expired'],
    ['expires-in=120', 'key-expired'],
    ['bad-tag', 'decrypt'],
    ['extra-slot', 'framing'],
  ]
  it.each(rejectedAs)('%s makes the app reject the response (%s)', async (fault, expected) => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    const result = await answer(chain, uri, { faults: [fault] })
    expect(result.faults).toEqual([fault])
    expect(reason(await verdictFor(chain, request, appPrivateKey))).toBe(expected)
  })

  it('budget=<n> grants exactly n credits to every auth key', async () => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    await answer(chain, uri, { faults: ['budget=1000'] })
    expect(chain.keysOf(alice).slice(5, 7).map((key) => key.totalBudget)).toEqual([1000n, 1000n])
    expect(reason(await verdictFor(chain, request, appPrivateKey))).toBe('ok')
  })

  it('omit-enc and omit-profile decline those bindings; the grant still verifies', async () => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    const result = await answer(chain, uri, { faults: ['omit-enc', 'omit-profile'] })
    expect(result.answer.slots.map((slot) => slot.role)).toEqual(['contractGroup'])
    expect(reason(await verdictFor(chain, request, appPrivateKey))).toBe('ok')
  })

  it('copy-response republishes the payload under another identity, where it does not open', async () => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    const result = await answer(chain, uri, { faults: ['copy-response'], otherPersona: bob })
    expect(result.copiedTo).toBe(bob.identityId)
    expect(reason(await verdictFor(chain, request, appPrivateKey))).toBe('ok')
    expect(reason(await verdictFor(chain, request, appPrivateKey, bob))).toBe('decrypt')
  })

  it('second-identity answers the same request from another persona with its own keys', async () => {
    const chain = newChain()
    const { request, appPrivateKey, uri } = newRequest()
    const result = await answer(chain, uri, { faults: ['second-identity'], otherPersona: bob })
    expect(result.secondIdentity?.identityId).toBe(bob.identityId)
    const verdicts = await verifyAll(chain, request, appPrivateKey)
    expect(verdicts.map((entry) => [entry.ownerId, reason(entry.verification)]).sort())
      .toEqual([[alice.identityId, 'ok'], [bob.identityId, 'ok']].sort())
  })

  it('spam=<n> publishes junk from n other personas, without deleting their live responses', async () => {
    const chain = newChain()
    const spammers = [92, 93, 94].map((idx) => testPersona(idx))
    // Persona 92 is logged in elsewhere (another test lane).
    const lane = newRequest()
    await answer(chain, lane.uri, { persona: spammers[0] })

    const { request, appPrivateKey, uri } = newRequest()
    const result = await answer(chain, uri, { faults: ['spam=2'], spamPersonas: [alice, ...spammers] })
    expect(result.spam).toEqual(spammers.slice(0, 2).map((persona) => persona.identityId))
    const verdicts = await verifyAll(chain, request, appPrivateKey)
    expect(verdicts).toHaveLength(3)
    expect(verdicts.filter((entry) => entry.verification.ok).map((entry) => entry.ownerId)).toEqual([alice.identityId])
    expect(reason(await verdictFor(chain, lane.request, lane.appPrivateKey, spammers[0]))).toBe('ok')
  })

  it('spam=<n> can be retried on the same request', async () => {
    const chain = newChain()
    const spammers = [92, 93].map((idx) => testPersona(idx))
    const { request, appPrivateKey, uri } = newRequest()
    await answer(chain, uri, { faults: ['spam=2'], spamPersonas: spammers })
    await answer(chain, uri, { faults: ['spam=2'], spamPersonas: spammers })
    const verdicts = await verifyAll(chain, request, appPrivateKey)
    expect(verdicts).toHaveLength(3)
    expect(reason(await verdictFor(chain, request, appPrivateKey))).toBe('ok')
  })

  it('refuses faults it cannot honour as usage errors, before writing', async () => {
    const chain = newChain()
    await expect(answer(chain, newRequest().uri, { faults: ['second-identity'] })).rejects.toThrow(/other persona/)
    await expect(answer(chain, newRequest().uri, { faults: ['spam=3'], spamPersonas: [bob] })).rejects.toThrow(/spam=3/)
    const groupOnly = newRequest({ authBindings: [newRequest().request.authBindings[0]] })
    await expect(answer(chain, groupOnly.uri, { faults: ['critical'] })).rejects.toBeInstanceOf(AppConnectUsageError)
    expect(chain.calls).toEqual([])
  })
})
