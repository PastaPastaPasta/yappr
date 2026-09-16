import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transformRawPost } from './transform-raw-post';
import type { CompositeFeedPage } from './composite-feed-page';
import type { Post } from '@/lib/types';

const mocks = vi.hoisted(() => ({ composite: vi.fn(), timeline: vi.fn() }));
vi.mock('./composite-feed-page', () => ({ loadCompositeFeedPage: mocks.composite }));
vi.mock('@/lib/services/post-service', () => ({ postService: { getTimeline: mocks.timeline } }));
import { loadForYouFeed } from './load-for-you-feed';

const raw = Array.from({ length: 41 }, (_, i) => ({
  $id: `post${String(i).padStart(8, '0')}`, $ownerId: '111111111', $createdAt: 1000, content: 'test',
}));
const posts: Post[] = raw.map(transformRawPost);
function compositePage(start: number, end: number, live: Post[] = posts.slice(start, end)): CompositeFeedPage {
  return { rawPosts: raw.slice(start, end), posts: live, hasMore: end - start === 20, preloaded: {} };
}
function timelineFromPosts() {
  mocks.timeline.mockImplementation(async ({ startAfter, limit }: { startAfter: string; limit: number }) => {
    const start = posts.findIndex(post => post.id === startAfter) + 1;
    return { documents: posts.slice(start, start + limit) };
  });
}
beforeEach(() => vi.resetAllMocks());

describe('For You pagination', () => {
  it('should return every timestamp tie over three pages using document cursors', async () => {
    mocks.composite.mockResolvedValueOnce(compositePage(0, 20))
      .mockResolvedValueOnce(compositePage(20, 40)).mockResolvedValueOnce(compositePage(40, 41));
    timelineFromPosts();
    const first = await loadForYouFeed({});
    expect(mocks.timeline).not.toHaveBeenCalled();
    const second = await loadForYouFeed({ startAfter: first.cursor ?? undefined });
    const third = await loadForYouFeed({ startAfter: second.cursor ?? undefined });
    expect([...first.posts, ...second.posts, ...third.posts].map(post => post.id)).toEqual(posts.map(post => post.id));
    expect(mocks.timeline.mock.calls.map(call => call[0].startAfter)).toEqual([posts[19].id, posts[39].id]);
    expect(mocks.composite.mock.calls[1][0].documentIds).toEqual(posts.slice(20, 40).map(post => post.id));
    expect(third.hasMore).toBe(false);
  });

  it('requires composite enrichment for every page', async () => {
    const error = new Error('composite unavailable');
    mocks.composite.mockRejectedValue(error);
    mocks.timeline.mockResolvedValue({ documents: posts.slice(20) });
    await expect(loadForYouFeed({ startAfter: posts[19].id })).rejects.toBe(error);
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
  });

  it('should preserve the raw timeline cursor when the last card is a tombstone', async () => {
    mocks.timeline.mockResolvedValue({ documents: posts.slice(20, 23) });
    mocks.composite.mockResolvedValue(compositePage(20, 23, posts.slice(20, 22)));
    const page = await loadForYouFeed({ startAfter: posts[19].id });
    expect(page.cursor).toBe(posts[22].id);
    expect(page.posts).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it('should return a short page as-is and leave the next one to the scroll sentinel', async () => {
    // A page thinned by tombstones used to trigger a background top-up that
    // raced the sentinel's own pagination and fetched every page twice.
    mocks.composite.mockResolvedValueOnce(compositePage(0, 20, posts.slice(0, 7)));
    timelineFromPosts();
    const page = await loadForYouFeed({});
    expect(page.posts).toHaveLength(7);
    expect(page.cursor).toBe(posts[19].id);
    expect(page.hasMore).toBe(true);
    expect(mocks.composite).toHaveBeenCalledTimes(1);
    expect(mocks.timeline).not.toHaveBeenCalled();
  });

  it('should skip pages that hold only tombstones', async () => {
    mocks.composite.mockResolvedValueOnce(compositePage(0, 20, []))
      .mockResolvedValueOnce(compositePage(20, 40, posts.slice(20, 25)));
    timelineFromPosts();
    const page = await loadForYouFeed({});
    expect(page.posts.map(post => post.id)).toEqual(posts.slice(20, 25).map(post => post.id));
    expect(page.cursor).toBe(posts[39].id);
    expect(mocks.timeline.mock.calls.map(call => call[0].startAfter)).toEqual([posts[19].id]);
  });

  it('should stop skipping tombstone pages after the budget and keep the cursor', async () => {
    mocks.composite.mockResolvedValue(compositePage(0, 20, []));
    mocks.timeline.mockResolvedValue({ documents: posts.slice(20, 40) });
    const page = await loadForYouFeed({});
    expect(page.posts).toEqual([]);
    expect(page.hasMore).toBe(true);
    // The cursor is the last page tried, so a retry never re-reads skipped pages.
    expect(page.cursor).toBe(posts[39].id);
    expect(mocks.composite).toHaveBeenCalledTimes(6);
  });
});
