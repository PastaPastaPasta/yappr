/**
 * One place that turns "this card is a reply" into the document it answers.
 *
 * A profile's Replies tab shows replies stripped of their thread, so a card on
 * its own reads as a non-sequitur — the reader needs the post (or reply) it was
 * written under. This resolves that parent in one batch for a whole page of
 * replies, mirroring `attachQuotedPosts`: v3 knows which doctype each parent
 * lives in and asks for it directly, v2 has one polymorphic link and has to
 * probe.
 */

import { logger } from '@/lib/logger';
import type { Post } from '@/lib/types';
import { postService } from '@/lib/services/post-service';
import { hasFlatThreads } from '@/lib/contract-topology';

/** Which doctype a parent id names — `unknown` only on v2's polymorphic field. */
type ParentTarget = { id: string; where: 'post' | 'reply' | 'unknown' };

/**
 * The document a reply is a direct answer to. On v3 that is the reply it nests
 * under, or the thread root when it nests under nothing; on v2 it is the single
 * `parentId`, which may name either doctype.
 */
function parentTargetOf(reply: Post): ParentTarget | null {
  if (hasFlatThreads()) {
    if (reply.replyToReplyId) return { id: reply.replyToReplyId, where: 'reply' };
    if (reply.rootPostId) return { id: reply.rootPostId, where: 'post' };
    return null;
  }
  return reply.parentId ? { id: reply.parentId, where: 'unknown' } : null;
}

/**
 * Resolve the parent of every reply in `replies`, keyed by the reply's own id.
 *
 * Never throws: a failed lookup leaves those cards rendering without their
 * context rather than failing the whole tab.
 */
export async function fetchReplyParents(replies: Post[]): Promise<Map<string, Post>> {
  const parents = new Map<string, Post>();

  const targets: Array<{ replyId: string; target: ParentTarget }> = [];
  replies.forEach((reply) => {
    const target = parentTargetOf(reply);
    if (target) targets.push({ replyId: reply.id, target });
  });
  if (targets.length === 0) return parents;

  try {
    const idsWhere = (where: ParentTarget['where']): string[] =>
      Array.from(new Set(targets.filter((t) => t.target.where === where).map((t) => t.target.id)));

    const resolved = hasFlatThreads()
      ? await postService.fetchQuotedTargets({
          postIds: idsWhere('post'),
          replyIds: idsWhere('reply'),
          blogPostIds: [],
        })
      : await postService.fetchPostsOrReplies(idsWhere('unknown'));

    const byId = new Map(resolved.map((post) => [post.id, post]));
    targets.forEach(({ replyId, target }) => {
      const found = byId.get(target.id);
      if (found) parents.set(replyId, found);
    });
  } catch (error) {
    logger.error('Failed to resolve reply parents:', error);
  }

  return parents;
}
