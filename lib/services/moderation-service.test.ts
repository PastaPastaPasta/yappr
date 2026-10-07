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
    unbanUser: vi.fn(),
    suspendUser: vi.fn(),
    unsuspendUser: vi.fn(),
    moderatorDeleteDocument: vi.fn(),
    claimFees: vi.fn(),
    moderatorRestoreDocument: vi.fn(),
    moderationStatus: vi.fn(),
    moderationEntries: vi.fn(),
    moderatorChangeDocumentFields: vi.fn(),
    documentRemovals: vi.fn(),
    moderatorDeleteSettledDocument: vi.fn(),
    moderatorApproveTeamAction: vi.fn(),
    teamActions: vi.fn(),
    teamActionSigners: vi.fn(),
    moderationActionCounts: vi.fn(),
  },
  documents: { get: vi.fn(), query: vi.fn() },
  identities: { fetch: vi.fn() },
  moderationCharters: { team: vi.fn() },
}))
const topology = vi.hoisted(() => ({
  moderated: true, lists: ['banlist', 'suspensions'] as string[], deletable: ['post', 'reply'], ownerProtected: true,
  /** v10: reports are resolved (changeFields) and a deleted one keeps no removal record. */
  resolvesReports: false, recordless: [] as string[],
  /** v11: a week's window on post and reply, then the leader plus two members. */
  v11: false,
  /** v10: authors delete for real, so a missing post may be the author's delete. */
  authorsDelete: false,
}))
const SETTLED_RULE = { windowSeconds: 604800, leaderRequired: true, approvals: 3 }
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
  authorDeletesLeaveHoles: () => topology.authorsDelete,
  moderationListsKept: () => (topology.moderated ? topology.lists : []),
  contractKeepsWarnings: () => topology.moderated && topology.lists.includes('warnings'),
  moderatorDeletableTypes: () => (topology.moderated ? topology.deletable : []),
  electedModeration: () => (topology.moderated ? { ownerProtected: topology.ownerProtected } : null),
  moderatorDeletionKeepsRecord: (type: string) => topology.moderated && topology.deletable.includes(type) && !topology.recordless.includes(type),
  reportsAreResolved: () => topology.moderated && topology.resolvesReports,
  isV11: () => topology.v11,
  moderatorDeleteWindowSeconds: (type: string) => (topology.v11 && (type === 'post' || type === 'reply') ? SETTLED_RULE.windowSeconds : null),
  settledDeletionFor: (type: string) => (topology.v11 && (type === 'post' || type === 'reply') ? SETTLED_RULE : null),
}))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
})

import {
  SETTLE_MARGIN_MS, countedSigners, deletionPhase, missingDocumentState, moderationService, neededApprovals, protectedIdentities, teamActionTargetState,
  moderatedTypeOpenFor, postedOnLabel, removalRouteFor, resolveModerationTeam, teamCanApprove, toKeptFields, toModerationReason, toRemoval, toTeamAction, toWarning,
} from './moderation-service'
import { removalHashOf, saveSnapshot } from '@/lib/moderation-snapshots'

const MODERATOR = 'Mod111111111111111111111111111111111111111'
const TARGET = 'Tgt111111111111111111111111111111111111111'

beforeEach(() => {
  storage.clear()
  topology.moderated = true
  topology.lists = ['banlist', 'suspensions']
  topology.resolvesReports = false
  topology.recordless = []
  topology.v11 = false
  topology.authorsDelete = false
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
    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => LEADER }, members: [{ toBase58: () => MEMBER }], electedMembers: [], seats: () => 2, free })
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

  it('reads the team again on a fresh request, inside the cache\'s minute', async () => {
    const contract = { ownerId: { toBase58: () => OWNER }, config: { moderation: { moderators: elected({ $type: 'contractOwner' }) } } }
    sdk.contracts.fetch.mockResolvedValue(contract)
    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => LEADER }, members: [{ toBase58: () => MEMBER }], electedMembers: [], seats: () => 2, free: vi.fn() })
    expect((await moderationService.getTeam())?.appointed).toEqual([LEADER, MEMBER])
    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => LEADER }, members: [], electedMembers: [], seats: () => 1, free: vi.fn() })
    expect((await moderationService.getTeam())?.appointed).toEqual([LEADER, MEMBER])
    expect((await moderationService.getTeam({ fresh: true }))?.appointed).toEqual([LEADER])
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

  it('refuses a text over 1024 BYTES before anything is signed (10903 on chain), though it is under 1024 characters', () => {
    const text = '\u00e9'.repeat(600) // 600 characters, 1200 bytes of UTF-8
    expect(() => toModerationReason({ text })).toThrow(/1200 bytes long, the maximum is 1024/)
    expect(toModerationReason({ text: 'a'.repeat(1024) })).toEqual({ text: 'a'.repeat(1024) })
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
      removedAt: BigInt(10), documentHash: 'ab'.repeat(32), keptFields: {}, restoredAt: BigInt(20), restoredBy: 'M2',
    })
    expect(removal).toMatchObject({ documentHash: 'ab'.repeat(32), restoredAt: 20, restoredBy: 'M2', removedAt: 10 })
    expect(toRemoval({ documentId: 'D1', documentOwnerId: 'O1', moderatorId: 'M1', reason: { text: '' }, removedAt: BigInt(10), documentHash: '00', keptFields: {} }))
      .toMatchObject({ restoredAt: null, restoredBy: null })
  })
})

