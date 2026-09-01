/**
 * One place that turns "this post references something" into a populated
 * `post.quotedPost`.
 *
 * There used to be seven copies of this loop (both feed loaders, the homepage
 * hook, the profile page's initial and paged loads, and the post-detail hook's
 * chain and main-post paths), each collecting `quotedPostId`s and calling
 * `fetchPostsOrReplies`. The v3 topology splits the single quote field in three —
 * `quotedPostId` for posts, `quotedReplyId` for replies, and the embed triple for
 * anything on another contract — so all seven would have had to learn the same
 * dispatch. They call this instead.
 *
 * v2 behaviour is unchanged: the same ids go to the same cascading lookup.
 */

import { logger } from '@/lib/logger';
import type { Post } from '@/lib/types';
import { postService } from '@/lib/services/post-service';
import { quoteFieldsAreSplit, quoteFieldFor, targetKindOf } from '@/lib/contract-topology';
import { YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants';
import type { PostEmbed } from '@/lib/poll-embed';

/** Document type name used by the cross-contract embed that carries a blog quote. */
export const BLOG_POST_EMBED_DOC_TYPE = 'blogPost';

/** The write-side counterpart of `quoteTargetOf`: where a new quote's reference goes. */
export interface QuoteReference {
  /** Contract properties to set on the new post. */
  fields: { quotedPostId?: string; quotedReplyId?: string; quotedPostOwnerId?: string };
  /** Set instead of `fields` when the target lives on another contract. */
  embed?: PostEmbed;
}

/**
 * Decide which reference field a new quote post should carry.
 *
 * On v2 everything goes in the single polymorphic `quotedPostId` — including blog
 * posts, which live on a different contract entirely. On v3 that field is
 * `refersTo`-checked against `post`, so a reply id moves to `quotedReplyId` and a
 * blog post to the embed triple (the only reference kind allowed to point off the
 * social contract).
 */
export function resolveQuoteReference(quotingPost: Post | null | undefined): QuoteReference {
  if (!quotingPost) return { fields: {} };

  if (quotingPost.__isBlogPostQuote) {
    return quoteFieldsAreSplit()
      ? {
          fields: {},
          embed: {
            contractId: YAPPR_BLOG_CONTRACT_ID,
            docType: BLOG_POST_EMBED_DOC_TYPE,
            id: quotingPost.id,
          },
        }
      : { fields: { quotedPostId: quotingPost.id, quotedPostOwnerId: quotingPost.author.id } };
  }

  const field = quoteFieldFor(targetKindOf(quotingPost));
  if (!field) return { fields: {} };

  return {
    fields: {
      [field]: quotingPost.id,
      // Kept on both topologies for the "quotes of my posts" notification index.
      quotedPostOwnerId: quotingPost.author.id,
    },
  };
}

/**
 * The quote target a post references, or null when it references nothing.
 * Exactly one of the three fields is ever set on a document.
 */
export function quoteTargetOf(post: Post): { id: string; where: 'post' | 'reply' | 'blogPost' } | null {
  if (post.quotedPostId) return { id: post.quotedPostId, where: 'post' };
  if (post.quotedReplyId) return { id: post.quotedReplyId, where: 'reply' };
  if (post.embedDocType === BLOG_POST_EMBED_DOC_TYPE && post.embedId) {
    return { id: post.embedId, where: 'blogPost' };
  }
  return null;
}

/** True when this post references a quote target that has not been resolved yet. */
function needsQuoteResolution(post: Post): boolean {
  return !post.quotedPost && quoteTargetOf(post) !== null;
}

// Shared between the batch pass and the per-card fallback so the two paths
// never fetch the same target twice: successes land in the cache, and every
// lookup in flight — batch or single — is joinable by target id.
const resolvedQuoteCache = new Map<string, Post>();
const pendingQuoteResolutions = new Map<string, Promise<Post | null>>();

/** One network pass over the given posts' targets, per topology. */
function fetchQuoteTargets(pending: Post[]): Promise<Post[]> {
  return quoteFieldsAreSplit() ? resolveByField(pending) : resolveByProbe(pending);
}

/** Cache peek for the per-card fallback's synchronous fast path. */
export function getCachedQuotedPost(targetId: string): Post | null {
  return resolvedQuoteCache.get(targetId) ?? null;
}

/**
 * Populate `quotedPost` on every post in `posts` that references one.
 *
 * Mutates in place (every existing call site did) and never throws: a failed
 * quote lookup leaves the referencing post rendering without its embed rather
 * than failing the whole feed load. Targets already cached or in flight are
 * reused instead of refetched.
 */
export async function attachQuotedPosts(posts: Post[]): Promise<void> {
  const pending = posts.filter(needsQuoteResolution);
  if (pending.length === 0) return;

  try {
    const stillNeeded: Post[] = [];
    const joins: Promise<void>[] = [];

    for (const post of pending) {
      const target = quoteTargetOf(post);
      if (!target) continue;

      const cached = resolvedQuoteCache.get(target.id);
      if (cached) {
        post.quotedPost = cached;
        continue;
      }

      const inflight = pendingQuoteResolutions.get(target.id);
      if (inflight) {
        joins.push(
          inflight
            .then((found) => { if (found) post.quotedPost = found; })
            .catch(() => { /* the owning lookup already logged it */ })
        );
        continue;
      }

      stillNeeded.push(post);
    }

    if (stillNeeded.length > 0) {
      const batch = fetchQuoteTargets(stillNeeded)
        .then((resolved) => new Map(resolved.map((target) => [target.id, target])));

      // Register every target of this batch so concurrent passes (another
      // surface, or a card's fallback fetch) join it instead of refetching.
      const ids = Array.from(new Set(
        stillNeeded
          .map((post) => quoteTargetOf(post)?.id)
          .filter((id): id is string => id !== undefined)
      ));
      for (const id of ids) {
        // Failures resolve to null (never reject): a joiner treats that as a
        // miss, and an unjoined entry can't become an unhandled rejection.
        pendingQuoteResolutions.set(
          id,
          batch.then((byId) => byId.get(id) ?? null).catch(() => null)
        );
      }

      try {
        const byId = await batch;
        for (const post of stillNeeded) {
          const target = quoteTargetOf(post);
          const found = target ? byId.get(target.id) : undefined;
          if (found) {
            post.quotedPost = found;
            resolvedQuoteCache.set(found.id, found);
          }
        }
      } finally {
        for (const id of ids) pendingQuoteResolutions.delete(id);
      }
    }

    await Promise.all(joins);
  } catch (error) {
    logger.error('Failed to resolve quoted posts:', error);
  }
}

/**
 * Resolve a single post's quote target on demand — the per-card fallback for
 * quotes the batch pass missed (a surface that never called
 * `attachQuotedPosts`, or a transient DAPI failure on a flaky gateway).
 *
 * Successes are cached and concurrent lookups deduped; a first miss is retried
 * once after a short delay (DAPI gateways time out routinely — see CLAUDE.md).
 * Misses are NOT cached, because a swallowed network error is
 * indistinguishable from genuine absence here, and caching it would pin the
 * failure for the whole session.
 */
export async function resolveQuotedPost(post: Post): Promise<Post | null> {
  const target = quoteTargetOf(post);
  if (!target) return null;
  if (post.quotedPost) return post.quotedPost;

  const cached = resolvedQuoteCache.get(target.id);
  if (cached) return cached;

  const pending = pendingQuoteResolutions.get(target.id);
  if (pending) return pending;

  const request = (async () => {
    try {
      // A shallow probe keeps the caller's (React state) object unmutated.
      const probe: Post = { ...post, quotedPost: undefined };

      const attempt = async (): Promise<Post | null> => {
        const resolved = await fetchQuoteTargets([probe]);
        return resolved.find((candidate) => candidate.id === target.id) ?? null;
      };

      let found: Post | null = null;
      try {
        found = await attempt();
      } catch (error) {
        logger.error('resolveQuotedPost: first attempt failed:', error);
      }
      if (!found) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        found = await attempt();
      }

      if (found) resolvedQuoteCache.set(target.id, found);
      return found;
    } finally {
      pendingQuoteResolutions.delete(target.id);
    }
  })();

  pendingQuoteResolutions.set(target.id, request);
  return request;
}

/**
 * v2: one polymorphic field, so the id could name a post, a reply or a blog post
 * and every miss has to be retried against the next doctype.
 */
async function resolveByProbe(pending: Post[]): Promise<Post[]> {
  const ids = new Set(pending.flatMap((post) => (post.quotedPostId ? [post.quotedPostId] : [])));
  return postService.fetchPostsOrReplies(Array.from(ids));
}

/** v3: each field names exactly one doctype, so nothing is probed. */
async function resolveByField(pending: Post[]): Promise<Post[]> {
  const postIds = new Set<string>();
  const replyIds = new Set<string>();
  const blogPostIds = new Set<string>();

  for (const post of pending) {
    const target = quoteTargetOf(post);
    if (!target) continue;
    if (target.where === 'post') postIds.add(target.id);
    else if (target.where === 'reply') replyIds.add(target.id);
    else blogPostIds.add(target.id);
  }

  return postService.fetchQuotedTargets({
    postIds: Array.from(postIds),
    replyIds: Array.from(replyIds),
    blogPostIds: Array.from(blogPostIds),
  });
}
