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
    for (const topology of ['v15', 'v16', 'v17']) {
      vi.resetModules()
      vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
      shapes[topology] = (await import('./post-service')).postsTaggedQuery('dash')
    }
    expect(shapes).toEqual({
      v15: { where: [['hashtag', '==', 'dash'], ['$createdAt', '>', 0]], orderBy: [['hashtag', 'asc'], ['$createdAt', 'desc']] },
      v16: { where: [['tags', 'contains', 'dash'], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] },
      // v17 keys tagAndTime [live, tags, $createdAt]: live is pinned in where only (an orderBy
      // naming it would not be a contiguous run of the index, which Drive refuses).
      v17: { where: [['live', '==', true], ['tags', 'contains', 'dash'], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] },
    })
  })
})

describe('the post timeline (timeline)', () => {
  it('pins live == true on v17 only', async () => {
    const shapes: Record<string, unknown> = {}
    for (const topology of ['v16', 'v17']) {
      vi.resetModules()
      vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
      shapes[topology] = (await import('./document-service')).postTimelineClauses('en', 5)
    }
    expect(shapes).toEqual({
      v16: { where: [['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']] },
      v17: { where: [['live', '==', true], ['$createdAt', '>', 5]], orderBy: [['$createdAt', 'desc']] },
    })
  })
})
