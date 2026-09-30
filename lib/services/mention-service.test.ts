import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { query, createDocument } = vi.hoisted(() => ({ query: vi.fn(), createDocument: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument } }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))

beforeEach(() => {
  vi.resetModules()
  query.mockReset()
  createDocument.mockReset()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('v10 mentions (post.mentionedUserId)', () => {
  it('lists the mentioning posts off the permanent mentionedUserAndTime index, as mention records', async () => {
    query.mockResolvedValueOnce([
      { $id: 'post-a', $ownerId: 'alice', $createdAt: 10, mentionedUserId: 'me' },
      { $id: 'post-b', $ownerId: 'bob', $createdAt: 20, mentionedUserId: 'me' },
    ])
    const { mentionService } = await import('./mention-service')
    expect(await mentionService.getPostsMentioningUser('me')).toEqual([
      { $id: 'post-a', $ownerId: 'alice', $createdAt: 10, postId: 'post-a', mentionedUserId: 'me' },
      { $id: 'post-b', $ownerId: 'bob', $createdAt: 20, postId: 'post-b', mentionedUserId: 'me' },
    ])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toMatchObject({
      documentTypeName: 'post',
      where: [['mentionedUserId', '==', 'me'], ['$createdAt', '>', 0]],
      orderBy: [['mentionedUserId', 'asc'], ['$createdAt', 'asc']],
    })
    expect(query.mock.calls[0][0]).not.toHaveProperty('timeRange')
  })

  it('writes no postMention document: the doctype is gone', async () => {
    const { mentionService } = await import('./mention-service')
    expect(await mentionService.createPostMention('post', 'owner', 'someone')).toBe(false)
    expect(createDocument).not.toHaveBeenCalled()
  })
})
