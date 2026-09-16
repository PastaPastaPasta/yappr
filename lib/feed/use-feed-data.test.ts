import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type EffectCallback } from 'react';
import { renderToString } from 'react-dom/server';
import type { Post } from '@/lib/types';

type Update = Post[] | null | ((current: Post[] | null) => Post[] | null);
const mocks = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  cached: vi.fn(), enrich: vi.fn(), load: vi.fn(), setData: vi.fn(),
}));
// Exercise the real hook's callbacks with deterministic deferred service results.
// React state rendering is separate; capture effects and observe its data setter.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: EffectCallback) => { mocks.effects.push(effect); },
}));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { identityId: 'viewer' } }) }));
vi.mock('@/components/ui/loading-state', () => ({ useAsyncState: () => ({
  data: null, loading: false, error: null,
  setData: mocks.setData, setLoading: vi.fn(), setError: vi.fn(),
}) }));
vi.mock('@/lib/cache-manager', () => ({ cacheManager: { get: mocks.cached, set: vi.fn(), clear: vi.fn() } }));
vi.mock('@/hooks/use-progressive-enrichment', () => ({ useProgressiveEnrichment: () => ({
  enrichProgressively: vi.fn(), enrichmentState: { blockStatus: new Map() },
  reset: vi.fn(), getPostEnrichment: vi.fn(),
}) }));
vi.mock('@/lib/feed/enrich-posts', () => ({ enrichPostsWithRepostsAndQuotes: mocks.enrich }));
vi.mock('@/lib/feed/load-for-you-feed', () => ({ loadForYouFeed: mocks.load }));
vi.mock('@/lib/feed/load-following-feed', () => ({ loadFollowingFeed: vi.fn() }));
vi.mock('@/lib/services', () => ({ followService: {}, postService: {} }));
vi.mock('@/lib/services/document-service', () => ({ queryPostsByOwnersSince: vi.fn(), queryPostsSince: vi.fn() }));
import { useFeedData } from '@/hooks/use-feed-data';
import { transformRawPost } from './transform-raw-post';

const cachedPost = transformRawPost({ $id: 'post00000001', $ownerId: 'owner0000001', $createdAt: 1000, content: 'cached' });
const freshPost = { ...cachedPost, content: 'fresh', _syncPending: false };
const staleEnriched = { ...cachedPost, repostedBy: { ...cachedPost.author, id: 'unrelated', displayName: 'Unrelated user' } };
let current: Post[] | null;
/** Resolves the enrichment started for the cached page mount() rendered. */
let complete: (posts: Post[]) => void;
let cleanups: (() => void)[];

function mount() {
  let feed!: ReturnType<typeof useFeedData>;
  function Probe() { feed = useFeedData({ activeTab: 'forYou' }); return null; }
  renderToString(createElement(Probe));
  cleanups = mocks.effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
  return feed;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects.length = 0;
  current = null;
  cleanups = [];
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mocks.setData.mockImplementation((update: Update) => { current = typeof update === 'function' ? update(current) : update; });
  mocks.cached.mockReturnValue({ posts: [cachedPost], cursor: cachedPost.id, hasMore: false });
  // Every call gets its own deferred so a later load's enrichment cannot be
  // completed by resolving the cached page's; `complete` is always the first.
  const resolvers: ((posts: Post[]) => void)[] = [];
  complete = (posts) => resolvers[0](posts);
  mocks.enrich.mockImplementation(() => new Promise<Post[]>(resolve => { resolvers.push(resolve); }));
  mocks.load.mockResolvedValue({ posts: [freshPost], preloaded: undefined, hasMore: false, cursor: freshPost.id });
});
afterEach(() => { cleanups.forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

describe('cached feed enrichment lifetime', () => {
  it('ignores enrichment completing after a refresh replaced the cached page', async () => {
    const feed = mount();
    await feed.refresh();
    complete([staleEnriched]);
    await Promise.resolve();
    expect(current).toEqual([freshPost]);
  });

  it('ignores enrichment after the feed view effect is cleaned up', async () => {
    mount();
    cleanups.forEach(cleanup => cleanup());
    current = [freshPost];
    complete([staleEnriched]);
    await Promise.resolve();
    expect(current).toEqual([freshPost]);
  });

  it('rechecks when a queued updater runs after refresh', async () => {
    const feed = mount();
    let queued!: (value: Post[] | null) => Post[] | null;
    mocks.setData.mockImplementation((update: Update) => {
      if (typeof update === 'function') queued = update;
      else current = update;
    });
    complete([staleEnriched]);
    await Promise.resolve();
    expect(queued).toBeTypeOf('function');
    await feed.refresh();
    expect(queued(current)).toEqual([freshPost]);
  });

  it('still applies current-view enrichment while preserving current content', async () => {
    mount();
    current = [freshPost];
    complete([staleEnriched]);
    await Promise.resolve();
    expect(current).toEqual([{ ...freshPost, repostedBy: staleEnriched.repostedBy, repostTimestamp: undefined }]);
  });
});
