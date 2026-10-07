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
import type { Post } from '@/lib/types'

const mocks = vi.hoisted(() => ({ getTeam: vi.fn(), getIdentity: vi.fn(), contentKeyFor: vi.fn() }))
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

  it('seals a reply in a private thread with the thread owner\'s feed', async () => {
    const { buildReportBox } = await import('./report-box-service')
    const reply: Post = { ...privatePost, id: id(10), targetKind: 'reply', author: { ...privatePost.author, id: id(11) }, rootPostId: id(9), rootOwnerId: AUTHOR }
    await buildReportBox(REPORTER, reply)
    expect(mocks.contentKeyFor).toHaveBeenCalledWith(AUTHOR, 3, REPORTER)
  })
})
