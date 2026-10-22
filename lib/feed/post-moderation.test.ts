import { afterEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import type { Post } from '@/lib/types';
import { isHiddenItem, isQuoteHidden, markQuoteHidden, postModerationOf, withoutHiddenItems } from './post-moderation';
import { transformRawPost } from './transform-raw-post';

afterEach(() => vi.unstubAllEnvs());

const MODERATOR = bs58.encode(new Uint8Array(32).fill(7));
const stored = { $id: 'post00001', $ownerId: bs58.encode(new Uint8Array(32).fill(9)), $createdAt: 1000, content: 'hello' };

describe('postModerationOf', () => {
  it('is undefined for a listed post', () => {
    expect(postModerationOf({ ...stored, live: 1 })).toBeUndefined();
    expect(transformRawPost({ ...stored, live: 1 }).moderation).toBeUndefined();
  });

  it('carries the marks of a hidden post', () => {
    expect(postModerationOf({ ...stored, live: 1, mod: 1, modLabel: 12, $moderatedBy: MODERATOR, $moderatedAt: 1_700_000_000_000 })).toEqual({
      mod: 1, modLabel: 12, moderatedBy: MODERATOR, moderatedAt: 1_700_000_000_000,
    });
  });

  it('reads the moderator as an identifier whether it arrives as base58 or as bytes', () => {
    expect(postModerationOf({ ...stored, mod: 1, $moderatedBy: bs58.decode(MODERATOR) })?.moderatedBy).toBe(MODERATOR);
    expect(postModerationOf({ ...stored, mod: 1, $moderatedBy: MODERATOR })?.moderatedBy).toBe(MODERATOR);
  });

  it('marks a post written while its author was restricted (live 2)', () => {
    expect(postModerationOf({ ...stored, live: 2 })).toEqual({ restricted: true });
    expect(postModerationOf({ ...stored, live: 2, mod: 2, modLabel: 3 })).toEqual({ mod: 2, modLabel: 3, restricted: true });
  });

  it('reads a document nested under `data` too', () => {
    const doc = { $id: 'post00002', $moderatedAt: 5, data: { content: 'x', live: 2, mod: 1 } };
    expect(postModerationOf(doc, doc.data)).toEqual({ mod: 1, moderatedAt: 5, restricted: true });
  });

  it('keeps what an already-built post carries', () => {
    const carried = { mod: 1, restricted: true };
    expect(postModerationOf({ ...stored, moderation: carried })).toBe(carried);
    expect(transformRawPost({ ...stored, moderation: carried }).moderation).toBe(carried);
  });
});

describe('transformRawPost', () => {
  it('sets post.moderation from the stored document', () => {
    const post = transformRawPost({ ...stored, live: 2, mod: 1, modLabel: 4, $moderatedBy: bs58.decode(MODERATOR), $moderatedAt: 99 });
    expect(post.moderation).toEqual({ mod: 1, modLabel: 4, moderatedBy: MODERATOR, moderatedAt: 99, restricted: true });
    expect(post.content).toBe('hello');
  });

  it('leaves the key off a post nothing applies to', () => {
    expect('moderation' in transformRawPost({ ...stored, live: 1 })).toBe(false);
  });
});

const card = (id: string, moderation?: Post['moderation']): Post => ({
  id, targetKind: 'post', content: id, createdAt: new Date(0),
  author: { id: 'a', username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) },
  likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0,
  ...(moderation ? { moderation } : {}),
});

describe('hidden items', () => {
  it('drops hidden posts and keeps the rest in order', () => {
    const posts = [card('a'), card('b', { mod: 1 }), card('c', { restricted: true }), card('d', { mod: 2, modLabel: 1 })];
    expect(withoutHiddenItems(posts).map((post) => post.id)).toEqual(['a', 'c']);
  });

  it('keeps everything on an archival build', () => {
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all');
    const posts = [card('a'), card('b', { mod: 1 })];
    expect(withoutHiddenItems(posts)).toHaveLength(2);
    expect(isHiddenItem(posts[1])).toBe(false);
  });

  it('never drops an object that carries no marks at all', () => {
    expect(isHiddenItem({})).toBe(false);
    expect(isHiddenItem(null)).toBe(false);
    expect(isHiddenItem({ moderation: null })).toBe(false);
  });
});

describe('a quote of a hidden post', () => {
  it('reads as an unavailable quote, with no text and no fetch', () => {
    const quoting: Post = { ...card('q'), quotedPostId: 'target', quotedPost: card('target', { mod: 1 }) };
    markQuoteHidden(quoting);
    expect(quoting.quotedPost).toBeUndefined();
    expect(quoting.quotedPostRemoved).toBe(true);
    expect(isQuoteHidden(quoting)).toBe(true);
    expect(isQuoteHidden(card('plain'))).toBe(false);
  });
});
