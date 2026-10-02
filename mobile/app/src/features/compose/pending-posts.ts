import type { AuthorDTO, ContentCreatedEvent, DraftDTO, PostDTO, ProfileDTO, TargetRef, ThreadReplyDTO, WriteTicket } from '@engine/api';
import { parse, stringify } from '@engine/protocol/codec';
import type { Query } from '@tanstack/react-query';
import { router } from 'expo-router';
import { create } from 'zustand';

import { engine, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { onEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { EMPTY_VIEWER, updateCachedPosts, useRemovedPosts } from '~/data/optimistic';
import { useSessionStore } from '~/data/session';
import { checkWrite, runWrite, type WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';
import { toast } from '~/ui/toast';
import type { WriteState as CardWriteState, WriteStatusProps } from '~/ui/WriteStatus';

import {
  deleteDraft,
  forgetDrafts,
  loadDraft,
  saveDraft,
  type ComposeContext,
  type ComposeDraft,
  type DraftPart,
} from './drafts';

/**
 * Posts on their way to the chain (PRD COMP-10, PD-3). Compose closes on
 * Post; from then on the post lives here: an optimistic card at the top of
 * the Home feeds and the author's profile (a reply: under its parent in the
 * thread), with the write-status row in place of the action bar.
 *
 * The entry is the source of truth, kept in MMKV so a card survives a kill:
 * every cached list it belongs to gets the card back whenever it loads or
 * refetches, until the ticket confirms (the card becomes the real post) or
 * the user takes it back with Edit. A failed post's text returns to its
 * draft (PRD G-4).
 */

export interface PendingPost {
  /** The optimistic card's id (`pending-…`); never sent anywhere. */
  localId: string;
  identityId: string;
  context: ComposeContext;
  /** What was submitted: only parts with content, `resume` aligned with them. */
  draft: DraftDTO;
  /** The optimistic card: the first part still to post. */
  post: PostDTO;
  /** Where the card shows: Home and the profile, under its parent in a thread, or nowhere (a resumed thread). */
  placement: 'feed' | 'thread' | 'none';
  ticketId: string | null;
  /** The last ticket seen. */
  ticket: WriteTicket | null;
  /** The engine refused the call itself (no ticket): nothing was sent. */
  refused: boolean;
  /**
   * The call was cut short (an engine restart or timeout, or the app was
   * killed) before it named its ticket: it may have gone out. Followed again
   * once the engine shows a ticket that matches it, never re-sent.
   */
  orphaned?: boolean;
  /** An orphan "Check again" found no ticket for: it cannot be proved either way. */
  lost?: boolean;
  /** When the last call went out (a retry's republish is later than `createdAt`). */
  submittedAt?: number;
  createdAt: number;
  /**
   * When the ticket confirmed. The entry then holds the real post for a
   * while, so a list that refetches before the chain's indexes show it
   * (a read a second after the confirm can miss it) still keeps it on top.
   */
  confirmedAt?: number;
  /**
   * The card's real id, learned from `content.created` before the ticket
   * names it (a thread's first part lands while the rest still post): the
   * real post then carries the write status instead of a second card.
   */
  adoptedId?: string;
}

/** How long a confirmed post stays pinned in the lists it was put in. */
const PIN_MS = 2 * 60_000;

interface PendingState {
  entries: Record<string, PendingPost>;
}

const STORAGE_KEY = 'yappr.compose.pending';

function restore(): Record<string, PendingPost> {
  try {
    const raw = syncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (parse(raw) as Record<string, PendingPost>) : {};
    // A post killed between submit and the engine's answer never got its ticket id: it may or may
    // not have gone out, so it reads "Not confirmed yet" until its ticket shows up, never re-sent.
    for (const entry of Object.values(parsed)) {
      if (!entry.ticketId && !entry.refused && !entry.confirmedAt) entry.orphaned = true;
    }
    return parsed;
  } catch {
    return {};
  }
}

export const usePendingPosts = create<PendingState>()(() => ({ entries: restore() }));

usePendingPosts.subscribe(({ entries }) => {
  if (Object.keys(entries).length === 0) syncStorage.removeItem(STORAGE_KEY);
  else syncStorage.setItem(STORAGE_KEY, stringify(entries));
});

const getEntry = (localId: string): PendingPost | undefined => usePendingPosts.getState().entries[localId];

function patchEntry(localId: string, patch: Partial<PendingPost>): void {
  usePendingPosts.setState(({ entries }) => {
    const entry = entries[localId];
    return entry ? { entries: { ...entries, [localId]: { ...entry, ...patch } } } : { entries };
  });
}

function dropEntry(localId: string): void {
  usePendingPosts.setState(({ entries }) => {
    const { [localId]: _dropped, ...rest } = entries;
    return { entries: rest };
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Part index → the id it was posted under: the submitted `resume`, then what
 * the ticket names. A document the engine proved absent (a retryable
 * ticket's unconfirmed one, which `writes.retry` drops too) never landed.
 */
export function postedIds(entry: PendingPost): (string | null)[] {
  const posted = entry.draft.parts.map((_, i) => entry.draft.resume?.postedIds[i] ?? null);
  const ticket = entry.ticket;
  for (const doc of ticket?.documents ?? []) {
    if (ticket?.retryable && !doc.confirmed) continue;
    if (doc.action === 'create' && doc.part !== undefined && doc.part < posted.length) posted[doc.part] = doc.id;
  }
  return posted;
}

/** A failure that may have landed anyway (a transport error after the broadcast): never re-sent. */
const mayHaveLanded = (ticket: WriteTicket) =>
  ticket.state === 'failed' && !ticket.retryable && ticket.error?.outcome === 'unknown';

/** The write-status row for an entry (UX_SPEC §2.4.11); null once confirmed. */
export function pendingStatus(entry: PendingPost): CardWriteState | null {
  const total = entry.draft.parts.length;
  const posted = postedIds(entry).filter(Boolean).length;
  const failed: CardWriteState =
    total > 1 && posted > 0 ? { state: 'partial', posted, total } : { state: 'failed' };
  const ticket = entry.ticket;
  if (entry.confirmedAt) return null;
  if (entry.refused) return failed;
  if (!entry.ticketId && entry.orphaned) return entry.lost ? { state: 'uncertain' } : { state: 'unconfirmed' };
  if (!ticket || ticket.state === 'pending') {
    const progress = ticket?.progress;
    return total > 1 && progress
      ? { state: 'threadProgress', index: Math.min(progress.done + 1, total), total }
      : { state: 'posting' };
  }
  if (mayHaveLanded(ticket)) return { state: 'uncertain' };
  if (ticket.state === 'failed' || (ticket.state === 'unconfirmed' && ticket.retryable)) return failed;
  // A part that timed out before its id was known can never be checked (the engine's probe
  // says unknown every time): Edit, to resume past what the profile shows, never a resend.
  if (ticket.state === 'unconfirmed') return posted < total ? { state: 'uncertain' } : { state: 'unconfirmed' };
  return null;
}

// ---------------------------------------------------------------------------
// The optimistic card in cached lists
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;
const idOf = (value: unknown) => (isObject(value) && typeof value.id === 'string' ? value.id : undefined);

/** Rebuilds every array in `value` through `edit` (children first); untouched branches keep their identity. */
function mapArrays(value: unknown, edit: (items: unknown[]) => unknown[]): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = mapArrays(item, edit);
      if (next !== item) changed = true;
      return next;
    });
    const edited = edit(changed ? mapped : value);
    return edited !== value || changed ? edited : value;
  }
  if (!isObject(value) || value instanceof Date) return value;
  let next: Json = value;
  for (const [key, child] of Object.entries(value)) {
    const mapped = mapArrays(child, edit);
    if (mapped !== child) {
      if (next === value) next = { ...value };
      next[key] = mapped;
    }
  }
  return next;
}

function setData(query: Query, data: unknown): void {
  if (data === query.state.data) return;
  queryClient.setQueryData(query.queryKey, data, { updatedAt: query.state.dataUpdatedAt });
}

/** Removes the card from every cached query, or swaps it for the real post. */
function replaceInCaches(localId: string, replacement: PostDTO | null): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })) {
    const data = query.state.data;
    if (data === undefined) continue;
    const next = mapArrays(data, (items) => {
      const index = items.findIndex((item) => idOf(item) === localId);
      if (index < 0) return items;
      const copy = [...items];
      if (!replacement || items.some((item) => idOf(item) === replacement.id)) copy.splice(index, 1);
      else copy[index] = { ...(items[index] as Json), ...replacement };
      return copy;
    });
    setData(query, next);
  }
}

