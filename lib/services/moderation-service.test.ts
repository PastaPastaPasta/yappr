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
    claimFees: vi.fn(),
    moderatorRestoreDocument: vi.fn(),
    moderationStatus: vi.fn(),
    moderationEntries: vi.fn(),
    moderatorChangeDocumentFields: vi.fn(),
    documentRemovals: vi.fn(),
  },
  documents: { get: vi.fn() },
  identities: { fetch: vi.fn() },
  moderationCharters: { team: vi.fn() },
}))
const topology = vi.hoisted(() => ({
  moderated: true, lists: ['banlist', 'suspensions'] as string[], deletable: ['post', 'reply'], ownerProtected: true,
  /** v10: reports are resolved (changeFields) and a deleted one keeps no removal record. */
  resolvesReports: false, recordless: [] as string[],
}))
const fromBytes = vi.hoisted(() => vi.fn(() => ({ restored: true })))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
// The nonce lock reads Platform's nonce; these tests are about moderation, so it just runs the write.
vi.mock('./identity-nonce', () => ({ withSdkSignedWrite: (...args: [string, string, () => Promise<unknown>]) => args[2]() }))
vi.mock('./sdk-helpers', () => ({ identifierToBase58: (value: unknown) => String(value) }))
vi.mock('./signer-service', () => ({ signerService: { createSigner: async () => ({ signer: true }) } }))
vi.mock('../secure-storage', () => ({ getPrivateKey: () => 'wif' }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true }) }))
vi.mock('@dashevo/evo-sdk', () => ({
  Document: { fromBytes },
  PlatformVersion: { latest: () => 'latest' },
}))
vi.mock('@/lib/contract-topology', () => ({
  contractIsModerated: () => topology.moderated,
  // The moderated cut these tests model is v9: posts tombstone, so an absence is a takedown.
  authorDeletesLeaveHoles: () => false,
  moderationListsKept: () => (topology.moderated ? topology.lists : []),
  contractKeepsWarnings: () => topology.moderated && topology.lists.includes('warnings'),
  moderatorDeletableTypes: () => (topology.moderated ? topology.deletable : []),
  electedModeration: () => (topology.moderated ? { ownerProtected: topology.ownerProtected } : null),
  moderatorDeletionKeepsRecord: (type: string) => topology.moderated && topology.deletable.includes(type) && !topology.recordless.includes(type),
  reportsAreResolved: () => topology.moderated && topology.resolvesReports,
}))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
})

import { missingDocumentState, moderationService, protectedIdentities, resolveModerationTeam, toModerationReason, toRemoval, toWarning } from './moderation-service'
import { removalHashOf, saveSnapshot } from '@/lib/moderation-snapshots'

const MODERATOR = 'Mod111111111111111111111111111111111111111'
const TARGET = 'Tgt111111111111111111111111111111111111111'

