/**
 * What a post or reply carries of v18's "hide, don't delete" model, and what a
 * list does with it (docs/SOCIAL_V18.md, docs/ARCHIVE_FRONTEND.md).
 *
 * The moderators can only hide a document (`mod`, `modLabel`, stamped
 * `$moderatedBy`/`$moderatedAt`), and a restricted author's documents are filed
 * in lane `live == 2`. yap.pr's listings read the listed lane only, so a hidden
 * post reaches the client only through a read that is not laned: a ranked list
 * (it ranks by likes, and a hidden post's likes still count), a quote list, a
 * reply notification window, a bookmark, a quote embed. Those drop what they
 * hydrate; an archival build keeps it and labels it.
 */

import type { Post, PostModeration } from '@/lib/types';
import { isHiddenItem, moderationMarksOf, moderationOf, moderationViewAll } from '@/lib/moderation-view';
import { identifierToBase58 } from '@/lib/services/sdk-helpers';

/** `post.moderation` for a stored post or reply: its moderator marks plus `restricted` for lane 2; undefined when neither applies. */
export function postModerationOf(doc: Record<string, unknown>, data: Record<string, unknown> = doc): PostModeration | undefined {
  // An already-built Post (an optimistic feed card, a cached page) carries its own.
  const carried = doc.moderation;
  if (typeof carried === 'object' && carried !== null) return carried as PostModeration;

  // `$moderatedBy` is an identifier; it arrives as bytes unless the reader already made it base58.
  const moderatedBy = doc.$moderatedBy ?? data.$moderatedBy;
  const marks = moderationMarksOf({
    ...data,
    $moderatedBy: identifierToBase58(moderatedBy) ?? moderatedBy,
    $moderatedAt: doc.$moderatedAt ?? data.$moderatedAt,
  });
  const restricted = (doc.live ?? data.live) === 2;
  if (Object.keys(marks).length === 0 && !restricted) return undefined;
  return restricted ? { ...marks, restricted: true } : marks;
}

/**
 * True when a default build's listings do not list `item`: a moderator hid it,
 * or its author was restricted when they wrote it (lane `live == 2`). An
 * archival build lists both, labelled, so for it nothing is unlisted.
 */
export function isUnlistedItem(item: object | null | undefined): boolean {
  if (isHiddenItem(item)) return true;
  if (moderationViewAll()) return false;
  return (moderationOf(item) as PostModeration | undefined)?.restricted === true;
}

/**
 * Sets what a card needs to show a hidden quote target the way it shows an
 * unavailable one, without its text: nothing is attached, nothing is fetched
 * (`quotedPostRemoved`), and `quotedPostHidden` lets the card say "hidden"
 * rather than "removed" or "deleted".
 */
export function markQuoteHidden(post: Post): void {
  post.quotedPost = undefined;
  Object.assign(post, { quotedPostRemoved: true, quotedPostHidden: true });
}

/** True once {@link markQuoteHidden} marked this post's quote target as hidden. */
export function isQuoteHidden(post: Post): boolean {
  return (post as Post & { quotedPostHidden?: boolean }).quotedPostHidden === true;
}
