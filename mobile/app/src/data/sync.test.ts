import type { Page, PostDTO } from '@engine/api';
import { InfiniteQueryObserver, type InfiniteData } from '@tanstack/react-query';

import { engine } from '~/engine';
import { queryClient } from '~/state/query-client';
import { fixturePost } from '~/ui/post/fixtures';

import { queryKeys } from './keys';
import { startDataLayer } from './sync';
import { fakeEngine } from './testing/fake-engine';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

const page = (items: PostDTO[], cursor: string | null = null): Page<PostDTO> => ({ items, cursor, hasMore: cursor !== null });

const recent = queryKeys.feed.home({ tab: 'forYou' });
const following = queryKeys.feed.home({ tab: 'following' });
const top = queryKeys.feed.home({ tab: 'forYou', sort: 'top', window: 'today' });
const tag = queryKeys.feed.hashtag({ tag: 'dash' });

const older = fixturePost({ id: 'older' });
const oldest = fixturePost({ id: 'oldest' });
const mine = fixturePost({ id: 'mine', author: { ...older.author, id: 'me' } });

const feed = (key: readonly unknown[]) => queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(key);

function seed(key: readonly unknown[]) {
  queryClient.setQueryData<InfiniteData<Page<PostDTO>>>(key, {
    pages: [page([older], 'c1'), page([oldest])],
    pageParams: [null, 'c1'],
  });
}

let stop: () => void = () => undefined;

beforeEach(() => {
  queryClient.clear();
  fakeEngine.reset();
  stop = startDataLayer();
});

afterEach(() => stop());
afterAll(() => queryClient.clear());

describe('content.created', () => {
  it('puts a new post on top of the Recent home feeds and marks feeds stale without re-reading their pages', () => {
    for (const key of [recent, following, top, tag]) seed(key);
    // A mounted feed: an invalidation that refetches would re-read both of its pages now.
    const observer = new InfiniteQueryObserver<Page<PostDTO>, Error, InfiniteData<Page<PostDTO>>, readonly unknown[], string | null>(queryClient, {
      queryKey: recent,
      queryFn: ({ pageParam }) => engine.api.feed.home({ tab: 'forYou', cursor: pageParam }),
      initialPageParam: null,
      getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    fakeEngine.emit('content.created', { kind: 'post', id: mine.id, confirmed: false, post: mine });
    unsubscribe();

    for (const key of [recent, following]) {
      expect(feed(key)?.pages.map((p) => p.items.map((item) => item.id))).toEqual([['mine', 'older'], ['oldest']]);
      expect(feed(key)?.pageParams).toEqual([null, 'c1']);
    }
    // A ranking and a tag feed are left as they are.
    expect(feed(top)?.pages[0].items.map((item) => item.id)).toEqual(['older']);
    expect(feed(tag)?.pages[0].items.map((item) => item.id)).toEqual(['older']);
    for (const key of [recent, following, top, tag]) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    // Nothing is re-read: no page of any feed.
    expect(fakeEngine.method('feed.home')).not.toHaveBeenCalled();
    expect(fakeEngine.method('feed.hashtag')).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.post.detail('mine'))).toBe(mine);
  });

  it('replaces a copy a feed already holds instead of adding a second', () => {
    seed(recent);
    fakeEngine.emit('content.created', { kind: 'post', id: older.id, confirmed: true, post: { ...older, content: 'confirmed copy' } });
    expect(feed(recent)?.pages.map((p) => p.items.map((item) => [item.id, item.content]))).toEqual([
      [['older', 'confirmed copy']],
      [['oldest', oldest.content]],
    ]);
  });

  it('does not put a reply in the home feeds', () => {
    seed(recent);
    const reply = fixturePost({ id: 'reply', kind: 'reply', parentId: 'older', rootPostId: 'older' });
    fakeEngine.emit('content.created', { kind: 'reply', id: reply.id, confirmed: true, post: reply });
    expect(feed(recent)?.pages[0].items.map((item) => item.id)).toEqual(['older']);
  });
});
