import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ranked, loadCompositeFeedPage } = vi.hoisted(() => ({
  ranked: vi.fn(),
  loadCompositeFeedPage: vi.fn(),
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { ranked } }) }));
vi.mock('@/lib/feed/composite-feed-page', () => ({ loadCompositeFeedPage }));
vi.mock('./sdk-helpers', () => ({ getCurrentUserId: () => undefined }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('../constants', () => ({ YAPPR_CONTRACT_ID: 'contract' }));
vi.mock('../contract-topology', () => ({
  windowedRankingsAvailable: () => true,
  WINDOWED_DAY_GRID: { range: 86400000, step: 86400000 },
}));

function ranking(count: number, prefix = 'post') {
  return {
    entries: Array.from({ length: count }, (_, i) => ({ groupValue: `${prefix}-${i}`, value: BigInt(count - i) })),
  };
}

beforeEach(() => {
  // A new module gives each test its own hydrated cache.
  vi.resetModules();
  ranked.mockReset().mockImplementation(async ({ limit, where }) => ranking(limit, where?.[0]?.[2]));
  loadCompositeFeedPage.mockReset().mockImplementation(async ({ documentIds }: { documentIds: string[] }) => ({
    rawPosts: documentIds.map($id => ({ $id })),
    posts: documentIds.map(id => ({ id, author: { id: 'author' } })),
    preloaded: {},
  }));
});

describe('ranked page failures', () => {
  it.each(['ranking', 'hydration'] as const)('rejects a failed %s expansion and retries the same limit', async (failure) => {
    const { topLikedPostsHydrated } = await import('./ranked-likes');
    const firstPage = await topLikedPostsHydrated({ limit: 20, throwOnError: true });
    expect(firstPage).toHaveLength(20);

    const error = new Error(`${failure} unavailable`);
    (failure === 'ranking' ? ranked : loadCompositeFeedPage).mockRejectedValueOnce(error);
    await expect(topLikedPostsHydrated({ limit: 40, throwOnError: true })).rejects.toBe(error);

    // A failed expansion neither replaces the existing cached page nor caches
    // a false empty result at 40. The next attempt must perform a fresh read.
    expect(await topLikedPostsHydrated({ limit: 20, throwOnError: true })).toBe(firstPage);
    const expanded = await topLikedPostsHydrated({ limit: 40, throwOnError: true });
    expect(expanded).toHaveLength(40);
    expect(expanded.slice(0, 20).map(post => post.id)).toEqual(firstPage.map(post => post.id));
    expect(ranked).toHaveBeenCalledTimes(3);
  });

  it('rejects a Following expansion when one author fails, without caching partial results', async () => {
    const { topLikedPostsByAuthorsHydrated } = await import('./ranked-likes');
    const options = { authorIds: ['alice', 'bob'], limit: 20, throwOnError: true };
    const firstPage = await topLikedPostsByAuthorsHydrated(options);
    expect(firstPage).toHaveLength(20);

    const error = new Error('bob ranking unavailable');
    ranked.mockImplementation(async ({ where, limit }) => {
      if (where[0][2] === 'bob') throw error;
      return ranking(limit, where[0][2]);
    });
    loadCompositeFeedPage.mockClear();
    await expect(topLikedPostsByAuthorsHydrated({ ...options, limit: 40 })).rejects.toBe(error);
    expect(loadCompositeFeedPage).not.toHaveBeenCalled();
    expect(await topLikedPostsByAuthorsHydrated(options)).toBe(firstPage);

    ranked.mockImplementation(async ({ limit, where }) => ranking(limit, where[0][2]));
    expect(await topLikedPostsByAuthorsHydrated({ ...options, limit: 40 })).toHaveLength(40);
  });

  it.each(['ranking', 'hydration'] as const)('does not cache a fail-soft %s error for strict callers', async (failure) => {
    const { topLikedPostsHydrated } = await import('./ranked-likes');
    (failure === 'ranking' ? ranked : loadCompositeFeedPage).mockRejectedValueOnce(new Error('unavailable'));
    expect(await topLikedPostsHydrated({ limit: 20 })).toEqual([]);
    expect(await topLikedPostsHydrated({ limit: 20, throwOnError: true })).toHaveLength(20);
    expect(ranked).toHaveBeenCalledTimes(2);
  });

  it('does not cache a fail-soft partial Following ranking', async () => {
    const { topLikedPostsByAuthorsHydrated } = await import('./ranked-likes');
    ranked.mockRejectedValueOnce(new Error('one author unavailable'));
    const options = { authorIds: ['alice', 'bob'], limit: 20 };
    expect(await topLikedPostsByAuthorsHydrated(options)).toEqual([]);
    expect(loadCompositeFeedPage).not.toHaveBeenCalled();
    expect(await topLikedPostsByAuthorsHydrated({ ...options, throwOnError: true })).toHaveLength(20);
    expect(ranked).toHaveBeenCalledTimes(4);
  });

  it('keeps legacy raw reads fail-soft unless explicitly requested', async () => {
    const { topLikedPosts } = await import('./ranked-likes');
    const error = new Error('ranking unavailable');
    ranked.mockRejectedValue(error);
    expect(await topLikedPosts()).toEqual([]);
    await expect(topLikedPosts({ throwOnError: true })).rejects.toBe(error);
  });

  it('preserves genuine empty rankings and the cold-day absence workaround', async () => {
    const { topLikedPostsHydrated } = await import('./ranked-likes');
    ranked.mockResolvedValueOnce({ entries: [] });
    expect(await topLikedPostsHydrated({ throwOnError: true })).toEqual([]);
    ranked.mockRejectedValueOnce(new Error('a single-path axis read must produce exactly one axis descent'));
    expect(await topLikedPostsHydrated({ window: 'today', throwOnError: true })).toEqual([]);
    expect(loadCompositeFeedPage).not.toHaveBeenCalled();
    // Successful absences remain cacheable.
    expect(await topLikedPostsHydrated({ throwOnError: true })).toEqual([]);
    expect(await topLikedPostsHydrated({ window: 'today', throwOnError: true })).toEqual([]);
    expect(ranked).toHaveBeenCalledTimes(2);
  });

  it('preserves proven absent or tombstoned posts as a successful empty page', async () => {
    const { topLikedPostsHydrated } = await import('./ranked-likes');
    loadCompositeFeedPage.mockResolvedValueOnce({ rawPosts: [{ $id: 'post-0' }], posts: [], preloaded: {} });
    expect(await topLikedPostsHydrated({ limit: 2, throwOnError: true })).toEqual([]);
  });
});
