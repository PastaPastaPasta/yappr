import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '@/lib/types';

const load = vi.hoisted(() => vi.fn());
vi.mock('./composite-feed-page', () => ({ loadCompositeFeedPage: load }));
const makePost = (id: string, targetKind: 'post' | 'reply'): Post => ({
  id, targetKind, content: 'content', createdAt: new Date(1000),
  author: { id: 'author123', username: '', displayName: '', avatar: '', followers: 0, following: 0, verified: false, joinedAt: new Date(1000) },
  likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0,
});

beforeEach(() => {
  vi.resetModules();
  load.mockReset();
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9');
  load.mockImplementation(async options => ({ preloaded: {
    stats: new Map(options.documentIds.map((id: string) => [id, { likes: 2, replies: 0, reposts: 0, quotes: 0, views: 0 }])),
  } }));
});
afterEach(() => vi.unstubAllEnvs());

describe('shared post enrichment', () => {
  it('partitions mixed reply/post pages, caps IN values, and deduplicates targets', async () => {
    const posts = Array.from({ length: 101 }, (_, i) => makePost(`post${i}`, 'post'));
    const reply = makePost('reply1234', 'reply');
    const { loadPostEnrichment } = await import('./load-post-enrichment');
    const result = await loadPostEnrichment([...posts, posts[0], reply], 'viewer123');
    expect(result.stats?.size).toBe(102);
    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls.map(([options]) => [options.kind, options.documentIds.length])).toEqual([
      ['post', 100], ['post', 1], ['reply', 1],
    ]);
    expect(load.mock.calls.every(([options]) => options.currentUserId === 'viewer123')).toBe(true);
  });

  it('does not supply zero counts for a failed chunk or mix its result into a successful kind', async () => {
    load.mockRejectedValueOnce(new Error('bad proof'));
    const { loadPostEnrichment } = await import('./load-post-enrichment');
    const result = await loadPostEnrichment([makePost('post1234', 'post'), makePost('reply1234', 'reply')]);
    expect(result.stats?.has('post1234')).toBe(false);
    expect(result.stats?.get('reply1234')?.likes).toBe(2);
  });

  it('does not probe unsupported topologies or empty pages', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v2');
    const { loadPostEnrichment } = await import('./load-post-enrichment');
    expect(await loadPostEnrichment([makePost('post1234', 'post')])).toEqual({});
    expect(await loadPostEnrichment([])).toEqual({});
    expect(load).not.toHaveBeenCalled();
  });
});
