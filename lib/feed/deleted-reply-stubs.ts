import type { Reply } from '@/lib/types';

/**
 * The reply ids a flat thread's replies nest under (`replyToReplyId`) that are
 * not among the loaded replies. Where a reply outlives its parent (v10: an
 * author's delete or a moderator removal; v11: a moderator removal), these are
 * the candidates for a gone parent; the caller proves the absence before
 * stubbing any of them.
 */
export function unloadedReplyParents(replies: readonly Reply[]): string[] {
  const loaded = new Set(replies.map((reply) => reply.id));
  const missing = new Set<string>();
  for (const reply of replies) {
    if (reply.replyToReplyId && !loaded.has(reply.replyToReplyId)) missing.add(reply.replyToReplyId);
  }
  return Array.from(missing);
}

/**
 * Stand-ins for replies proved gone (deleted by their author on v10, removed
 * by the moderators on v10 and v11), so the replies nested under them keep
 * their place instead of dropping out of the thread with their parent. The
 * stub resolves who made the hole itself (`RemovedPostStub`).
 *
 * The deleted document is gone, and with it whatever it nested under, so a
 * stub sits at the top of the thread. It takes the earliest child's timestamp,
 * which keeps it in the same spot of the chronological thread order. Replies
 * already in `replies` (including earlier stubs) are never duplicated.
 */
export function deletedReplyStubs(replies: readonly Reply[], deletedIds: ReadonlySet<string>): Reply[] {
  const loaded = new Set(replies.map((reply) => reply.id));
  const stubs = new Map<string, Reply>();
  for (const reply of replies) {
    const parentId = reply.replyToReplyId;
    if (!parentId || loaded.has(parentId) || !deletedIds.has(parentId)) continue;
    const existing = stubs.get(parentId);
    if (existing && existing.createdAt <= reply.createdAt) continue;
    stubs.set(parentId, {
      id: parentId,
      author: { ...reply.author, id: '', username: '', displayName: '', avatar: '' },
      content: '',
      createdAt: reply.createdAt,
      likes: 0,
      reposts: 0,
      replies: 0,
      views: 0,
      parentId: reply.rootPostId ?? '',
      parentOwnerId: '',
      rootPostId: reply.rootPostId,
      deletedStub: true,
    });
  }
  return Array.from(stubs.values());
}
