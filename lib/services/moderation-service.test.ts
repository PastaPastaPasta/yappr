/**
 * The 4.2.0-beta.4 moderation additions: the shapes this service sends the
 * SDK (reasons citing documents, warnings, restore) and the gates that keep
 * them off contracts that do not declare the capability. Moutai has no
 * contracts to write to, so the SDK is mocked; the live check is PR C's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  contracts: {
    fetch: vi.fn(),
    warnUser: vi.fn(),
    clearUserWarnings: vi.fn(),
    banUser: vi.fn(),
    moderatorDeleteDocument: vi.fn(),
    moderatorRestoreDocument: vi.fn(),
    moderationStatus: vi.fn(),
    moderationEntries: vi.fn(),
  },
  documents: { get: vi.fn() },
  identities: { fetch: vi.fn() },
  moderationCharters: { team: vi.fn() },
}))
const topology = vi.hoisted(() => ({ moderated: true, lists: ['banlist', 'suspensions'] as string[], deletable: ['post', 'reply'] }))
const fromBytes = vi.hoisted(() => vi.fn(() => ({ restored: true })))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./signer-service', () => ({ signerService: { createSigner: async () => ({ signer: true }) } }))
vi.mock('../secure-storage', () => ({ getPrivateKey: () => 'wif' }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true }) }))
vi.mock('@dashevo/evo-sdk', () => ({
  Document: { fromBytes },
  PlatformVersion: { latest: () => 'latest' },
}))
vi.mock('@/lib/contract-topology', () => ({
  contractIsModerated: () => topology.moderated,
  moderationListsKept: () => (topology.moderated ? topology.lists : []),
  contractKeepsWarnings: () => topology.moderated && topology.lists.includes('warnings'),
  moderatorDeletableTypes: () => (topology.moderated ? topology.deletable : []),
}))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
})

import { moderationService, toModerationReason, toRemoval, toWarning } from './moderation-service'
import { removalHashOf, saveSnapshot } from '@/lib/moderation-snapshots'

const MODERATOR = 'Mod111111111111111111111111111111111111111'
const TARGET = 'Tgt111111111111111111111111111111111111111'

beforeEach(() => {
  storage.clear()
  topology.moderated = true
  topology.lists = ['banlist', 'suspensions']
  for (const group of [sdk.contracts, sdk.documents, sdk.identities, sdk.moderationCharters]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  sdk.identities.fetch.mockResolvedValue({ id: MODERATOR, publicKeys: [] })
})

describe('toModerationReason', () => {
  it('sends a bare { text } when nothing is cited, so a pre-beta.4 reason is unchanged', () => {
    expect(toModerationReason({ text: 'spam' })).toEqual({ text: 'spam' })
  })

  it('carries cited documents once each, and the charter reason document when given', () => {
    const post = { documentTypeName: 'post', documentId: 'P1' }
    expect(toModerationReason({ text: 'spam', documents: [post, post, { documentTypeName: 'reply', documentId: 'R1' }], reasonDocumentId: 'RD1' }))
      .toEqual({ text: 'spam', documents: [post, { documentTypeName: 'reply', documentId: 'R1' }], reasonDocumentId: 'RD1' })
  })

  it('refuses more than 16 cited documents before anything is signed (10904 on chain)', () => {
    const documents = Array.from({ length: 17 }, (_, i) => ({ documentTypeName: 'post', documentId: `P${i}` }))
    expect(() => toModerationReason({ text: 'x', documents })).toThrow(/16/)
  })
})

describe('read shapes', () => {
  it('decodes a warning with its cited documents', () => {
    expect(toWarning({ warnedAt: BigInt(1790000000000), reason: { text: 'tone', documents: [{ documentTypeName: 'post', documentId: 'P1' }] } }))
      .toEqual({ warnedAt: 1790000000000, reason: 'tone', documents: [{ documentTypeName: 'post', documentId: 'P1' }] })
  })

  it('decodes a removal record with its hash and restoration', () => {
    const removal = toRemoval({
      documentId: 'D1', documentOwnerId: 'O1', moderatorId: 'M1', reason: { text: 'r' },
      removedAt: BigInt(10), documentHash: 'ab'.repeat(32), restoredAt: BigInt(20), restoredBy: 'M2',
    })
    expect(removal).toMatchObject({ documentHash: 'ab'.repeat(32), restoredAt: 20, restoredBy: 'M2', removedAt: 10 })
    expect(toRemoval({ documentId: 'D1', documentOwnerId: 'O1', moderatorId: 'M1', reason: { text: '' }, removedAt: BigInt(10), documentHash: '00' }))
      .toMatchObject({ restoredAt: null, restoredBy: null })
  })
})

describe('warnings are gated on the contract keeping a warning list', () => {
  it('refuses locally, without signing, when the contract keeps none (v8 as cut)', async () => {
    expect(moderationService.canWarn()).toBe(false)
    const result = await moderationService.warn(MODERATOR, TARGET, 'tone')
    expect(result).toMatchObject({ success: false, errorCode: 'NOT_MODERATED' })
    expect(sdk.contracts.warnUser).not.toHaveBeenCalled()
    expect((await moderationService.listEntries('warnings')).entries).toEqual([])
    expect(sdk.contracts.moderationEntries).not.toHaveBeenCalled()
  })

  it('warns with a reason citing the post when the contract keeps one', async () => {
    topology.lists = ['banlist', 'suspensions', 'warnings']
    sdk.contracts.warnUser.mockResolvedValue({})
    const result = await moderationService.warn(MODERATOR, TARGET, { text: 'tone', documents: [{ documentTypeName: 'post', documentId: 'P1' }] })
    expect(result.success).toBe(true)
    expect(sdk.contracts.warnUser).toHaveBeenCalledWith(expect.objectContaining({
      identityId: TARGET,
      reason: { text: 'tone', documents: [{ documentTypeName: 'post', documentId: 'P1' }] },
    }))
  })

  it('reads the standing from exactly the lists the contract keeps', async () => {
    sdk.contracts.moderationStatus.mockResolvedValue({ lists: ['banlist', 'suspensions'], banned: false })
    const standing = await moderationService.getStanding(TARGET, { fresh: true })
    expect(sdk.contracts.moderationStatus).toHaveBeenCalledWith(expect.objectContaining({ lists: ['banlist', 'suspensions'] }))
    expect(standing.warnings).toEqual([])

    topology.lists = ['banlist', 'suspensions', 'warnings']
    sdk.contracts.moderationStatus.mockResolvedValue({
      lists: ['banlist', 'suspensions', 'warnings'], banned: false,
      warnings: [{ warnedAt: BigInt(5), reason: { text: 'tone' } }],
    })
    const warned = await moderationService.getStanding(TARGET, { fresh: true })
    expect(sdk.contracts.moderationStatus).toHaveBeenLastCalledWith(expect.objectContaining({ lists: ['banlist', 'suspensions', 'warnings'] }))
    expect(warned.warnings).toEqual([{ warnedAt: 5, reason: 'tone', documents: [] }])
  })

  it('classifies a full warning list as its own refusal (41118)', async () => {
    topology.lists = ['banlist', 'suspensions', 'warnings']
    sdk.contracts.warnUser.mockRejectedValue(new Error(
      'Identity Tgt1 already carries 16 warnings on contract C1, the most it may at a time; clear them before warning it again'))
    expect(await moderationService.warn(MODERATOR, TARGET, 'tone')).toMatchObject({ success: false, errorCode: 'WARNING_LIMIT' })
  })
})

describe('remove then restore', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])

  it('snapshots the document before the moderator deletes it', async () => {
    const contract = { id: 'C' }
    sdk.contracts.fetch.mockResolvedValue(contract)
    sdk.documents.get.mockResolvedValue({ toBytes: (c: unknown) => { expect(c).toBe(contract); return bytes } })
    sdk.contracts.moderatorDeleteDocument.mockResolvedValue({})
    const result = await moderationService.removeDocument(MODERATOR, 'post', 'D1', 'spam')
    expect(result.success).toBe(true)
    expect(sdk.documents.get.mock.invocationCallOrder[0]).toBeLessThan(sdk.contracts.moderatorDeleteDocument.mock.invocationCallOrder[0])
    const removal = { documentId: 'D1', documentOwnerId: 'O', moderatorId: MODERATOR, reason: 'spam', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null }
    expect(moderationService.canRestore('post', removal)).toBe(true)
  })

  it('still removes when the snapshot cannot be taken, and then offers no restore', async () => {
    sdk.contracts.fetch.mockRejectedValue(new Error('offline'))
    sdk.contracts.moderatorDeleteDocument.mockResolvedValue({})
    expect((await moderationService.removeDocument(MODERATOR, 'post', 'D2', 'spam')).success).toBe(true)
    const removal = { documentId: 'D2', documentOwnerId: 'O', moderatorId: MODERATOR, reason: '', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null }
    expect(moderationService.canRestore('post', removal)).toBe(false)
  })

  it('offers no restore once restored, past the week, or when the kept bytes do not hash to the record', () => {
    saveSnapshot('post', 'D3', bytes)
    const removal = { documentId: 'D3', documentOwnerId: 'O', moderatorId: MODERATOR, reason: '', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null }
    expect(moderationService.canRestore('post', removal)).toBe(true)
    expect(moderationService.canRestore('post', { ...removal, restoredAt: Date.now(), restoredBy: MODERATOR })).toBe(false)
    expect(moderationService.canRestore('post', removal, Date.now() + 8 * 86_400_000)).toBe(false)
    expect(moderationService.canRestore('post', { ...removal, documentHash: '00'.repeat(32) })).toBe(false)
  })

  it('restores from the kept bytes, decoded fresh under the current contract, and forgets them after', async () => {
    saveSnapshot('reply', 'D4', bytes)
    const contract = { id: 'C' }
    sdk.contracts.fetch.mockResolvedValue(contract)
    sdk.contracts.moderatorRestoreDocument.mockResolvedValue({})
    const result = await moderationService.restoreDocument(MODERATOR, 'reply', 'D4')
    expect(result.success).toBe(true)
    expect(fromBytes).toHaveBeenCalledWith(bytes, contract, 'reply', 'latest')
    expect(sdk.contracts.moderatorRestoreDocument).toHaveBeenCalledWith(expect.objectContaining({ documentTypeName: 'reply', document: { restored: true } }))
    expect(await moderationService.restoreDocument(MODERATOR, 'reply', 'D4')).toMatchObject({ success: false, errorCode: 'NO_SNAPSHOT' })
  })

  it('classifies a restore past the window (41120)', async () => {
    saveSnapshot('post', 'D5', bytes)
    sdk.contracts.fetch.mockResolvedValue({})
    sdk.contracts.moderatorRestoreDocument.mockRejectedValue(new Error(
      'Document D5 on contract C was removed at 1 and could be restored by moderators for 604800000 milliseconds after that, which block time 999999999999 is past'))
    expect(await moderationService.restoreDocument(MODERATOR, 'post', 'D5')).toMatchObject({ success: false, errorCode: 'RESTORE_WINDOW_ELAPSED' })
  })

  it('refuses everything off a moderated topology', async () => {
    topology.moderated = false
    expect(await moderationService.restoreDocument(MODERATOR, 'post', 'D1')).toMatchObject({ errorCode: 'NOT_MODERATED' })
    expect(await moderationService.removeDocument(MODERATOR, 'post', 'D1', 'x')).toMatchObject({ errorCode: 'NOT_MODERATED' })
    expect(sdk.contracts.moderatorDeleteDocument).not.toHaveBeenCalled()
  })
})
