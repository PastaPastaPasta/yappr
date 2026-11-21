import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BatchTransition, ContractUserModeration, Document, IdentityPublicKey, Identifier,
  PlatformVersion, PrivateKey, StateTransition, VerifiedDocuments, VerifiedTokenActionWithDocument, ensureInitialized,
} from '@dashevo/evo-sdk'
import type { EvoSDK, DocumentObject, IdentitySigner, Identity, StateTransitionProofResultType, DataContract } from '@dashevo/evo-sdk'
import bs58 from 'bs58'
import { chosenNonceWrites } from './chosen-nonce-writes'
import { ChosenWriteNotSentError } from './identity-nonce'

const OWNER = bs58.encode(new Uint8Array(32).fill(2))
const CONTRACT = bs58.encode(new Uint8Array(32).fill(1))
const TARGET = bs58.encode(new Uint8Array(32).fill(3))
const NONCE = BigInt(102)
let wif: string
let identityKey: IdentityPublicKey
let sent: StateTransition[] = []
const getDocument = vi.fn()
const calculateId = vi.fn(async () => TARGET)
let response: StateTransitionProofResultType
const broadcast = vi.fn(async (transition: StateTransition) => {
  const bytes = transition.toBytes()
  const decoded = StateTransition.fromBytes(bytes)
  expect(decoded.toBytes()).toEqual(bytes)
  decoded.verifyPublicKey(identityKey)
  sent.push(decoded)
  return response
})
const strictBroadcast = vi.fn((transition: StateTransition) => broadcast(transition))
const sdk = {
  contracts: { fetch: vi.fn(async () => ({})), addKnown: vi.fn(async () => true) },
  documents: { get: getDocument },
  tokens: { calculateId },
  stateTransitions: { broadcastAndWaitForAffectedState: broadcast, broadcastAndWait: strictBroadcast },
} as unknown as EvoSDK

beforeAll(async () => {
  await ensureInitialized()
  const privateKey = PrivateKey.fromHex('0101010101010101010101010101010101010101010101010101010101010101', 'testnet')
  wif = privateKey.toWIF()
  identityKey = new IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'critical', keyType: 'ecdsa_secp256k1', data: privateKey.getPublicKey().toBytes() })
  privateKey.free()
})
beforeEach(() => {
  sent = []
  broadcast.mockClear()
  strictBroadcast.mockClear()
  getDocument.mockReset()
  sdk.contracts.fetch = vi.fn(async () => ({} as DataContract))
  response = VerifiedDocuments.fromObject({ documents: new Map([[TARGET, undefined]]) })
})

function document() {
  return Document.fromObject({
    $formatVersion: '0', $id: new Uint8Array(32).fill(3), $ownerId: bs58.decode(OWNER),
    $dataContractId: bs58.decode(CONTRACT), $type: 'post', $revision: BigInt(2),
    $entropy: new Uint8Array(32).fill(7), content: 'kept content', postId: new Uint8Array(32).fill(4),
  } as unknown as DocumentObject, PlatformVersion.current())
}

const auth = () => ({ signer: {} as IdentitySigner, identity: {} as Identity, identityKey })
const tokenOptions = () => ({ ...auth(), dataContractId: new Identifier(CONTRACT), tokenPosition: 0 })
const writer = (assertLive?: () => void) => chosenNonceWrites(sdk, OWNER, NONCE, wif, identityKey, assertLive)

function batchJSON(): string {
  expect(sent[0].identityContractNonce).toBe(NONCE)
  expect(sent[0].ownerId?.toBase58()).toBe(OWNER)
  return JSON.stringify(BatchTransition.fromStateTransition(sent[0]).toJSON())
}

