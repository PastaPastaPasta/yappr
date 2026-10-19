/**
 * R-M24: storefront and blog elect moderators of their own, so the moderation
 * service is one instance per contract. Each instance must send ITS contract's
 * id on every read and write, read its own declaration (lists, deletable types,
 * interim), and gate its own types: a social team seated says nothing about a
 * storefront still closed. The SDK is mocked; the live check is on sakura.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ids = vi.hoisted(() => {
  const ids = { social: 'Soc1111111111111111111111111111111111111111', storefront: 'Sto1111111111111111111111111111111111111111', blog: 'Blg1111111111111111111111111111111111111111' }
  const saved = { ...process.env }
  // Read by lib/constants at import: the elected storefront (v7+) and blog (v7+) cuts.
  process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID = ids.social
  process.env.NEXT_PUBLIC_CONTRACT_TOPOLOGY = 'v16'
  process.env.NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID = ids.storefront
  process.env.NEXT_PUBLIC_STOREFRONT_TOPOLOGY = 'v9'
  process.env.NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID = ids.blog
  process.env.NEXT_PUBLIC_BLOG_TOPOLOGY = 'v8'
  return { ...ids, saved }
})
afterAll(() => {
  process.env = ids.saved
})

const sdk = vi.hoisted(() => ({
  contracts: {
    fetch: vi.fn(),
    banUser: vi.fn(),
    suspendUser: vi.fn(),
    warnUser: vi.fn(),
    moderatorDeleteDocument: vi.fn(),
    moderatorDeleteSettledDocument: vi.fn(),
    moderatorApproveTeamAction: vi.fn(),
    moderatorRestoreDocument: vi.fn(),
    claimFees: vi.fn(),
    feePots: vi.fn(),
    moderationStatus: vi.fn(),
    moderationEntries: vi.fn(),
    documentRemovals: vi.fn(),
    moderationActionCounts: vi.fn(),
  },
  documents: { get: vi.fn() },
  identities: { fetch: vi.fn() },
  moderationCharters: { team: vi.fn() },
}))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./identity-nonce', () => ({ withSdkSignedWrite: (_who: string, _contract: string, write: () => Promise<unknown>) => write() }))
vi.mock('./signer-service', () => ({ signerService: { createSigner: async () => ({ signer: true }) } }))
vi.mock('../secure-storage', () => ({ getPrivateKey: () => 'wif' }))
vi.mock('@/lib/auth/signing-keys', () => ({ hasAppConnectSession: () => false }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true }) }))
vi.mock('@dashevo/evo-sdk', () => ({ Document: { fromBytes: vi.fn() }, PlatformVersion: { latest: () => 'latest' } }))

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  key: () => null,
  length: 0,
})

import { electedDeclarationOf, listsKeptOf, moderatedContract } from '@/lib/moderated-contracts'
import { settledRuleOf } from '@/lib/registered-contracts'
import { moderationService, moderationServiceFor } from './moderation-service'

const MODERATOR = 'Mod111111111111111111111111111111111111111'
const AUTHOR = 'Aut111111111111111111111111111111111111111'

/** A registered contract as `sdk.contracts.fetch` returns it, with the interim it was registered under. */
const registered = (owner: string, interim: string) => ({
  ownerId: { toBase58: () => owner },
  config: { moderation: { moderators: { $type: 'elected', maxAddedModerators: 10, interim: { $type: interim } } } },
  toJSON: () => ({}),
})

