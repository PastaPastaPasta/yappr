/**
 * The author's delete and the repost undo both go through
 * `postService.deleteOwnPost`: a tombstone where posts are permanent (v9,
 * v11), a document delete elsewhere. On v11 undoing a repost therefore never
 * deletes; it tombstones the bare repost, whose cleared quote frees the slot
 * for a later repost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, updateDocument, deleteDocument } = vi.hoisted(() => ({ get: vi.fn(), updateDocument: vi.fn(), deleteDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument, deleteDocument } }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))

const repostId = '11111111111111111111111111111112'
const ownerId = '11111111111111111111111111111113'
const targetId = '11111111111111111111111111111114'
const targetOwnerId = '11111111111111111111111111111115'

beforeEach(() => {
  vi.resetModules()
  get.mockReset().mockResolvedValue({
    toObject: () => ({ $id: repostId, $ownerId: ownerId, $revision: 1, quotedPostId: targetId, quotedPostOwnerId: targetOwnerId }),
  })
  updateDocument.mockReset().mockResolvedValue({ success: true })
  deleteDocument.mockReset().mockResolvedValue({ success: true })
})
afterEach(() => vi.unstubAllEnvs())

async function deleteOwnPost(topology: string): Promise<boolean> {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const { postService } = await import('./post-service')
  return postService.deleteOwnPost(repostId, ownerId)
}

describe('deleteOwnPost', () => {
  it('tombstones a bare repost on v11, clearing its quote', async () => {
    await expect(deleteOwnPost('v11')).resolves.toBe(true)
    expect(deleteDocument).not.toHaveBeenCalled()
    expect(updateDocument).toHaveBeenCalledTimes(1)
    expect(updateDocument.mock.calls[0][4]).toEqual({ deleted: true })
  })

  it('deletes the document on v10', async () => {
    await expect(deleteOwnPost('v10')).resolves.toBe(true)
    expect(updateDocument).not.toHaveBeenCalled()
    expect(deleteDocument).toHaveBeenCalledWith(expect.any(String), 'post', repostId, ownerId)
  })

  it('tombstones with empty content on v9', async () => {
    await expect(deleteOwnPost('v9')).resolves.toBe(true)
    expect(deleteDocument).not.toHaveBeenCalled()
    expect(updateDocument.mock.calls[0][4]).toMatchObject({ content: '', deleted: true })
  })

  it('reports a refused tombstone as a failure', async () => {
    updateDocument.mockResolvedValue({ success: false, error: 'refused' })
    await expect(deleteOwnPost('v11')).resolves.toBe(false)
  })
})