beforeEach(() => {
  storage.clear()
  topology.moderated = true
  topology.lists = ['banlist', 'suspensions']
  topology.resolvesReports = false
  topology.recordless = []
  for (const group of [sdk.contracts, sdk.documents, sdk.identities, sdk.moderationCharters]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  sdk.identities.fetch.mockResolvedValue({ id: MODERATOR, publicKeys: [] })
  moderationService.invalidateTeam()
})

const OWNER = 'Own111111111111111111111111111111111111111'
const APPOINTED = 'App111111111111111111111111111111111111111'
const LEADER = 'Ldr111111111111111111111111111111111111111'
const MEMBER = 'Mem111111111111111111111111111111111111111'
const elected = (interim: Record<string, unknown>) =>
  ({ $type: 'elected', interim, moderatedDocumentTypes: {}, ownerProtected: true, seatContestable: false }) as unknown as Parameters<typeof resolveModerationTeam>[1]

describe('who moderates (mirrors Drive ContractModerators::may_moderate)', () => {
  it.each([
    ['contractOwner interim', { $type: 'contractOwner' }, true, []],
    ['appointedModerators interim', { $type: 'appointedModerators', identities: [APPOINTED] }, true, [APPOINTED]],
    ['notYetUsable interim', { $type: 'notYetUsable' }, false, []],
    ['noModeration interim', { $type: 'noModeration' }, false, []],
  ] as const)('an elected contract with a %s', (_label, interim, ownerModerates, appointed) => {
    const team = resolveModerationTeam(OWNER, elected(interim), null)
    expect(team).toEqual({ ownerId: OWNER, appointed, elected: false, ownerModerates })
  })

  it('a seated team moderates alone: the owner no longer may, even when ownerProtected', () => {
    const team = resolveModerationTeam(OWNER, elected({ $type: 'contractOwner' }), { leaderId: LEADER, members: [MEMBER] })
    expect(team).toEqual({ ownerId: OWNER, appointed: [LEADER, MEMBER], elected: true, ownerModerates: false })
  })

  it('an owner or appointed declaration always lets the owner moderate', () => {
    expect(resolveModerationTeam(OWNER, { $type: 'contractOwner' } as Parameters<typeof resolveModerationTeam>[1], null).ownerModerates).toBe(true)
    expect(resolveModerationTeam(OWNER, { $type: 'appointedModerators', identities: [APPOINTED] } as Parameters<typeof resolveModerationTeam>[1], null))
      .toEqual({ ownerId: OWNER, appointed: [APPOINTED], elected: false, ownerModerates: true })
  })

  it('sees a team seated mid-session once the cache expires or a moderation action ran, and frees the wasm team', async () => {
    const contract = { ownerId: { toBase58: () => OWNER }, config: { moderation: { moderators: elected({ $type: 'contractOwner' }) } } }
    sdk.contracts.fetch.mockResolvedValue(contract)
    sdk.moderationCharters.team.mockResolvedValue(undefined)
    expect(await moderationService.isModerator(OWNER)).toBe(true)

    const free = vi.fn()
    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => LEADER }, members: [{ toBase58: () => MEMBER }], free })
    // Still cached: the owner reads as a moderator until the cache moves.
    expect(await moderationService.isModerator(OWNER)).toBe(true)
    // A moderation action (here refused, as Drive refuses the owner once seated) drops the cache.
    sdk.contracts.banUser.mockRejectedValue(new Error('Identity Own1 is not the owner or a moderator of contract C'))
    expect(await moderationService.ban(OWNER, TARGET, 'x')).toMatchObject({ errorCode: 'NOT_MODERATOR' })
    expect(await moderationService.isModerator(OWNER)).toBe(false)
    expect(await moderationService.isModerator(LEADER)).toBe(true)
    expect(await moderationService.isModerator(MEMBER)).toBe(true)
    expect(free).toHaveBeenCalledTimes(1)
  })

  it('re-reads the team after its TTL', async () => {
    vi.useFakeTimers()
    try {
      const contract = { ownerId: { toBase58: () => OWNER }, config: { moderation: { moderators: elected({ $type: 'contractOwner' }) } } }
      sdk.contracts.fetch.mockResolvedValue(contract)
      sdk.moderationCharters.team.mockResolvedValue(undefined)
      await moderationService.getTeam()
      await moderationService.getTeam()
      expect(sdk.moderationCharters.team).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(61_000)
      await moderationService.getTeam()
      expect(sdk.moderationCharters.team).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
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

describe('what a missing post or reply may claim', () => {
  const record = (restoredAt: number | null) => toRemoval({
    documentId: 'D1', documentOwnerId: 'O1', moderatorId: 'M1', reason: { text: 'v9 battery takedown' },
    removedAt: BigInt(10), documentHash: '00', ...(restoredAt === null ? {} : { restoredAt: BigInt(restoredAt), restoredBy: 'M2' }),
  })

  it('claims a takedown for a standing removal record, proven absent or not', () => {
    expect(missingDocumentState(record(null), false)).toBe('removed')
    expect(missingDocumentState(record(null), true)).toBe('removed')
  })

  it('never claims a takedown for a RESTORED document that failed to load (QA D-08)', () => {
    expect(missingDocumentState(record(20), false)).toBe('loadFailed')
    // A record saying the document is live again outweighs a proof of absence.
    expect(missingDocumentState(record(20), true)).toBe('loadFailed')
  })

  it('without a record, only a proof of absence claims a takedown', () => {
    expect(missingDocumentState(null, true, { authorsDelete: false })).toBe('removed')
    expect(missingDocumentState(null, false, { authorsDelete: false })).toBe('unavailable')
    // v9 needs no record lookup to claim it: only moderators remove posts there.
    expect(missingDocumentState(null, true, { authorsDelete: false, recordsRead: false })).toBe('removed')
  })

  it('where authors delete for real (v10), a proven absence with no record found is the author\'s delete', () => {
    const v10 = { authorsDelete: true, recordsRead: true }
    expect(missingDocumentState(null, true, v10)).toBe('deleted')
    expect(missingDocumentState(null, false, v10)).toBe('unavailable')
    // A record still outranks the author reading.
    expect(missingDocumentState(record(null), true, v10)).toBe('removed')
  })

  it('on v10, a proven absence after a restore is the author\'s delete, not a failed read', () => {
    // The author deleted it after a moderator restored it: the restored record stays, and no new one is left.
    expect(missingDocumentState(record(20), true, { authorsDelete: true, recordsRead: true })).toBe('deleted')
    // Without a proof of absence it is still a failed read of a live document.
    expect(missingDocumentState(record(20), false, { authorsDelete: true, recordsRead: true })).toBe('loadFailed')
    // v9 keeps the restored record over a proof of absence.
    expect(missingDocumentState(record(20), true, { authorsDelete: false, recordsRead: true })).toBe('loadFailed')
  })

  it('on v10, never claims the author\'s delete while the record lookup is pending or failed', () => {
    // A takedown looks the same as a delete until the lookup answers.
    expect(missingDocumentState(null, true, { authorsDelete: true })).toBe('unavailable')
    expect(missingDocumentState(null, true, { authorsDelete: true, recordsRead: false })).toBe('unavailable')
  })
})

describe('reading removal records', () => {
  const ID = 'Doc111111111111111111111111111111111111111'

  it('readRemovals surfaces a failed read, so an empty answer means no record', async () => {
    sdk.contracts.documentRemovals.mockRejectedValue(new Error('offline'))
    await expect(moderationService.readRemovals('post', [ID])).rejects.toThrow('offline')
  })

  it('getRemovals stays lenient for the report queue', async () => {
    sdk.contracts.documentRemovals.mockRejectedValue(new Error('offline'))
    expect((await moderationService.getRemovals('post', [ID])).size).toBe(0)
  })

  it('readRemovals keys the records it finds by document id', async () => {
    sdk.contracts.documentRemovals.mockResolvedValue({
      removals: [{ documentId: ID, documentOwnerId: 'O1', moderatorId: 'M1', reason: { text: 'spam' }, removedAt: BigInt(10), documentHash: '00' }],
    })
    expect((await moderationService.readRemovals('post', [ID])).get(ID)).toMatchObject({ reason: 'spam', restoredAt: null })
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

describe('reading a standing', () => {
  it('readStanding surfaces a failed read instead of painting a clean record', async () => {
    sdk.contracts.moderationStatus.mockRejectedValue(new Error('offline'))
    await expect(moderationService.readStanding(TARGET)).rejects.toThrow('offline')
  })

  it('getStanding stays lenient for feed cards', async () => {
    sdk.contracts.moderationStatus.mockRejectedValue(new Error('offline'))
    expect(await moderationService.getStanding(TARGET, { fresh: true })).toMatchObject({ banned: false, warnings: [] })
  })

  it('readStanding returns the proved status', async () => {
    sdk.contracts.moderationStatus.mockResolvedValue({ lists: ['banlist', 'suspensions'], banned: true, banReason: { text: 'spam' } })
    expect(await moderationService.readStanding(TARGET)).toMatchObject({ banned: true, banReason: 'spam' })
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
    expect(result).toMatchObject({ success: true, snapshotSaved: true })
    expect(sdk.documents.get.mock.invocationCallOrder[0]).toBeLessThan(sdk.contracts.moderatorDeleteDocument.mock.invocationCallOrder[0])
    const removal = { documentId: 'D1', documentOwnerId: 'O', moderatorId: MODERATOR, reason: 'spam', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null }
    expect(moderationService.canRestore('post', removal)).toBe(true)
  })

  it('still removes when the snapshot cannot be taken, and then offers no restore', async () => {
    sdk.contracts.fetch.mockRejectedValue(new Error('offline'))
    sdk.contracts.moderatorDeleteDocument.mockResolvedValue({})
    expect(await moderationService.removeDocument(MODERATOR, 'post', 'D2', 'spam')).toMatchObject({ success: true, snapshotSaved: false })
    const removal = { documentId: 'D2', documentOwnerId: 'O', moderatorId: MODERATOR, reason: '', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null }
    expect(moderationService.canRestore('post', removal)).toBe(false)
  })

  it('forgets the snapshot only when the network definitively refused the delete', async () => {
    sdk.contracts.fetch.mockResolvedValue({})
    sdk.documents.get.mockResolvedValue({ toBytes: () => bytes })
    sdk.contracts.moderatorDeleteDocument.mockRejectedValue(new Error(
      'Document D6 on contract C was last modified at 1 and could be deleted by moderators for 60 seconds after that, which block time 999 is past'))
    expect(await moderationService.removeDocument(MODERATOR, 'post', 'D6', 'spam')).toMatchObject({ success: false, snapshotSaved: false })
    expect(storage.size).toBe(0)
  })

  it.each([
    'wait for state transition result timed out',
    'HTTP 504 Gateway Timeout',
    'deadline exceeded',
  ])('keeps the snapshot and reports MAYBE_APPLIED when the delete outcome is unknown (%s)', async (message) => {
    sdk.contracts.fetch.mockResolvedValue({})
    sdk.documents.get.mockResolvedValue({ toBytes: () => bytes })
    sdk.contracts.moderatorDeleteDocument.mockRejectedValue(new Error(message))
    const result = await moderationService.removeDocument(MODERATOR, 'post', 'D7', 'spam')
    expect(result).toMatchObject({ success: false, errorCode: 'MAYBE_APPLIED', snapshotSaved: true })
    expect(result.error).toMatch(/may have been removed/i)
    expect(storage.size).toBe(1)
  })

  it('keeps the snapshot on an unrecognised failure too: only a known refusal proves the delete did not land', async () => {
    sdk.contracts.fetch.mockResolvedValue({})
    sdk.documents.get.mockResolvedValue({ toBytes: () => bytes })
    sdk.contracts.moderatorDeleteDocument.mockRejectedValue(new Error('offline'))
    expect(await moderationService.removeDocument(MODERATOR, 'post', 'D8', 'spam')).toMatchObject({ success: false, snapshotSaved: true })
    expect(storage.size).toBe(1)
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

describe('claiming the moderators pot (41111 / 41112)', () => {
  const EMPTY = 'Failed to claim fees: Protocol error: The moderators fee pot of contract 8Xv3 holds nothing that can be paid out'

  it.each([
    ['41112 by its beta.6 prose', { code: -1, message: EMPTY }, 'NOTHING_TO_CLAIM'],
    ['41112 by its numeric code', { code: 41112, message: 'Failed to claim fees: refused' }, 'NOTHING_TO_CLAIM'],
    ['41111 by its numeric code', { code: 41111, message: 'Failed to claim fees: refused' }, 'ALREADY_CLAIMED'],
    ['41111 by a labelled code', { code: -1, message: 'refused, code=41111' }, 'ALREADY_CLAIMED'],
  ])('recognises %s', async (_label, error, errorCode) => {
    sdk.contracts.claimFees.mockRejectedValue(error)
    const result = await moderationService.claimModeratorsPot(MODERATOR)
    expect(result).toMatchObject({ success: false, errorCode })
  })
})

describe('who is protected from moderation (mirrors Drive ContractModerators::protects)', () => {
  it('protects whoever may moderate: the interim owner, or the seated team', () => {
    expect(protectedIdentities(resolveModerationTeam(OWNER, elected({ $type: 'contractOwner' }), null), false)).toEqual(new Set([OWNER]))
    const seated = resolveModerationTeam(OWNER, elected({ $type: 'contractOwner' }), { leaderId: LEADER, members: [MEMBER] })
    expect(protectedIdentities(seated, false)).toEqual(new Set([LEADER, MEMBER]))
  })

  it('protects the owner of an elected contract that says ownerProtected, once it no longer moderates', () => {
    const seated = resolveModerationTeam(OWNER, elected({ $type: 'contractOwner' }), { leaderId: LEADER, members: [MEMBER] })
    expect(protectedIdentities(seated, true)).toEqual(new Set([LEADER, MEMBER, OWNER]))
  })

  it('reads the team and the declaration for the contract as it stands', async () => {
    const contract = { ownerId: { toBase58: () => OWNER }, config: { moderation: { moderators: elected({ $type: 'contractOwner' }) } } }
    sdk.contracts.fetch.mockResolvedValue(contract)
    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => LEADER }, members: [], free: vi.fn() })
    expect(await moderationService.getProtectedIdentities()).toEqual(new Set([LEADER, OWNER]))
  })
})

describe('dismissing reports', () => {
  const withReports = () => { topology.deletable = ['post', 'reply', 'report'] }
  const reason = { text: 'reviewed', documents: [{ documentTypeName: 'post', documentId: 'P1' }] }

  beforeEach(() => { topology.deletable = ['post', 'reply'] })

  it('refuses locally when the contract does not let moderators delete reports', async () => {
    const result = await moderationService.dismissReports(MODERATOR, ['R1'], reason)
    expect(result).toMatchObject({ success: false, errorCode: 'NOT_MODERATED', dismissed: [] })
    expect(sdk.contracts.moderatorDeleteDocument).not.toHaveBeenCalled()
  })

  it('deletes each report as a moderator, in order, citing the reported post, and keeps no copy', async () => {
    withReports()
    sdk.contracts.moderatorDeleteDocument.mockResolvedValue({})
    const seen: string[] = []
    const result = await moderationService.dismissReports(MODERATOR, ['R1', 'R2'], reason, (id) => seen.push(id))
    expect(result).toMatchObject({ success: true, dismissed: ['R1', 'R2'] })
    expect(seen).toEqual(['R1', 'R2'])
    expect(sdk.contracts.moderatorDeleteDocument.mock.calls.map(([args]) => [args.documentTypeName, args.documentId, args.reason])).toEqual([
      ['report', 'R1', reason],
      ['report', 'R2', reason],
    ])
    expect(sdk.documents.get).not.toHaveBeenCalled()
    expect(storage.size).toBe(0)
  })

  it('stops at the first refusal and says which reports are already gone', async () => {
    withReports()
    sdk.contracts.moderatorDeleteDocument
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('wait for state transition result timed out'))
    const result = await moderationService.dismissReports(MODERATOR, ['R1', 'R2', 'R3'], reason)
    expect(result).toMatchObject({ success: false, errorCode: 'MAYBE_APPLIED', dismissed: ['R1'] })
    expect(sdk.contracts.moderatorDeleteDocument).toHaveBeenCalledTimes(2)
  })

  it('counts a report that is already gone (40101) as dismissed and carries on', async () => {
    withReports()
    sdk.contracts.moderatorDeleteDocument
      .mockRejectedValueOnce({ code: 40101, message: 'refused' })
      .mockRejectedValueOnce(new Error('Document 8Xv3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa document not found'))
      .mockResolvedValueOnce({})
    const result = await moderationService.dismissReports(MODERATOR, ['R1', 'R2', 'R3'], reason)
    expect(result).toMatchObject({ success: true, dismissed: ['R1', 'R2', 'R3'] })
  })
})

describe('resolving reports (v10: moderatorAbilities.changeFields)', () => {
  const reason = { text: 'Report resolved: content removed', documents: [{ documentTypeName: 'post', documentId: 'P1' }] }
  const open = (id: string) => ({ id, status: null, resolution: null })

  beforeEach(() => {
    topology.deletable = ['post', 'reply', 'report']
    topology.resolvesReports = true
    topology.recordless = ['report']
  })

  it('refuses locally on a contract whose moderators dismiss reports instead (v9)', async () => {
    topology.resolvesReports = false
    const result = await moderationService.resolveReports(MODERATOR, [open('R1')], { status: 1 }, reason)
    expect(result).toMatchObject({ success: false, errorCode: 'NOT_MODERATED', resolved: [], alreadyResolved: [], gone: [] })
    expect(sdk.contracts.moderatorChangeDocumentFields).not.toHaveBeenCalled()
  })

  it('writes status and the note on each report, in order, citing the reported post', async () => {
    sdk.contracts.moderatorChangeDocumentFields.mockResolvedValue({})
    const seen: string[] = []
    const result = await moderationService.resolveReports(MODERATOR, [open('R1'), open('R2')], { status: 2, note: '  Taken down  ' }, reason, (id) => seen.push(id))
    expect(result).toMatchObject({ success: true, resolved: ['R1', 'R2'], alreadyResolved: [], gone: [] })
    expect(seen).toEqual(['R1', 'R2'])
    expect(sdk.contracts.moderatorChangeDocumentFields.mock.calls.map(([args]) => [args.documentTypeName, args.documentId, args.fields, args.reason])).toEqual([
      ['report', 'R1', { status: 2, resolution: 'Taken down' }, reason],
      ['report', 'R2', { status: 2, resolution: 'Taken down' }, reason],
    ])
    // A resolution is not a deletion: nothing is removed, nothing snapshotted.
    expect(sdk.contracts.moderatorDeleteDocument).not.toHaveBeenCalled()
    expect(storage.size).toBe(0)
  })

  it('sends no resolution field without a note, and removes a stale note with null', async () => {
    sdk.contracts.moderatorChangeDocumentFields.mockResolvedValue({})
    await moderationService.resolveReports(MODERATOR, [open('R1'), { id: 'R2', status: 2, resolution: 'old' }], { status: 1, note: '   ' }, reason)
    expect(sdk.contracts.moderatorChangeDocumentFields.mock.calls.map(([args]) => args.fields)).toEqual([
      { status: 1 },
      { status: 1, resolution: null },
    ])
  })

  it('skips a report already reading that way, since a change that changes nothing is refused (10905)', async () => {
    sdk.contracts.moderatorChangeDocumentFields.mockResolvedValue({})
    const result = await moderationService.resolveReports(MODERATOR, [{ id: 'R1', status: 3, resolution: 'Banned' }, open('R2')], { status: 3, note: 'Banned' }, reason)
    expect(result.resolved).toEqual(['R1', 'R2'])
    expect(sdk.contracts.moderatorChangeDocumentFields).toHaveBeenCalledTimes(1)
  })

  it('counts a report another moderator resolved the same way meanwhile, says it was not this write, and sets aside withdrawn or expired ones', async () => {
    sdk.contracts.moderatorChangeDocumentFields
      .mockRejectedValueOnce(new Error("The fields a moderator's document change sets are invalid: every field already holds the value the change names, so nothing would change"))
      .mockRejectedValueOnce({ code: 40101, message: 'refused' })
      .mockRejectedValueOnce({ code: 40140, message: 'refused' })
      .mockResolvedValueOnce({})
    const result = await moderationService.resolveReports(MODERATOR, ['R1', 'R2', 'R3', 'R4'].map(open), { status: 1 }, reason)
    expect(result).toMatchObject({ success: true, resolved: ['R1', 'R4'], alreadyResolved: ['R1'], gone: ['R2', 'R3'] })
  })

  it('stops at the first refusal and says which reports were resolved', async () => {
    sdk.contracts.moderatorChangeDocumentFields
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('The moderation of contract 8Xv3 names no reason document, which the proposal S1 of its seated team does not list'))
    const result = await moderationService.resolveReports(MODERATOR, ['R1', 'R2', 'R3'].map(open), { status: 1 }, reason)
    expect(result).toMatchObject({ success: false, errorCode: 'REASON_NOT_LISTED', resolved: ['R1'] })
    expect(sdk.contracts.moderatorChangeDocumentFields).toHaveBeenCalledTimes(2)
  })

  it('still purges reports by deleting them, which on v10 resolves to nothing', async () => {
    sdk.contracts.moderatorDeleteDocument.mockResolvedValue(undefined)
    const result = await moderationService.dismissReports(MODERATOR, ['R1'], 'Report purged')
    expect(result).toMatchObject({ success: true, dismissed: ['R1'] })
  })
})

describe('removal records are read only for types that keep them', () => {
  it('never asks documentRemovals about a type whose deletion keeps no record (it would be refused)', async () => {
    topology.recordless = ['reply']
    sdk.contracts.documentRemovals.mockResolvedValue({ removals: [] })
    await expect(moderationService.listRemovals('reply')).resolves.toEqual({ removals: [] })
    await expect(moderationService.getRemovals('reply', ['R1'])).resolves.toEqual(new Map())
    expect(sdk.contracts.documentRemovals).not.toHaveBeenCalled()
    await moderationService.getRemovals('post', ['P1'])
    expect(sdk.contracts.documentRemovals).toHaveBeenCalledTimes(1)
  })
})
