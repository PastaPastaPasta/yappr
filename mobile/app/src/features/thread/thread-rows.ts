import type { PostDTO, ThreadDTO, ThreadReplyDTO } from '@engine/api/dto';

/**
 * The post detail screen as one list (UX_SPEC §4.9): what is above the
 * focused post, the post itself, then its replies flattened to one indent
 * level. Pure, so the shape is unit tested without rendering.
 */

/** Why a slot above the focus holds a stub instead of a post. */
export type AncestorGap = 'unavailable';

export type ThreadRow =
  /** A post above the focus (root first), compact, with the thread line to the next. */
  | { type: 'ancestor'; key: string; post: PostDTO }
  /** A post above the focus that is gone: never claims "removed" or "deleted" (PRD POST-04). */
  | { type: 'ancestorStub'; key: string; id: string; kind: PostDTO['kind'] }
  /** The focused post, detail variant. `lineAbove` joins it to the ancestor over it. */
  | { type: 'focus'; key: string; post: PostDTO; lineAbove: boolean; replyingTo?: string }
  /** The focus is gone (removed on this device, or unreadable after it was shown). */
  | { type: 'focusStub'; key: string; kind: PostDTO['kind']; state: 'deleted' | 'unavailable' }
  | { type: 'focusSkeleton'; key: string }
  | {
      type: 'reply';
      key: string;
      reply: ThreadReplyDTO;
      /** "Replying to @x" when the parent is not the row right above. */
      replyingTo?: string;
      /** The focus author's own continuation: the line to the author's reply above / below. */
      lineAbove: boolean;
      lineBelow: boolean;
      /** The first reply of the author's thread carries the "Author thread" label. */
      authorThreadStart: boolean;
      highlighted: boolean;
    }
  /** Replies nested deeper than the one indent level: "Continue thread · N more replies". */
  | { type: 'continue'; key: string; replyId: string; count: number }
  | { type: 'repliesLoading'; key: string }
  | { type: 'repliesEmpty'; key: string }
  | { type: 'repliesError'; key: string; message: string };

export interface ThreadRowsInput {
  /** The thread's latest (cumulative) page, once loaded. */
  thread?: ThreadDTO;
  /** What the screen can show before the thread arrives: the card that was tapped. */
  seed?: PostDTO | null;
  /** The focus's direct parent when the thread's ancestors don't hold it (flat threads list only the root). */
  parent?: PostDTO | null;
  /** The parent read finished and found nothing. */
  parentMissing?: boolean;
  /** The viewer deleted the focus on this device. */
  focusRemoved?: boolean;
  /** `?reply=`: the reply to highlight. */
  highlightId?: string;
  repliesError?: string | null;
}

/** "@name" for a reply context line, or nothing when the author has no username. */
const handleOf = (post: PostDTO | undefined) => post?.author.username ?? undefined;

function replyRows(replies: ThreadReplyDTO[], highlightId: string | undefined): ThreadRow[] {
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  const rows: ThreadRow[] = [];
  const authorThread = (reply: ThreadReplyDTO | undefined) => reply?.depth === 0 && reply.isAuthorThread;
  let seenAuthorThread = false;
  replies.forEach((reply, index) => {
    const previous = replies[index - 1];
    const next = replies[index + 1];
    const parent = reply.parentId ? byId.get(reply.parentId) : undefined;
    // Indented replies name their parent when it isn't the row right above (PRD POST-02).
    const replyingTo =
      reply.depth === 1 && parent && previous?.id !== parent.id && !parent.deletedStub ? handleOf(parent) : undefined;
    const inAuthorThread = authorThread(reply);
    rows.push({
      type: 'reply',
      key: `reply:${reply.id}`,
      reply,
      replyingTo,
      lineAbove: inAuthorThread && authorThread(previous),
      lineBelow: inAuthorThread && authorThread(next),
      authorThreadStart: inAuthorThread && !seenAuthorThread,
      highlighted: reply.id === highlightId,
    });
    if (inAuthorThread) seenAuthorThread = true;
    if (reply.hiddenReplyCount > 0 && !reply.deletedStub) {
      rows.push({ type: 'continue', key: `continue:${reply.id}`, replyId: reply.id, count: reply.hiddenReplyCount });
    }
  });
  return rows;
}

/**
 * Rows for the post detail list. Order: stubs for ancestors that are gone,
 * the ancestors (root first), the focus's direct parent when the thread
 * didn't include it, the focus, then the replies or their loading, empty
 * or error row.
 */
export function buildThreadRows({
  thread,
  seed,
  parent,
  parentMissing = false,
  focusRemoved = false,
  highlightId,
  repliesError,
}: ThreadRowsInput): ThreadRow[] {
  const rows: ThreadRow[] = [];
  // A post shown before (the tapped card) stays on screen, as a stub, if the thread no longer finds it.
  const focus = thread?.focus ?? seed;

  if (!focus) {
    // Nothing to show yet; a loaded thread with no focus is the screen's "Post not found".
    if (!thread) rows.push({ type: 'focusSkeleton', key: 'focus-skeleton' }, { type: 'repliesLoading', key: 'replies-loading' });
    return rows;
  }

  const ancestors = thread?.ancestors ?? [];
  for (const id of thread?.removedAncestorIds ?? []) {
    rows.push({ type: 'ancestorStub', key: `gone:${id}`, id, kind: 'post' });
  }
  for (const post of ancestors) rows.push({ type: 'ancestor', key: `ancestor:${post.id}`, post });

  const parentId = focus.parentId;
  const parentInChain = parentId ? ancestors.find((post) => post.id === parentId) : undefined;
  if (parentId && !parentInChain && thread && !thread.removedAncestorIds.includes(parentId)) {
    if (parent) rows.push({ type: 'ancestor', key: `ancestor:${parent.id}`, post: parent });
    else if (parentMissing) rows.push({ type: 'ancestorStub', key: `gone:${parentId}`, id: parentId, kind: 'reply' });
  }

  const above = rows[rows.length - 1];
  const shownParent = parentInChain ?? (parentId && parent?.id === parentId ? parent : undefined);
  if (focusRemoved) {
    rows.push({ type: 'focusStub', key: `focus:${focus.id}`, kind: focus.kind, state: 'deleted' });
  } else if (thread && !thread.focus) {
    rows.push({ type: 'focusStub', key: `focus:${focus.id}`, kind: focus.kind, state: 'unavailable' });
  } else {
    rows.push({
      type: 'focus',
      key: `focus:${focus.id}`,
      post: focus,
      lineAbove: above?.type === 'ancestor',
      replyingTo: handleOf(shownParent),
    });
  }

  if (!thread) {
    rows.push(
      repliesError
        ? { type: 'repliesError', key: 'replies-error', message: repliesError }
        : { type: 'repliesLoading', key: 'replies-loading' },
    );
    return rows;
  }
  const replies = thread.replies.items;
  if (replies.length === 0) {
    rows.push(
      repliesError
        ? { type: 'repliesError', key: 'replies-error', message: repliesError }
        : { type: 'repliesEmpty', key: 'replies-empty' },
    );
    return rows;
  }
  rows.push(...replyRows(replies, highlightId));
  return rows;
}

/** FlashList recycling pools: one per row shape. */
export function threadRowType(row: ThreadRow): string {
  if (row.type === 'reply') return row.reply.deletedStub || row.reply.deleted ? 'replyStub' : `reply${row.reply.depth}`;
  return row.type;
}
