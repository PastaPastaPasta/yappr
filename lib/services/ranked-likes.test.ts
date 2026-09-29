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

it.each([['v9', 'beat'], ['v10', 'like']])("reads today's hashtag window from the %s cut's %s doctype", async (topology, docType) => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology);
  mocks.ranked.mockResolvedValue({ entries: [] });
  const { topHashtagsByLikes, topLikedPosts } = await import('./ranked-likes');
  await topHashtagsByLikes(12, 'today');
  await topLikedPosts({ hashtag: 'dash', window: 'today' });
  expect(mocks.ranked.mock.calls.map(([query]) => query.documentTypeName)).toEqual([docType, docType]);
  await topHashtagsByLikes(12, 'all');
  expect(mocks.ranked.mock.calls[2][0].documentTypeName).toBe('like');
});
