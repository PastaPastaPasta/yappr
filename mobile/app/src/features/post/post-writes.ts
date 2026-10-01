import type { PostDTO, TargetRef } from '@engine/api';

import { hidePost, markPostDeleted, setFollowing, setViewerState } from '~/data/optimistic';
import type { WriteSpec } from '~/data/writes';

/**
 * The engagement writes a post's controls make (PRD ENG-01 – ENG-08), as
 * `WriteSpec`s for `submitWrite` / `useWrite`. Each one patches every cached
 * copy of the post at once and is undone if the write fails. Screens that
 * show posts (thread, bookmarks, profile) reuse these rather than their own.
 */

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/** The engine's reference to a post or reply. */
export function targetOf(post: PostDTO): TargetRef {
  return { id: post.id, kind: post.kind, ownerId: post.author.id, rootPostId: post.rootPostId ?? null };
}

export const likeWrite: WriteSpec<{ post: PostDTO; like: boolean }> = {
  key: ({ post }) => `like:${post.id}`,
  submit: (api, { post, like }) => (like ? api.engage.like(targetOf(post)) : api.engage.unlike(targetOf(post))),
  optimistic: ({ post, like }) => setViewerState(post.id, { liked: like }),
  noun: 'like',
  failureMessage: 'Failed to update like. Please try again.',
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
  optimistic: ({ post, repost }) => setViewerState(post.id, repost ? { reposted: true } : { reposted: false, ownQuoteId: null }),
  noun: 'repost',
  failureMessage: 'Failed to update repost. Please try again.',
  onRejected: (error, { onQuoteHasText }) => {
    const code = errorCode(error);
    if (code === 'QUOTE_HAS_TEXT' && onQuoteHasText) {
      onQuoteHasText();
      return true;
    }
    return false;
  },
};

export const bookmarkWrite: WriteSpec<{ post: PostDTO; bookmark: boolean }> = {
  key: ({ post }) => `bookmark:${post.id}`,
  submit: (api, { post, bookmark }) =>
    bookmark ? api.engage.bookmark(targetOf(post)) : api.engage.unbookmark(targetOf(post)),
  optimistic: ({ post, bookmark }) => setViewerState(post.id, { bookmarked: bookmark }),
  noun: 'bookmark',
  failureMessage: 'Failed to update bookmark. Please try again.',
};

export const followWrite: WriteSpec<{ authorId: string; follow: boolean }> = {
  key: ({ authorId }) => `follow:${authorId}`,
  submit: (api, { authorId, follow }) => (follow ? api.graph.follow(authorId) : api.graph.unfollow(authorId)),
  optimistic: ({ authorId, follow }) => setFollowing(authorId, follow),
  noun: 'follow',
  failureMessage: 'Failed to update follow status',
};

/**
 * Delete own post or reply (ENG-06). It leaves every list at once and comes
 * back if the delete fails; confirmed, every cached copy reads as deleted.
 * `target` is set for the viewer's v10 quote, deleted from the repost menu.
 */
export const deleteWrite: WriteSpec<{ target: TargetRef; quotedPostId?: string }> = {
  key: ({ target }) => `delete:${target.id}`,
  submit: (api, { target }) => api.posts.delete(target),
  optimistic: ({ target, quotedPostId }) => {
    const unhide = hidePost(target.id);
    // Deleting the viewer's quote frees their slot on the quoted post.
    const unslot = quotedPostId ? setViewerState(quotedPostId, { ownQuoteId: null }) : undefined;
    return () => {
      unhide();
      unslot?.();
    };
  },
  onConfirmed: (_ticket, { target }) => markPostDeleted(target.id),
  noun: 'delete',
  failureMessage: 'Failed to delete. Please try again.',
};