/** Which cached list a query is: `feed.home` (Recent), a profile's Posts tab, or a thread. */
function listKind(key: readonly unknown[]): { kind: 'home' } | { kind: 'profile'; id: string } | { kind: 'thread' } | null {
  const [, , family, a, b, c] = key;
  if (family === 'feed' && a === 'home' && isObject(b) && b.sort === 'recent') return { kind: 'home' };
  if (family === 'profile' && typeof a === 'string' && b === 'posts' && isObject(c) && c.tab === 'posts') {
    return { kind: 'profile', id: a };
  }
  if (family === 'post' && b === 'thread') return { kind: 'thread' };
  return null;
}

interface PagesData {
  pages: { items: unknown[] }[];
}
const isPages = (data: unknown): data is PagesData =>
  isObject(data) && Array.isArray(data.pages) && data.pages.every((p) => isObject(p) && Array.isArray(p.items));

/** A feed or profile's pages with the card first, unless it (or the post it became) is already there. */
function withCardFirst(data: PagesData, card: PostDTO, realId: string | null): PagesData {
  const ids = new Set(data.pages.flatMap((page) => page.items.map(idOf)));
  if (ids.has(card.id) || (realId && ids.has(realId)) || data.pages.length === 0) return data;
  const [first, ...rest] = data.pages;
  return { ...data, pages: [{ ...first, items: [card, ...(first?.items ?? [])] }, ...rest] };
}

