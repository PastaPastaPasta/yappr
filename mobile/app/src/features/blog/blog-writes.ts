import type { BlogCommentDTO, BlogFollowDTO, BlogInput, BlogPostInput, BlogReportTargetDTO, WriteTicket } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { engine } from '~/engine';
import type { WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';

/**
 * The blog writes (web's `components/blog/**`): each is one engine ticket.
 * Follow is optimistic; the rest are waited on by the screen that sends
 * them, which shows its saving state and moves on once confirmed.
 */

const refetch = (key: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey: key }).catch(() => undefined);
};

/** The blog a ticket names (`BlogTargetRef`), for `matches`. */
const blogTargetOf = (ticket: WriteTicket): { type: string; id: string } | null =>
  (ticket.target as { blog?: { type: string; id: string } } | null)?.blog ?? null;

const names = (ticket: WriteTicket, op: WriteTicket['op'], id: string) =>
  ticket.op === op && blogTargetOf(ticket)?.id === id;

/** The id of the document a create ticket made, once known. */
export const createdId = (ticket: WriteTicket | null): string | null =>
  ticket?.documents.find((doc) => doc.action === 'create')?.id ?? null;

export const createBlogWrite: WriteSpec<{ input: BlogInput }> = {
  submit: (api, { input }) => api.blogs.create(input),
  onConfirmed: () => {
    refetch(queryKeys.blog.mine);
    refetch(queryKeys.blog.discover);
  },
  failureMessage: "Couldn't create your blog. Try again.",
};

export const updateBlogWrite: WriteSpec<{ blogId: string; input: Partial<BlogInput> }> = {
  key: ({ blogId }) => `blog:${blogId}`,
  submit: (api, { blogId, input }) => api.blogs.update(blogId, input),
  onConfirmed: (_ticket, { blogId }) => {
    refetch(queryKeys.blog.detail(blogId));
    refetch(queryKeys.blog.mine);
    refetch(queryKeys.blog.discover);
  },
  matches: (ticket, { blogId }) => names(ticket, 'blog.update', blogId),
  failureMessage: "Couldn't save your blog. Try again.",
};

export const deleteBlogWrite: WriteSpec<{ blogId: string }> = {
  key: ({ blogId }) => `blog:${blogId}`,
  submit: (api, { blogId }) => api.blogs.remove(blogId),
  onConfirmed: () => refetch(queryKeys.blog.all),
  matches: (ticket, { blogId }) => names(ticket, 'blog.delete', blogId),
  failureMessage: "Couldn't delete this blog. Try again.",
};

/** A new post's draft on this device, per account and blog (web's `yappr:blog-draft:…:new`). */
export const draftKey = (viewerId: string, blogId: string) => `yappr.blog.draft:${viewerId}:${blogId}`;
const heldKey = (viewerId: string, blogId: string) => `${draftKey(viewerId, blogId)}:sent`;

interface HeldPublish {
  at: number;
  title: string;
  /** The title's own address was free just before the send, so the post can be traced by it. */
  addressFree: boolean;
}

/**
 * A publish of this draft was sent and may still land: the editor holds it,
 * across closing and reopening, until its outcome is known
 * (`resolveHeldPublish`), never for a set time.
 */
export function holdPublish(viewerId: string, blogId: string, title: string): void {
  writeHeld(viewerId, blogId, { at: Date.now(), title, addressFree: false });
}

function writeHeld(viewerId: string, blogId: string, held: HeldPublish): void {
  syncStorage.setItem(heldKey(viewerId, blogId), JSON.stringify(held));
}

function heldPublish(viewerId: string, blogId: string): HeldPublish | null {
  try {
    const held = JSON.parse(syncStorage.getItem(heldKey(viewerId, blogId)) ?? 'null') as Partial<HeldPublish> | null;
    return held && typeof held.at === 'number' && typeof held.title === 'string'
      ? { at: held.at, title: held.title, addressFree: held.addressFree === true }
      : null;
  } catch {
    return null;
  }
}

/** Records, on the hold, whether the title's own address was free just before the send. */
function markAddressFree(viewerId: string, blogId: string, addressFree: boolean): void {
  const held = heldPublish(viewerId, blogId);
  if (held) writeHeld(viewerId, blogId, { ...held, addressFree });
}

export const publishHeld = (viewerId: string, blogId: string): boolean => heldPublish(viewerId, blogId) !== null;

