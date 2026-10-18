import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/services/evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: sdk }) }));
vi.mock('@/lib/services/state-transition-service', () => ({ stateTransitionService: {} }));
vi.mock('@/lib/services/identity-batch', () => ({ loadIdentityBatch: async () => ({ usernames: new Map(), profiles: [] }) }));
import { blogService } from '@/lib/services/blog-service';
import { enrichBlogPostsWithBlogNames } from './content-utils';

const posts = [{ id: 'p1', ownerId: 'owner', blogId: 'live' }, { id: 'p2', ownerId: 'owner', blogId: 'other' }];
const blog = { $id: 'live', $ownerId: 'owner', $createdAt: 1000, name: 'Live blog' };

beforeEach(() => {
  blogService.clearCache();
  sdk.query.mockReset();
  sdk.get.mockReset();
});

describe('post discovery parent-blog hydration', () => {
  it.each([false, true])('rejects a %s partial parent-blog read failure', async (partial) => {
    sdk.query.mockRejectedValue(new Error('batch offline'));
    sdk.get.mockImplementation(async (_contract, _type, id) => {
      if (partial && id === 'live') return blog;
      throw new Error('parent blog offline');
    });
    await expect(enrichBlogPostsWithBlogNames(posts, { throwOnError: true })).rejects.toThrow('parent blog offline');
  });

  it('keeps posts with readable blogs and omits genuinely absent blogs', async () => {
    sdk.query.mockRejectedValue(new Error('batch offline'));
    sdk.get.mockImplementation(async (_contract, _type, id) => id === 'live' ? blog : null);
    const listed = await enrichBlogPostsWithBlogNames(posts, { throwOnError: true });
    expect(listed).toMatchObject([{ id: 'p1', blogName: 'Live blog' }]);
  });

  it('preserves fail-soft enrichment for callers that do not opt in', async () => {
    sdk.query.mockRejectedValue(new Error('batch offline'));
    sdk.get.mockRejectedValue(new Error('parent blog offline'));
    expect(await enrichBlogPostsWithBlogNames(posts)).toEqual([]);
  });
});
