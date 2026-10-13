import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query: vi.fn() } }) }))
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }))
vi.mock('./dpns-service', () => ({ dpnsService: {} }))
vi.mock('./unified-profile-service', () => ({ unifiedProfileService: {} }))

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllEnvs())

describe('posts tagged with one tag (tagAndTime)', () => {
  it('pins hashtag with == through v15, and one element of v16\'s tags with contains, ordered by $createdAt alone', async () => {
    const shapes: Record<string, unknown> = {}
    for (const topology of ['v15', 'v16']) {
      vi.resetModules()
      vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
      shapes[topology] = (await import('./post-service')).postsTaggedQuery('dash')
    }
    expect(shapes).toEqual({
      v15: { where: [['hashtag', '==', 'dash'], ['$createdAt', '>', 0]], orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']] },
      v16: { where: [['tags', 'contains', 'dash'], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] },
    })
  })
})
