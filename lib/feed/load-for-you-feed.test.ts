import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transformRawPost } from './transform-raw-post';
import type { CompositeFeedPage } from './composite-feed-page';
import type { Post } from '@/lib/types';

const mocks = vi.hoisted(() => ({ composite: vi.fn(), timeline: vi.fn() }));
vi.mock('./composite-feed-page', () => ({ loadCompositeFeedPage: mocks.composite }));
vi.mock('@/lib/services/post-service', () => ({ postService: { getTimeline: mocks.timeline } }));
vi.mock('./enrich-posts', () => ({ enrichPostsWithRepostsAndQuotes: async (posts: Post[]) => posts }));
import { loadForYouFeed } from './load-for-you-feed';

const raw = Array.from({ length: 41 }, (_, i) => ({
  $id: `post${String(i).padStart(8, '0')}`, $ownerId: '111111111', $createdAt: 1000, content: 'test',
}));
const posts = raw.map(transformRawPost);
const callbacks = () => ({
  setData: vi.fn(), setHasMore: vi.fn(), setLastPostId: vi.fn(), enrichProgressively: vi.fn(),
});
function compositePage(start: number, end: number): CompositeFeedPage {
  return { rawPosts: raw.slice(start, end), posts: posts.slice(start, end), hasMore: end - start === 20, preloaded: {} };
}
beforeEach(() => vi.resetAllMocks());

describe('For You pagination', () => {
  it('should return every timestamp tie over three pages using document cursors', async () => {
    mocks.composite.mockResolvedValueOnce(compositePage(0, 20))
      .mockResolvedValueOnce(compositePage(20, 40)).mockResolvedValueOnce(compositePage(40, 41));
    mocks.timeline.mockImplementation(async ({ startAfter, limit }: { startAfter: string; limit: number }) => {
      const start = posts.findIndex(post => post.id === startAfter) + 1;
      return { documents: posts.slice(start, start + limit) };
    });
    const first = await loadForYouFeed(callbacks());
    expect(mocks.timeline).not.toHaveBeenCalled();
    const second = await loadForYouFeed({ ...callbacks(), startAfter: first.cursor ?? undefined });
    const third = await loadForYouFeed({ ...callbacks(), startAfter: second.cursor ?? undefined });
    expect([...first.posts, ...second.posts, ...third.posts].map(post => post.id)).toEqual(posts.map(post => post.id));
    expect(mocks.timeline.mock.calls.map(call => call[0].startAfter)).toEqual([posts[19].id, posts[39].id]);
    expect(mocks.composite.mock.calls[1][0].documentIds).toEqual(posts.slice(20, 40).map(post => post.id));
    expect(third.hasMore).toBe(false);
  });

  it('should reuse the cursor query when composite is unavailable', async () => {
    mocks.composite.mockResolvedValue(null);
    mocks.timeline.mockResolvedValue({ documents: posts.slice(20) });
    const page = await loadForYouFeed({ ...callbacks(), startAfter: posts[19].id });
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
    expect(page.posts[0].author.hasDpns).toBeUndefined();
    expect(page.posts.map(post => post.id)).toEqual(posts.slice(20).map(post => post.id));
  });

  it('should preserve the raw timeline cursor when the last card is a tombstone', async () => {
    mocks.timeline.mockResolvedValue({ documents: posts.slice(20, 23) });
    mocks.composite.mockResolvedValue({ ...compositePage(20, 23), posts: posts.slice(20, 22) });
    const page = await loadForYouFeed({ ...callbacks(), startAfter: posts[19].id });
    expect(page.cursor).toBe(posts[22].id);
    expect(page.posts).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });
});