describe('chosen nonce writes, real WASM signatures and exact serialization', () => {
  it('replaces without changing the document id, revision or data', async () => {
    response = VerifiedDocuments.fromObject({ documents: new Map([[TARGET, document()]]) })
    await writer().documents.replace({ ...auth(), document: document() } as Parameters<EvoSDK['documents']['replace']>[0])
    const json = batchJSON()
    expect(json).toContain('kept content')
    expect(json).toContain(TARGET)
    expect(BatchTransition.fromStateTransition(sent[0]).toObject().transitions[0]).toMatchObject({ $revision: BigInt(2) })
    expect(strictBroadcast).toHaveBeenCalledOnce()
  })

  it('deletes by full values or identifiers without fetching a document', async () => {
    const doc = document()
    await writer().documents.delete({ ...auth(), document: doc } as Parameters<EvoSDK['documents']['delete']>[0])
    expect(batchJSON()).toContain(TARGET)
    await writer().documents.delete({ ...auth(), document: { id: TARGET, ownerId: OWNER, dataContractId: CONTRACT, documentTypeName: 'post' } } as Parameters<EvoSDK['documents']['delete']>[0])
    expect(getDocument).not.toHaveBeenCalled()
    expect(strictBroadcast).toHaveBeenCalledTimes(2)
    expect(sent[1].toBytes()).toEqual(sent[0].toBytes())
  })

  it('carries all index-only delete values and only a supplied creation time', async () => {
    const doc = document()
    doc.createdAt = BigInt(1700000000123)
    await writer().documents.deleteByValues(doc)
    const json = batchJSON()
    expect(json).toContain('indexOnlyDelete')
    expect(json).toContain('kept content')
    expect(json).toContain('1700000000123')
    const payload = BatchTransition.fromStateTransition(sent[0]).toObject().transitions[0] as Record<string, unknown>
    expect(payload.postId).toEqual(new Uint8Array(32).fill(4))
    doc.createdAt = undefined
    await writer().documents.deleteByValues(doc)
    expect(JSON.stringify(BatchTransition.fromStateTransition(sent[1]).toJSON())).not.toContain('$createdAt')
  })

  it.each(['transfer', 'directPurchase', 'claim', 'freeze', 'unfreeze', 'destroyFrozen'] as const)('builds %s with a separate nonce and keeps its action fields', async action => {
    response = VerifiedTokenActionWithDocument.fromObject({ document: document().toObject() })
    const options = { ...tokenOptions(), senderId: new Identifier(OWNER), buyerId: new Identifier(OWNER), identityId: new Identifier(OWNER), authorityId: new Identifier(OWNER), recipientId: new Identifier(TARGET), frozenIdentityId: new Identifier(TARGET), amount: BigInt(25), maxTotalCost: BigInt(1000), distributionType: 'oncePerIdentity' as const, publicNote: 'note' }
    await writer().tokens[action](options)
    const json = batchJSON()
    expect(BatchTransition.fromStateTransition(sent[0]).toObject().transitions[0]).toMatchObject({ '$identity-contract-nonce': NONCE })
    expect(strictBroadcast).toHaveBeenCalledTimes(action === 'claim' || action === 'destroyFrozen' ? 1 : 0)
    expect(json).toContain(TARGET)
    if (action !== 'directPurchase') expect(json).toContain('note')
    if (action === 'directPurchase') { expect(json).toContain('25'); expect(json).toContain('1000') }
  })

  it.each(['banUser', 'unbanUser', 'suspendUser', 'unsuspendUser', 'warnUser', 'clearUserWarnings', 'moderatorDeleteDocument'] as const)('builds %s with the moderator nonce and target', async action => {
    const options = { ...auth(), contractId: CONTRACT, identityId: TARGET, documentId: TARGET, documentTypeName: 'post' }
    if (action === 'moderatorDeleteDocument') await writer().contracts[action]({ ...options, reason: { text: 'Spam' } })
    else {
      const result = action === 'suspendUser' ? writer().contracts[action]({ ...options, reason: { text: 'Spam' }, until: BigInt(1800000000000) })
        : action === 'banUser' || action === 'warnUser' ? writer().contracts[action]({ ...options, reason: { text: 'Spam' } })
        : writer().contracts[action](options)
      await expect(result).rejects.toMatchObject({ name: 'DriveProofError' })
    }
    const transition = ContractUserModeration.fromStateTransition(sent[0])
    expect(transition.identityContractNonce).toBe(NONCE)
    expect(JSON.stringify(transition.toJSON())).toContain(TARGET)
  })

  it.each(['missing', 'present', 'wrong id'] as const)('rejects a delete proof with %s document state', async state => {
    response = VerifiedDocuments.fromObject({ documents: state === 'missing' ? new Map() : new Map([[state === 'wrong id' ? OWNER : TARGET, state === 'present' ? document() : undefined]]) })
    await expect(writer().documents.delete({ ...auth(), document: document() })).rejects.toMatchObject({ name: 'DriveProofError' })
    expect(strictBroadcast).toHaveBeenCalledOnce()
  })

  it('rejects a document with no revision before entering the replacement constructor', async () => {
    const doc = document()
    doc.revision = undefined
    await expect(writer().documents.replace({ ...auth(), document: doc })).rejects.toMatchObject({ reason: new Error('This item could not be updated. Refresh the page and try again.') })
    expect(broadcast).not.toHaveBeenCalled()
    expect(document().revision).toBe(BigInt(2))
  })

  it('marks preparation failures as unsent and leaves broadcast failures uncertain', async () => {
    const failure = new Error('unavailable')
    vi.mocked(sdk.contracts.fetch).mockRejectedValueOnce(failure)
    await expect(writer().documents.replace({ ...auth(), document: document() })).rejects.toBeInstanceOf(ChosenWriteNotSentError)
    expect(broadcast).not.toHaveBeenCalled()
    strictBroadcast.mockRejectedValueOnce(failure)
    await expect(writer().documents.replace({ ...auth(), document: document() })).rejects.toBe(failure)
  })

  it('checks the session again after awaited preparation and before signing', async () => {
    const assertLive = vi.fn(() => { throw new Error('signed out') })
    await expect(writer(assertLive).tokens.claim({ ...tokenOptions(), identityId: new Identifier(OWNER), distributionType: 'oncePerIdentity' })).rejects.toMatchObject({ reason: new Error('signed out') })
    expect(broadcast).not.toHaveBeenCalled()
  })
})
