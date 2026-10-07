/**
 * The moderators' box end to end, without a network: a follower's CEK sealed
 * to the current team's encryption keys, opened by a moderator, and the
 * reported private post decrypted read-only.
 */
import bs58 from 'bs58'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from '@/lib/crypto/keys'
import { bytesToBase64 } from '@/lib/bytes'
import { privateFeedCryptoService } from './private-feed-crypto-service'
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
vi.mock('./index', () => ({
  privateFeedFollowerService: { contentKeyFor: mocks.contentKeyFor },
  privateFeedKeyStore: { getFeedSeed: () => null },
  privateFeedCryptoService,
  MAX_KEY_GENERATION: 2000,
}))

const id = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
const [AUTHOR, REPORTER, LEADER, MEMBER, KEYLESS] = [id(1), id(2), id(3), id(4), id(5)]
const secret = (fill: number) => new Uint8Array(32).fill(fill)
const MODERATOR_KEYS: Record<string, Uint8Array> = { [LEADER]: secret(30), [MEMBER]: secret(40) }

const encryptionKeyOf = (identityId: string) => {
  const key = MODERATOR_KEYS[identityId]
  return { publicKeys: key ? [{ id: 2, type: 0, purpose: 1, securityLevel: 2, data: bytesToBase64(getPublicKey(key)) }] : [] }
}

const chain = privateFeedCryptoService.generateCekChain(secret(77), 10)
const encrypted = privateFeedCryptoService.encryptPostContent(chain[3], 'the private words', bs58.decode(AUTHOR), 3)
const privatePost: Post = {
  id: id(9), targetKind: 'post', content: '🔒', createdAt: new Date(0),
  author: { id: AUTHOR, username: '', displayName: '', avatar: '', followers: 0, following: 0, verified: false, joinedAt: new Date(0) },
  likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0,
  encryptedContent: encrypted.ciphertext, nonce: encrypted.nonce, keyGeneration: 3,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v13')
  mocks.getTeam.mockResolvedValue({ ownerId: id(99), appointed: [LEADER, MEMBER, KEYLESS], elected: true, ownerModerates: false })
  mocks.getIdentity.mockImplementation(async (identityId: string) => encryptionKeyOf(identityId))
  // The reporter follows the feed: its keys give the CEK of the post's generation.
  mocks.contentKeyFor.mockResolvedValue({ cek: chain[3] })
})
afterEach(() => vi.unstubAllEnvs())

describe('the report box service', () => {
  it('seals the reporter\'s key to every seated moderator with an encryption key, and each reads the post', async () => {
    const { buildReportBox, openReportedContent } = await import('./report-box-service')
    const outcome = await buildReportBox(REPORTER, privatePost)
    if (outcome.kind !== 'sealed') throw new Error(`expected a sealed box, got ${outcome.kind}`)
    expect([outcome.recipients, outcome.missing]).toEqual([2, 1])
    expect(mocks.contentKeyFor).toHaveBeenCalledWith(AUTHOR, 3, REPORTER)
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
    mocks.contentKeyFor.mockResolvedValue({ error: 'No keys for this feed' })
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
    const reply = (owner: string): Post => {
      const sealed = privateFeedCryptoService.encryptPostContent(chain[3], 'the private reply', bs58.decode(owner), 3)
      return { ...privatePost, id: id(10), targetKind: 'reply', author: { ...privatePost.author, id: REPLIER }, rootPostId: id(9), rootOwnerId: AUTHOR,
        encryptedContent: sealed.ciphertext, nonce: sealed.nonce }
    }

    it('in a private thread seals the thread owner\'s key', async () => {
      const { buildReportBox } = await import('./report-box-service')
      mocks.getPostById.mockResolvedValue(privatePost)
      await expect(buildReportBox(REPORTER, reply(AUTHOR))).resolves.toMatchObject({ kind: 'sealed' })
      expect(mocks.contentKeyFor).toHaveBeenLastCalledWith(AUTHOR, 3, REPORTER)
    })

    it('under a public post seals the replier\'s own key', async () => {
      const { buildReportBox } = await import('./report-box-service')
      mocks.getPostById.mockResolvedValue({ ...privatePost, encryptedContent: undefined, nonce: undefined, keyGeneration: undefined })
      await expect(buildReportBox(REPORTER, reply(REPLIER))).resolves.toMatchObject({ kind: 'sealed' })
      expect(mocks.contentKeyFor).toHaveBeenLastCalledWith(REPLIER, 3, REPORTER)
    })

    it.each([
      ['cannot be read', null],
      ['is a tombstone', { ...privatePost, deleted: true, encryptedContent: undefined, nonce: undefined, keyGeneration: undefined }],
    ])('seals nothing when its root %s, even with keys to both feeds', async (_case, root) => {
      const { buildReportBox } = await import('./report-box-service')
      mocks.getPostById.mockResolvedValue(root)
      await expect(buildReportBox(REPORTER, reply(AUTHOR))).resolves.toEqual({ kind: 'no-key' })
      expect(mocks.contentKeyFor).not.toHaveBeenCalled()
    })

    it('seals nothing when the chosen feed\'s key does not open it', async () => {
      const { buildReportBox } = await import('./report-box-service')
      // The root reads back public, but the reply was encrypted under the thread owner's feed.
      mocks.getPostById.mockResolvedValue({ ...privatePost, encryptedContent: undefined, nonce: undefined, keyGeneration: undefined })
      await expect(buildReportBox(REPORTER, reply(AUTHOR))).resolves.toEqual({ kind: 'no-key' })
    })
  })

  it('refuses a box naming another key generation before deriving any key', async () => {
    const { openReportedContent } = await import('./report-box-service')
    const forged = sealReportBox({ feedOwnerId: AUTHOR, keyGeneration: 0xffffffff, cek: chain[3] }, [getPublicKey(MODERATOR_KEYS[LEADER])], privatePost.id)
    const derive = vi.spyOn(privateFeedCryptoService, 'deriveCEK')
    await expect(openReportedContent(forged, privatePost, MODERATOR_KEYS[LEADER])).resolves.toMatchObject({ kind: 'failed', reason: expect.stringMatching(/another generation/) })
    expect(derive).not.toHaveBeenCalled()
    derive.mockRestore()
  })
})
