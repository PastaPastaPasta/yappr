import type { Page, PostDTO, ProfileDTO, UserSummaryDTO } from '@engine/api';
import { QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { queryClient } from '~/state/query-client';
import { POSTS, fixturePost } from '~/ui/post/fixtures';

import { queryKeys } from './keys';
import { hidePost, markPostDeleted, setFollowing, setViewerState, useRemovedPosts } from './optimistic';
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
  queryClient.setQueryData(queryKeys.post.stats('target'), { id: 'target', stats: target.stats });
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

  it('undoes only the copies it changed', () => {
    const stale = fixturePost({ id: 'both' });
    const fresh = fixturePost({ id: 'both', stats: { ...stale.stats, likes: 49 }, viewer: { ...stale.viewer!, liked: true } });
    queryClient.setQueryData(queryKeys.feed.home({ tab: 'forYou' }), { pages: [page([stale])], pageParams: [null] });
    queryClient.setQueryData(queryKeys.post.detail('both'), fresh);
    const undo = setViewerState('both', { liked: true });
    expect(queryClient.getQueryData(queryKeys.post.detail('both'))).toBe(fresh);
    undo();
    expect(queryClient.getQueryData(queryKeys.post.detail('both'))).toBe(fresh);
    expect(feed().pages[0].items[0]).toMatchObject({ stats: { likes: 48 }, viewer: { liked: false } });
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
    const reposted = fixturePost({ id: 'r', viewer: { ...target.viewer!, reposted: true, ownQuoteId: 'q1' } });
    queryClient.setQueryData(queryKeys.post.detail('r'), reposted);
    const undo = setViewerState('r', { reposted: false, ownQuoteId: null });
    expect(queryClient.getQueryData(queryKeys.post.detail('r'))).toMatchObject({
      stats: { reposts: 2 },
      viewer: { reposted: false, ownQuoteId: null },
    });
    undo();
    expect(queryClient.getQueryData(queryKeys.post.detail('r'))).toMatchObject({
      stats: { reposts: 3 },
      viewer: { reposted: true, ownQuoteId: 'q1' },
    });
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
