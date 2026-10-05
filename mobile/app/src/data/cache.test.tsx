import type { Page, PostDTO, ProfileDTO, UserSummaryDTO } from '@engine/api';
import { QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { queryClient } from '~/state/query-client';
import { AUTHORS, POSTS, fixturePost } from '~/ui/post/fixtures';

import { queryKeys } from './keys';
import {
  applyProfileChange,
  dropFromLists,
  hidePost,
  holdOwnQuote,
  markPostDeleted,
  setAuthorBlocked,
  setFollowing,
  setProfileChange,
  setViewerState,
  useRemovedPosts,
} from './optimistic';
import { flattenPages, useEngineInfiniteQuery, useEngineQuery } from './queries';
import { fakeEngine } from './testing/fake-engine';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

const page = <T,>(items: T[], cursor: string | null = null): Page<T> => ({ items, cursor, hasMore: cursor !== null });

const target = fixturePost({ id: 'target', stats: { likes: 5, reposts: 2, replies: 0, quotes: 0 } });
const quoting = fixturePost({ id: 'quoting', quoted: target, quotedPostId: 'target' });
const other = fixturePost({ id: 'other' });

function seed() {
  queryClient.setQueryData<InfiniteData<Page<PostDTO>>>(queryKeys.feed.home({ tab: 'forYou' }), {
    pages: [page([target, other], 'c1'), page([quoting])],
    pageParams: [null, 'c1'],
  });
  queryClient.setQueryData(queryKeys.post.detail('target'), target);
  queryClient.setQueryData(queryKeys.post.stats('target'), {
    id: 'target',
    stats: target.stats,
    viewer: { liked: false, reposted: false, bookmarked: false, ownQuoteId: null, ownQuoteBare: false },
  });
  // Another network's cache is never touched.
  queryClient.setQueryData(['engine', 'testnet', 'post', 'target'], target);
}

const feed = () => queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(queryKeys.feed.home({ tab: 'forYou' }))!;
const detail = () => queryClient.getQueryData<PostDTO>(queryKeys.post.detail('target'))!;

afterAll(() => queryClient.clear());

beforeEach(() => {
  queryClient.clear();
  fakeEngine.reset();
});

describe('setViewerState', () => {
  it('patches every cached copy of the post, moves the counts, and undoes', () => {
    seed();
    const before = feed();
    const undo = setViewerState('target', { liked: true });

    expect(feed().pages[0].items[0]).toMatchObject({ stats: { likes: 6 }, viewer: { liked: true } });
    expect(feed().pages[1].items[0].quoted).toMatchObject({ stats: { likes: 6 }, viewer: { liked: true } });
    expect(detail()).toMatchObject({ stats: { likes: 6 }, viewer: { liked: true } });
    expect(queryClient.getQueryData(queryKeys.post.stats('target'))).toMatchObject({
      stats: { likes: 6 },
      viewer: { liked: true },
    });
    // Other posts keep their identity, so their memoized cells don't re-render.
    expect(feed().pages[0].items[1]).toBe(before.pages[0].items[1]);
    expect(queryClient.getQueryData(['engine', 'testnet', 'post', 'target'])).toBe(target);
    // Dates survive (only plain objects are rebuilt).
    expect(detail().createdAt).toBeInstanceOf(Date);

    undo();
    expect(detail()).toMatchObject({ stats: { likes: 5 }, viewer: { liked: false } });
    expect(feed().pages[1].items[0].quoted).toMatchObject({ stats: { likes: 5 } });
  });

  it('undoes on every copy, including ones cached after the change, and refetches the detail', () => {
    queryClient.setQueryData(queryKeys.post.detail('late'), fixturePost({ id: 'late' }));
    const undo = setViewerState('late', { liked: true });
    // A detail screen seeded from the patched card after the change.
    queryClient.setQueryData(queryKeys.post.thread('late'), {
      focus: queryClient.getQueryData(queryKeys.post.detail('late')),
    });
    undo();
    expect(queryClient.getQueryData<{ focus: PostDTO }>(queryKeys.post.thread('late'))?.focus).toMatchObject({
      stats: { likes: 48 },
      viewer: { liked: false },
    });
    expect(queryClient.getQueryState(queryKeys.post.detail('late'))?.isInvalidated).toBe(true);
  });

  it('changes only the patched marks, and moves counts only where the mark was known', () => {
    const quoted = { ...fixturePost({ id: 'q' }), viewer: undefined };
    const statsEntry = { id: 'q', stats: quoted.stats, viewer: { liked: false } };
    queryClient.setQueryData(queryKeys.post.detail('q'), quoted);
    queryClient.setQueryData(queryKeys.post.stats('q'), statsEntry);
    setViewerState('q', { liked: true });
    // No follow or block state invented, and no count moved without knowing the old mark.
    expect(queryClient.getQueryData(queryKeys.post.detail('q'))).toMatchObject({ stats: { likes: 48 }, viewer: { liked: true } });
    expect((queryClient.getQueryData(queryKeys.post.detail('q')) as PostDTO).viewer).toEqual({ liked: true });
    expect(queryClient.getQueryData(queryKeys.post.stats('q'))).toEqual({
      id: 'q',
      stats: { ...quoted.stats, likes: 49 },
      viewer: { liked: true },
    });
  });

  it('keeps a query fetching underneath a patch successful (the cancelled fetch reverts, then the patch applies)', async () => {
    queryClient.setQueryData(queryKeys.post.detail('busy'), fixturePost({ id: 'busy' }));
    let finish: (post: PostDTO) => void = () => undefined;
    const fetching = queryClient
      .fetchQuery({
        queryKey: queryKeys.post.detail('busy'),
        queryFn: () => new Promise<PostDTO>((resolve) => (finish = resolve)),
        staleTime: 0,
      })
      .catch(() => undefined);
    setViewerState('busy', { liked: true });
    finish(fixturePost({ id: 'busy' }));
    await fetching;
    const state = queryClient.getQueryState(queryKeys.post.detail('busy'));
    expect(state?.status).toBe('success');
    expect(state?.fetchStatus).toBe('idle');
    expect(queryClient.getQueryData(queryKeys.post.detail('busy'))).toMatchObject({ viewer: { liked: true } });
  });

  it('keeps a query stale: an optimistic change is not fresh data', () => {
    queryClient.setQueryData(queryKeys.post.detail('target'), target, { updatedAt: 1000 });
    setViewerState('target', { liked: true });
    expect(queryClient.getQueryState(queryKeys.post.detail('target'))?.dataUpdatedAt).toBe(1000);
  });

  it('leaves a copy already in that state alone', () => {
    queryClient.setQueryData(queryKeys.post.detail('liked'), POSTS.liked);
    setViewerState(POSTS.liked.id, { liked: true });
    expect(queryClient.getQueryData(queryKeys.post.detail('liked'))).toBe(POSTS.liked);
  });

  it('restores the v10 quote slot on undo', () => {
    // v10 reads the slot's bare repost back among the quotes: it has no repost documents.
    const reposted = fixturePost({
      id: 'r',
      stats: { likes: 0, reposts: 0, replies: 0, quotes: 3 },
      viewer: { ...target.viewer!, reposted: true, ownQuoteId: 'q1', ownQuoteBare: true },
    });
    queryClient.setQueryData(queryKeys.post.detail('r'), reposted);
    const undo = setViewerState('r', { reposted: false, ownQuoteId: null, ownQuoteBare: false });
    expect(queryClient.getQueryData(queryKeys.post.detail('r'))).toMatchObject({
      stats: { reposts: 0, quotes: 2 },
      viewer: { reposted: false, ownQuoteId: null, ownQuoteBare: false },
    });
    undo();
    expect(queryClient.getQueryData(queryKeys.post.detail('r'))).toMatchObject({
      stats: { reposts: 0, quotes: 3 },
      viewer: { reposted: true, ownQuoteId: 'q1', ownQuoteBare: true },
    });
  });

  it('counts a repost made here in reposts until it is read back (v2, or v10 before a read)', () => {
    queryClient.setQueryData(queryKeys.post.detail('fresh'), fixturePost({ id: 'fresh' }));
    setViewerState('fresh', { reposted: true });
    expect(queryClient.getQueryData(queryKeys.post.detail('fresh'))).toMatchObject({ stats: { reposts: 4, quotes: 0 } });
    setViewerState('fresh', { reposted: false, ownQuoteId: null, ownQuoteBare: false });
    expect(queryClient.getQueryData(queryKeys.post.detail('fresh'))).toMatchObject({ stats: { reposts: 3, quotes: 0 } });
  });

  it('leaves a copy that already read that way alone on undo (D-L3i-002: a stale card gained a repost)', () => {
    const slot = { reposted: true, ownQuoteId: 'q1', ownQuoteBare: false };
    const stats = { likes: 0, reposts: 0, replies: 0, quotes: 1 };
    queryClient.setQueryData(queryKeys.post.detail('t'), fixturePost({ id: 't', stats, viewer: { ...target.viewer!, ...slot } }));
    // The feed's copy predates the quote: not reposted.
    queryClient.setQueryData<InfiniteData<Page<PostDTO>>>(queryKeys.feed.home({ tab: 'forYou' }), {
      pages: [page([fixturePost({ id: 't', stats })])],
      pageParams: [null],
    });
    const undo = setViewerState('t', { reposted: false });
    undo();
    expect(feed().pages[0].items[0]).toMatchObject({ stats: { reposts: 0, quotes: 1 }, viewer: { reposted: false } });
    expect(queryClient.getQueryData(queryKeys.post.detail('t'))).toMatchObject({ stats: { quotes: 1 }, viewer: slot });
  });

  it('puts back the slot a changed copy had, not a stale copy visited first', () => {
    const slot = { reposted: true, ownQuoteId: 'q1', ownQuoteBare: false };
    const stats = { likes: 0, reposts: 0, replies: 0, quotes: 1 };
    // The feed's copy, cached first, predates the quote (made on another device).
    const stale = fixturePost({ id: 't', stats });
    queryClient.setQueryData<InfiniteData<Page<PostDTO>>>(queryKeys.feed.home({ tab: 'forYou' }), {
      pages: [page([stale])],
      pageParams: [null],
    });
    queryClient.setQueryData(queryKeys.post.detail('t'), fixturePost({ id: 't', stats, viewer: { ...target.viewer!, ...slot } }));
    // "Delete your quote", and the delete fails.
    const undo = setViewerState('t', { reposted: false, ownQuoteId: null, ownQuoteBare: false });
    expect(queryClient.getQueryData(queryKeys.post.detail('t'))).toMatchObject({ stats: { reposts: 0, quotes: 0 } });
    undo();
    expect(queryClient.getQueryData(queryKeys.post.detail('t'))).toMatchObject({
      stats: { reposts: 0, quotes: 1 },
      viewer: slot,
    });
    expect(feed().pages[0].items[0]).toBe(stale);
  });

  it('leaves a stale copy alone on undo even in a query it changed', () => {
    const slot = { reposted: true, ownQuoteId: 'q1', ownQuoteBare: false };
    const stats = { likes: 0, reposts: 0, replies: 0, quotes: 1 };
    // The quoted post's own card is stale; the viewer's quote embeds a fresh copy.
    const stale = fixturePost({ id: 't', stats });
    const fresh = fixturePost({ id: 't', stats, viewer: { ...target.viewer!, ...slot } });
    queryClient.setQueryData<InfiniteData<Page<PostDTO>>>(queryKeys.feed.home({ tab: 'forYou' }), {
      pages: [page([stale, fixturePost({ id: 'q1', quoted: fresh, quotedPostId: 't' })])],
      pageParams: [null],
    });
    const undo = setViewerState('t', { reposted: false, ownQuoteId: null, ownQuoteBare: false });
    expect(feed().pages[0].items[1].quoted).toMatchObject({ stats: { quotes: 0 }, viewer: { reposted: false } });
    undo();
    expect(feed().pages[0].items[0]).toBe(stale);
    expect(feed().pages[0].items[1].quoted).toMatchObject({ stats: { quotes: 1 }, viewer: slot });
  });
});

describe('holdOwnQuote', () => {
  it("fills the viewer's v10 slot on every copy of the quoted post, counts untouched", () => {
    seed();
    holdOwnQuote('target', 'my-quote');
    const held = { reposted: true, ownQuoteId: 'my-quote', ownQuoteBare: false };
    expect(detail()).toMatchObject({ stats: target.stats, viewer: held });
    expect(feed().pages[0].items[0]).toMatchObject({ stats: target.stats, viewer: held });
    expect(feed().pages[1].items[0].quoted).toMatchObject({ viewer: held });
    // Already held: nothing rebuilt.
    const before = detail();
    holdOwnQuote('target', 'my-quote');
    expect(detail()).toBe(before);
  });
});

describe('setFollowing', () => {
  it("updates the author's posts, profile and user rows", () => {
    const author = target.author.id;
    const unfollowed = fixturePost({ id: 'u', viewer: { ...target.viewer!, followsAuthor: false } });
    const profile = {
      id: author,
      hasProfile: true,
      stats: { posts: 1, followers: 10, following: 2 },
      viewer: { follows: false, blocks: false, isSelf: false },
    } as Partial<ProfileDTO>;
    const row = { id: author, viewerFollows: false } as Partial<UserSummaryDTO>;
    queryClient.setQueryData(queryKeys.post.detail('u'), unfollowed);
    queryClient.setQueryData(queryKeys.profile.detail(author), profile);
    queryClient.setQueryData(queryKeys.profile.followers('someone'), page([row]));

    const undo = setFollowing(author, true);
    expect(queryClient.getQueryData(queryKeys.post.detail('u'))).toMatchObject({ viewer: { followsAuthor: true } });
    expect(queryClient.getQueryData(queryKeys.profile.detail(author))).toMatchObject({
      viewer: { follows: true },
      stats: { followers: 11 },
    });
    expect(queryClient.getQueryData<Page<UserSummaryDTO>>(queryKeys.profile.followers('someone'))!.items[0]).toMatchObject({
      viewerFollows: true,
    });

    undo();
    expect(queryClient.getQueryData(queryKeys.profile.detail(author))).toMatchObject({ stats: { followers: 10 } });
  });
});

describe('setProfileChange', () => {
  const me = 'me';
  const profile: ProfileDTO = {
    id: me,
    username: 'jana',
    usernames: ['jana'],
    displayName: 'Jana',
    avatar: { uri: null, dicebear: { style: 'thumbs', seed: me } },
    hasProfile: true,
    pronouns: 'she/her',
    stats: { posts: 1, followers: 3, following: 7 },
  };
  const byId = () => queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail(me));
  const byName = () => queryClient.getQueryData<ProfileDTO>(queryKeys.profile.detail('jana'));

  it('edits every cached copy of the profile, not user rows, and the undo puts back what it changed', () => {
    const row = { id: me, displayName: 'Jana' } as Partial<UserSummaryDTO>;
    queryClient.setQueryData(queryKeys.profile.detail(me), profile);
    queryClient.setQueryData(queryKeys.profile.detail('jana'), profile);
    queryClient.setQueryData(queryKeys.profile.followers('someone'), page([row]));

    const undo = setProfileChange(me, { displayName: 'Jana A.', pronouns: undefined, bio: 'Film.' });
    expect(byId()).toMatchObject({ displayName: 'Jana A.', bio: 'Film.' });
    expect(byId()).not.toHaveProperty('pronouns');
    expect(byName()).toMatchObject({ displayName: 'Jana A.' });
    expect(queryClient.getQueryData<Page<UserSummaryDTO>>(queryKeys.profile.followers('someone'))!.items[0]).toBe(row);

    undo();
    expect(byId()).toEqual(profile);
    expect(byName()).toEqual(profile);
    // Marked stale for the next screen that shows it, without a refetch under an open form.
    expect(queryClient.getQueryState(queryKeys.profile.detail(me))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.profile.detail(me))?.fetchStatus).toBe('idle');
  });

  it('leaves a copy read since alone, and undoes one the change was put back on', () => {
    queryClient.setQueryData(queryKeys.profile.detail(me), profile);
    const undo = setProfileChange(me, { displayName: 'Jana A.' });
    // A read from before the write landed over the change, which `reapply` puts back.
    queryClient.setQueryData(queryKeys.profile.detail('jana'), profile);
    applyProfileChange(me, { displayName: 'Jana A.' }, new Set([queryClient.getQueryCache().find({ queryKey: queryKeys.profile.detail('jana') })!.queryHash]));
    expect(byName()?.displayName).toBe('Jana A.');
    // Another device renamed the profile since.
    queryClient.setQueryData(queryKeys.profile.detail(me), { ...profile, displayName: 'J.' });

    undo();
    expect(byName()?.displayName).toBe('Jana');
    expect(byId()?.displayName).toBe('J.');
  });
});

