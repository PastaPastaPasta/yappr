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

import { moderationService, resolveModerationTeam, toModerationReason, toRemoval, toWarning } from './moderation-service'
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
