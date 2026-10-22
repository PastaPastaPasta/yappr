import type { Reply } from '@/lib/types';
import { replyThreadsCarryLiveMarker, repliesOutliveTheirParent } from '@/lib/contract-topology';
import { isHiddenItem } from './post-moderation';

/**
 * A reply the moderators hid, as the placeholder a default build shows in its
 * place: it keeps its thread position (so its children stay under it) and
 * nothing else of the reply, not its text, media, author or marks.
 */
function hiddenReplyStub(hidden: Reply): Reply {
  return {
    id: hidden.id,
    author: { ...hidden.author, id: '', username: '', displayName: '', avatar: '' },
    content: '',
    createdAt: hidden.createdAt,
    likes: 0,
    reposts: 0,
    replies: 0,
    views: 0,
    parentId: hidden.parentId,
    parentOwnerId: hidden.parentOwnerId,
    rootPostId: hidden.rootPostId,
    rootOwnerId: hidden.rootOwnerId,
    replyToReplyId: hidden.replyToReplyId,
    hiddenStub: true,
  };
}

/** The reads {@link withMissingReplyParents} makes; both reject when the read or proof fails. */
export interface MissingParentReads {
  /** The replies among `ids` that exist, read by id. */
  getMany(ids: string[]): Promise<Reply[]>;
  /** The ids among `ids` proved absent. */
  provenAbsent(ids: string[]): Promise<Set<string>>;
}

/**
 * A flat thread page's replies plus what keeps each reply under a missing
 * parent in the thread, in place of the parent:
 *
 * - Where `repliesOf` is keyed on `live` (`replyThreadsCarryLiveMarker`), an
 *   author's tombstone is not listed, so a live reply under one comes back
 *   without it. Missing parents are read by id and the tombstones among them
 *   added (a chain of them, one level per round, until no new parent is
 *   missing; each id is read once); the thread shows each as
 *   its "deleted" placeholder. A live parent on a later page is left to that
 *   page, as on the earlier shape.
 * - Where a reply can outlive its parent (`repliesOutliveTheirParent`), the
 *   parents still missing are proved absent and stubbed
 *   ({@link deletedReplyStubs}).
 * - A reply the moderators hid (v18) is not listed either, so its children
 *   would lose their parent. A default build reads it by id and stands in a
 *   `hiddenStub` placeholder (no content, same place in the thread). An
 *   archival build lists the hidden reply itself, labelled, so nothing here.
 *
 * `loaded` names replies already shown from earlier pages: a parent among
 * them is not missing, so it is neither read again nor proved.
 */
export async function withMissingReplyParents(replies: readonly Reply[], reads: MissingParentReads, loaded: ReadonlySet<string> = new Set()): Promise<Reply[]> {
  let all = [...replies];
  if (replyThreadsCarryLiveMarker()) {
    const tried = new Set<string>();
    for (;;) {
      const missing = unloadedReplyParents(all, loaded).filter((id) => !tried.has(id));
      if (missing.length === 0) break;
      missing.forEach((id) => tried.add(id));
      const have = new Set(all.map((reply) => reply.id));
      const found = (await reads.getMany(missing)).filter((reply) => !have.has(reply.id));
      // A parent the moderators hid (v18) is not listed either: it holds its place as a stub with no content.
      const stubs = found.map((reply) => (reply.deleted === true ? reply : isHiddenItem(reply) ? hiddenReplyStub(reply) : null)).filter((reply) => reply !== null);
      if (stubs.length === 0) break;
      all = [...stubs, ...all];
    }
  }
  if (!repliesOutliveTheirParent()) return all;
  const candidates = unloadedReplyParents(all, loaded);
  const deleted = candidates.length > 0 ? await reads.provenAbsent(candidates) : new Set<string>();
  return [...deletedReplyStubs(all, deleted), ...all];
}

/**
 * The reply ids a flat thread's replies nest under (`replyToReplyId`) that are
 * not among the loaded replies. Where a reply outlives its parent (v10: an
 * author's delete or a moderator removal; v11: a moderator removal), these are
 * the candidates for a gone parent; the caller proves the absence before
 * stubbing any of them.
 */
export function unloadedReplyParents(replies: readonly Reply[], alsoLoaded: ReadonlySet<string> = new Set()): string[] {
  const loaded = new Set([...alsoLoaded, ...replies.map((reply) => reply.id)]);
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
