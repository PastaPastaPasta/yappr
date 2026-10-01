/**
 * One place that turns "this card is a reply" into the document it answers.
 *
 * A profile's Replies tab shows replies stripped of their thread, so a card on
 * its own reads as a non-sequitur — the reader needs the post (or reply) it was
 * written under. This resolves that parent in one batch for a whole page of
 * replies, mirroring `attachQuotedPosts`: v9 knows which doctype each parent
 * lives in and asks for it directly, v2 has one polymorphic link and has to
 * probe.
 */

import type { Post } from '@/lib/types';
import { postService } from '@/lib/services/post-service';
import { hasFlatThreads, repliesOutliveTheirParent, type TargetKind } from '@/lib/contract-topology';
import { provenAbsent } from './prove-absent';

/** Which doctype a parent id names — `unknown` only on v2's polymorphic field. */
type ParentTarget = { id: string; where: 'post' | 'reply' | 'unknown' };

/** A parent the chain proved absent: deleted by its author (v10) or removed by the moderators (v10, v11). */
export interface MissingReplyParent {
  id: string;
  kind: TargetKind;
}

export interface ReplyParents {
  /** The resolved parent of each reply, keyed by the reply's own id. */
  parents: Map<string, Post>;
  /**
   * Parents proved absent, keyed by the reply's own id. Only where a reply
   * outlives its parent (`repliesOutliveTheirParent()`: v10, where the hole is
   * an author's delete or a moderator removal, and v11, where it is a
   * moderator removal); always empty on v2 and v9.
   */
  missing: Map<string, MissingReplyParent>;
}

/**
 * The document a reply is a direct answer to. On v9 that is the reply it nests
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
 * Resolve the parent of every reply in `replies`.
 *
 * A parent that cannot be found is absent from `parents`; where replies can
 * outlive their parents and the absence is proved, it is listed in `missing`
 * so the card can say the parent was deleted instead of silently losing its
 * context. A failed lookup rejects; the caller logs it and leaves those cards
 * rendering without their context rather than failing the whole tab.
 */
export async function fetchReplyParents(replies: Post[]): Promise<ReplyParents> {
  const parents = new Map<string, Post>();
  const missing = new Map<string, MissingReplyParent>();

  const targetByReply = new Map<string, ParentTarget>();
  const ids: Record<ParentTarget['where'], Set<string>> = {
    post: new Set(),
    reply: new Set(),
    unknown: new Set(),
  };

  replies.forEach((reply) => {
    const target = parentTargetOf(reply);
    if (!target) return;
    targetByReply.set(reply.id, target);
    ids[target.where].add(target.id);
  });
  if (targetByReply.size === 0) return { parents, missing };

  const resolved = hasFlatThreads()
    ? await postService.fetchQuotedTargets({
        postIds: Array.from(ids.post),
        replyIds: Array.from(ids.reply),
        blogPostIds: [],
      })
    : await postService.fetchPostsOrReplies(Array.from(ids.unknown));

  const byId = new Map(resolved.map((post) => [post.id, post]));
  targetByReply.forEach((target, replyId) => {
    const found = byId.get(target.id);
    if (found) parents.set(replyId, found);
  });

  if (repliesOutliveTheirParent()) {
    const unresolved = (where: TargetKind) => Array.from(ids[where]).filter((id) => !byId.has(id));
    const [absentPosts, absentReplies] = await Promise.all([
      provenAbsent('post', unresolved('post')),
      provenAbsent('reply', unresolved('reply')),
    ]);
    targetByReply.forEach((target, replyId) => {
      if (target.where === 'post' && absentPosts.has(target.id)) missing.set(replyId, { id: target.id, kind: 'post' });
      if (target.where === 'reply' && absentReplies.has(target.id)) missing.set(replyId, { id: target.id, kind: 'reply' });
    });
  }

  return { parents, missing };
}
