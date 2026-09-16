import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, createDocument, deleteDocument } = vi.hoisted(() => ({
  query: vi.fn(), createDocument: vi.fn(), deleteDocument: vi.fn(),
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument, deleteDocument } }))
import { bookmarkService } from './bookmark-service'

const postId = '11111111111111111111111111111111'
const ownerId = '11111111111111111111111111111112'
const bookmark = { $id: 'bookmark-id', $ownerId: ownerId, postId, $createdAt: 1 }

beforeEach(() => {
  query.mockReset()
  createDocument.mockReset()
  deleteDocument.mockReset()
})

describe('bookmark mutation confirmation', () => {
  it('does not report a failed lookup as successful removal', async () => {
    query.mockRejectedValueOnce(new Error('offline'))
    await expect(bookmarkService.removeBookmark(postId, ownerId)).resolves.toBe(false)
    expect(deleteDocument).not.toHaveBeenCalled()
  })

  it('does not create a duplicate when the existing-bookmark lookup fails', async () => {
    query.mockRejectedValueOnce(new Error('offline'))
    await expect(bookmarkService.bookmarkPost(postId, ownerId)).resolves.toBe(false)
    expect(createDocument).not.toHaveBeenCalled()
  })

  it('accepts confirmed absence without issuing a delete', async () => {
    query.mockResolvedValueOnce([])
    await expect(bookmarkService.removeBookmark(postId, ownerId)).resolves.toBe(true)
    expect(deleteDocument).not.toHaveBeenCalled()
  })

  it.each([true, false])('returns the confirmed deletion result %s', async success => {
    query.mockResolvedValueOnce([bookmark])
    deleteDocument.mockResolvedValueOnce({ success })
    await expect(bookmarkService.removeBookmark(postId, ownerId)).resolves.toBe(success)
    expect(deleteDocument).toHaveBeenCalledWith(expect.any(String), 'bookmark', 'bookmark-id', ownerId)
  })

  it('reports a rejected deletion as failure', async () => {
    query.mockResolvedValueOnce([bookmark])
    deleteDocument.mockRejectedValueOnce(new Error('offline'))
    await expect(bookmarkService.removeBookmark(postId, ownerId)).resolves.toBe(false)
  })

  it('preserves the read-only membership fallback', async () => {
    query.mockRejectedValueOnce(new Error('offline'))
    await expect(bookmarkService.isBookmarked(postId, ownerId)).resolves.toBe(false)
  })
})