export function releasePublish(viewerId: string, blogId: string, published: boolean): void {
  syncStorage.removeItem(heldKey(viewerId, blogId));
  if (published) syncStorage.removeItem(draftKey(viewerId, blogId));
}

const publishesTo = (ticket: WriteTicket, blogId: string) => names(ticket, 'blogPost.publish', blogId);

/**
 * What became of a held publish: its ticket while the engine still lists it
 * (`ticketId` while it may land); once the engine has let it go, the address
 * the post takes (`blogs.publishOutcome`), only when that address was free
 * just before the send: a post of the author's there is it, no post there
 * means it never landed. Anything else (the address was already taken, so
 * the post landed under another one; someone else holds it; a read failed)
 * keeps it held, never guessed; the writer can still discard the draft.
 */
export async function resolveHeldPublish(viewerId: string, blogId: string): Promise<{ state: 'held'; ticketId: string | null } | { state: 'published' | 'free' }> {
  const held = heldPublish(viewerId, blogId);
  if (!held) return { state: 'free' };
  try {
    const ticket = (await engine.api.writes.list()).find((t) => publishesTo(t, blogId));
    if (ticket) {
      if (ticket.state === 'confirmed') {
        releasePublish(viewerId, blogId, true);
        return { state: 'published' };
      }
      if (ticket.state === 'failed' && ticket.error?.outcome !== 'unknown') {
        releasePublish(viewerId, blogId, false);
        return { state: 'free' };
      }
      return { state: 'held', ticketId: ticket.id };
    }
    if (!held.addressFree) return { state: 'held', ticketId: null };
    const outcome = await engine.api.blogs.publishOutcome(blogId, held.title, held.at);
    if (outcome === 'unknown') return { state: 'held', ticketId: null };
    releasePublish(viewerId, blogId, outcome === 'published');
    return { state: outcome === 'published' ? 'published' : 'free' };
  } catch {
    return { state: 'held', ticketId: null };
  }
}

export const publishPostWrite: WriteSpec<{ viewerId: string; blogId: string; input: BlogPostInput }> = {
  submit: async (api, { viewerId, blogId, input }) => {
    // Only a title whose own address is free now can be traced by it later; a failed read just leaves it untraceable.
    markAddressFree(viewerId, blogId, await api.blogs.publishAddressFree(blogId, input.title).catch(() => false));
    return api.blogs.publish(blogId, input);
  },
  // A call cut short is adopted once the engine restores its ticket, so the callbacks below still run.
  matches: (ticket, { blogId }) => publishesTo(ticket, blogId),
  // Settled here, not in the editor: the writer may have left it before the publish did.
  onConfirmed: (_ticket, { viewerId, blogId }) => {
    releasePublish(viewerId, blogId, true);
    refetch(queryKeys.blog.posts(blogId));
    refetch(queryKeys.blog.latestPosts);
    refetch(queryKeys.blog.myPosts);
  },
  onFailed: (_ticket, { viewerId, blogId }) => releasePublish(viewerId, blogId, false),
  failureMessage: "Couldn't publish your post. Try again.",
};

/** A post changed: its own caches, and the lists that show it. */
function refetchPost(postId: string, blogId: string): void {
  refetch(queryKeys.blog.post(postId));
  refetch(queryKeys.blog.slugs(blogId));
  refetch(queryKeys.blog.posts(blogId));
  refetch(queryKeys.blog.latestPosts);
  refetch(queryKeys.blog.myPosts);
}

export const editPostWrite: WriteSpec<{ postId: string; blogId: string; input: Partial<BlogPostInput> }> = {
  key: ({ postId }) => `blogPost:${postId}`,
  submit: (api, { postId, input }) => api.blogs.edit(postId, input),
  onConfirmed: (_ticket, { postId, blogId }) => refetchPost(postId, blogId),
  matches: (ticket, { postId }) => names(ticket, 'blogPost.update', postId),
  failureMessage: "Couldn't save your post. Try again.",
};

export const deletePostWrite: WriteSpec<{ postId: string; blogId: string }> = {
  key: ({ postId }) => `blogPost:${postId}`,
  submit: (api, { postId }) => api.blogs.deletePost(postId),
  onConfirmed: (_ticket, { postId, blogId }) => refetchPost(postId, blogId),
  matches: (ticket, { postId }) => names(ticket, 'blogPost.delete', postId),
  failureMessage: "Couldn't delete this post. Try again.",
};

