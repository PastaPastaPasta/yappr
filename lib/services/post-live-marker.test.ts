/**
 * v13's `live` marker: every new post carries `live: true`, and every read of
 * `post.ownerAndTime [live, $ownerId, $createdAt]` (author timelines, the
 * following feed, author post counts, the top-posters ranking) pins
 * `live == true` first. Elsewhere the queries are byte-for-byte what they were.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ query: vi.fn(), count: vi.fn(), ranked: vi.fn() }))
const createDocument = vi.hoisted(() => vi.fn())
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: sdk }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument } }))
vi.mock('./dpns-service', () => ({ dpnsService: { resolveIdentity: vi.fn(async () => null) } }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))
vi.mock('./follow-service', () => ({ followService: { getFollowing: vi.fn(async () => []) } }))

const AUTHOR = '11111111111111111111111111111112'
const FOLLOWED = '11111111111111111111111111111113'

beforeEach(() => {
  vi.resetModules()
  sdk.query.mockReset().mockResolvedValue([])
  sdk.count.mockReset().mockResolvedValue(new Map([['', 3n]]))
  sdk.ranked.mockReset().mockResolvedValue({ entries: [] })
  createDocument.mockReset().mockResolvedValue({ success: true, document: { $id: 'new', $ownerId: AUTHOR, $createdAt: 1, content: 'hi' } })
})
afterEach(() => vi.unstubAllEnvs())

async function on(topology: string) {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const [{ postService }, helpers, ranked] = await Promise.all([import('./post-service'), import('./post-query-helpers'), import('./ranked-likes')])
  return { postService, helpers, ranked }
}

describe('the v13 live marker', () => {
  it('writes live: true on every new post', async () => {
    const { postService } = await on('v13')
    await postService.createPost(AUTHOR, 'hello')
    expect(createDocument.mock.calls[0][3]).toMatchObject({ content: 'hello', live: true })
  })

  it('pins live == true first on the author timeline and the author post count', async () => {
    const { postService } = await on('v13')
    await postService.getUserPosts(AUTHOR)
    const [query] = sdk.query.mock.calls[0]
    expect(query.where).toEqual([['live', '==', true], ['$ownerId', '==', AUTHOR], ['$createdAt', '>', 0]])
    expect(query.orderBy).toEqual([['live', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'desc']])

    await expect(postService.countUserPosts(AUTHOR)).resolves.toBe(3)
    expect(sdk.count.mock.calls[0][0].where).toEqual([['live', '==', true], ['$ownerId', '==', AUTHOR]])
  })

  it('pins live == true first on the following feed', async () => {
    const { helpers } = await on('v13')
    await helpers.fetchFollowingFeed(AUTHOR, 'contract', (doc) => doc as never, { followingIds: [FOLLOWED], timeWindowEnd: new Date(2_000_000_000_000) })
    const [query] = sdk.query.mock.calls[0]
    expect(query.where.slice(0, 2)).toEqual([['live', '==', true], ['$ownerId', 'in', [FOLLOWED]]])
    expect(query.orderBy).toEqual([['live', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'asc']])
  })

  it('pins live == true first on the Following "new posts" check', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v13')
    const { queryPostsByOwnersSince } = await import('./document-service')
    await queryPostsByOwnersSince([FOLLOWED], 1_000)
    const [query] = sdk.query.mock.calls[0]
    expect(query.where).toEqual([['live', '==', true], ['$ownerId', 'in', [FOLLOWED]], ['$createdAt', '>', 1_000]])
    expect(query.orderBy).toEqual([['live', 'asc'], ['$ownerId', 'asc'], ['$createdAt', 'asc']])
  })

  it('ranks top posters under live == true', async () => {
    const { ranked } = await on('v13')
    await ranked.topAuthorsByPostCount(10)
    expect(sdk.ranked.mock.calls[0][0]).toMatchObject({ documentTypeName: 'post', groupBy: '$ownerId', where: [['live', '==', true]] })
  })

  it('changes nothing on v12: no live field, no live clause', async () => {
    const { postService, ranked } = await on('v12')
    await postService.createPost(AUTHOR, 'hello')
    expect(createDocument.mock.calls[0][3]).not.toHaveProperty('live')
    await postService.getUserPosts(AUTHOR)
    expect(sdk.query.mock.calls[0][0].where).toEqual([['$ownerId', '==', AUTHOR], ['$createdAt', '>', 0]])
    await postService.countUserPosts(AUTHOR)
    expect(sdk.count.mock.calls[0][0].where).toEqual([['$ownerId', '==', AUTHOR]])
    await ranked.topAuthorsByPostCount(10)
    expect(sdk.ranked.mock.calls[0][0]).not.toHaveProperty('where')
  })
})