describe('deletes', () => {
  it('hides a post until undone, and marks every copy deleted', () => {
    const undo = hidePost('target');
    expect(useRemovedPosts.getState().ids.has('target')).toBe(true);
    undo();
    expect(useRemovedPosts.getState().ids.has('target')).toBe(false);

    seed();
    markPostDeleted('target');
    expect(detail().deleted).toBe(true);
    expect(feed().pages[1].items[0].quoted?.deleted).toBe(true);
  });

  it('takes a deleted post, and bare reposts of it, out of every cached list but not threads (SR-25)', () => {
    seed();
    const repost = fixturePost({ id: 'repost', author: AUTHORS.carol, bareRepost: true, quoted: target, quotedPostId: 'target' });
    const posts = queryKeys.profile.posts(AUTHORS.carol.id, 'posts');
    queryClient.setQueryData<InfiniteData<Page<PostDTO>>>(posts, { pages: [page([repost, other])], pageParams: [null] });
    const thread = { pages: [{ focus: target, ancestors: [], removedAncestorIds: [], replies: [] }], pageParams: [null] };
    queryClient.setQueryData(queryKeys.post.thread('target'), thread);
    // A notification that shares the post's id (a reply notification is the reply's id) is not a post.
    const notifications = { pages: [page([{ id: 'target', type: 'reply', target: { id: 'target', kind: 'post' } }])], pageParams: [null] };
    queryClient.setQueryData(queryKeys.notifications(), notifications);

    dropFromLists('target');
    expect(queryClient.getQueryData(queryKeys.notifications())).toBe(notifications);
    expect(feed().pages.map((p) => p.items.map((item) => item.id))).toEqual([['other'], ['quoting']]);
    expect(queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(posts)!.pages[0].items.map((item) => item.id)).toEqual(['other']);
    expect(queryClient.getQueryData(queryKeys.post.thread('target'))).toBe(thread);
    expect(detail()).toBe(target);
  });
});