export const commentWrite: WriteSpec<{ postId: string; postOwnerId: string; content: string }> = {
  submit: (api, { postId, postOwnerId, content }) => api.blogs.comment(postId, postOwnerId, content),
  onConfirmed: (_ticket, { postId }) => refetch(queryKeys.blog.comments(postId)),
  failureMessage: "Couldn't post your comment. Try again.",
};

/** The cached comments without `commentId`, and the undo. */
function hideComment(postId: string, commentId: string): () => void {
  const key = queryKeys.blog.comments(postId);
  const previous = queryClient.getQueryData<BlogCommentDTO[]>(key);
  if (!previous) return () => undefined;
  queryClient.setQueryData<BlogCommentDTO[]>(key, previous.filter((comment) => comment.id !== commentId));
  return () => queryClient.setQueryData(key, previous);
}

export const deleteCommentWrite: WriteSpec<{ commentId: string; postId: string }> = {
  key: ({ commentId }) => `blogComment:${commentId}`,
  submit: (api, { commentId }) => api.blogs.deleteComment(commentId),
  reconcile: null,
  optimistic: ({ commentId, postId }) => hideComment(postId, commentId),
  onConfirmed: (_ticket, { postId }) => refetch(queryKeys.blog.comments(postId)),
  matches: (ticket, { commentId }) => names(ticket, 'blogComment.delete', commentId),
  failureMessage: "Couldn't delete your comment. Try again.",
};

/** The cached follow state with `following` set, and its undo. */
function setBlogFollowing(blogId: string, following: boolean): () => void {
  const key = queryKeys.blog.follow(blogId);
  const previous = queryClient.getQueryData<BlogFollowDTO>(key);
  if (!previous) return () => undefined;
  const delta = previous.following === following ? 0 : following ? 1 : -1;
  queryClient.setQueryData<BlogFollowDTO>(key, { following, followers: Math.max(0, previous.followers + delta) });
  return () => queryClient.setQueryData(key, previous);
}

export const followBlogWrite: WriteSpec<{ blogId: string; follow: boolean }> = {
  key: ({ blogId }) => `blogFollow:${blogId}`,
  submit: (api, { blogId, follow }) => (follow ? api.blogs.follow(blogId) : api.blogs.unfollow(blogId)),
  reconcile: null,
  optimistic: ({ blogId, follow }) => setBlogFollowing(blogId, follow),
  // A read that landed while the write was on its way may predate it: put the change back over it.
  reapply: ({ blogId, follow }, queries) => {
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.blog.follow(blogId), exact: true });
    if (query && queries.has(query.queryHash)) setBlogFollowing(blogId, follow);
  },
  intent: ({ follow }) => follow,
  onConfirmed: (_ticket, { blogId }) => {
    refetch(queryKeys.blog.follow(blogId));
    refetch(queryKeys.blog.followed);
  },
  matches: (ticket, { blogId, follow }) => names(ticket, follow ? 'blog.follow' : 'blog.unfollow', blogId),
  failureMessage: ({ follow }) => (follow ? "Couldn't follow this blog. Try again." : "Couldn't unfollow this blog. Try again."),
};

export const reportBlogWrite: WriteSpec<{ target: BlogReportTargetDTO; reason: number; note: string }> = {
  key: ({ target }) => `blogReport:${target.targetId}`,
  submit: (api, { target, reason, note }) => api.blogs.report(target, reason, note),
  onConfirmed: (_ticket, { target }) => refetch(queryKeys.blog.ownReport(target.docType, target.targetId)),
  matches: (ticket, { target }) => names(ticket, 'blog.report', target.targetId),
  failureMessage: "Couldn't send your report. Try again.",
};

export const withdrawBlogReportWrite: WriteSpec<{ reportId: string; target: BlogReportTargetDTO }> = {
  key: ({ target }) => `blogReport:${target.targetId}`,
  submit: (api, { reportId }) => api.blogs.withdrawReport(reportId),
  onConfirmed: (_ticket, { target }) => refetch(queryKeys.blog.ownReport(target.docType, target.targetId)),
  matches: (ticket, { reportId }) => names(ticket, 'blog.report.withdraw', reportId),
  failureMessage: "Couldn't withdraw your report. Try again.",
};