describe('what a missing post or reply may claim', () => {
  const record = (restoredAt: number | null) => toRemoval({
    documentId: 'D1', documentOwnerId: 'O1', moderatorId: 'M1', reason: { text: 'v9 battery takedown' },
    removedAt: BigInt(10), documentHash: '00', keptFields: {}, ...(restoredAt === null ? {} : { restoredAt: BigInt(restoredAt), restoredBy: 'M2' }),
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
    const removal = { documentId: 'D1', documentOwnerId: 'O', moderatorId: MODERATOR, reason: 'spam', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null, kept: {} }
    expect(moderationService.canRestore('post', removal)).toBe(true)
  })

  it('still removes when the snapshot cannot be taken, and then offers no restore', async () => {
    sdk.contracts.fetch.mockRejectedValue(new Error('offline'))
    sdk.contracts.moderatorDeleteDocument.mockResolvedValue({})
    expect(await moderationService.removeDocument(MODERATOR, 'post', 'D2', 'spam')).toMatchObject({ success: true, snapshotSaved: false })
    const removal = { documentId: 'D2', documentOwnerId: 'O', moderatorId: MODERATOR, reason: '', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null, kept: {} }
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
    const removal = { documentId: 'D3', documentOwnerId: 'O', moderatorId: MODERATOR, reason: '', removedAt: Date.now(), documentHash: removalHashOf(bytes), restoredAt: null, restoredBy: null, kept: {} }
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
    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => LEADER }, members: [], electedMembers: [], seats: () => 1, free: vi.fn() })
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

describe('removal records that keep fields (v11 deleteKeepsFields)', () => {
  const entry = (keptFields: Record<string, unknown>) => ({
    documentId: 'D1', documentOwnerId: 'O1', moderatorId: 'M1', reason: { text: 'spam' }, removedAt: BigInt(10), documentHash: '00', keptFields,
  })

  it('carries a post\'s hashtag and $createdAt', () => {
    expect(toRemoval(entry({ hashtag: 'dash', $createdAt: 1759100000000 })).kept).toEqual({ hashtag: 'dash', createdAt: 1759100000000 })
  })

  it('carries a reply\'s rootPostId and a bigint $createdAt', () => {
    expect(toRemoval(entry({ rootPostId: 'Root1', $createdAt: BigInt(1759100000000) })).kept).toEqual({ rootPostId: 'Root1', createdAt: 1759100000000 })
  })

  it('says when a removed post was written, with the year only when it is not this one', () => {
    const now = new Date(2026, 9, 1).getTime()
    expect(postedOnLabel(new Date(2026, 8, 30).getTime(), now)).toBe(new Date(2026, 8, 30).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    expect(postedOnLabel(new Date(2025, 8, 30).getTime(), now)).toBe(new Date(2025, 8, 30).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
  })

  it('keeps nothing before v11, and leaves out values of an unexpected shape', () => {
    expect(toRemoval(entry({})).kept).toEqual({})
    expect(toKeptFields(undefined)).toEqual({})
    expect(toKeptFields({ hashtag: '', $createdAt: 'soon', rootPostId: null, extra: 1 })).toEqual({})
    expect(toKeptFields({ hashtag: 7, $createdAt: -1 })).toEqual({})
  })
})

describe('settled documents (v11 deleteWithin + deleteSettled)', () => {
  const WEEK_MS = 604800 * 1000
  const createdAt = 1_759_000_000_000

  it('places a document against its window, with a minute either side of the end left to the node', () => {
    expect(deletionPhase(604800, createdAt, createdAt + 1000)).toBe('open')
    expect(deletionPhase(604800, createdAt, createdAt + WEEK_MS - SETTLE_MARGIN_MS - 1)).toBe('open')
    expect(deletionPhase(604800, createdAt, createdAt + WEEK_MS - SETTLE_MARGIN_MS)).toBe('closing')
    expect(deletionPhase(604800, createdAt, createdAt + WEEK_MS + SETTLE_MARGIN_MS)).toBe('closing')
    expect(deletionPhase(604800, createdAt, createdAt + WEEK_MS + SETTLE_MARGIN_MS + 1)).toBe('settled')
  })

  it('never settles a type without a window (v2, v9, v10), nor a document whose time is unknown', () => {
    expect(deletionPhase(null, createdAt, createdAt + 10 * WEEK_MS)).toBe('open')
    expect(deletionPhase(604800, Number.NaN, createdAt + 10 * WEEK_MS)).toBe('open')
    expect(moderationService.isSettled('post', new Date(createdAt), createdAt + 10 * WEEK_MS)).toBe(false)
    topology.v11 = true
    expect(moderationService.isSettled('post', new Date(createdAt), createdAt + 10 * WEEK_MS)).toBe(true)
    expect(moderationService.isSettled('reply', createdAt, createdAt + 1000)).toBe(false)
    expect(moderationService.teamDeletesSettled()).toBe(true)
  })

  it('needs min(approvals, seats) approvals, and at least one', () => {
    expect(neededApprovals({ approvals: 3 }, 26)).toBe(3)
    expect(neededApprovals({ approvals: 3 }, 2)).toBe(2)
    expect(neededApprovals({ approvals: 3 }, 0)).toBe(1)
    expect(neededApprovals({ approvals: 3 }, null)).toBe(3)
  })

  it('routes a removal: alone while open or closing, by proposal once settled, and only for the seated team', () => {
    const seated = { leaderId: LEADER, members: [MEMBER], electedMembers: [MEMBER], seats: 2 }
    expect(removalRouteFor('open', SETTLED_RULE, seated, MEMBER)).toEqual({ route: 'single', closing: false })
    expect(removalRouteFor('closing', SETTLED_RULE, seated, MEMBER)).toEqual({ route: 'single', closing: true })
    expect(removalRouteFor('settled', null, seated, MEMBER)).toEqual({ route: 'none', why: 'noSettledRule' })
    expect(removalRouteFor('settled', SETTLED_RULE, null, OWNER)).toEqual({ route: 'none', why: 'noTeamSeated' })
    expect(removalRouteFor('settled', SETTLED_RULE, seated, OWNER)).toEqual({ route: 'none', why: 'notOnTeam' })
    expect(removalRouteFor('settled', SETTLED_RULE, seated, MEMBER))
      .toEqual({ route: 'team', needed: 2, leaderRequired: true, leaderId: LEADER, viewerIsLeader: false, reachable: true })
    // Seats count unfilled added places: leader + one member can never give three approvals.
    expect(removalRouteFor('settled', SETTLED_RULE, { ...seated, seats: 12 }, LEADER))
      .toEqual({ route: 'team', needed: 3, leaderRequired: true, leaderId: LEADER, viewerIsLeader: true, reachable: false })
  })

  it('a team can approve only with as many people as approvals needed', () => {
    expect(teamCanApprove(3, { members: [MEMBER] })).toBe(false)
    expect(teamCanApprove(3, { members: [MEMBER, APPOINTED] })).toBe(true)
    expect(teamCanApprove(1, { members: [] })).toBe(true)
  })

  it('reads no seats before v11, so a seats() failure can never break the moderator check', async () => {
    const seats = vi.fn(() => { throw new Error('boom') })
    sdk.contracts.fetch.mockResolvedValue({ ownerId: { toBase58: () => OWNER }, config: { moderation: { moderators: elected({ $type: 'contractOwner' }) } } })
    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => LEADER }, members: [], electedMembers: [], seats, free: vi.fn() })
    expect(await moderationService.isModerator(LEADER)).toBe(true)
    expect(seats).not.toHaveBeenCalled()
    moderationService.invalidateTeam()
    topology.v11 = true
    expect(await moderationService.isModerator(LEADER)).toBe(true)
    await expect(moderationService.getSeatedTeam()).resolves.toMatchObject({ seats: null })
  })

  it('reads the seated team\'s seats from the declaration\'s maxAddedModerators, for the route', async () => {
    topology.v11 = true
    const seats = vi.fn(() => 12)
    sdk.contracts.fetch.mockResolvedValue({
      ownerId: { toBase58: () => OWNER },
      config: { moderation: { moderators: { ...elected({ $type: 'contractOwner' }), maxAddedModerators: 10 } } },
    })
    sdk.moderationCharters.team.mockResolvedValue({
      leaderId: { toBase58: () => LEADER }, members: [{ toBase58: () => MEMBER }], electedMembers: [{ toBase58: () => MEMBER }], seats, free: vi.fn(),
    })
    const route = await moderationService.removalRoute(MEMBER, 'post', createdAt, createdAt + 2 * WEEK_MS)
    expect(route).toEqual({ route: 'team', needed: 3, leaderRequired: true, leaderId: LEADER, viewerIsLeader: false, reachable: false })
    expect(seats).toHaveBeenCalledWith(10)
    await expect(moderationService.getSeatedTeam()).resolves.toEqual({ leaderId: LEADER, members: [MEMBER], electedMembers: [MEMBER], seats: 12 })
  })

  it('counts only the signers still on the team', () => {
    expect(countedSigners([LEADER, MEMBER, 'Gone1'], { leaderId: LEADER, members: [MEMBER] })).toEqual([LEADER, MEMBER])
    expect(countedSigners(['A', 'B'], null)).toEqual(['A', 'B'])
  })

  it('decodes a team action with the approvals its rule needs', () => {
    topology.v11 = true
    const action = toTeamAction({
      actionId: 'A1', proposerId: MEMBER, proposedAt: BigInt(20), approvalCount: 2,
      event: { type: 'deleteSettledDocument', documentTypeName: 'post', documentId: 'P1', documentLastModifiedAt: BigInt(10), reason: { text: 'spam', reasonDocumentId: 'RD1' } },
    }, 'active', 2)
    expect(action).toEqual({
      actionId: 'A1', status: 'active', proposerId: MEMBER, proposedAt: 20, documentTypeName: 'post', documentId: 'P1',
      documentLastModifiedAt: 10, reason: 'spam', reasonDocumentId: 'RD1', approvalCount: 2, neededApprovals: 2, leaderRequired: true,
    })
  })
})

