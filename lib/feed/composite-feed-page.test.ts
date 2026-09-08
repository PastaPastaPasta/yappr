import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the loader and decoders with an in-memory SDK boundary. No SDK
// initialization, browser storage or network calls are made by these tests.
const mocks = vi.hoisted(() => ({
  composite: vi.fn(),
  getEvoSdk: vi.fn(),
  seedUsernames: vi.fn(),
  seedProfiles: vi.fn(() => new Map()),
  resolveAuthors: vi.fn(),
}));
vi.mock('@/lib/services/evo-sdk-service', () => ({ getEvoSdk: mocks.getEvoSdk }));
vi.mock('@/lib/services/dpns-service', () => ({ dpnsService: { seedUsernames: mocks.seedUsernames } }));
vi.mock('@/lib/services/unified-profile-service', () => ({
  unifiedProfileService: {
    seedProfileDocuments: mocks.seedProfiles,
    getDefaultAvatarUrl: (id: string) => `avatar:${id}`,
  },
}));
vi.mock('@/lib/services/post-enrichment-helpers', () => ({ resolvePostAuthorsBatch: mocks.resolveAuthors }));

const ownerIds = ['111111111', '222222222', '333333333', '444444444'];
const docs = ownerIds.map((ownerId, i) => ({
  $id: `post0000${i}`, $ownerId: ownerId, $createdAt: 1000, content: 'test', language: 'en',
}));
const names = ownerIds.map((id, i) => ({ records: { identity: id }, label: `name${i}` }));
function result(dpns = names, page = docs) {
  return {
    pageDocuments: page,
    subResults: [
      ...Array.from({ length: 4 }, () => ({ kind: 'counts', counts: new Map() })),
      { kind: 'documents', documents: [] },
      { kind: 'documents', documents: [] },
      { kind: 'documents', documents: dpns },
      { kind: 'documents', documents: [] },
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v6');
  mocks.getEvoSdk.mockResolvedValue({ documents: { composite: mocks.composite } });
  mocks.composite.mockResolvedValue(result());
});
afterEach(() => vi.unstubAllEnvs());

describe('composite feed page', () => {
  it('should preload all four named authors using a total budget of 100', async () => {
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.size).toBe(4);
    expect(page?.preloaded.usernames?.get(ownerIds[3])).toBe('name3.dash');
    const query = mocks.composite.mock.calls[0][0];
    expect(query.subQueries).toHaveLength(8);
    expect(query.subQueries[6].limit).toBe(100);
  });

  it('should not preload partial primary names or negative cache entries at the cap', async () => {
    mocks.composite.mockResolvedValue(result(Array.from({ length: 100 }, (_, i) => ({
      records: { identity: ownerIds[0] }, label: `alias${i}`,
    }))));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.size).toBe(0);
    expect(mocks.seedUsernames).toHaveBeenCalledWith(new Map());
  });

  it('should seed absence only when the DPNS result leaves capacity for every author', async () => {
    mocks.composite.mockResolvedValue(result(names.slice(0, 3)));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.get(ownerIds[3])).toBeNull();
  });

  it('should leave capacity for empty identity branches before trusting completeness', async () => {
    mocks.composite.mockResolvedValue(result(Array.from({ length: 97 }, (_, i) => ({
      records: { identity: ownerIds[0] }, label: `alias${i}`,
    }))));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20 });
    expect(page?.preloaded.usernames?.size).toBe(0);
  });

  it('should query exact cursor-selected ids and restore their timeline order', async () => {
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const ids = docs.map(doc => doc.$id).reverse();
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20, documentIds: ids });
    expect(mocks.composite.mock.calls[0][0].where).toEqual([['$id', 'in', ids]]);
    expect(mocks.composite.mock.calls[0][0].orderBy).toBeUndefined();
    expect(page?.posts.map(post => post.id)).toEqual(ids);
  });

  it('should keep tombstones in the raw cursor page and remove them from cards', async () => {
    mocks.composite.mockResolvedValue(result(names, docs.map((doc, i) => ({ ...doc, deleted: i === 3 }))));
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 4 });
    expect(page?.rawPosts).toHaveLength(4);
    expect(page?.posts).toHaveLength(3);
    expect(page?.hasMore).toBe(true);
  });

  it('should fit viewer interactions within ten subqueries', async () => {
    const response = result();
    response.subResults.push({ kind: 'documents', documents: [] }, { kind: 'documents', documents: [] });
    mocks.composite.mockResolvedValue(response);
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    const page = await loadCompositeFeedPage({ language: 'en', limit: 20, currentUserId: ownerIds[0] });
    expect(mocks.composite.mock.calls[0][0].subQueries).toHaveLength(10);
    expect(page?.preloaded.interactions?.size).toBe(4);
  });

  it('should fall back without requesting composite documents on an old SDK', async () => {
    mocks.getEvoSdk.mockResolvedValue({ documents: {} });
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    expect(await loadCompositeFeedPage({ language: 'en', limit: 20 })).toBeNull();
    expect(mocks.composite).not.toHaveBeenCalled();
  });

  it('should fall back on unsupported nodes and back off for a minute', async () => {
    mocks.composite.mockRejectedValue(new Error('unsupported sub_queries'));
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { loadCompositeFeedPage } = await import('./composite-feed-page');
      expect(await loadCompositeFeedPage({ language: 'en', limit: 20 })).toBeNull();
      expect(await loadCompositeFeedPage({ language: 'en', limit: 20 })).toBeNull();
      expect(mocks.composite).toHaveBeenCalledTimes(1);
      time.mockReturnValue(now + 60_001);
      mocks.composite.mockResolvedValue(result());
      expect(await loadCompositeFeedPage({ language: 'en', limit: 20 })).not.toBeNull();
    } finally {
      time.mockRestore();
    }
  });

  it('should fall back without seeding false absences on an incomplete response', async () => {
    mocks.composite.mockResolvedValue({ pageDocuments: docs, subResults: [] });
    const { loadCompositeFeedPage } = await import('./composite-feed-page');
    expect(await loadCompositeFeedPage({ language: 'en', limit: 20 })).toBeNull();
    expect(mocks.seedUsernames).not.toHaveBeenCalled();
    expect(mocks.seedProfiles).not.toHaveBeenCalled();
  });
});
