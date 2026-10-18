/**
 * The moderators' box end to end, without a network: a follower's CEK sealed
 * to the current team's encryption keys, opened by a moderator, and the
 * reported private post decrypted read-only.
 */
import bs58 from 'bs58'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from '@/lib/crypto/keys'
import { bytesToBase64 } from '@/lib/bytes'
import { cekAt, encryptContent, type ContentKind } from '@/lib/private-feed/crypto'
import { sealReportBox } from '@/lib/report-box'
import type { Post } from '@/lib/types'

const mocks = vi.hoisted(() => ({ getTeam: vi.fn(), getIdentity: vi.fn(), contentKeyFor: vi.fn(), getPostById: vi.fn() }))
vi.mock('./post-service', () => ({ postService: { getPostById: mocks.getPostById } }))
vi.mock('./moderation-service', () => ({
  moderationService: { getTeam: mocks.getTeam },
  moderatorIdsOf: (team: { appointed: string[]; ownerModerates: boolean; ownerId: string }) =>
    [...new Set([...team.appointed, ...(team.ownerModerates ? [team.ownerId] : [])])],
}))
vi.mock('./identity-service', () => ({ identityService: { getIdentity: mocks.getIdentity } }))
vi.mock('./private-feed-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./private-feed-reader')>()),
  contentKeyFor: mocks.contentKeyFor,
}))

const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
const [AUTHOR, REPORTER, LEADER, MEMBER, KEYLESS] = [id(1), id(2), id(3), id(4), id(5)]
const secret = (fill: number) => new Uint8Array(32).fill(fill)
const MODERATOR_KEYS: Record<string, Uint8Array> = { [LEADER]: secret(30), [MEMBER]: secret(40) }

const encryptionKeyOf = (identityId: string) => {
  const key = MODERATOR_KEYS[identityId]
  return { publicKeys: key ? [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(key)) }] : [] }
}

const FEED = 2
const cek = cekAt(secret(77), 10, 3)
const seal = (text: string, feedOwner: string, author: string, kind: ContentKind) =>
  encryptContent(cek, text, { feedOwnerId: bs58.decode(feedOwner), feed: FEED, keyGeneration: 3, authorId: bs58.decode(author), kind })
const encrypted = seal('the private words', AUTHOR, AUTHOR, 'post')
const privatePost: Post = {
  id: id(9), targetKind: 'post', content: '🔒', createdAt: new Date(0),
  author: { id: AUTHOR, username: '', displayName: '', avatar: '', followers: 0, following: 0, verified: false, joinedAt: new Date(0) },
  likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0,
  encryptedContent: encrypted.ciphertext, nonce: encrypted.nonce, keyGeneration: 3, feed: FEED,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v17')
  mocks.getTeam.mockResolvedValue({ ownerId: id(99), appointed: [LEADER, MEMBER, KEYLESS], elected: true, ownerModerates: false })
  mocks.getIdentity.mockImplementation(async (identityId: string) => encryptionKeyOf(identityId))
  // The reporter follows the feed: its keys give the CEK of the post's generation.
  mocks.contentKeyFor.mockResolvedValue({ cek })
})
afterEach(() => vi.unstubAllEnvs())