describe('the team\'s settled-deletion writes and reads', () => {
  beforeEach(() => {
    topology.v11 = true
  })

  it('proposes with the charter reason and returns the action id to approve', async () => {
    sdk.contracts.moderatorDeleteSettledDocument.mockResolvedValue({ actionId: { toBase58: () => 'A1' }, status: 'active' })
    const result = await moderationService.proposeSettledDeletion(MEMBER, 'post', 'P1', { text: 'spam', reasonDocumentId: 'RD1' })
    expect(result).toEqual({ success: true, actionId: 'A1', status: 'active' })
    expect(sdk.contracts.moderatorDeleteSettledDocument).toHaveBeenCalledWith(expect.objectContaining({
      contractId: expect.any(String), documentTypeName: 'post', documentId: 'P1', reason: { text: 'spam', reasonDocumentId: 'RD1' }, signer: expect.anything(), identity: expect.anything(),
    }))
    // No copy is kept: a team deletion is never restored.
    expect(sdk.documents.get).not.toHaveBeenCalled()
  })

  it('refuses locally without a charter reason, or where the type sets no settled rule', async () => {
    expect(await moderationService.proposeSettledDeletion(MEMBER, 'post', 'P1', { text: 'spam' })).toMatchObject({ success: false, errorCode: 'REASON_NOT_LISTED' })
    topology.v11 = false
    expect(await moderationService.proposeSettledDeletion(MEMBER, 'post', 'P1', { text: 'spam', reasonDocumentId: 'RD1' }))
      .toMatchObject({ success: false, errorCode: 'NOT_SETTLED_DELETABLE' })
    expect(sdk.contracts.moderatorDeleteSettledDocument).not.toHaveBeenCalled()
  })

  it.each([
    [41206, 'NOT_SETTLED'],
    [41205, 'TEAM_NOT_SEATED'],
    [41212, 'TEAM_MEMBER_ADDED_AFTER_DOCUMENT'],
  ])('maps a proposal refused %s to %s', async (code, errorCode) => {
    sdk.contracts.moderatorDeleteSettledDocument.mockRejectedValue({ code, message: 'refused' })
    expect(await moderationService.proposeSettledDeletion(MEMBER, 'post', 'P1', { text: 'x', reasonDocumentId: 'RD1' })).toMatchObject({ success: false, errorCode })
  })

  it('approves by action id and reports when the approval ran the action', async () => {
    sdk.contracts.moderatorApproveTeamAction.mockResolvedValue({ actionId: { toBase58: () => 'A1' }, status: 'closed' })
    expect(await moderationService.approveTeamAction(LEADER, 'A1')).toEqual({ success: true, status: 'closed' })
    expect(sdk.contracts.moderatorApproveTeamAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'A1', contractId: expect.any(String) }))
  })

  it.each([
    [41208, 'TEAM_ACTION_ALREADY_SIGNED'],
    [41210, 'TEAM_ACTION_COMPLETED'],
    [41211, 'TEAM_ACTION_DOCUMENT_CHANGED'],
    [41212, 'TEAM_MEMBER_ADDED_AFTER_DOCUMENT'],
  ])('maps an approval refused %s to %s', async (code, errorCode) => {
    sdk.contracts.moderatorApproveTeamAction.mockRejectedValue({ code, message: 'refused' })
    expect(await moderationService.approveTeamAction(LEADER, 'A1')).toMatchObject({ success: false, errorCode })
  })

  it('a single delete past the window says only the team can remove it now (41116)', async () => {
    sdk.contracts.fetch.mockResolvedValue(null)
    sdk.contracts.moderatorDeleteDocument.mockRejectedValue({ code: 41116, message: 'refused' })
    const result = await moderationService.removeDocument(MODERATOR, 'post', 'P1', 'spam')
    expect(result).toMatchObject({ success: false, errorCode: 'DELETE_WINDOW_ELAPSED' })
    expect(result.error).toMatch(/only the seated moderation team/i)
  })

  it('lists every page of team actions with the needed approvals capped at the seats', async () => {
    sdk.contracts.fetch.mockResolvedValue({
      ownerId: { toBase58: () => OWNER },
      config: { moderation: { moderators: { ...elected({ $type: 'contractOwner' }), maxAddedModerators: 0 } } },
    })
    sdk.moderationCharters.team.mockResolvedValue({
      leaderId: { toBase58: () => LEADER }, members: [{ toBase58: () => MEMBER }], electedMembers: [{ toBase58: () => MEMBER }], seats: () => 2, free: vi.fn(),
    })
    const entry = (actionId: string, documentId: string) => ({
      actionId, proposerId: MEMBER, proposedAt: BigInt(20), approvalCount: 1,
      event: { type: 'deleteSettledDocument', documentTypeName: 'reply', documentId, documentLastModifiedAt: BigInt(10), reason: { text: 'abuse' } },
    })
    sdk.contracts.teamActions
      .mockResolvedValueOnce({ actions: [entry('A1', 'R1')], nextStartAtActionId: 'A1' })
      .mockResolvedValueOnce({ actions: [entry('A2', 'R2')] })
    const { actions, truncated } = await moderationService.listTeamActions('active')
    expect(truncated).toBe(false)
    expect(actions.map((action) => action.actionId)).toEqual(['A1', 'A2'])
    expect(actions[0]).toMatchObject({ documentTypeName: 'reply', approvalCount: 1, neededApprovals: 2, reasonDocumentId: null })
    expect(sdk.contracts.teamActions).toHaveBeenNthCalledWith(1, { contractId: expect.any(String), status: 'active', limit: 100 })
    expect(sdk.contracts.teamActions).toHaveBeenNthCalledWith(2, { contractId: expect.any(String), status: 'active', startAtActionId: 'A1', startAtActionIdIncluded: false, limit: 100 })

    sdk.contracts.teamActions.mockResolvedValue({ actions: [entry('A3', 'R3')], nextStartAtActionId: 'A3' })
    await expect(moderationService.listTeamActions('closed', { max: 1 })).resolves.toMatchObject({ truncated: true })

    // A second proposal for a document would split the approvals: the modal finds the first.
    sdk.contracts.teamActions.mockResolvedValue({ actions: [entry('A1', 'R1'), entry('A2', 'R2')] })
    await expect(moderationService.findActiveTeamAction('R2')).resolves.toMatchObject({ actionId: 'A2' })
    await expect(moderationService.findActiveTeamAction('R9')).resolves.toBeNull()
  })

  it('says an approval can never run once its document is gone (40101)', async () => {
    sdk.contracts.moderatorApproveTeamAction.mockRejectedValue({ code: 40101, message: 'refused' })
    expect(await moderationService.approveTeamAction(LEADER, 'A1')).toMatchObject({ success: false, errorCode: 'DOCUMENT_GONE' })
  })

  it('reads the signers of an action', async () => {
    sdk.contracts.teamActionSigners.mockResolvedValue({ signerIds: [LEADER, MEMBER] })
    await expect(moderationService.teamActionSigners('A1', 'active')).resolves.toEqual([LEADER, MEMBER])
    expect(sdk.contracts.teamActionSigners).toHaveBeenCalledWith({ contractId: expect.any(String), status: 'active', actionId: 'A1' })
  })

  it('reads nothing about team actions before v11', async () => {
    topology.v11 = false
    await expect(moderationService.listTeamActions('active')).resolves.toEqual({ actions: [], truncated: false })
    await expect(moderationService.teamActionSigners('A1', 'closed')).resolves.toEqual([])
    expect(await moderationService.approveTeamAction(LEADER, 'A1')).toMatchObject({ success: false, errorCode: 'NOT_MODERATED' })
    expect(sdk.contracts.teamActions).not.toHaveBeenCalled()
    expect(sdk.contracts.teamActionSigners).not.toHaveBeenCalled()
  })

  it('reads the per-member action counts, and answers null instead of throwing when refused or off v11', async () => {
    sdk.contracts.moderationActionCounts.mockResolvedValue({ counts: [{ identityId: LEADER, count: 3 }, { identityId: MEMBER, count: 1 }] })
    await expect(moderationService.getActionCounts()).resolves.toEqual(new Map([[LEADER, 3], [MEMBER, 1]]))
    sdk.contracts.moderationActionCounts.mockRejectedValue(new Error('contract keeps no moderation action counts'))
    await expect(moderationService.getActionCounts()).resolves.toBeNull()
    topology.v11 = false
    sdk.contracts.moderationActionCounts.mockClear()
    await expect(moderationService.getActionCounts()).resolves.toBeNull()
    expect(sdk.contracts.moderationActionCounts).not.toHaveBeenCalled()
  })
})

