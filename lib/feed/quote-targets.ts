/**
 * What a post quotes, and how often each quote target has been forgotten.
 *
 * Kept free of service imports so callers that only need to recognise a quote
 * target (the ranked hydrated-page cache, the post card) don't pull in the
 * lookup machinery in `resolve-quoted-posts.ts`.
 */

import type { Post } from '@/lib/types';

/** Document type name used by the cross-contract embed that carries a blog quote. */
export const BLOG_POST_EMBED_DOC_TYPE = 'blogPost';

/**
 * The quote target a post references, or null when it references nothing.
 * Exactly one of the three fields is ever set on a document.
 *
 * A TOMBSTONE references nothing, whatever it still stores. On v9 the
 * contract freezes the quote and embed fields as `immutable`, so a tombstone
 * carries its reference forever; `PostCard` short-circuits on `deleted` and
 * never renders a quote, so resolving one would be a batch-pass entry plus a
 * per-card fetch whose result is discarded — pure wasted DAPI traffic on every
 * feed holding a deleted quote post. On v11 the tombstone clears the quote and
 * the embed (`tombstoneIsBlank`), so there is nothing to resolve anyway.
 */
export function quoteTargetOf(post: Post): { id: string; where: 'post' | 'reply' | 'blogPost' } | null {
  if (post.deleted) return null;
  if (post.quotedPostId) return { id: post.quotedPostId, where: 'post' };
  if (post.quotedReplyId) return { id: post.quotedReplyId, where: 'reply' };
  if (post.embedDocType === BLOG_POST_EMBED_DOC_TYPE && post.embedId) {
    return { id: post.embedId, where: 'blogPost' };
  }
  return null;
}

// Bumped per id by `forgetQuotedPosts`. A lookup that started before a forget
// carries the generation it saw at start; if the id's generation has moved on
// by the time the lookup resolves, its result is stale and must not overwrite
// a cache a forget already cleared (or a newer lookup already repopulated).
const quoteGenerations = new Map<string, number>();

/**
 * The current generation of a quote target: bumped every time
 * `forgetQuotedPosts` is given this id. Callers that cache an already hydrated
 * `quotedPost` outside `resolve-quoted-posts`' own cache (the ranked "Top"
 * surfaces' hydrated-page cache in `ranked-likes.ts`) snapshot this at cache
 * time and compare it on a hit, so a forget invalidates their cache too.
 */
export function generationOf(id: string): number {
  return quoteGenerations.get(id) ?? 0;
}

/** Mark this target's earlier lookups and cached copies stale. */
export function bumpGeneration(id: string): void {
  quoteGenerations.set(id, generationOf(id) + 1);
}
