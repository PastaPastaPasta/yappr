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
function quoteTargetOf(post: Post): { id: string; where: 'post' | 'reply' | 'blogPost' } | null {
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

/**
 * Populate `quotedPost` on every post in `posts` that references one.
 *
 * Mutates in place (every existing call site did) and never throws: a failed
 * quote lookup leaves the referencing post rendering without its embed rather
 * than failing the whole feed load.
 */
export async function attachQuotedPosts(posts: Post[]): Promise<void> {
  const pending = posts.filter(needsQuoteResolution);
  if (pending.length === 0) return;

  try {
    const resolved = quoteFieldsAreSplit()
      ? await resolveByField(pending)
      : await resolveByProbe(pending);

    const byId = new Map(resolved.map((target) => [target.id, target]));
    for (const post of pending) {
      const target = quoteTargetOf(post);
      const found = target ? byId.get(target.id) : undefined;
      if (found) post.quotedPost = found;
    }
  } catch (error) {
    logger.error('Failed to resolve quoted posts:', error);
  }
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
