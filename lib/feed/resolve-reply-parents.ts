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
 * Replies whose parent cannot be found are simply absent from the result. A
 * failed lookup rejects; the caller logs it and leaves those cards rendering
 * without their context rather than failing the whole tab.
 */
export async function fetchReplyParents(replies: Post[]): Promise<Map<string, Post>> {
  const parents = new Map<string, Post>();

  const parentIdByReply = new Map<string, string>();
  const ids: Record<ParentTarget['where'], Set<string>> = {
    post: new Set(),
    reply: new Set(),
    unknown: new Set(),
  };

  replies.forEach((reply) => {
    const target = parentTargetOf(reply);
    if (!target) return;
    parentIdByReply.set(reply.id, target.id);
    ids[target.where].add(target.id);
  });
  if (parentIdByReply.size === 0) return parents;

  const resolved = hasFlatThreads()
    ? await postService.fetchQuotedTargets({
        postIds: Array.from(ids.post),
        replyIds: Array.from(ids.reply),
        blogPostIds: [],
      })
    : await postService.fetchPostsOrReplies(Array.from(ids.unknown));

  const byId = new Map(resolved.map((post) => [post.id, post]));
  parentIdByReply.forEach((parentId, replyId) => {
    const found = byId.get(parentId);
    if (found) parents.set(replyId, found);
  });

  return parents;
}