interface ThreadData {
  focus: PostDTO | null;
  replies: { items: ThreadReplyDTO[] };
}
const isThread = (data: unknown): data is ThreadData =>
  isObject(data) && 'focus' in data && isObject(data.replies) && Array.isArray(data.replies.items);

/** A thread with the reply under its parent: first among the focus's replies, or just below a listed reply. */
function withReply(thread: ThreadData, card: PostDTO, realId: string | null): ThreadData {
  const items = thread.replies.items;
  if (items.some((r) => r.id === card.id || r.id === realId)) return thread;
  const reply = (depth: 0 | 1): ThreadReplyDTO => ({ ...card, depth, isAuthorThread: false, hiddenReplyCount: 0 });
  let next: ThreadReplyDTO[] | null = null;
  if (thread.focus?.id === card.parentId) next = [reply(0), ...items];
  else {
    const at = items.findIndex((r) => r.id === card.parentId);
    if (at >= 0) next = [...items.slice(0, at + 1), reply(1), ...items.slice(at + 1)];
  }
  return next ? { ...thread, replies: { ...thread.replies, items: next } } : thread;
}

/**
 * The card's real id: the first part's, whether it landed in this call or an
 * earlier one (a refused thread retried with `resume`), else the adopted one.
 */
const firstPostedId = (entry: PendingPost): string | null => postedIds(entry)[0] ?? entry.adoptedId ?? null;

/** Forgets confirmed posts once their pin has run out. */
function prunePinned(now = Date.now()): void {
  const expired = Object.values(usePendingPosts.getState().entries).filter(
    (e) => e.confirmedAt && now - e.confirmedAt > PIN_MS,
  );
  for (const entry of expired) dropEntry(entry.localId);
}

/**
 * Puts each pending card of the signed-in account, and each post confirmed
 * in the last two minutes, into the queries given (default: every cached one).
 */
function placeCards(queries?: Query[]): void {
  prunePinned();
  const viewerId = useSessionStore.getState().session?.identityId;
  const entries = Object.values(usePendingPosts.getState().entries).filter(
    (e) => e.identityId === viewerId && e.placement !== 'none' && (e.confirmedAt || pendingStatus(e) !== null),
  );
  if (entries.length === 0) return;
  for (const query of queries ?? queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })) {
    const list = listKind(query.queryKey);
    let data = query.state.data;
    if (!list || data === undefined) continue;
    // Oldest first, so the newest card ends on top.
    for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
      const realId = firstPostedId(entry);
      if (entry.placement === 'feed' && isPages(data)) {
        if (list.kind === 'home' || (list.kind === 'profile' && list.id === entry.identityId)) {
          data = withCardFirst(data, entry.post, realId);
        }
      } else if (entry.placement === 'thread' && list.kind === 'thread') {
        if (isThread(data)) data = withReply(data, entry.post, realId);
        else if (isObject(data) && Array.isArray(data.pages)) {
          // Infinite thread pages are cumulative: each holds the whole thread.
          const current: unknown[] = data.pages;
          const pages = current.map((page) => (isThread(page) ? withReply(page, entry.post, realId) : page));
          if (pages.some((page, i) => page !== current[i])) data = { ...data, pages };
        }
      }
    }
    setData(query, data);
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

interface PublishVars {
  localId: string;
  /** Re-run the ticket the engine proved did not land (`writes.retry`), instead of publishing anew. */
  retry: boolean;
}

