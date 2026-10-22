import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blogAuthorsCanBeRestricted, blogListedLivePin, blogLiveValue, blogModPin, lanePinOrderBy,
} from '../constants';
import { carryModerationIntoReplace, isDropped, moderationFieldOf, withoutHidden } from './moderation-carry';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the blog and storefront lane pins', () => {
  it.each(['v1', 'v8'] as const)('are empty before the new cuts (blog %s)', (topology) => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', topology);
    expect(blogListedLivePin()).toEqual([]);
    expect(blogModPin()).toEqual([]);
    expect(blogLiveValue(true)).toBeUndefined();
  });

  it('pin live == true on v9, byte-identical to before', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v9');
    expect(blogListedLivePin()).toEqual([['live', '==', true]]);
    expect(blogModPin()).toEqual([]);
    expect(blogLiveValue(false)).toBe(true);
    expect(blogLiveValue(true)).toBe(true);
    expect(blogAuthorsCanBeRestricted()).toBe(false);
  });

  it('pin live == 1 then mod == null on v10, and write the 1 / 2 lane', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v10');
    expect(blogListedLivePin()).toEqual([['live', '==', 1]]);
    expect(blogModPin()).toEqual([['mod', '==', null]]);
    expect(blogLiveValue(false)).toBe(1);
    expect(blogLiveValue(true)).toBe(2);
  });

  it('turns pins into the contiguous ascending orderBy the index needs', () => {
    expect(lanePinOrderBy([['live', '==', 1], ['mod', '==', null]])).toEqual([['live', 'asc'], ['mod', 'asc']]);
    expect(lanePinOrderBy([])).toEqual([]);
  });
});

describe('moderator marks carried by a service', () => {
  it('reads the marks off a raw document, and nothing off a listed one', () => {
    expect(moderationFieldOf({ $id: 'a', mod: 1, modLabel: 4, $moderatedBy: 'mod', $moderatedAt: 12 }))
      .toEqual({ moderation: { mod: 1, modLabel: 4, moderatedBy: 'mod', moderatedAt: 12 } });
    expect(moderationFieldOf({ $id: 'a', data: { mod: 2 } })).toEqual({ moderation: { mod: 2 } });
    expect(moderationFieldOf({ $id: 'a' })).toEqual({});
  });

  it('sends mod and modLabel back unchanged on a replace, and never the UI-only moderation object', () => {
    const fields: Record<string, unknown> = { title: 'T', moderation: { mod: 1 } };
    carryModerationIntoReplace(fields, { moderation: { mod: 1, modLabel: 9, moderatedBy: 'x', moderatedAt: 3 } });
    expect(fields).toEqual({ title: 'T', mod: 1, modLabel: 9 });
    const listed: Record<string, unknown> = { title: 'T' };
    carryModerationIntoReplace(listed, {});
    expect(listed).toEqual({ title: 'T' });
  });

  it('drops hidden documents from a public list, and keeps them on an archival build', () => {
    const listed = { id: 'a' };
    const hidden = { id: 'b', moderation: { mod: 1 } };
    const held = { id: 'c', moderation: { mod: 2 } };
    expect(withoutHidden([listed, hidden, held])).toEqual([listed]);
    expect(isDropped(hidden)).toBe(true);
    expect(isDropped(listed)).toBe(false);
    expect(isDropped(null)).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all');
    expect(withoutHidden([listed, hidden, held])).toEqual([listed, hidden, held]);
    expect(isDropped(hidden)).toBe(false);
  });
});
