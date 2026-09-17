import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, updateDocument, createDocument } = vi.hoisted(() => ({
  get: vi.fn(), updateDocument: vi.fn(), createDocument: vi.fn(),
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get } }) }))
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
    expect(result).toMatchObject({ ...content, commentsEnabledDefault: false })
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
