/**
 * "Hide, don't delete" (social v18, blog v10, storefront v11): moderators hide
 * and unhide with `moderatorChangeDocumentFields`, restrict an account with a
 * `restriction` document (a create, then field changes on the same one) and
 * never delete, ban or suspend. Runs the real v18-set topology off the
 * committed files; the SDK is mocked (the live battery is
 * scripts/prove-v18-moderation.mjs).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ids = vi.hoisted(() => {
  const ids = { social: 'Soc1111111111111111111111111111111111111111', storefront: 'Sto1111111111111111111111111111111111111111', blog: 'Blg1111111111111111111111111111111111111111' }
  process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID = ids.social
  process.env.NEXT_PUBLIC_CONTRACT_TOPOLOGY = 'v18'
  process.env.NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID = ids.storefront
  process.env.NEXT_PUBLIC_STOREFRONT_TOPOLOGY = 'v11'
  process.env.NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID = ids.blog
  process.env.NEXT_PUBLIC_BLOG_TOPOLOGY = 'v10'
  return ids
})

const sdk = vi.hoisted(() => ({
  contracts: {
    fetch: vi.fn(),
    moderatorChangeDocumentFields: vi.fn(),
    moderatorDeleteDocument: vi.fn(),
    banUser: vi.fn(),
    suspendUser: vi.fn(),
    unbanUser: vi.fn(),
    unsuspendUser: vi.fn(),
    warnUser: vi.fn(),
  },
  identities: { fetch: vi.fn(), contractNonce: vi.fn() },
  documents: { query: vi.fn() },
  stateTransitions: { broadcastStateTransition: vi.fn(), waitForResponse: vi.fn() },
  moderationCharters: { team: vi.fn() },
}))
const restrictions = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn() }))
const built = vi.hoisted(() => ({ buildDocumentForCreate: vi.fn(), buildSignedCreateTransition: vi.fn() }))

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./identity-nonce', () => ({ withSdkSignedWrite: (_who: string, _contract: string, write: () => Promise<unknown>) => write() }))
vi.mock('./signer-service', () => ({ signerService: { createSigner: async () => ({ signer: true }) } }))
vi.mock('../secure-storage', () => ({ getPrivateKey: () => 'wif' }))
vi.mock('@/lib/auth/signing-keys', () => ({ hasAppConnectSession: () => false }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true, key: { keyId: 0 } }) }))
vi.mock('@dashevo/wasm-sdk', () => ({ Document: { fromBytes: vi.fn() }, PlatformVersion: { latest: () => 'latest' }, PrivateKey: { fromWIF: (wif: string) => ({ wif }) } }))
vi.mock('./restriction-service', () => ({ restrictionServiceFor: () => restrictions }))
vi.mock('./document-builder-service', () => ({ documentBuilderService: { buildDocumentForCreate: built.buildDocumentForCreate } }))
vi.mock('@/lib/manual-batch', () => ({ buildSignedCreateTransition: built.buildSignedCreateTransition }))

import { hideFields, isModerationLabel, missingDocumentState, moderationServiceFor, restrictionCreateFields } from './moderation-service'
import { identifierToBase58 } from './sdk-helpers'

const MODERATOR = 'Mod111111111111111111111111111111111111111'
const AUTHOR = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF'
const POST = 'Pst111111111111111111111111111111111111111'

beforeEach(() => {
  for (const group of [sdk.contracts, sdk.identities, sdk.documents, sdk.stateTransitions, sdk.moderationCharters]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  for (const fn of [restrictions.read, restrictions.refresh, built.buildDocumentForCreate, built.buildSignedCreateTransition]) fn.mockReset()
  sdk.identities.fetch.mockResolvedValue({ id: MODERATOR, publicKeys: [] })
  sdk.contracts.moderatorChangeDocumentFields.mockResolvedValue({})
  restrictions.refresh.mockResolvedValue(null)
  built.buildDocumentForCreate.mockResolvedValue({ document: true })
  built.buildSignedCreateTransition.mockReturnValue({ transition: true })
})

const changeCall = () => sdk.contracts.moderatorChangeDocumentFields.mock.calls[0][0]

describe('abilities on the v18 set', () => {
  it('never removes, restores, settles or bans: hides, restricts and warns instead', () => {
    for (const key of ['social', 'blog', 'storefront'] as const) {
      const service = moderationServiceFor(key)
      expect(service.hidesInsteadOfDeleting()).toBe(true)
      expect(service.canRemove('post') || service.canRemove('blogPost') || service.canRemove('storeReview')).toBe(false)
      expect(service.teamDeletesSettled()).toBe(false)
      expect([service.canBan(), service.canSuspend(), service.canWarn()]).toEqual([false, false, true])
      expect(service.canDismissReports()).toBe(false)
      expect(service.canResolveReports()).toBe(true)
      expect(service.canRestore('post', { restoredAt: null, removedAt: Date.now(), documentId: POST, documentHash: 'h' } as Parameters<typeof service.canRestore>[1])).toBe(false)
    }
    expect(moderationServiceFor('social').canHide('post')).toBe(true)
    expect(moderationServiceFor('social').canHide('report')).toBe(false)
    expect(moderationServiceFor('blog').canHide('blogComment')).toBe(true)
    expect(moderationServiceFor('storefront').canHide('itemReview')).toBe(true)
    expect([moderationServiceFor('social').canRestrict(), moderationServiceFor('blog').canRestrict(), moderationServiceFor('storefront').canRestrict()])
      .toEqual([true, true, false])
  })

  it('refuses a ban, a suspension and a removal locally, without signing', async () => {
    const social = moderationServiceFor('social')
    expect(await social.ban(MODERATOR, AUTHOR, 'spam')).toMatchObject({ success: false, errorCode: 'NOT_MODERATED' })
    expect(await social.suspend(MODERATOR, AUTHOR, Date.now() + 1000, 'spam')).toMatchObject({ success: false, errorCode: 'NOT_MODERATED' })
    expect(await social.unban(MODERATOR, AUTHOR)).toMatchObject({ success: false })
    expect(await social.removeDocument(MODERATOR, 'post', POST, 'spam')).toMatchObject({ success: false, errorCode: 'NOT_MODERATED' })
    expect(sdk.contracts.banUser).not.toHaveBeenCalled()
    expect(sdk.contracts.suspendUser).not.toHaveBeenCalled()
    expect(sdk.contracts.moderatorDeleteDocument).not.toHaveBeenCalled()
  })

  it('never calls a missing document a takedown', () => {
    expect(missingDocumentState(null, true, { recordsRead: true })).toBe('unavailable')
    expect(missingDocumentState(null, false)).toBe('unavailable')
    expect(missingDocumentState(null, true, { recordsRead: true, authorsDelete: true })).toBe('deleted')
  })
})

describe('hide and unhide', () => {
  it('hides with mod 1 and the label, citing the reason, on the contract it belongs to', async () => {
    const result = await moderationServiceFor('social').hide(MODERATOR, 'post', POST, { label: 3, reason: { text: 'Spam', reasonDocumentId: 'R1' } })
    expect(result).toEqual({ success: true })
    expect(changeCall()).toMatchObject({
      contractId: ids.social, documentTypeName: 'post', documentId: POST,
      fields: { mod: 1, modLabel: 3 }, reason: { text: 'Spam', reasonDocumentId: 'R1' }, signer: { signer: true },
    })
  })

  it('writes mod 2 for a legal hold', () => {
    expect(hideFields(5, true)).toEqual({ mod: 2, modLabel: 5 })
    expect(hideFields(5)).toEqual({ mod: 1, modLabel: 5 })
  })

  it('unhides by clearing mod alone', async () => {
    expect(await moderationServiceFor('storefront').unhide(MODERATOR, 'storeReview', 'R9')).toEqual({ success: true })
    expect(changeCall()).toMatchObject({ contractId: ids.storefront, documentTypeName: 'storeReview', fields: { mod: null } })
    expect(changeCall().fields).not.toHaveProperty('modLabel')
  })

  it('refuses a label outside 1–63 and a type it cannot hide, before signing', async () => {
    expect(isModerationLabel(0) || isModerationLabel(64) || isModerationLabel(1.5)).toBe(false)
    expect(await moderationServiceFor('social').hide(MODERATOR, 'post', POST, { label: 0 })).toMatchObject({ errorCode: 'INVALID_LABEL' })
    expect(await moderationServiceFor('social').hide(MODERATOR, 'report', POST, { label: 1 })).toMatchObject({ errorCode: 'NOT_MODERATED' })
    expect(sdk.contracts.moderatorChangeDocumentFields).not.toHaveBeenCalled()
  })

  it('says "already hidden" for a change that changes nothing (10905), and "check again" when unconfirmed', async () => {
    sdk.contracts.moderatorChangeDocumentFields.mockRejectedValueOnce(Object.assign(new Error('The fields a moderator\'s document change sets are invalid'), { code: 10905 }))
    expect(await moderationServiceFor('blog').hide(MODERATOR, 'blogPost', 'B1', { label: 1 }))
      .toMatchObject({ success: false, errorCode: 'NOTHING_TO_CHANGE', error: 'This blog post is already hidden for that reason' })
    sdk.contracts.moderatorChangeDocumentFields.mockRejectedValueOnce(new Error('Request timeout: deadline exceeded'))
    const unconfirmed = await moderationServiceFor('social').hide(MODERATOR, 'reply', 'R1', { label: 1 })
    expect(unconfirmed.errorCode).toBe('MAYBE_APPLIED')
    expect(unconfirmed.error).toMatch(/may already be hidden/)
  })

  it('classifies a non-moderator\'s change (41101)', async () => {
    sdk.contracts.moderatorChangeDocumentFields.mockRejectedValueOnce(Object.assign(new Error('Identity X is not the owner or a moderator of contract C'), { code: 41101 }))
    expect(await moderationServiceFor('social').unhide(MODERATOR, 'post', POST)).toMatchObject({ success: false, errorCode: 'NOT_MODERATOR' })
  })
})

describe('a profile extension as a hide target', () => {
  it('reads its id and marks by owner, fresh', async () => {
    sdk.documents.query.mockResolvedValue([{ $id: 'Prf1', $ownerId: AUTHOR, mod: 1, modLabel: 2, $moderatedBy: MODERATOR, $moderatedAt: 1000 }])
    expect(await moderationServiceFor('social').readProfileModeration(AUTHOR)).toEqual({
      documentId: 'Prf1', moderation: { mod: 1, modLabel: 2, moderatedBy: MODERATOR, moderatedAt: 1000 },
    })
    expect(sdk.documents.query).toHaveBeenCalledWith(expect.objectContaining({ dataContractId: ids.social, documentTypeName: 'yapprProfile', where: [['$ownerId', '==', AUTHOR]] }))
  })

  it('is null without an extension, and off a contract that hides no profiles', async () => {
    sdk.documents.query.mockResolvedValue([])
    expect(await moderationServiceFor('social').readProfileModeration(AUTHOR)).toBeNull()
    expect(await moderationServiceFor('blog').readProfileModeration(AUTHOR)).toBeNull()
    expect(sdk.documents.query).toHaveBeenCalledTimes(1)
  })
})

describe('restrict and lift', () => {
  it('creates the restriction document the first time: target bytes, state 1, the reason', async () => {
    restrictions.read.mockResolvedValue(null)
    sdk.identities.contractNonce.mockResolvedValue(BigInt(6))
    expect(await moderationServiceFor('social').restrict(MODERATOR, AUTHOR, 4)).toEqual({ success: true })
    const [contractId, docType, ownerId, data, identity] = built.buildDocumentForCreate.mock.calls[0]
    expect([contractId, docType, ownerId]).toEqual([ids.social, 'restriction', MODERATOR])
    expect(identifierToBase58(data.target)).toBe(AUTHOR)
    expect([data.state, data.reason]).toEqual([1, 4])
    expect(identity.identityContractNonce).toBe(BigInt(7))
    expect(built.buildSignedCreateTransition).toHaveBeenCalledWith(expect.objectContaining({ ownerId: MODERATOR, identityContractNonce: BigInt(7), privateKey: { wif: 'wif' }, identityKey: { keyId: 0 } }))
    expect(sdk.stateTransitions.broadcastStateTransition).toHaveBeenCalledWith({ transition: true })
    expect(sdk.stateTransitions.waitForResponse).toHaveBeenCalledWith({ transition: true })
    expect(restrictions.refresh).toHaveBeenCalledWith(AUTHOR)
    expect(sdk.contracts.moderatorChangeDocumentFields).not.toHaveBeenCalled()
  })

  it('re-restricts by flipping the existing document (byTarget is unique)', async () => {
    restrictions.read.mockResolvedValue({ id: 'RX', target: AUTHOR, state: 2, reason: 1 })
    expect(await moderationServiceFor('blog').restrict(MODERATOR, AUTHOR, 2, { text: 'again' })).toEqual({ success: true })
    expect(changeCall()).toMatchObject({ contractId: ids.blog, documentTypeName: 'restriction', documentId: 'RX', fields: { state: 1, reason: 2 } })
    expect(built.buildDocumentForCreate).not.toHaveBeenCalled()
  })

  it('flips the other moderator\'s document when a create races it (40105)', async () => {
    restrictions.read.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'RY', target: AUTHOR, state: 2, reason: 1 })
    sdk.identities.contractNonce.mockResolvedValue(undefined)
    sdk.stateTransitions.broadcastStateTransition.mockRejectedValueOnce(Object.assign(new Error('Document has duplicate unique properties'), { code: 40105 }))
    expect(await moderationServiceFor('social').restrict(MODERATOR, AUTHOR, 3)).toEqual({ success: true })
    expect(changeCall()).toMatchObject({ documentId: 'RY', fields: { state: 1, reason: 3 } })
  })

  it('says so when the account is already restricted, or not restricted', async () => {
    restrictions.read.mockResolvedValue({ id: 'RX', target: AUTHOR, state: 1, reason: 3 })
    expect(await moderationServiceFor('social').restrict(MODERATOR, AUTHOR, 3)).toMatchObject({ errorCode: 'ALREADY_RESTRICTED' })
    restrictions.read.mockResolvedValue(null)
    expect(await moderationServiceFor('social').liftRestriction(MODERATOR, AUTHOR)).toMatchObject({ errorCode: 'NOT_RESTRICTED' })
    expect(sdk.contracts.moderatorChangeDocumentFields).not.toHaveBeenCalled()
  })

  it('lifts with state 2 alone and refreshes the standing', async () => {
    restrictions.read.mockResolvedValue({ id: 'RX', target: AUTHOR, state: 1, reason: 3 })
    expect(await moderationServiceFor('social').liftRestriction(MODERATOR, AUTHOR)).toEqual({ success: true })
    expect(changeCall()).toMatchObject({ documentTypeName: 'restriction', documentId: 'RX', fields: { state: 2 } })
    expect(restrictions.refresh).toHaveBeenCalledWith(AUTHOR)
  })

  it('is refused on the storefront, which keeps no restrictions', async () => {
    expect(await moderationServiceFor('storefront').restrict(MODERATOR, AUTHOR, 1)).toMatchObject({ success: false, errorCode: 'NOT_MODERATED' })
    expect(restrictions.read).not.toHaveBeenCalled()
  })

  it('builds the create fields from a base58 identity', () => {
    const fields = restrictionCreateFields(AUTHOR, 9)
    expect(fields.target).toBeInstanceOf(Uint8Array)
    expect(fields.target).toHaveLength(32)
    expect([fields.state, fields.reason]).toEqual([1, 9])
  })
})