beforeEach(() => {
  for (const group of [sdk.contracts, sdk.documents, sdk.identities, sdk.moderationCharters]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  sdk.identities.fetch.mockResolvedValue({ id: MODERATOR, publicKeys: [] })
  sdk.moderationCharters.team.mockResolvedValue(null)
  for (const key of ['social', 'storefront', 'blog'] as const) moderationServiceFor(key).invalidateTeam()
})

describe('each contract describes its own moderation', () => {
  it('reads the storefront and blog declarations off their contract files', () => {
    const storefront = moderatedContract('storefront')
    expect(storefront.contractId).toBe(ids.storefront)
    expect(storefront.moderated()).toBe(true)
    expect(Object.keys(storefront.elected()?.moderatedDocumentTypes ?? {})).toEqual(['store', 'storeItem', 'storeReview', 'itemReview'])
    expect(storefront.deletableTypes()).toEqual(['store', 'storeItem', 'storeReview', 'itemReview'])
    expect(storefront.listsKept()).toEqual(['banlist', 'suspensions', 'warnings'])
    expect(storefront.keepsRecord('storeReview')).toBe(true)
    expect(storefront.keepsRecord('storeOrder')).toBe(false)
    // Stores and listings are closed, not deleted, by their owners; reviews may be deleted.
    expect(storefront.authorsDelete('store')).toBe(false)
    expect(storefront.authorsDelete('storeReview')).toBe(true)

    const blog = moderatedContract('blog')
    expect(blog.contractId).toBe(ids.blog)
    expect(Object.keys(blog.elected()?.moderatedDocumentTypes ?? {})).toEqual(['blog', 'blogPost', 'blogComment'])
    expect(blog.deletableTypes()).toEqual(['blog', 'blogPost', 'blogComment'])
    expect(blog.reportsResolved()).toBe(false)
  })

  it('keeps the frozen declaration stable across calls (React effects depend on it)', () => {
    expect(moderatedContract('storefront').elected()).toBe(moderatedContract('storefront').elected())
    expect(Object.isFrozen(moderatedContract('blog').elected())).toBe(true)
  })

  it('keeps storefront and older blog cuts windowless', () => {
    for (const key of ['storefront', 'blog'] as const) {
      const contract = moderatedContract(key)
      for (const type of contract.deletableTypes()) {
        expect(contract.deleteWindowSeconds(type)).toBeNull()
        expect(contract.settledDeletionFor(type)).toBeNull()
      }
    }
  })
})

describe('pure declaration readers', () => {
  it('reads the lists a config keeps', () => {
    expect(listsKeptOf(undefined)).toEqual([])
    expect(listsKeptOf({ banlist: true, warnings: true })).toEqual(['banlist', 'warnings'])
  })

  it('reads an elected declaration and ignores any other', () => {
    expect(electedDeclarationOf({ moderators: { $type: 'appointedModerators' } as never })).toBeNull()
    const declaration = electedDeclarationOf({
      moderators: {
        $type: 'elected', joinWindow: 3600, voteWindow: 3600, seatContestable: false,
        moderatedDocumentTypes: { store: ['deleteDocuments'] }, interim: { $type: 'notYetUsable' },
      },
    })
    expect(declaration).toMatchObject({ joinWindowSeconds: 3600, voteWindowSeconds: 3600, interim: 'notYetUsable', maxAddedModerators: 0, ownerProtected: false, electionDelaySeconds: null })
  })

  it('routes blog v9 posts and comments to settled proposals while storefront stays windowless', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v9')
    const blog = moderatedContract('blog')
    for (const type of ['blogPost', 'blogComment']) {
      expect(blog.settledDeletionFor(type)).toEqual({ windowSeconds: 86400, leaderRequired: true, approvals: 2 })
      expect(blog.deleteWindowSeconds(type)).toBe(86400)
      expect(blog.keepsRecord(type)).toBe(true)
    }
    expect(blog.authorsDelete('blog')).toBe(true)
    expect(moderationServiceFor('blog').teamDeletesSettled()).toBe(true)
    expect(blog.settledDeletionFor('blog')).toBeNull()
    expect(moderatedContract('storefront').settledDeletionFor('storeItem')).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v8')
    expect(blog.settledDeletionFor('blogPost')).toBeNull()
    expect(blog.deleteWindowSeconds('blogComment')).toBeNull()
    expect(blog.authorsDelete('blog')).toBe(false)
    expect(moderationServiceFor('blog').teamDeletesSettled()).toBe(false)
    vi.unstubAllEnvs()
  })

  it('reads a settled-deletion rule only with both a window and a team rule', () => {
    expect(settledRuleOf({ delete: true })).toBeNull()
    expect(settledRuleOf({ delete: true, deleteWithin: 604800 })).toBeNull()
    expect(settledRuleOf({ delete: true, deleteWithin: 604800, deleteSettled: { leader: true, approvals: 3 } }))
      .toEqual({ windowSeconds: 604800, leaderRequired: true, approvals: 3 })
    expect(settledRuleOf({ delete: false, deleteWithin: 1, deleteSettled: {} })).toBeNull()
  })
})