describe('refusals and unverified answers seen live on sakura (QA 2026-10-01)', () => {
  it.each([
    ['ban', 41103, 'Identity T is already banned on contract C', 'ALREADY_BANNED', () => moderationService.ban(MODERATOR, TARGET, 'spam'), 'banUser'],
    ['unban', 41104, 'Identity T is not banned on contract C', 'NOT_BANNED', () => moderationService.unban(MODERATOR, TARGET), 'unbanUser'],
    ['unsuspend', 41105, 'Identity T is not suspended on contract C', 'NOT_SUSPENDED', () => moderationService.unsuspend(MODERATOR, TARGET), 'unsuspendUser'],
    ['suspend', 41106, 'Suspension of identity T on contract C ends at 1 which is not after the block time 2', 'SUSPENSION_NOT_IN_FUTURE', () => moderationService.suspend(MODERATOR, TARGET, 1, 'spam'), 'suspendUser'],
    ['ban', 10901, 'Identity M can not moderate itself', 'SELF_TARGET', () => moderationService.ban(MODERATOR, MODERATOR, 'spam'), 'banUser'],
  ] as const)('classifies a %s refused %i', async (_label, code, message, errorCode, run, method) => {
    sdk.contracts[method].mockRejectedValue({ code, message, name: 'Protocol' })
    expect(await run()).toMatchObject({ success: false, errorCode })
  })

  it('reads a 41107 on a suspension as the TARGET being banned, not the moderator', async () => {
    sdk.contracts.suspendUser.mockRejectedValue({ code: 41107, message: 'Identity T is banned on contract C and can not act on its documents', name: 'Protocol' })
    const result = await moderationService.suspend(MODERATOR, TARGET, Date.now() + 60_000, 'spam')
    expect(result).toMatchObject({ success: false, errorCode: 'ALREADY_BANNED' })
    expect(result.error).toMatch(/unban it first/)
  })

  it('reports a ban whose proof failed to verify after it was sent as MAYBE_APPLIED, never a plain failure', async () => {
    sdk.contracts.banUser.mockRejectedValue({ code: -1, name: 'Proof', message: 'context provider error: invalid quorum: Quorum not found in cache for hash: 1855' })
    expect(await moderationService.ban(MODERATOR, TARGET, 'spam')).toMatchObject({ success: false, errorCode: 'MAYBE_APPLIED' })
  })

  it('reports a proposal whose answer was lost after it was sent as MAYBE_APPLIED, so nobody proposes it twice', async () => {
    topology.v11 = true
    sdk.contracts.moderatorDeleteSettledDocument.mockRejectedValue({ code: -1, name: 'Proof', message: 'proof verification failed: invalid quorum' })
    const result = await moderationService.proposeSettledDeletion(MODERATOR, 'post', 'D1', { text: 'spam', reasonDocumentId: 'RD1' })
    expect(result).toMatchObject({ success: false, errorCode: 'MAYBE_APPLIED' })
    expect(result.error).toMatch(/check the team actions/i)
  })

  it('keeps a proof failure BEFORE anything was sent a plain failure', async () => {
    sdk.identities.fetch.mockRejectedValue({ code: -1, name: 'Proof', message: 'context provider error: invalid quorum: Quorum not found in cache' })
    const result = await moderationService.ban(MODERATOR, TARGET, 'spam')
    expect(result).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    expect(sdk.contracts.banUser).not.toHaveBeenCalled()
  })

  it('says a post another moderator already removed (40101) is gone, and keeps the copy any moderator may restore from', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    sdk.contracts.fetch.mockResolvedValue({})
    sdk.documents.get.mockResolvedValue({ toBytes: () => bytes })
    sdk.contracts.moderatorDeleteDocument.mockRejectedValue({ code: 40101, name: 'Protocol', message: '6FLRRz7QLnTb4UzEz5UrSqSBRTU2w2THHwLEgKNaUQ2Q document not found' })
    const result = await moderationService.removeDocument(MODERATOR, 'post', 'D9', 'spam')
    expect(result).toMatchObject({ success: false, errorCode: 'DOCUMENT_GONE', snapshotSaved: true })
    expect(result.error).toMatch(/already gone/)
    expect(result.error).not.toMatch(/deleted by its author/)
    expect(storage.size).toBe(1)
  })

  it.each([
    ['ban', () => moderationService.ban(MODERATOR, TARGET, '\u00e9'.repeat(600))],
    ['remove', () => moderationService.removeDocument(MODERATOR, 'post', 'D1', '\u00e9'.repeat(600))],
  ] as const)('refuses a %s reason over 1024 bytes before taking the write lock or a signer', async (_label, run) => {
    // Inside the lock, a local refusal carries no verdict and would hold every later write back for 15 minutes.
    const result = await run()
    expect(result).toMatchObject({ success: false, errorCode: 'REASON_TOO_LONG' })
    expect(sdk.identities.fetch).not.toHaveBeenCalled()
    expect(sdk.contracts.banUser).not.toHaveBeenCalled()
    expect(sdk.contracts.moderatorDeleteDocument).not.toHaveBeenCalled()
  })
})