describe('the report box service', () => {
  it('seals the reporter\'s key to every seated moderator with an encryption key, and each reads the post', async () => {
    const { buildReportBox, openReportedContent } = await import('./report-box-service')
    const outcome = await buildReportBox(REPORTER, privatePost)
    if (outcome.kind !== 'sealed') throw new Error(`expected a sealed box, got ${outcome.kind}`)
    expect([outcome.recipients, outcome.missing]).toEqual([2, 1])
    expect(mocks.contentKeyFor).toHaveBeenCalledWith(REPORTER, AUTHOR, FEED, 3, undefined)
    for (const moderator of [LEADER, MEMBER]) {
      await expect(openReportedContent(outcome.box, privatePost, MODERATOR_KEYS[moderator])).resolves.toEqual({ kind: 'opened', text: 'the private words' })
    }
    await expect(openReportedContent(outcome.box, privatePost, secret(50))).resolves.toMatchObject({ kind: 'failed' })
  })

  it('seals to the team as it is now, never to a cached one: a removed moderator is left out, a new one included', async () => {
    const NEWCOMER = id(6)
    MODERATOR_KEYS[NEWCOMER] = secret(50)
    const before = { ownerId: id(99), appointed: [LEADER, MEMBER], elected: true, ownerModerates: false }
    const after = { ownerId: id(99), appointed: [LEADER, NEWCOMER], elected: true, ownerModerates: false }
    // A cached read still answers the old team; only a fresh read sees the change.
    mocks.getTeam.mockImplementation(async (options?: { fresh?: boolean }) => (options?.fresh ? after : before))
    try {
      const { buildReportBox, openReportedContent } = await import('./report-box-service')
      const outcome = await buildReportBox(REPORTER, privatePost)
      if (outcome.kind !== 'sealed') throw new Error(`expected a sealed box, got ${outcome.kind}`)
      expect(mocks.getTeam).toHaveBeenCalledWith({ fresh: true })
      await expect(openReportedContent(outcome.box, privatePost, MODERATOR_KEYS[NEWCOMER])).resolves.toMatchObject({ kind: 'opened' })
      await expect(openReportedContent(outcome.box, privatePost, MODERATOR_KEYS[MEMBER])).resolves.toMatchObject({ kind: 'failed' })
    } finally {
      delete MODERATOR_KEYS[NEWCOMER]
    }
  })

  it('seals to a moderator\'s encryption key as it is now: a rotated-out key never opens the box', async () => {
    const replacement = secret(55)
    // The cached identity still holds the old key; the network has the replacement.
    mocks.getIdentity.mockImplementation(async (identityId: string, options?: { fresh?: boolean }) => (
      identityId === LEADER && options?.fresh
        ? { publicKeys: [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(MODERATOR_KEYS[LEADER])), disabledAt: 1 },
          { id: 3, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(replacement)) }] }
        : encryptionKeyOf(identityId)
    ))
    const { buildReportBox, openReportedContent } = await import('./report-box-service')
    const outcome = await buildReportBox(REPORTER, privatePost)
    if (outcome.kind !== 'sealed') throw new Error(`expected a sealed box, got ${outcome.kind}`)
    expect(mocks.getIdentity).toHaveBeenCalledWith(LEADER, { fresh: true })
    await expect(openReportedContent(outcome.box, privatePost, replacement)).resolves.toMatchObject({ kind: 'opened' })
    await expect(openReportedContent(outcome.box, privatePost, MODERATOR_KEYS[LEADER])).resolves.toMatchObject({ kind: 'failed' })
  })

  it('seals nothing when any moderator\'s fresh identity read fails, never falling back to a cached one', async () => {
    mocks.getIdentity.mockImplementation(async (identityId: string, options?: { fresh?: boolean }) => {
      if (identityId === MEMBER && options?.fresh) throw new Error('DAPI unavailable')
      return encryptionKeyOf(identityId)
    })
    const { buildReportBox } = await import('./report-box-service')
    await expect(buildReportBox(REPORTER, privatePost)).rejects.toThrow('DAPI unavailable')
  })

  it('seals nothing, and says so by throwing, when the fresh team read fails', async () => {
    mocks.getTeam.mockRejectedValue(new Error('DAPI unavailable'))
    const { buildReportBox } = await import('./report-box-service')
    await expect(buildReportBox(REPORTER, privatePost)).rejects.toThrow('DAPI unavailable')
  })

  it('seals nothing when no moderator holds an encryption key (the email channel)', async () => {
    mocks.getTeam.mockResolvedValue({ ownerId: id(99), appointed: [KEYLESS], elected: true, ownerModerates: false })
    const { buildReportBox } = await import('./report-box-service')
    await expect(buildReportBox(REPORTER, privatePost)).resolves.toEqual({ kind: 'no-recipients' })
  })

  it('seals nothing when this device cannot read the post itself', async () => {
    mocks.contentKeyFor.mockResolvedValue({ reason: 'no-access' })
    const { buildReportBox } = await import('./report-box-service')
    await expect(buildReportBox(REPORTER, privatePost)).resolves.toEqual({ kind: 'no-key' })
  })

  it('needs no box for public content, or before v13', async () => {
    const { buildReportBox } = await import('./report-box-service')
    await expect(buildReportBox(REPORTER, { ...privatePost, encryptedContent: undefined })).resolves.toEqual({ kind: 'not-needed' })
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v12')
    const v12 = await import('./report-box-service')
    await expect(v12.buildReportBox(REPORTER, privatePost)).resolves.toEqual({ kind: 'not-needed' })
  })

  describe('a reply', () => {
    const REPLIER = id(11)
    // Each case its own thread: the reader keeps a root it read for a while.
    let thread = 20
    const reply = (owner: string): Post => {
      const sealed = seal('the private reply', owner, REPLIER, 'reply')
      return { ...privatePost, id: id(10), targetKind: 'reply', author: { ...privatePost.author, id: REPLIER }, rootPostId: id(thread++), rootOwnerId: AUTHOR,
        encryptedContent: sealed.ciphertext, nonce: sealed.nonce }
    }

    it('in a private thread seals the thread owner\'s key', async () => {
      const { buildReportBox } = await import('./report-box-service')
      mocks.getPostById.mockResolvedValue(privatePost)
      await expect(buildReportBox(REPORTER, reply(AUTHOR))).resolves.toMatchObject({ kind: 'sealed' })
      expect(mocks.contentKeyFor).toHaveBeenLastCalledWith(REPORTER, AUTHOR, FEED, 3, undefined)
    })

    it('under a public post seals the replier\'s own key', async () => {
      const { buildReportBox } = await import('./report-box-service')
      mocks.getPostById.mockResolvedValue({ ...privatePost, encryptedContent: undefined, nonce: undefined, keyGeneration: undefined })
      await expect(buildReportBox(REPORTER, reply(REPLIER))).resolves.toMatchObject({ kind: 'sealed' })
      expect(mocks.contentKeyFor).toHaveBeenLastCalledWith(REPORTER, REPLIER, FEED, 3, undefined)
    })

    it.each([
      ['cannot be read', null],
      ['is a tombstone', { ...privatePost, deleted: true, encryptedContent: undefined, nonce: undefined, keyGeneration: undefined }],
    ])('seals the thread owner\'s key when its root %s, once that key opens the reply', async (_case, root) => {
      const { buildReportBox } = await import('./report-box-service')
      mocks.getPostById.mockResolvedValue(root)
      await expect(buildReportBox(REPORTER, reply(AUTHOR))).resolves.toMatchObject({ kind: 'sealed' })
      expect(mocks.contentKeyFor).toHaveBeenLastCalledWith(REPORTER, AUTHOR, FEED, 3, undefined)
    })

    it('seals nothing when its root reads back public but the reply is not in its replier\'s feed', async () => {
      const { buildReportBox } = await import('./report-box-service')
      // A public root settles whose feed it is (the replier's): the thread owner's key is not handed over for it.
      mocks.getPostById.mockResolvedValue({ ...privatePost, encryptedContent: undefined, nonce: undefined, keyGeneration: undefined })
      await expect(buildReportBox(REPORTER, reply(AUTHOR))).resolves.toEqual({ kind: 'no-key' })
      expect(mocks.contentKeyFor).toHaveBeenCalledTimes(1)
    })

    it('seals nothing when no candidate feed\'s key opens it', async () => {
      const { buildReportBox } = await import('./report-box-service')
      mocks.getPostById.mockResolvedValue({ ...privatePost, deleted: true, encryptedContent: undefined, nonce: undefined, keyGeneration: undefined })
      mocks.contentKeyFor.mockResolvedValue({ cek: cekAt(secret(78), 10, 3) })
      await expect(buildReportBox(REPORTER, reply(AUTHOR))).resolves.toEqual({ kind: 'no-key' })
      expect(mocks.contentKeyFor).toHaveBeenCalledTimes(2)
    })
  })

  it('refuses a box naming another feed or key generation than the content', async () => {
    const { openReportedContent } = await import('./report-box-service')
    const moderator = [getPublicKey(MODERATOR_KEYS[LEADER])]
    for (const forged of [{ feed: FEED + 1, keyGeneration: 3 }, { feed: FEED, keyGeneration: 0xffff }]) {
      const box = sealReportBox({ feedOwnerId: AUTHOR, cek, ...forged }, moderator, privatePost.id)
      await expect(openReportedContent(box, privatePost, MODERATOR_KEYS[LEADER])).resolves.toMatchObject({ kind: 'failed', reason: expect.stringMatching(/another feed or generation/) })
    }
  })

  it('opens nothing presented as another author\'s post', async () => {
    const { openReportedContent } = await import('./report-box-service')
    const box = sealReportBox({ feedOwnerId: AUTHOR, feed: FEED, keyGeneration: 3, cek }, [getPublicKey(MODERATOR_KEYS[LEADER])], privatePost.id)
    // The author binding: the same ciphertext presented as someone else's post does not open.
    const moved = { ...privatePost, author: { ...privatePost.author, id: REPORTER } }
    await expect(openReportedContent(box, moved, MODERATOR_KEYS[LEADER])).resolves.toMatchObject({ kind: 'failed' })
  })
})