describe('one service per contract, each sending its own contract id', () => {
  it('bans, removes and claims on the storefront contract, never on social', async () => {
    const storefront = moderationServiceFor('storefront')
    await storefront.ban(MODERATOR, AUTHOR, { text: 'spam reviews', documents: [{ documentTypeName: 'storeReview', documentId: 'R1' }] })
    expect(sdk.contracts.banUser).toHaveBeenCalledWith(expect.objectContaining({
      contractId: ids.storefront,
      identityId: AUTHOR,
      reason: { text: 'spam reviews', documents: [{ documentTypeName: 'storeReview', documentId: 'R1' }] },
    }))

    sdk.contracts.fetch.mockResolvedValue(null)
    const removed = await storefront.removeDocument(MODERATOR, 'itemReview', 'IR1', 'fake review')
    expect(removed.success).toBe(true)
    expect(sdk.contracts.moderatorDeleteDocument).toHaveBeenCalledWith(expect.objectContaining({ contractId: ids.storefront, documentTypeName: 'itemReview', documentId: 'IR1' }))

    sdk.contracts.claimFees.mockResolvedValue({ remainingCredits: BigInt(0) })
    await storefront.claimModeratorsPot(MODERATOR)
    expect(sdk.contracts.claimFees).toHaveBeenCalledWith(expect.objectContaining({ contractId: ids.storefront, pot: 'moderators' }))

    for (const call of [...sdk.contracts.banUser.mock.calls, ...sdk.contracts.moderatorDeleteDocument.mock.calls, ...sdk.contracts.claimFees.mock.calls]) {
      expect(call[0].contractId).not.toBe(ids.social)
    }
  })

  it('refuses locally to remove a type its contract does not let moderators delete', async () => {
    const result = await moderationServiceFor('storefront').removeDocument(MODERATOR, 'storeOrder', 'O1', 'nope')
    expect(result).toMatchObject({ success: false, errorCode: 'NOT_MODERATED' })
    expect(moderationServiceFor('blog').canRemove('post')).toBe(false)
    expect(moderationServiceFor('blog').canRemove('blogComment')).toBe(true)
    expect(sdk.contracts.moderatorDeleteDocument).not.toHaveBeenCalled()
  })

  it('proposes and approves settled blog deletion on the blog contract', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v9')
    try {
      const blog = moderationServiceFor('blog')
      sdk.contracts.moderatorDeleteSettledDocument.mockResolvedValue({ actionId: { toBase58: () => 'BA1' }, status: 'active' })
      sdk.contracts.moderatorApproveTeamAction.mockResolvedValue({ status: 'closed' })
      expect(await blog.proposeSettledDeletion(MODERATOR, 'blogPost', 'BP1', { text: 'spam', reasonDocumentId: 'BR1' }))
        .toMatchObject({ success: true, actionId: 'BA1', status: 'active' })
      expect(sdk.contracts.moderatorDeleteSettledDocument).toHaveBeenCalledWith(expect.objectContaining({
        contractId: ids.blog, documentTypeName: 'blogPost', documentId: 'BP1', reason: { text: 'spam', reasonDocumentId: 'BR1' },
      }))
      expect(await blog.approveTeamAction(MODERATOR, 'BA1')).toMatchObject({ success: true, status: 'closed' })
      expect(sdk.contracts.moderatorApproveTeamAction).toHaveBeenCalledWith(expect.objectContaining({ contractId: ids.blog, actionId: 'BA1' }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reads standing, lists, removals and pots on the blog contract with the blog lists', async () => {
    const blog = moderationServiceFor('blog')
    sdk.contracts.moderationStatus.mockResolvedValue({ banned: true, banReason: { text: 'spam' } })
    expect(await blog.readStanding(AUTHOR)).toMatchObject({ banned: true, banReason: 'spam' })
    expect(sdk.contracts.moderationStatus).toHaveBeenCalledWith({ contractId: ids.blog, identityId: AUTHOR, lists: ['banlist', 'suspensions', 'warnings'] })

    sdk.contracts.moderationEntries.mockResolvedValue({ entries: [] })
    await blog.listEntries('warnings')
    expect(sdk.contracts.moderationEntries).toHaveBeenCalledWith(expect.objectContaining({ contractId: ids.blog, list: 'warnings' }))

    sdk.contracts.documentRemovals.mockResolvedValue({ removals: [] })
    await blog.listRemovals('blogComment')
    expect(sdk.contracts.documentRemovals).toHaveBeenCalledWith(expect.objectContaining({ contractId: ids.blog, documentTypeName: 'blogComment' }))

    const pot = { credits: BigInt(5), lastClaimEpoch: undefined, lastClaimantId: undefined }
    sdk.contracts.feePots.mockResolvedValue({ owner: pot, moderators: pot })
    expect((await blog.getFeePots())?.moderators.credits).toBe(BigInt(5))
    expect(sdk.contracts.feePots).toHaveBeenCalledWith(ids.blog)

    sdk.contracts.moderationActionCounts.mockResolvedValue({ counts: [{ identityId: MODERATOR, count: 2 }] })
    expect((await blog.getActionCounts())?.get(MODERATOR)).toBe(2)
    expect(sdk.contracts.moderationActionCounts).toHaveBeenCalledWith(ids.blog)
  })
})

describe('per-contract "closed until a team is seated" gate (D1)', () => {
  it('reads each contract\'s own registered interim and seated team', async () => {
    // Social has a seated team; the storefront was registered notYetUsable and has none; blogs moderate by owner.
    sdk.contracts.fetch.mockImplementation(async (id: string) => {
      if (id === ids.storefront) return registered('Maker', 'notYetUsable')
      if (id === ids.blog) return registered('Maker', 'contractOwner')
      return registered('Maker', 'notYetUsable')
    })
    sdk.moderationCharters.team.mockImplementation(async (id: string) => (id === ids.social
      ? { leaderId: { toBase58: () => 'Lead' }, members: [], electedMembers: [], seats: () => 3, free: () => undefined }
      : null))

    expect(await moderationServiceFor('storefront').moderatedTypeOpen('storeReview')).toBe(false)
    expect(await moderationServiceFor('storefront').moderatedTypeOpen('store')).toBe(false)
    // Not a moderated type: open without a read of its own.
    expect(await moderationServiceFor('storefront').moderatedTypeOpen('storeOrder')).toBe(true)
    expect(await moderationServiceFor('blog').moderatedTypeOpen('blogComment')).toBe(true)
    expect(await moderationService.moderatedTypeOpen('post')).toBe(true)

    expect(sdk.contracts.fetch).toHaveBeenCalledWith(ids.storefront)
    expect(sdk.moderationCharters.team).toHaveBeenCalledWith(ids.storefront)
    expect(await moderationServiceFor('storefront').getInterim()).toBe('notYetUsable')
  })

  it('lets nobody moderate a notYetUsable storefront until its team is seated, then only that team', async () => {
    sdk.contracts.fetch.mockResolvedValue(registered('Maker', 'notYetUsable'))
    const storefront = moderationServiceFor('storefront')
    expect(await storefront.isModerator('Maker')).toBe(false)

    sdk.moderationCharters.team.mockResolvedValue({ leaderId: { toBase58: () => 'Lead' }, members: [{ toBase58: () => 'Member' }], electedMembers: [], seats: () => 3, free: () => undefined })
    storefront.invalidateTeam()
    expect(await storefront.isModerator('Lead')).toBe(true)
    expect(await storefront.isModerator('Member')).toBe(true)
    expect(await storefront.isModerator('Maker')).toBe(false)
    // The social team is a different read: its cache was never touched.
    expect(sdk.moderationCharters.team).not.toHaveBeenCalledWith(ids.social)
  })
})
