import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transformRawPost } from './transform-raw-post';
import type { CompositeFeedPage } from './composite-feed-page';
import type { Post } from '@/lib/types';

const mocks = vi.hoisted(() => ({ composite: vi.fn(), timeline: vi.fn(), indexOnly: vi.fn() }));
vi.mock('./composite-feed-page', () => ({ loadCompositeFeedPage: mocks.composite }));
vi.mock('@/lib/contract-topology', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/contract-topology')>(),
  likesAreIndexOnly: mocks.indexOnly,
}));
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
/** Posts tombstoned where `flags` is true, served as the timeline after `start`, honoring each read's limit. */
function timelineOf(flags: boolean[]): Post[] {
  const docs = flags.map((deleted, i) => transformRawPost({
    $id: `tl${String(i).padStart(8, '0')}`, $ownerId: '111111111', $createdAt: 1000,
    ...(deleted ? { deleted: true } : { content: 'test' }),
  }));
  mocks.timeline.mockImplementation(async ({ startAfter, limit }: { startAfter?: string; limit: number }) => {
    const start = startAfter && startAfter !== 'start' ? docs.findIndex(post => post.id === startAfter) + 1 : 0;
    return { documents: docs.slice(start, start + limit) };
  });
  return docs;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.indexOnly.mockReturnValue(true);
});

describe('For You pagination', () => {
  it('reads the plain timeline on a topology without composite pages (v2 testnet)', async () => {
    mocks.indexOnly.mockReturnValue(false);
    timelineFromPosts();
    mocks.timeline.mockResolvedValueOnce({ documents: posts.slice(0, 20) });
    const first = await loadForYouFeed({});
    const second = await loadForYouFeed({ startAfter: first.cursor ?? undefined });
    expect(mocks.composite).not.toHaveBeenCalled();
    expect(first.posts.map(post => post.id)).toEqual(posts.slice(0, 20).map(post => post.id));
    expect(first.posts[0].author.hasDpns).toBeUndefined();
    expect(first.cursor).toBe(posts[19].id);
    expect(first.hasMore).toBe(true);
    expect(second.posts.map(post => post.id)).toEqual(posts.slice(20, 40).map(post => post.id));
  });

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
    const timeline = timelineOf([false, false, true]);
    mocks.composite.mockImplementation(async ({ documentIds }: { documentIds: string[] }) => ({
      rawPosts: [], posts: timeline.filter(post => documentIds.includes(post.id)), hasMore: false, preloaded: {},
    }));
    const page = await loadForYouFeed({ startAfter: 'start' });
    expect(mocks.composite.mock.calls[0][0].documentIds).toEqual([timeline[0].id, timeline[1].id]);
    expect(page.cursor).toBe(timeline[2].id);
    expect(page.posts).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it('should end or continue on a full page by whether the read was full', async () => {
    timelineOf(Array.from({ length: 20 }, () => false));
    mocks.composite.mockResolvedValue({ rawPosts: [], posts: posts.slice(0, 20), hasMore: false, preloaded: {} });
    // Exactly 20 live posts left: the read is full, so another (empty) one is due.
    expect((await loadForYouFeed({ startAfter: 'start' })).hasMore).toBe(true);
    timelineOf(Array.from({ length: 19 }, () => false));
    expect((await loadForYouFeed({ startAfter: 'start' })).hasMore).toBe(false);
  });

  it('should cut a wide read at its 20th live post without composite pages (v2 testnet)', async () => {
    mocks.indexOnly.mockReturnValue(false);
    const timeline = timelineOf([...Array.from({ length: 30 }, () => true), ...Array.from({ length: 25 }, () => false)]);
    const live = timeline.filter(post => !post.deleted);
    const page = await loadForYouFeed({});
    expect(mocks.timeline.mock.calls.map(call => call[0].limit)).toEqual([20, 100]);
    expect(mocks.composite).not.toHaveBeenCalled();
    expect(page.posts.map(post => post.id)).toEqual(live.slice(0, 20).map(post => post.id));
    expect(page.cursor).toBe(live[19].id);
    expect(page.hasMore).toBe(true);
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
    const tombs = timelineOf(Array.from({ length: 1000 }, () => true));
    mocks.composite.mockResolvedValue({
      rawPosts: tombs.slice(0, 20).map(post => ({ $id: post.id })), posts: [], hasMore: true, preloaded: {},
    });
    const page = await loadForYouFeed({});
    expect(page.posts).toEqual([]);
    expect(page.hasMore).toBe(true);
    // Five wide reads past the first page, none of them enriched.
    expect(mocks.timeline.mock.calls.map(call => call[0].limit)).toEqual([100, 100, 100, 100, 100]);
    expect(mocks.composite).toHaveBeenCalledTimes(1);
    // The cursor is the last document read, so a retry never re-reads skipped pages.
    expect(page.cursor).toBe(tombs[519].id);
  });

  it('should enrich only the live posts of a later page, and none of an all-tombstone one', async () => {
    const mixed = timelineOf([true, false, true, false, ...Array.from({ length: 20 }, () => true)]);
    mocks.composite.mockImplementation(async ({ documentIds }: { documentIds: string[] }) => ({
      rawPosts: [], posts: mixed.filter(post => documentIds.includes(post.id)), hasMore: false, preloaded: {},
    }));
    const page = await loadForYouFeed({ startAfter: 'start' });
    expect(mocks.composite).toHaveBeenCalledTimes(1);
    expect(mocks.composite.mock.calls[0][0].documentIds).toEqual([mixed[1].id, mixed[3].id]);
    expect(page.posts.map(post => post.id)).toEqual([mixed[1].id, mixed[3].id]);
    expect(page.cursor).toBe(mixed[19].id);
    expect(page.hasMore).toBe(true);

    // 20..23 are tombstones and the timeline ends there: nothing to enrich, no further page.
    const next = await loadForYouFeed({ startAfter: page.cursor ?? undefined });
    expect(mocks.composite).toHaveBeenCalledTimes(1);
    expect(next.posts).toEqual([]);
    expect(next.hasMore).toBe(false);
    expect(next.cursor).toBe(mixed[23].id);
  });

  it('should read past a run of tombstones widely and stop at a full page of live posts', async () => {
    // A tombstone page, then a run of 150 more tombstones with 30 live posts after it.
    const timeline = timelineOf([...Array.from({ length: 170 }, () => true), ...Array.from({ length: 30 }, () => false)]);
    const live = timeline.filter(post => !post.deleted);
    mocks.composite.mockImplementation(async ({ documentIds }: { documentIds: string[] }) => ({
      rawPosts: [], posts: timeline.filter(post => documentIds.includes(post.id)), hasMore: false, preloaded: {},
    }));
    const page = await loadForYouFeed({ startAfter: 'start' });
    // 20, then 100 (all tombstones), then 100 holding the 30 live posts.
    expect(mocks.timeline.mock.calls.map(call => call[0].limit)).toEqual([20, 100, 100]);
    expect(mocks.composite).toHaveBeenCalledTimes(1);
    expect(page.posts.map(post => post.id)).toEqual(live.slice(0, 20).map(post => post.id));
    // Resumes right after the last post shown, not after the whole wide read.
    expect(page.cursor).toBe(live[19].id);
    expect(page.hasMore).toBe(true);
  });
});
