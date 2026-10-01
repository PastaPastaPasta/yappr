import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ranked: vi.fn(), hydrate: vi.fn(), viewer: 'viewerA' }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { ranked: mocks.ranked } }) }));
vi.mock('./sdk-helpers', () => ({ getCurrentUserId: () => mocks.viewer }));
vi.mock('@/lib/feed/composite-feed-page', () => ({ loadCompositeFeedPage: mocks.hydrate }));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9');
  mocks.viewer = 'viewerA';
  mocks.hydrate.mockResolvedValue({ rawPosts: [{ $id: 'post1234' }], posts: [], preloaded: {} });
});
afterEach(() => vi.unstubAllEnvs());

it('captures the viewer once before ranking and isolates hydrated caches across account switches', async () => {
  let finish: (value: { entries: { groupValue: string; value: bigint }[] }) => void = () => { throw new Error('not started'); };
  mocks.ranked.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { topLikedPostsHydrated } = await import('./ranked-likes');
  const pending = topLikedPostsHydrated({ postAuthor: 'author123' });
  await vi.waitFor(() => expect(mocks.ranked).toHaveBeenCalledTimes(1));
  mocks.viewer = 'viewerB';
  const ranking = { entries: [{ groupValue: 'post1234', value: BigInt(1) }] };
  finish(ranking);
  await pending;
  expect(mocks.hydrate.mock.calls[0][0].currentUserId).toBe('viewerA');
  mocks.viewer = 'viewerA';
  await topLikedPostsHydrated({ postAuthor: 'author123' });
  expect(mocks.ranked).toHaveBeenCalledTimes(1);
  mocks.viewer = 'viewerB';
  mocks.ranked.mockResolvedValue(ranking);
  await topLikedPostsHydrated({ postAuthor: 'author123' });
  expect(mocks.ranked).toHaveBeenCalledTimes(2);
  expect(mocks.hydrate.mock.calls[1][0].currentUserId).toBe('viewerB');
});

const WINDOWED_READS = {
  // v9: one daily grid, the current UTC day.
  v9: {
    hashtags: { documentTypeName: 'beat', timeRange: [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 86400 } }] },
    posts: { documentTypeName: 'like', timeRange: [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 86400 } }] },
    creators: { documentTypeName: 'like', timeRange: [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 86400 } }] },
  },
  // v10: rolling grids read through their OLDEST open window (the full span); no creator window.
  v10: {
    hashtags: { documentTypeName: 'like', timeRange: [{ field: '$createdAt', selector: 'oldest', grid: { range: 86400, step: 21600 } }] },
    posts: { documentTypeName: 'like', timeRange: [{ field: '$createdAt', selector: 'oldest', grid: { range: 259200, step: 86400 } }] },
    creators: { documentTypeName: 'like' },
  },
} as const;

it.each(['v9', 'v10'] as const)('reads each axis through the %s windows', async (topology) => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology);
  mocks.ranked.mockResolvedValue({ entries: [] });
  const { topHashtagsByLikes, topLikedPosts, topCreatorsByLikes } = await import('./ranked-likes');
  const reads = WINDOWED_READS[topology];
  const shape = ({ documentTypeName, timeRange }: { documentTypeName: string; timeRange?: unknown }) => ({ documentTypeName, ...(timeRange ? { timeRange } : {}) });
  await topHashtagsByLikes(12, 'today');
  await topLikedPosts({ hashtag: 'dash', window: 'today' });
  await topLikedPosts({ window: 'today' });
  await topLikedPosts({ postAuthor: 'author123', window: 'today' });
  await topCreatorsByLikes(10, 'today');
  expect(mocks.ranked.mock.calls.map(([query]) => shape(query))).toEqual([reads.hashtags, reads.hashtags, reads.posts, reads.creators, reads.creators]);
  await topHashtagsByLikes(12, 'all');
  expect(shape(mocks.ranked.mock.calls[5][0])).toEqual({ documentTypeName: 'like' });
});

it('reads nothing windowed on v2, which has no windows', async () => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v2');
  const { topHashtagsByLikes, topLikedPosts, topCreatorsByLikes } = await import('./ranked-likes');
  expect([await topHashtagsByLikes(12, 'today'), await topLikedPosts({ window: 'today' }), await topCreatorsByLikes(10, 'today')]).toEqual([[], [], []]);
  expect(mocks.ranked).not.toHaveBeenCalled();
});

it('reads the Following Top all-time on v10 (per-author has no window there)', async () => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v10');
  mocks.ranked.mockResolvedValue({ entries: [] });
  const { topLikedPostsByAuthorsHydrated } = await import('./ranked-likes');
  await topLikedPostsByAuthorsHydrated({ authorIds: ['authorA', 'authorB'], window: 'today' });
  expect(mocks.ranked.mock.calls.map(([query]) => ('timeRange' in query ? 'windowed' : query.documentTypeName))).toEqual(['like', 'like']);
});

it('drops the zero-count groups of v11\'s preallocated like trees, which rank last', async () => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v11');
  const { topLikedPosts, topCreatorsByLikes } = await import('./ranked-likes');
  mocks.ranked.mockResolvedValue({ entries: [
    { groupValue: 'liked1', value: BigInt(3) },
    { groupValue: 'liked2', value: BigInt(1) },
    { groupValue: 'never1', value: BigInt(0) },
    { groupValue: 'never2', value: BigInt(0) },
  ] });
  expect(await topLikedPosts({ postAuthor: 'author123', limit: 4 })).toEqual([
    { postId: 'liked1', likes: 3 },
    { postId: 'liked2', likes: 1 },
  ]);
  expect((await topCreatorsByLikes(4)).map((entry) => entry.key)).toEqual(['liked1', 'liked2']);
});
