import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type EffectCallback } from 'react';
import { renderToString } from 'react-dom/server';
import type { Post } from '@/lib/types';

type Update = Post[] | null | ((current: Post[] | null) => Post[] | null);
const mocks = vi.hoisted(() => ({
  effects: [] as EffectCallback[], state: [] as unknown[], slot: 0, refs: [] as { current: unknown }[], refSlot: 0,
  cached: vi.fn(), cacheSet: vi.fn(), enrich: vi.fn(), load: vi.fn(), setData: vi.fn(), setLoading: vi.fn(),
}));
// Exercise the real hook's callbacks with deterministic deferred service results.
// React state rendering is separate; capture effects, observe the data setter and
// keep plain useState and useRef slots across renders (keyed by call order, like
// React's own hook slots) so callbacks from a later render() see earlier updates,
// including loadGenerationRef bumps made by an earlier render's callbacks.
// This targets hooks/use-feed-data.ts but lives beside the lib/feed modules it
// orchestrates so vitest's lib/**/*.test.ts include picks it up.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: EffectCallback) => { mocks.effects.push(effect); },
  useState: (initial: unknown) => {
    const slot = mocks.slot++;
    if (!(slot in mocks.state)) mocks.state[slot] = initial;
    const set = (update: unknown) => {
      mocks.state[slot] = typeof update === 'function' ? update(mocks.state[slot]) : update;
    };
    return [mocks.state[slot], set];
  },
  useRef: (initial: unknown) => {
    const slot = mocks.refSlot++;
    mocks.refs[slot] ??= { current: initial };
    return mocks.refs[slot];
  },
}));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { identityId: 'viewer' } }) }));
vi.mock('@/components/ui/loading-state', () => ({ useAsyncState: () => ({
  data: null, loading: false, error: null,
  setData: mocks.setData, setLoading: mocks.setLoading, setError: vi.fn(),
}) }));
vi.mock('@/lib/cache-manager', () => ({ cacheManager: { get: mocks.cached, set: mocks.cacheSet, clear: vi.fn() } }));
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
const stalePost = transformRawPost({ $id: 'post00000002', $ownerId: 'owner0000002', $createdAt: 500, content: 'stale' });
const stalePage = { posts: [stalePost], preloaded: undefined, hasMore: true, cursor: stalePost.id };
let current: Post[] | null;
/** Resolves the enrichment started for the cached page mount() rendered. */
let complete: (posts: Post[]) => void;
let cleanups: (() => void)[];

function render(enabled = true) {
  let feed!: ReturnType<typeof useFeedData>;
  function Probe() { feed = useFeedData({ activeTab: 'forYou', enabled }); return null; }
  mocks.slot = 0;
  mocks.refSlot = 0;
  renderToString(createElement(Probe));
  return feed;
}
function mount(enabled = true) {
  const feed = render(enabled);
  cleanups = mocks.effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
  return feed;
}
function deferredPage() {
  let resolve!: (page: typeof stalePage) => void;
  const promise = new Promise<typeof stalePage>(r => { resolve = r; });
  mocks.load.mockReturnValueOnce(promise);
  return resolve;
}
/** Lets a resolved page run through loadPosts' awaits and finally block. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects.length = 0;
  mocks.state.length = 0;
  mocks.refs.length = 0;
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

describe('feed page load lifetime', () => {
  beforeEach(() => { mocks.cached.mockReturnValue(undefined); });

  it('drops a first page that lands after the feed view effect is cleaned up', async () => {
    const resolvePage = deferredPage();
    mount();
    cleanups.forEach(cleanup => cleanup());
    resolvePage(stalePage);
    await settle();
    expect(current).toBeNull();
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    expect(mocks.enrich).not.toHaveBeenCalled();
  });

  it('keeps a refresh when the load it superseded lands afterwards', async () => {
    const resolvePage = deferredPage();
    const feed = mount();
    await feed.refresh();
    resolvePage(stalePage);
    await settle();
    expect(current).toEqual([freshPost]);
    expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
    expect(mocks.cacheSet.mock.calls[0][2].posts).toEqual([freshPost]);
  });

  it('does not append a loadMore page that lands after a refresh', async () => {
    mocks.cached.mockReturnValueOnce({ posts: [cachedPost], cursor: cachedPost.id, hasMore: true });
    mount();
    const resolvePage = deferredPage();
    const loadingMore = render().loadMore();
    expect(mocks.load).toHaveBeenLastCalledWith(expect.objectContaining({ startAfter: cachedPost.id }));
    // refresh from a later render: only a shared loadGenerationRef lets it
    // invalidate the loadMore captured by the previous render.
    await render().refresh();
    resolvePage(stalePage);
    await loadingMore;
    expect(current).toEqual([freshPost]);
    expect(render().isLoadingMore).toBe(false);
  });

  it('clears loading when the feed is disabled', () => {
    mount(false);
    expect(mocks.setLoading).toHaveBeenCalledWith(false);
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
