import type { PostDTO } from '@engine/api';

import { fixturePost } from '~/ui/post/fixtures';

import {
  feedTimestamp,
  keepFirstPage,
  newestTimestamp,
  prependToFirstPage,
  readErrorMessage,
  UNAVAILABLE_MESSAGE,
  type FeedData,
} from './feed-data';

const post = (id: string, minutesAgo = 0, overrides: Partial<PostDTO> = {}) =>
  fixturePost({ id, createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0) - minutesAgo * 60_000), ...overrides }) as PostDTO;

const data = (...pages: PostDTO[][]): FeedData => ({
  pages: pages.map((items, i) => ({ items, cursor: i < pages.length - 1 ? `c${i}` : null, hasMore: true })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${i - 1}`)),
});

describe('feed timestamps', () => {
  it('uses the repost time for a repost', () => {
    const repostAt = new Date(Date.UTC(2026, 9, 2));
    expect(feedTimestamp(post('a', 60, { repostTimestamp: repostAt }))).toBe(repostAt.getTime());
  });

  it('finds the newest, or null for none', () => {
    expect(newestTimestamp([post('a', 5), post('b', 1), post('c', 9)])).toBe(post('b', 1).createdAt.getTime());
    expect(newestTimestamp([])).toBeNull();
  });

  it('skips a post whose time did not parse, so the new-posts check stays on (FEED-05)', () => {
    const unparsed = post('x', 0, { createdAt: new Date('not a date') });
    expect(newestTimestamp([unparsed, post('a', 5)])).toBe(post('a', 5).createdAt.getTime());
    expect(newestTimestamp([unparsed])).toBeNull();
  });
});

describe('prependToFirstPage', () => {
  it('puts new posts on top of the first page, skipping ones already cached', () => {
    const cached = data([post('b'), post('c')], [post('d')]);
    const next = prependToFirstPage(cached, [post('a'), post('d')]);
    expect(next?.pages[0]?.items.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(next?.pages[1]).toBe(cached.pages[1]);
    expect(next?.pageParams).toBe(cached.pageParams);
  });

  it('leaves the data alone when there is nothing new or no feed yet', () => {
    const cached = data([post('a')]);
    expect(prependToFirstPage(cached, [post('a')])).toBe(cached);
    expect(prependToFirstPage(cached, [])).toBe(cached);
    expect(prependToFirstPage(undefined, [post('a')])).toBeUndefined();
  });
});

describe('keepFirstPage', () => {
  it('drops every page after the first, with their cursors', () => {
    const next = keepFirstPage(data([post('a')], [post('b')], [post('c')]));
    expect(next?.pages.map((p) => p.items.map((i) => i.id))).toEqual([['a']]);
    expect(next?.pageParams).toEqual([null]);
  });

  it('returns a single page as is', () => {
    const one = data([post('a')]);
    expect(keepFirstPage(one)).toBe(one);
    expect(keepFirstPage(undefined)).toBeUndefined();
  });
});

describe('readErrorMessage', () => {
  const coded = (code: string) => Object.assign(new Error('boom'), { code });

  it('maps engine and transport codes to the web copy', () => {
    expect(readErrorMessage(coded('ENGINE_UNAVAILABLE'))).toBe(UNAVAILABLE_MESSAGE);
    expect(readErrorMessage(coded('RPC_TIMEOUT'))).toBe(UNAVAILABLE_MESSAGE);
    expect(readErrorMessage(coded('NETWORK'))).toMatch(/^Network error/);
    expect(readErrorMessage(coded('NOT_SIGNED_IN'))).toMatch(/sign in again/);
  });

  it('has nothing specific to say otherwise', () => {
    expect(readErrorMessage(coded('BAD_CURSOR'))).toBeUndefined();
    expect(readErrorMessage(new Error('boom'))).toBeUndefined();
    expect(readErrorMessage(null)).toBeUndefined();
  });

  it('reads an uncoded failure on the way to Dash Platform as unavailable (G-11)', () => {
    expect(readErrorMessage(new Error('Failed to prefetch quorums: HTTP request error: error sending request'))).toBe(
      UNAVAILABLE_MESSAGE,
    );
  });

  it('says network error while offline, unless the session is gone (G-1, G-11)', () => {
    expect(readErrorMessage(new Error('boom'), { offline: true })).toMatch(/^Network error/);
    expect(readErrorMessage(coded('ENGINE_UNAVAILABLE'), { offline: true })).toMatch(/^Network error/);
    expect(readErrorMessage(coded('NOT_SIGNED_IN'), { offline: true })).toMatch(/sign in again/);
  });
});