describe('team actions that can never run (QA 2026-10-01, sakura)', () => {
  // Live: a second proposal for the same post was accepted; once the first ran, approving the
  // second was a paid 40101, and an action whose post its author tombstoned after the proposal
  // was a paid 41211 on every approval. Neither lapses: both stayed `active`.
  beforeEach(() => {
    topology.v11 = true
    sdk.contracts.fetch.mockResolvedValue({
      ownerId: { toBase58: () => OWNER },
      config: { moderation: { moderators: { ...elected({ $type: 'contractOwner' }), maxAddedModerators: 2 } } },
    })
    sdk.moderationCharters.team.mockResolvedValue({
      leaderId: { toBase58: () => LEADER }, members: [{ toBase58: () => MEMBER }], electedMembers: [], seats: () => 5, free: vi.fn(),
    })
  })
  const entry = (actionId: string, documentId: string, lastModified: number) => ({
    actionId, proposerId: MEMBER, proposedAt: BigInt(20), approvalCount: 1,
    event: { type: 'deleteSettledDocument' as const, documentTypeName: 'post', documentId, documentLastModifiedAt: BigInt(lastModified), reason: { text: 'spam', reasonDocumentId: 'RD1' } },
  })
  const doc = (updatedAt: number) => ({ updatedAt: BigInt(updatedAt), createdAt: BigInt(5) })

  it('places a document against the action: live, changed after the proposal, or gone', () => {
    expect(teamActionTargetState({ documentLastModifiedAt: 10 }, { updatedAt: BigInt(10), createdAt: BigInt(5) })).toBe('live')
    expect(teamActionTargetState({ documentLastModifiedAt: 10 }, { updatedAt: BigInt(11), createdAt: BigInt(5) })).toBe('changed')
    expect(teamActionTargetState({ documentLastModifiedAt: 5 }, { createdAt: BigInt(5) })).toBe('live')
    expect(teamActionTargetState({ documentLastModifiedAt: 10 }, null)).toBe('gone')
  })

  it('reads every action\'s document in one proved $id-in query and claims nothing when it fails', async () => {
    sdk.documents.query.mockResolvedValueOnce(new Map([['P1', doc(10)], ['P2', doc(99)]]))
    const actions = [entry('A1', 'P1', 10), entry('A2', 'P2', 10), entry('A3', 'P3', 10)].map((e) => toTeamAction(e, 'active', 5))
    const states = await moderationService.readTeamActionTargets(actions)
    expect(Object.fromEntries(states)).toEqual({ A1: 'live', A2: 'changed', A3: 'gone' })
    expect(sdk.documents.query).toHaveBeenCalledWith(expect.objectContaining({ documentTypeName: 'post', where: [['$id', 'in', ['P1', 'P2', 'P3']]], limit: 3 }))
    sdk.documents.query.mockRejectedValueOnce(new Error('invalid quorum'))
    expect((await moderationService.readTeamActionTargets(actions)).size).toBe(0)
  })

  it('offers the proposal that can still run, never a dead one, for the modal to approve', async () => {
    sdk.contracts.teamActions.mockResolvedValue({ actions: [entry('OLD', 'P1', 10), entry('NEW', 'P1', 50)] })
    sdk.documents.query.mockResolvedValue(new Map([['P1', doc(50)]]))
    await expect(moderationService.findActiveTeamAction('P1')).resolves.toMatchObject({ actionId: 'NEW' })
    // Only a dead proposal: the modal offers a fresh one instead of a paid 41211.
    sdk.contracts.teamActions.mockResolvedValue({ actions: [entry('OLD', 'P1', 10)] })
    await expect(moderationService.findActiveTeamAction('P1')).resolves.toBeNull()
    // The document could not be read: the first proposal, as before.
    sdk.documents.query.mockRejectedValue(new Error('offline'))
    await expect(moderationService.findActiveTeamAction('P1')).resolves.toMatchObject({ actionId: 'OLD' })
  })

  it('says what a 41211 means on v11: the author changed it, and one moderator may remove it again', async () => {
    sdk.contracts.moderatorApproveTeamAction.mockRejectedValue({ code: 41211, message: 'Document D1 changed since team action A1 on contract C proposed its deletion' })
    const result = await moderationService.approveTeamAction(LEADER, 'A1')
    expect(result).toMatchObject({ success: false, errorCode: 'TEAM_ACTION_DOCUMENT_CHANGED' })
    expect(result.error).toMatch(/one moderator removes it alone/)
    expect(result.error).not.toMatch(/week/)
  })

  it('blames the author for a gone document only where authors delete (v10), never on v11', async () => {
    sdk.contracts.moderatorApproveTeamAction.mockRejectedValue({ code: 40101, message: 'P1 document not found' })
    const v11 = await moderationService.approveTeamAction(LEADER, 'A1')
    expect(v11).toMatchObject({ success: false, errorCode: 'DOCUMENT_GONE' })
    expect(v11.error).not.toMatch(/author deleted/)
    topology.authorsDelete = true
    expect((await moderationService.approveTeamAction(LEADER, 'A1')).error).toMatch(/or its author deleted it/)
  })
})

describe('moderatedTypeOpenFor (the registered interim, not the committed file)', () => {
  it('closes moderated writes only under a notYetUsable interim with no team seated', () => {
    expect(moderatedTypeOpenFor('notYetUsable', null)).toBe(false)
    expect(moderatedTypeOpenFor('notYetUsable', { leaderId: 'L', members: [] })).toBe(true)
    for (const interim of ['contractOwner', 'appointedModerators', 'noModeration', null] as const) {
      expect(moderatedTypeOpenFor(interim, null), String(interim)).toBe(true)
    }
  })
})
