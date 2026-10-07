import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ documents: { query: vi.fn(), count: vi.fn() } }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
import { blogFollowService } from './blog-follow-service'

beforeEach(() => {
  vi.resetAllMocks()
  sdk.documents.query.mockResolvedValue(new Map())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the blogs a reader follows', () => {
  it('rides ownerAndBlog on v7, which drops the following index', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7')
    await blogFollowService.getFollowedBlogs('reader')
    expect(sdk.documents.query).toHaveBeenCalledWith(expect.objectContaining({
      documentTypeName: 'blogFollow',
      where: [['$ownerId', '==', 'reader']],
      orderBy: [['$ownerId', 'asc'], ['blogId', 'asc']],
    }))
  })

  it('walks following [$ownerId, $createdAt] up to v6', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v6')
    await blogFollowService.getFollowedBlogs('reader')
    expect(sdk.documents.query).toHaveBeenCalledWith(expect.objectContaining({
      where: [['$ownerId', '==', 'reader'], ['$createdAt', '>', 0]],
      orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
    }))
  })
})

describe('follower counts', () => {
  it('pin only blogId on v7, the prefix total of the merged followers index', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v7')
    sdk.documents.count.mockResolvedValue(new Map([['', 12n]]))
    expect(await blogFollowService.countBlogFollowers('blogA')).toBe(12)
    expect(sdk.documents.count).toHaveBeenCalledWith(expect.objectContaining({ documentTypeName: 'blogFollow', where: [['blogId', '==', 'blogA']] }))
  })
})