describe('setAuthorBlocked', () => {
  it("marks the author's cached posts and quotes blocked, leaves other authors alone, and undoes (SR-25)", () => {
    seed();
    const carols = fixturePost({ id: 'carols', author: AUTHORS.carol });
    queryClient.setQueryData(queryKeys.post.detail('carols'), carols);
    const undo = setAuthorBlocked(target.author.id, true);

    expect(feed().pages[0].items[0].viewer?.authorBlocked).toBe(true);
    expect(feed().pages[1].items[0].quoted?.viewer?.authorBlocked).toBe(true);
    expect(detail().viewer?.authorBlocked).toBe(true);
    expect(queryClient.getQueryData(queryKeys.post.detail('carols'))).toBe(carols);

    undo();
    expect(feed().pages[0].items[0].viewer?.authorBlocked).toBe(false);
    expect(detail().viewer?.authorBlocked).toBe(false);
  });
});

describe('engine queries', () => {
  it('reads through engine.api under the given key', async () => {
    fakeEngine.method('posts.get').mockResolvedValue(target);
    const { result } = renderHook(
      () => useEngineQuery(queryKeys.post.detail('target'), (api) => api.posts.get('target'), { persist: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBe(target));
    expect(fakeEngine.method('posts.get')).toHaveBeenCalledWith('target');
    expect(queryClient.getQueryCache().find({ queryKey: queryKeys.post.detail('target') })?.meta).toEqual({
      persist: true,
    });
  });

  it('pages by cursor and flattens the pages without repeats', async () => {
    fakeEngine
      .method('feed.home')
      .mockResolvedValueOnce(page([target, other], 'c1'))
      .mockResolvedValueOnce(page([other, quoting]));
    const { result } = renderHook(
      () =>
        useEngineInfiniteQuery(queryKeys.feed.home({ tab: 'forYou' }), (api, cursor) =>
          api.feed.home({ tab: 'forYou', cursor }),
        ),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(fakeEngine.method('feed.home')).toHaveBeenLastCalledWith({ tab: 'forYou', cursor: 'c1' });
    await waitFor(() => expect(result.current.items.map((p) => p.id)).toEqual(['target', 'other', 'quoting']));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('asks for the next page after a refetch in flight, instead of cancelling or dropping it (D-L1a-003)', async () => {
    const read = fakeEngine.method('feed.home');
    read.mockResolvedValueOnce(page([target], 'c1'));
    const { result } = renderHook(
      () =>
        useEngineInfiniteQuery(queryKeys.feed.home({ tab: 'forYou' }), (api, cursor) =>
          api.feed.home({ tab: 'forYou', cursor }),
        ),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    let answer!: (value: Page<PostDTO>) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    read.mockResolvedValueOnce(page([quoting]));
    let refetched!: Promise<unknown>;
    let paged!: Promise<unknown>;
    act(() => {
      refetched = result.current.refetch();
    });
    act(() => {
      paged = result.current.fetchNextPage();
    });
    // Only the refetch is in flight: the page request waits for it.
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      answer(page([other], 'c2'));
      await Promise.all([refetched, paged]);
    });

    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith({ tab: 'forYou', cursor: 'c2' });
    await waitFor(() => expect(result.current.items.map((p) => p.id)).toEqual(['other', 'quoting']));
  });

  it('flattens items without ids as they come', () => {
    const data = { pages: [page([{ n: 1 }]), page([{ n: 1 }])], pageParams: [null, 'x'] };
    expect(flattenPages(data)).toHaveLength(2);
  });

  it('keys feed queries the same with or without the defaults', () => {
    expect(queryKeys.feed.home({ tab: 'forYou' })).toEqual(
      queryKeys.feed.home({ tab: 'forYou', sort: 'recent', window: 'all' }),
    );
    expect(queryKeys.post.thread('a').slice(0, queryKeys.post.detail('a').length)).toEqual(queryKeys.post.detail('a'));
  });
});
