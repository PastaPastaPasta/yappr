import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, query, updateDocument, createDocument } = vi.hoisted(() => ({
  get: vi.fn(), query: vi.fn(), updateDocument: vi.fn(), createDocument: vi.fn(),
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get, query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument, createDocument } }))

import { blogService } from './blog-service'
import { YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants'

const ownerId = 'blog-owner'
const blogId = 'blog-document'
const content = {
  name: 'QA blog',
  description: 'Original description',
  avatar: 'https://example.invalid/avatar.png',
  headerImage: 'https://example.invalid/header.png',
  labels: 'only-label',
  commentsEnabledDefault: true,
}
const raw = { $id: blogId, $ownerId: ownerId, $revision: 7, $createdAt: 1700000000000, ...content }

beforeEach(() => {
  blogService.clearCache()
  get.mockReset().mockResolvedValue(raw)
  updateDocument.mockReset().mockImplementation(async (_contract, _type, id, owner, data, revision) => ({
    success: true,
    document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  }))
  createDocument.mockReset().mockImplementation(async (_contract, _type, owner, data) => ({
    success: true,
    document: { $id: blogId, $ownerId: owner, $revision: 1, ...data },
  }))
})

describe('blog optional-field updates', () => {
  it.each(['description', 'avatar', 'headerImage', 'labels'] as const)(
    'removes an explicitly cleared %s instead of restoring the saved value', async (field) => {
      // Settings represents cleared controls (including the final label) as undefined.
      const result = await blogService.updateBlog(blogId, ownerId, { [field]: undefined })
      const expected: Record<string, unknown> = { ...content }
      delete expected[field]

      expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
        YAPPR_BLOG_CONTRACT_ID, 'blog', blogId, ownerId, expected, 7
      )
      expect(result[field]).toBeUndefined()
      expect(result.$revision).toBe(8)
    }
  )

  it('preserves optional fields that are omitted from a partial update', async () => {
    const result = await blogService.updateBlog(blogId, ownerId, { commentsEnabledDefault: false })

    expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_BLOG_CONTRACT_ID, 'blog', blogId, ownerId,
      { ...content, commentsEnabledDefault: false }, 7
    )
    expect(result).toMatchObject({ ...content, labels: ['only-label'], commentsEnabledDefault: false })
  })

  it('rejects failed replacements so settings cannot report a successful clear', async () => {
    updateDocument.mockResolvedValueOnce({ success: false, error: 'Replacement rejected' })
    await expect(blogService.updateBlog(blogId, ownerId, { description: undefined }))
      .rejects.toThrow('Replacement rejected')
  })

  it('still omits unset optional fields when creating a blog', async () => {
    await blogService.createBlog(ownerId, { name: 'New blog', description: undefined, labels: undefined })

    expect(createDocument).toHaveBeenCalledExactlyOnceWith(
      YAPPR_BLOG_CONTRACT_ID, 'blog', ownerId, { name: 'New blog' }, undefined
    )
  })
})

describe('blog v4 typed labels (docs/SOCIAL_V9.md)', () => {
  it('writes labels as a list on blog v4 and reads a stored list back as a list', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v4')
    try {
      get.mockResolvedValueOnce({ ...raw, labels: ['oncall', 'databases'] })
      const result = await blogService.updateBlog(blogId, ownerId, { labels: ['oncall', 'databases', 'essays'] })
      expect(updateDocument).toHaveBeenCalledExactlyOnceWith(
        YAPPR_BLOG_CONTRACT_ID, 'blog', blogId, ownerId,
        { ...content, labels: ['oncall', 'databases', 'essays'] }, 7
      )
      expect(result.labels).toEqual(['oncall', 'databases', 'essays'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps a label containing a comma as ONE label on v4 (QA D-55)', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v4')
    try {
      get.mockResolvedValueOnce({ ...raw, labels: ['oncall'] })
      const result = await blogService.updateBlog(blogId, ownerId, { labels: ['oncall', 'alpha,beta'] })
      expect(updateDocument.mock.calls[0][4].labels).toEqual(['oncall', 'alpha,beta'])
      expect(result.labels).toEqual(['oncall', 'alpha,beta'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses a label containing a comma on v1-v3, whose CSV encoding would split it', async () => {
    await expect(blogService.updateBlog(blogId, ownerId, { labels: ['alpha,beta'] })).rejects.toThrow(/comma/)
    expect(updateDocument).not.toHaveBeenCalled()
  })

  it('re-encodes an untouched stored list on v4 instead of sending the CSV model', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v4')
    try {
      get.mockResolvedValueOnce({ ...raw, labels: ['oncall'] })
      await blogService.updateBlog(blogId, ownerId, { commentsEnabledDefault: false })
      expect(updateDocument.mock.calls[0][4]).toMatchObject({ labels: ['oncall'], commentsEnabledDefault: false })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('blog v4 label limits', () => {
  it('refuses more than 64 blog labels before anything is written', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v4')
    try {
      const labels = Array.from({ length: 65 }, (_, i) => `label${i}`)
      await expect(blogService.updateBlog(blogId, ownerId, { labels })).rejects.toThrow(/At most 64 blog labels/)
      expect(updateDocument).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not apply the v4 caps on blog v3 (its own byte cap stands)', async () => {
    const labels = Array.from({ length: 65 }, (_, i) => `l${i}`)
    await blogService.updateBlog(blogId, ownerId, { labels })
    expect(updateDocument.mock.calls[0][4].labels).toBe(labels.join(','))
  })
})

describe('newest blogs for discovery', () => {
  /** `total` blogs in owner order, created in reverse of it, paged after `startAfter`. */
  const blogs = (total: number) => async ({ limit, startAfter }: { limit: number; startAfter?: string }) => {
    const first = startAfter ? Number(startAfter.slice(1)) + 1 : 0
    return Array.from({ length: Math.max(0, Math.min(limit, total - first)) }, (_, i) => ({
      $id: `b${first + i}`, $ownerId: `o${first + i}`, $createdAt: 1_000_000 - (first + i), name: `Blog ${first + i}`,
    }))
  }

  it('sorts every blog by creation time, not just the first page in owner order', async () => {
    query.mockReset().mockImplementation(blogs(250))
    const { blogs: newest, complete } = await blogService.getNewestBlogs(100)
    expect(complete).toBe(true)
    expect(newest).toHaveLength(100)
    // The newest blog is the lowest owner id here, the oldest of those kept is the 100th.
    expect(newest[0].id).toBe('b0')
    expect(newest.at(-1)?.id).toBe('b99')
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[0][0]).toMatchObject({ orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100 })
  })

  it('reuses the scan for a while, and a created blog drops it', async () => {
    query.mockReset().mockImplementation(blogs(150))
    await blogService.getNewestBlogs(10)
    await blogService.getNewestBlogs(100)
    expect(query).toHaveBeenCalledTimes(2)
    blogService.clearCache()
    await blogService.getNewestBlogs(10)
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('says when the scan stopped at its cap', async () => {
    query.mockReset().mockImplementation(blogs(5000))
    const { complete } = await blogService.getNewestBlogs(100)
    expect(complete).toBe(false)
    // Ten full pages, then a one-row probe that proves there is more.
    expect(query).toHaveBeenCalledTimes(11)
  })
})