/** The parent's reply count or the quoted post's quote count, moved with the post (PRD COMP-03); returns the undo. */
function bumpTarget(entry: PendingPost | undefined): () => void {
  const target = entry?.draft.replyTo ?? entry?.draft.quote;
  if (!entry || !target) return () => undefined;
  const field = entry.draft.replyTo ? 'replies' : 'quotes';
  const move = (by: number, only?: ReadonlySet<string>) =>
    updateCachedPosts(target.id, (post) => ({ ...post, stats: { ...post.stats, [field]: Math.max(0, post.stats[field] + by) } }), only);
  const changed = move(1);
  return () => {
    move(-1, changed);
  };
}

const partText = (index: number) => `Post ${index + 1}`;

/** "Thread partly posted. Post {n} failed: {reason}" (UX_SPEC §5.4), or the deleted-target line for a reply. */
function failureTextFor(ticket: WriteTicket, entry: PendingPost | undefined): string | null {
  if (!entry) return null;
  const reason = ticket.error?.userMessage ?? 'Something went wrong.';
  if (entry.draft.replyTo && /not found|deleted/i.test(reason) && ticket.error?.outcome !== 'unknown') {
    return "This post was deleted, so it can't be replied to.";
  }
  const total = entry.draft.parts.length;
  const posted = postedIds({ ...entry, ticket });
  const failedAt = posted.findIndex((id) => !id);
  if (total < 2 || failedAt <= 0 || posted.every((id) => !id)) return null;
  return `Thread partly posted. ${partText(failedAt)} failed: ${reason}`;
}

/**
 * A cut-short call's ticket was made by it: a publish for the same target,
 * created as the call reached the engine (just after it was sent).
 */
const ORPHAN_SKEW_MS = 5_000;
const ORPHAN_WINDOW_MS = 60_000;
function ticketMatches(entry: PendingPost, ticket: WriteTicket): boolean {
  if (ticket.op !== 'post.publish' || (ticket.identityId ?? entry.identityId) !== entry.identityId) return false;
  const sent = entry.submittedAt ?? entry.createdAt;
  const at = new Date(ticket.createdAt).getTime();
  if (at < sent - ORPHAN_SKEW_MS || at > sent + ORPHAN_WINDOW_MS) return false;
  const want = (entry.draft.replyTo ?? entry.draft.quote)?.id ?? null;
  const got = ticket.target && 'id' in ticket.target ? ticket.target.id : null;
  return want === got;
}

export const publishWrite: WriteSpec<PublishVars> = {
  key: ({ localId }) => `publish:${localId}`,
  submit: (api, { localId, retry }) => {
    const entry = getEntry(localId);
    if (!entry) return Promise.reject(new Error('This post is no longer pending'));
    return retry && entry.ticketId ? api.writes.retry(entry.ticketId) : api.posts.publish(entry.draft);
  },
  optimistic: ({ localId }) => bumpTarget(getEntry(localId)),
  noun: 'post',
  failureMessage: "Couldn't post. Please try again.",
  failureText: (ticket, { localId }) => failureTextFor(ticket, getEntry(localId)),
  matches: (ticket, { localId }) => {
    const entry = getEntry(localId);
    return entry !== undefined && ticketMatches(entry, ticket);
  },
};

/** The draft a pending post came from, for Edit and for a failure (PRD G-4: text is never lost). */
function draftPartsOf(entry: PendingPost): DraftPart[] {
  const posted = postedIds(entry);
  return entry.draft.parts.map((part, i) => ({ text: part.text, postedId: posted[i] ?? null }));
}

/** The composer draft a pending post holds, marked as coming from it. */
export function pendingDraft(localId: string): ComposeDraft | null {
  const entry = getEntry(localId);
  if (!entry) return null;
  return {
    context: entry.context,
    parts: draftPartsOf(entry),
    sensitive: entry.draft.sensitive === true,
    mediaUrl: entry.draft.mediaUrl ?? '',
    updatedAt: Date.now(),
    fromPending: entry.localId,
  };
}

/** Whether the post's own context has room for its text: no draft there, or the one it brought back. */
function draftSlotFree(entry: PendingPost): boolean {
  const existing = loadDraft(entry.identityId, entry.context);
  return !existing || existing.fromPending === entry.localId;
}

/**
 * A failed post's text back in its context's draft (PRD G-4). Never over
 * another draft: then the text stays with the card, and Edit opens it on a
 * slot of its own. Returns whether the draft now holds it.
 */
function returnToDraft(entry: PendingPost): boolean {
  if (!draftSlotFree(entry)) return false;
  const draft = pendingDraft(entry.localId);
  if (draft) saveDraft(entry.identityId, draft);
  return draft !== null;
}

