import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  documents: { ranked: vi.fn(), count: vi.fn(), query: vi.fn() },
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }));
import { blogStatsService } from './blog-stats-service';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v2');
  blogStatsService.invalidate();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('blog rankings', () => {
  it('maps ranked entries to counts and drops zero groups', async () => {
    sdk.documents.ranked.mockResolvedValue({
      entries: [
        { groupValue: 'blogA', value: 7n },
        { groupValue: 'blogB', value: 0n },
      ],
    });
    expect(await blogStatsService.mostFollowedBlogs(10)).toEqual([{ id: 'blogA', count: 7 }]);
    expect(sdk.documents.ranked).toHaveBeenCalledWith(
      expect.objectContaining({
        documentTypeName: 'blogFollow',
        groupBy: 'blogId',
        aggregate: { type: 'count' },
        direction: 'desc',
        limit: 10,
      })
    );
    // All-time rankings carry no window.
    expect(sdk.documents.ranked.mock.calls[0][0]).not.toHaveProperty('timeRange');
  });

  it('pins the daily bucket for trending blogs', async () => {
    sdk.documents.ranked.mockResolvedValue({ entries: [{ groupValue: 'blogA', value: 2n }] });
    expect(await blogStatsService.trendingBlogs(5)).toEqual([{ id: 'blogA', count: 2 }]);
    expect(sdk.documents.ranked).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 86400 } }],
      })
    );
  });

  it('ranks posts by comment count on the blogComment tree', async () => {
    sdk.documents.ranked.mockResolvedValue({ entries: [{ groupValue: 'postA', value: 3n }] });
    expect(await blogStatsService.mostDiscussedPosts()).toEqual([{ id: 'postA', count: 3 }]);
    expect(sdk.documents.ranked).toHaveBeenCalledWith(
      expect.objectContaining({ documentTypeName: 'blogComment', groupBy: 'blogPostId' })
    );
  });

  it('treats a cold windowed bucket as an empty page', async () => {
    sdk.documents.ranked.mockRejectedValue(
      new Error('a single-path axis read must produce exactly one axis descent, the walk produced 0')
    );
    expect(await blogStatsService.trendingBlogs()).toEqual([]);
  });

  it('returns an empty page instead of throwing when a ranked read fails', async () => {
    sdk.documents.ranked.mockRejectedValue(new Error('offline'));
    expect(await blogStatsService.mostFollowedBlogs()).toEqual([]);
  });

  it('caches a ranking until invalidated', async () => {
    sdk.documents.ranked.mockResolvedValue({ entries: [{ groupValue: 'blogA', value: 1n }] });
    await blogStatsService.mostFollowedBlogs(10);
    await blogStatsService.mostFollowedBlogs(10);
    expect(sdk.documents.ranked).toHaveBeenCalledTimes(1);
    blogStatsService.invalidate();
    await blogStatsService.mostFollowedBlogs(10);
    expect(sdk.documents.ranked).toHaveBeenCalledTimes(2);
  });

  it('serves nothing on the v1 contract, where the ranked axes do not exist', async () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v1');
    expect(await blogStatsService.mostFollowedBlogs()).toEqual([]);
    expect(await blogStatsService.trendingBlogs()).toEqual([]);
    expect(await blogStatsService.mostDiscussedPosts()).toEqual([]);
    expect(sdk.documents.ranked).not.toHaveBeenCalled();
  });
});
