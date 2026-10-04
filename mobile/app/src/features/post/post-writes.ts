import type { PostDTO, TargetRef, WriteTicket } from '@engine/api';

import { dropFromLists, hidePost, markPostDeleted, setFollowing, setViewerState } from '~/data/optimistic';
import { errorCode, type WriteSpec } from '~/data/writes';

/**
 * The engagement writes a post's controls make (PRD ENG-01 – ENG-08), as
 * `WriteSpec`s for `submitWrite` / `useWrite`. Each one patches every cached
 * copy of the post at once and is undone if the write fails. An unconfirmed
 * write counts as done (PRD G-3): the reconciler checks it quietly. Screens
 * that show posts (thread, bookmarks, profile) reuse these.
 */

/**
 * A restored ticket for this write (after an engine restart cut the call
 * short): the op this write asked for (`on` or `off`), on this post.
 */
const ticketOnPost =
  <V extends { post: PostDTO }>(on: string, off: string, isOn: (vars: V) => boolean) =>
  (ticket: WriteTicket, vars: V): boolean =>
    ticket.op === (isOn(vars) ? on : off) && (ticket.target as { id?: string } | null)?.id === vars.post.id;

/** The engine's reference to a post or reply. */
export function targetOf(post: PostDTO): TargetRef {
  return { id: post.id, kind: post.kind, ownerId: post.author.id, rootPostId: post.rootPostId ?? null };
}

export const likeWrite: WriteSpec<{ post: PostDTO; like: boolean }> = {
  key: ({ post }) => `like:${post.id}`,
  submit: (api, { post, like }) => (like ? api.engage.like(targetOf(post)) : api.engage.unlike(targetOf(post))),
  optimistic: ({ post, like }) => setViewerState(post.id, { liked: like }),
  intent: ({ like }) => like,
  matches: ticketOnPost('like', 'unlike', ({ like }: { post: PostDTO; like: boolean }) => like),
  failureMessage: ({ like }) => (like ? "Couldn't like this post. Try again." : "Couldn't unlike this post. Try again."),
};

export interface RepostVars {
  post: PostDTO;
  repost: boolean;
  /** v10: the viewer's slot holds a quote with text, which only a delete undoes (confirm first). */
  onQuoteHasText?: () => void;
}

export const repostWrite: WriteSpec<RepostVars> = {
  key: ({ post }) => `repost:${post.id}`,
  submit: (api, { post, repost }) => (repost ? api.engage.repost(targetOf(post)) : api.engage.unrepost(targetOf(post))),
  // Undoing a v10 repost deletes the bare quote, which frees the slot.
  optimistic: ({ post, repost }) =>
    setViewerState(post.id, repost ? { reposted: true } : { reposted: false, ownQuoteId: null, ownQuoteBare: false }),
  intent: ({ repost }) => repost,
  matches: ticketOnPost('repost', 'unrepost', ({ repost }: RepostVars) => repost),
  failureMessage: ({ repost }) => (repost ? "Couldn't repost this post. Try again." : "Couldn't undo your repost. Try again."),
  onRejected: (error, { onQuoteHasText }) => {
    if (errorCode(error) !== 'QUOTE_HAS_TEXT' || !onQuoteHasText) return false;
    onQuoteHasText();
    return true;
  },
};

export const bookmarkWrite: WriteSpec<{ post: PostDTO; bookmark: boolean }> = {
  key: ({ post }) => `bookmark:${post.id}`,
  submit: (api, { post, bookmark }) =>
    bookmark ? api.engage.bookmark(targetOf(post)) : api.engage.unbookmark(targetOf(post)),
  optimistic: ({ post, bookmark }) => setViewerState(post.id, { bookmarked: bookmark }),
  intent: ({ bookmark }) => bookmark,
  matches: ticketOnPost('bookmark', 'unbookmark', ({ bookmark }: { post: PostDTO; bookmark: boolean }) => bookmark),
  failureMessage: ({ bookmark }) =>
    bookmark ? "Couldn't bookmark this post. Try again." : "Couldn't remove your bookmark. Try again.",
};

export const followWrite: WriteSpec<{ authorId: string; follow: boolean }> = {
  key: ({ authorId }) => `follow:${authorId}`,
  submit: (api, { authorId, follow }) => (follow ? api.graph.follow(authorId) : api.graph.unfollow(authorId)),
  optimistic: ({ authorId, follow }) => setFollowing(authorId, follow),
  intent: ({ follow }) => follow,
  matches: (ticket, { authorId, follow }) =>
    ticket.op === (follow ? 'follow' : 'unfollow') &&
    (ticket.target as { identityId?: string } | null)?.identityId === authorId,
  failureMessage: ({ follow }) => (follow ? "Couldn't follow this account. Try again." : "Couldn't unfollow this account. Try again."),
};

/**
 * Delete own post or reply (ENG-06). It leaves every list at once and comes
 * back if the delete fails; confirmed, it leaves the cached lists too (so a
 * relaunch keeps it out), and every other cached copy reads as deleted.
 * `quotedPostId` is set for the viewer's v10 quote (from the repost menu's
 * "Delete your quote", or its own menu): the post whose one slot it holds.
 */
export const deleteWrite: WriteSpec<{ target: TargetRef; quotedPostId?: string }> = {
  key: ({ target }) => `delete:${target.id}`,
  submit: (api, { target }) => api.posts.delete(target),
  optimistic: ({ target, quotedPostId }) => {
    const unhide = hidePost(target.id);
    // Deleting the viewer's quote frees their slot on the quoted post, and takes it out of its count.
    const unslot = quotedPostId
      ? setViewerState(quotedPostId, { reposted: false, ownQuoteId: null, ownQuoteBare: false })
      : undefined;
    return () => {
      unhide();
      unslot?.();
    };
  },
  // A second delete while the first is pending asks for the same thing: dropped, never sent.
  intent: () => 'deleted',
  onConfirmed: (_ticket, { target }) => {
    markPostDeleted(target.id);
    dropFromLists(target.id);
  },
  matches: (ticket, { target }) => ticket.op === 'post.delete' && (ticket.target as { id?: string } | null)?.id === target.id,
  failureMessage: ({ target }) => `Couldn't delete ${target.kind === 'reply' ? 'reply' : 'post'}. Try again.`,
};