/** Submit calls still waiting for their ticket: while one is, a stray ticket may be its own, not an orphan's. */
let submitting = 0;

async function submit(localId: string, retry: boolean): Promise<void> {
  patchEntry(localId, { submittedAt: Date.now() });
  submitting++;
  let result: Awaited<ReturnType<typeof runWrite>>;
  try {
    result = await runWrite(publishWrite, { localId, retry });
  } finally {
    submitting--;
  }
  const entry = getEntry(localId);
  if (!entry) return;
  if (result.status === 'submitted') {
    patchEntry(localId, { ticketId: result.ticket.id, refused: false });
    receiveTicket(result.ticket);
  } else if (result.status === 'unknown' && !retry) {
    // Cut short: it may have run. It waits for its ticket (PRD COMP-10), never re-sent.
    patchEntry(localId, { orphaned: true, lost: false });
  } else if (result.status === 'refused' && !retry) {
    // Refused before any ticket: nothing went out.
    patchEntry(localId, { refused: true });
    settleFailure({ ...entry, refused: true });
  }
  adoptOrphans().catch(() => undefined);
}

/**
 * A post that will not land as it stands: its text back to the draft. One
 * with no card (a resumed thread) then goes, its text safe in the draft.
 */
function settleFailure(entry: PendingPost): void {
  if (returnToDraft(entry) && entry.placement === 'none') discardPending(entry.localId);
}

export interface PublishInput {
  identityId: string;
  context: ComposeContext;
  /** Every editor part, posted ones included. */
  parts: DraftPart[];
  sensitive: boolean;
  mediaUrl: string | null;
  /** The post replied to or quoted. */
  target: PostDTO | null;
  author: AuthorDTO;
}

const newLocalId = () => `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const targetRef = (post: PostDTO): TargetRef => ({
  id: post.id,
  kind: post.kind,
  ownerId: post.author.id,
  rootPostId: post.rootPostId ?? null,
});

/**
 * Posts what compose holds: the optimistic card appears at once and the
 * write runs in the background (PRD PD-3). Parts without visible text are
 * left out; parts already posted are resumed past, never posted again.
 */
export function publishPost(input: PublishInput, hasContent: (text: string) => boolean): string {
  const parts = input.parts.filter((part) => part.postedId || hasContent(part.text));
  const postedIdList = parts.map((part) => part.postedId);
  const firstOpen = postedIdList.findIndex((id) => !id);
  const { mode } = input.context;
  const target = input.target;
  const localId = newLocalId();
  const media = firstOpen === 0 && input.mediaUrl ? [{ type: 'image' as const, url: input.mediaUrl }] : [];
  const reply = mode === 'reply' && target !== null;
  const post: PostDTO = {
    id: localId,
    kind: reply ? 'reply' : 'post',
    author: input.author,
    content: (parts[firstOpen]?.text ?? '').trim(),
    createdAt: new Date(),
    stats: { likes: 0, reposts: 0, replies: 0, quotes: 0 },
    viewer: EMPTY_VIEWER,
    media,
    sensitive: input.sensitive,
    deleted: false,
    encrypted: false,
    ...(reply ? { parentId: target.id, rootPostId: target.rootPostId ?? target.id } : {}),
    ...(mode === 'quote' && target ? { quotedPostId: target.id, quoted: target } : {}),
    quotedRemoved: false,
    bareRepost: false,
  };
  const draft: DraftDTO = {
    parts: parts.map((part) => ({ text: part.text })),
    replyTo: reply ? targetRef(target) : null,
    quote: mode === 'quote' && target ? targetRef(target) : null,
    sensitive: input.sensitive,
    // The image went with the first part: a resume past it must not put it on the next one.
    mediaUrl: firstOpen === 0 ? input.mediaUrl || null : null,
    resume: postedIdList.some(Boolean) ? { postedIds: postedIdList } : null,
  };
  const entry: PendingPost = {
    localId,
    identityId: input.identityId,
    // A post edited on a slot of its own belongs to its context again.
    context: { mode, targetId: input.context.targetId },
    draft,
    post,
    placement: firstOpen !== 0 ? 'none' : reply ? 'thread' : 'feed',
    ticketId: null,
    ticket: null,
    refused: false,
    createdAt: Date.now(),
  };
  usePendingPosts.setState(({ entries }) => ({ entries: { ...entries, [localId]: entry } }));
  // The draft moves into the pending post; a failure brings it back.
  deleteDraft(input.identityId, input.context);
  placeCards();
  submit(localId, false).catch((error: unknown) => appendLog('warn', 'host', `Publish failed: ${errorMessage(error)}`));
  return localId;
}

/**
 * "Check again" on an unconfirmed post. An orphan first looks for its
 * ticket; with none, it cannot be proved either way (Edit only).
 */
export function checkPending(localId: string): void {
  const run = async () => {
    const entry = getEntry(localId);
    if (entry?.orphaned && !entry.ticketId) {
      await adoptOrphans();
      const after = getEntry(localId);
      if (after && !after.ticketId) {
        patchEntry(localId, { lost: true });
        if (after.placement === 'none') settleFailure(after);
        return;
      }
    }
    const ticketId = getEntry(localId)?.ticketId;
    if (!ticketId) return;
    const ticket = await checkWrite(ticketId);
    if (ticket) receiveTicket(ticket);
  };
  run().catch((error: unknown) => appendLog('warn', 'host', `Checking a post failed: ${errorMessage(error)}`));
}

/** Follows each orphan whose ticket the engine now lists (`writes.list`). */
async function adoptOrphans(): Promise<void> {
  const orphans = () => Object.values(usePendingPosts.getState().entries).filter((e) => e.orphaned && !e.ticketId);
  if (orphans().length === 0) return;
  const tickets = await engine.api.writes.list();
  for (const ticket of [...tickets].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    receiveTicket(ticket);
  }
}

/**
 * "Retry" / "Retry the rest". A ticket the engine proved did not land is
 * retried in place (it resumes past the parts that landed); a refused one
 * is published again with the posted parts as `resume`. Never while the
 * write may still land.
 */
export function retryPending(localId: string): void {
  const entry = getEntry(localId);
  if (!entry) return;
  const ticket = entry.ticket;
  const status = pendingStatus(entry);
  if (!status || (status.state !== 'failed' && status.state !== 'partial')) return;
  deleteDraft(entry.identityId, entry.context, localId);
  if (ticket?.retryable) {
    submit(localId, true).catch(() => undefined);
    return;
  }
  const posted = postedIds(entry);
  patchEntry(localId, {
    draft: {
      ...entry.draft,
      resume: posted.some(Boolean) ? { postedIds: posted } : null,
      // The image went with the first part: a resume past it must not put it on the next one.
      mediaUrl: posted[0] ? null : (entry.draft.mediaUrl ?? null),
    },
    ticketId: null,
    ticket: null,
    refused: false,
  });
  if (ticket) engine.api.writes.dismiss(ticket.id).catch(() => undefined);
  submit(localId, false).catch(() => undefined);
}

/**
 * "Edit": compose opens on the post's text. With its context free, the
 * text goes back to that draft and the card goes; when another draft holds
 * the context, compose opens on a slot of its own and the card stays until
 * that is posted or deleted.
 */
export function editPending(localId: string): void {
  const entry = getEntry(localId);
  if (!entry) return;
  const { mode, targetId } = entry.context;
  const params = mode === 'reply' ? { replyTo: targetId ?? '' } : mode === 'quote' ? { quote: targetId ?? '' } : {};
  const ownSlot = loadDraft(entry.identityId, { ...entry.context, pendingId: localId }) !== null;
  if (!ownSlot && returnToDraft(entry)) {
    discardPending(localId);
    router.push({ pathname: '/compose', params });
  } else {
    router.push({ pathname: '/compose', params: { ...params, pending: localId } });
  }
}

/** Forgets a pending post and its card (compose posts its returned draft anew, or Edit). */
export function discardPending(localId: string): void {
  const entry = getEntry(localId);
  dropEntry(localId);
  replaceInCaches(localId, null);
  if (entry?.ticketId) engine.api.writes.dismiss(entry.ticketId).catch(() => undefined);
}

const SUCCESS = {
  post: 'Post created successfully!',
  quote: 'Post created successfully!',
  reply: 'Reply posted',
} as const;

/**
 * The ticket confirmed: the card becomes the real post (seeded by
 * `content.created` when it arrived) and stays pinned for a while.
 */
function confirmed(entry: PendingPost, ticket: WriteTicket): void {
  const realId = firstPostedId({ ...entry, ticket });
  const real = realId ? (queryClient.getQueryData<PostDTO>(queryKeys.post.detail(realId)) ?? null) : null;
  const post = realId ? { ...entry.post, id: realId, ...(real ?? {}) } : null;
  if (post) patchEntry(entry.localId, { ticket, post, confirmedAt: Date.now() });
  else dropEntry(entry.localId);
  replaceInCaches(entry.localId, post);
  deleteDraft(entry.identityId, entry.context, entry.localId);
  deleteDraft(entry.identityId, { ...entry.context, pendingId: entry.localId });
  const total = entry.draft.parts.length;
  toast.success(total > 1 ? `Thread with ${total} posts created!` : SUCCESS[entry.context.mode]);
}

/**
 * The orphan a ticket the app has not followed belongs to: only when exactly
 * one could have made it (two posts cut short together cannot be told apart,
 * so neither is guessed; Check again then leaves each to Edit). None while a
 * submit still waits for its own.
 */
function orphanFor(ticket: WriteTicket, entries: PendingPost[]): PendingPost | undefined {
  if (submitting > 0) return undefined;
  const candidates = entries.filter((e) => e.orphaned && !e.ticketId && ticketMatches(e, ticket));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** A ticket update for a pending post: track it, finish it, or bring its text back to the draft. */
function receiveTicket(ticket: WriteTicket): void {
  const entries = Object.values(usePendingPosts.getState().entries);
  if (entries.some((e) => e.ticketId === ticket.id) === false) {
    // Not ours yet: a cut-short call's ticket, restored by the engine.
    const orphan = orphanFor(ticket, entries);
    if (!orphan) return;
    patchEntry(orphan.localId, { ticketId: ticket.id, orphaned: false, lost: false });
  }
  const entry = Object.values(usePendingPosts.getState().entries).find((e) => e.ticketId === ticket.id);
  if (!entry || entry.confirmedAt) return;
  const before = pendingStatus(entry)?.state;
  const next = { ...entry, ticket };
  if (ticket.state === 'confirmed') {
    confirmed(entry, ticket);
    return;
  }
  patchEntry(entry.localId, { ticket });
  const after = pendingStatus(next)?.state;
  if (before === after) return;
  if (after === 'failed' || after === 'partial') settleFailure(next);
  // Unprovable: the text stays with the card for Edit, unless there is no card.
  else if (after === 'uncertain' && next.placement === 'none') settleFailure(next);
}

/**
 * `content.created` for a post this device is still publishing (a thread's
 * first part, before the ticket names it): the card becomes that post, so a
 * feed refetch never shows it twice.
 */
function adoptCreated({ post }: ContentCreatedEvent): void {
  const entry = Object.values(usePendingPosts.getState().entries).find(
    (e) =>
      !e.confirmedAt &&
      !e.adoptedId &&
      e.placement !== 'none' &&
      e.identityId === post.author.id &&
      e.post.kind === post.kind &&
      (e.post.parentId ?? null) === (post.parentId ?? null) &&
      (e.post.quotedPostId ?? null) === (post.quotedPostId ?? null) &&
      e.post.content === post.content.trim(),
  );
  if (!entry) return;
  patchEntry(entry.localId, { adoptedId: post.id });
  replaceInCaches(entry.localId, { ...entry.post, ...post });
}

/** Asks the engine for every pending ticket of the account (after a restart); a ticket it no longer has goes. */
function reconcile(identityId: string): void {
  for (const entry of Object.values(usePendingPosts.getState().entries)) {
    if (entry.identityId !== identityId || !entry.ticketId || entry.confirmedAt) continue;
    engine.api.writes
      .get(entry.ticketId)
      .then((ticket) => {
        const state = pendingStatus(entry)?.state;
        if (ticket) receiveTicket(ticket);
        else if (state !== 'failed' && state !== 'partial' && state !== 'uncertain') {
          // Pruned by the engine: it confirmed long ago. The next refresh shows the real post.
          dropEntry(entry.localId);
          replaceInCaches(entry.localId, null);
        }
      })
      .catch((error: unknown) => appendLog('warn', 'host', `Reading a pending post failed: ${errorMessage(error)}`));
  }
  // Calls a restart cut short: their tickets, if the engine made them.
  adoptOrphans()
    .then(() => {
      // A resumed thread has no card to check again from: with no ticket, its text returns to the draft.
      for (const entry of Object.values(usePendingPosts.getState().entries)) {
        if (entry.identityId !== identityId || !entry.orphaned || entry.ticketId || entry.placement !== 'none') continue;
        patchEntry(entry.localId, { lost: true });
        settleFailure(entry);
      }
    })
    .catch((error: unknown) => appendLog('warn', 'host', `Reading restored posts failed: ${errorMessage(error)}`));
}

/** Signing out deletes the account's drafts and the posts it had on their way (PRD AUTH-11). */
function forgetAccount(identityId: string): void {
  forgetDrafts(identityId);
  for (const entry of Object.values(usePendingPosts.getState().entries)) {
    if (entry.identityId === identityId) dropEntry(entry.localId);
  }
}

/** After a sign-out: every account seen here that is no longer on the device loses its compose data. */
function forgetSignedOut(seen: Set<string>): void {
  engine.api.session
    .accounts()
    .then((accounts) => {
      const kept = new Set(accounts.map((a) => a.identityId));
      const owners = Object.values(usePendingPosts.getState().entries).map((e) => e.identityId);
      for (const id of new Set([...seen, ...owners])) {
        if (!kept.has(id)) {
          forgetAccount(id);
          seen.delete(id);
        }
      }
    })
    .catch((error: unknown) => appendLog('warn', 'host', `Clearing signed-out drafts failed: ${errorMessage(error)}`));
}

/**
 * Starts following pending posts: their tickets, the lists that should show
 * them, and the account. The root layout starts it once; returns the stop.
 */
export function startPendingPosts(): () => void {
  const stopTickets = onEngineEvent('write.status', receiveTicket);
  const stopCreated = onEngineEvent('content.created', adoptCreated);
  const stopCache = queryClient.getQueryCache().subscribe((event) => {
    const loaded =
      (event.type === 'updated' && event.action.type === 'success') ||
      (event.type === 'added' && event.query.state.data !== undefined);
    if (loaded && listKind(event.query.queryKey)) placeCards([event.query]);
  });
  // Once per engine boot and account.
  let reconciled = '';
  const onSession = () => {
    const { status, session } = useSessionStore.getState();
    const key = `${engineSupervisor.getStatus().epoch}:${session?.identityId ?? ''}`;
    if (status !== 'signed-in' || !session || key === reconciled) return;
    reconciled = key;
    reconcile(session.identityId);
    placeCards();
  };
  const stopSession = useSessionStore.subscribe(onSession);
  onSession();
  // The accounts signed in here, for sign-out to clear.
  const seen = new Set<string>();
  const stopSeen = useSessionStore.subscribe(({ session }) => {
    if (session) seen.add(session.identityId);
  });
  const signedIn = useSessionStore.getState().session?.identityId;
  if (signedIn) seen.add(signedIn);
  const stopSignOut = onEngineEvent('session.changed', ({ reason }) => {
    if (reason === 'signed-out') forgetSignedOut(seen);
  });
  // A post deleted while pinned must not come back with the pin.
  const stopRemoved = useRemovedPosts.subscribe(({ ids }) => {
    for (const entry of Object.values(usePendingPosts.getState().entries)) {
      if (entry.confirmedAt && ids.has(entry.post.id)) dropEntry(entry.localId);
    }
  });
  return () => {
    stopTickets();
    stopCreated();
    stopCache();
    stopSession();
    stopSeen();
    stopSignOut();
    stopRemoved();
  };
}

/**
 * The write-status row for a post, when it is a pending card of the
 * signed-in account (PostItem renders it as the optimistic variant).
 */
export function usePendingWriteStatus(postId: string): WriteStatusProps | null {
  // The card, or the real post it became (adopted, or the root a resumed thread already posted).
  const entry = usePendingPosts(
    (s) => s.entries[postId] ?? Object.values(s.entries).find((e) => firstPostedId(e) === postId),
  );
  const viewerId = useSessionStore((s) => s.session?.identityId ?? null);
  if (!entry || entry.identityId !== viewerId) return null;
  const status = pendingStatus(entry);
  if (!status) return null;
  const { localId } = entry;
  return {
    status,
    onCheckAgain: () => checkPending(localId),
    onRetry: () => retryPending(localId),
    onRetryRest: () => retryPending(localId),
    onEdit: () => editPending(localId),
  };
}

/** The signed-in author for an optimistic card: their profile (given or cached), else the session's name. */
export function viewerAuthor(identityId: string, username: string | null, known?: ProfileDTO | null): AuthorDTO {
  const profile = known ?? queryClient.getQueryData<ProfileDTO | null>(queryKeys.profile.detail(identityId));
  if (profile) {
    return { id: identityId, username: profile.username, displayName: profile.displayName, avatar: profile.avatar, resolved: true };
  }
  const style = engineSupervisor.getStatus().info?.avatarStyles?.defaultStyle ?? 'thumbs';
  return {
    id: identityId,
    username,
    displayName: username ?? `User ${identityId.slice(-6)}`,
    avatar: { uri: null, dicebear: { style, seed: identityId } },
    resolved: true,
  };
}
