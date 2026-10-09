import type { BlockedUserDTO, BlockSourceDTO, ProfileDTO, WriteTicket } from '@engine/api';
import { hashKey, type InvalidateQueryFilters } from '@tanstack/react-query';
import { useMemo } from 'react';
import { create } from 'zustand';

import { queryKeys } from '~/data/keys';
import { setAuthorBlocked } from '~/data/optimistic';
import { useEngineQuery, type EngineRemote } from '~/data/queries';
import { getCapabilities, useSessionStore, useViewerId } from '~/data/session';
import { sendWrite, useLandingIntent, useLandingTicket, type WriteSpec } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { onMessagesBlockChosen, setBlockedInMessages } from '~/features/messages/dm-actions';
import { inboxReadHeld, inboxReadsSoFar, refreshDm } from '~/features/messages/dm-data';
import { queryClient } from '~/state/query-client';
import { errorFeedback } from '~/ui/haptics';
import { toast } from '~/ui/toast';

import { copy } from './copy';

/**
 * Blocks made on this device (PRD SAFE-01, SAFE-02, G-6). A block or unblock
 * takes effect everywhere at once: every `PostItem` of the author leaves
 * its list (or collapses to the blocked stub in a thread), their profile
 * shows the blocked notice, and the Blocked list gains or loses the row.
 *
 * The decision is kept per viewer and author until the account changes (a
 * sign-out or a switch), so a list read while the write is in flight (or
 * from the engine's own short cache of the block list) can't undo it on
 * screen. A failed write undoes the decision, and everything returns.
 */
interface Decision {
  blocked: boolean;
  /** Blocks: the account's row for the Blocked list, with the note given. */
  user?: BlockedUserDTO;
  /** Blocked only by a followed block list (`STILL_BLOCKED`): no own block to list. */
  listOnly?: boolean;
  /**
   * Confirmed (or overtaken by a choice made in Messages here): on DM v5 the
   * engine has it in Messages, so a read of them numbered from this one on
   * ({@link inboxReadsSoFar}), begun after, shows it. A read begun before
   * may still answer with Messages as they were.
   */
  readFrom?: number;
  /**
   * Once this decision has settled, Messages decide the conversation: a read
   * of them begun since `readFrom` has answered, so they show it and anything
   * changed in Messages alone since, here or on another device (Message
   * settings, a conversation's Block or Unblock). The account's block is
   * unchanged.
   */
  messagesDecide?: boolean;
}

const useBlockDecisions = create<{ byKey: Readonly<Record<string, Decision>> }>()(() => ({ byKey: {} }));

const decisionKey = (viewerId: string, authorId: string) => `${viewerId}:${authorId}`;

/** Forgets every decision. */
export function resetBlockDecisions(): void {
  useBlockDecisions.setState({ byKey: {} });
}

// A change of account forgets them, as `startDataLayer` forgets writes: signed back in, the engine's word counts
// again (an unblock made on web meanwhile shows).
useSessionStore.subscribe((state, previous) => {
  if (previous.status !== 'unknown' && state.session?.identityId !== previous.session?.identityId) {
    resetBlockDecisions();
  }
});

/**
 * The first read of Messages (by {@link inboxReadsSoFar}) that shows every
 * block change this device has seen land there. Until one numbered so far
 * has answered, the inbox is read again after each answer.
 */
let readAgainFrom = 0;

/** Messages just changed: only a read begun from now on shows it. Returns that read's number. */
function messagesChanged(): number {
  readAgainFrom = inboxReadsSoFar() + 1;
  return readAgainFrom;
}

/** `decided`, settled now: Messages decide once a read of them begun from here on has answered. */
const settledNow = (decided: Decision): Decision => ({ ...decided, readFrom: messagesChanged(), messagesDecide: false });

// A choice made in Messages alone is newer than the decision: the conversation follows Messages from the next read
// of them on (one begun before the choice still shows them as they were).
onMessagesBlockChosen((viewerId, peerId) => {
  const decided = useBlockDecisions.getState().byKey[decisionKey(viewerId, peerId)];
  if (decided && !decided.listOnly) decide(viewerId, peerId, settledNow(decided));
  else messagesChanged();
});

// Messages read after a block or unblock was confirmed already follow it (the engine follows it before it reports
// the confirmation): from then on they decide, so a choice synchronized from another device shows too (DM v5 only;
// legacy re-reads the account's blocks on its own time). Only a read begun after counts: one begun before (that a
// refresh joined rather than replaced) may answer with Messages from before, so the inbox is read again. A read
// patched here (`setQueryData`) is no read.
const conversationsHash = hashKey(queryKeys.dm.conversations);
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
  if (event.query.queryHash !== conversationsHash || getCapabilities()?.dm !== 'v5') return;
  const viewerId = useSessionStore.getState().session?.identityId;
  if (!viewerId || !event.query.state.data) return;
  const held = inboxReadHeld();
  // Out of this update: a read begun now is numbered at or past `readAgainFrom`, so this asks once.
  if (held < readAgainFrom) {
    Promise.resolve()
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations }))
      .catch(() => undefined);
  }
  const prefix = decisionKey(viewerId, '');
  const { byKey } = useBlockDecisions.getState();
  const read = Object.entries(byKey).filter(
    ([key, d]) => key.startsWith(prefix) && !d.messagesDecide && d.readFrom !== undefined && held >= d.readFrom,
  );
  if (read.length === 0) return;
  useBlockDecisions.setState({ byKey: { ...byKey, ...Object.fromEntries(read.map(([key, d]) => [key, { ...d, messagesDecide: true }])) } });
});

/**
 * Whether the viewer blocks `authorId`: the decision made on this device, else
 * what the engine said (`fallback`, e.g. `post.viewer.authorBlocked`).
 * Always false signed out.
 */
export function useAuthorBlocked(authorId: string | undefined, fallback?: boolean | null): boolean {
  const viewerId = useViewerId();
  const decided = useBlockDecisions((s) =>
    viewerId && authorId ? s.byKey[decisionKey(viewerId, authorId)]?.blocked : undefined,
  );
  if (!viewerId || !authorId) return false;
  return decided ?? fallback === true;
}

/** How often a failed block-status read is asked again (5, 10, 20 and 40 s apart). */
const BLOCK_STATUS_RETRIES = 4;

/** The engine's cap on one `safety.isBlocked` call. */
const STATUS_BATCH_MAX = 100;
let statusBatch: { ids: Set<string>; blocked: Promise<Record<string, boolean>> } | null = null;

/**
 * Whether the viewer blocks `userId` (own blocks and followed block lists),
 * asked in one `safety.isBlocked` call with every other card that asks in
 * the same tick. A failure rejects: cached as "not blocked", it would show a
 * blocked author's quote until the card remounted (lib's block-service warns
 * against exactly that false negative).
 */
function readBlockStatus(api: EngineRemote, userId: string): Promise<boolean> {
  let batch = statusBatch;
  if (!batch || batch.ids.size >= STATUS_BATCH_MAX) {
    const ids = new Set<string>();
    const blocked = Promise.resolve()
      .then(() => {
        if (statusBatch?.ids === ids) statusBatch = null;
        return api.safety.isBlocked([...ids]);
      });
    batch = statusBatch = { ids, blocked };
  }
  batch.ids.add(userId);
  return batch.blocked.then((statuses) => statuses[userId] === true);
}

/**
 * {@link useAuthorBlocked} for a quoted post's author. The engine reads
 * block status only for the posts it lists, not for the posts they quote,
 * so a quote's own flag can't tell a block made before this session: this
 * asks the engine (batched across cards), unless the flag already says so.
 */
export function useQuotedAuthorBlocked(authorId: string | undefined, fallback?: boolean | null): boolean {
  const viewerId = useViewerId();
  const id = authorId ?? '';
  const ask = viewerId !== null && id !== '' && id !== viewerId && fallback !== true;
  const { data: blocked } = useEngineQuery(queryKeys.blockStatus(id), (api) => readBlockStatus(api, id), {
    enabled: ask,
    // Asked again with backoff, so an engine that was down (a cold start offline) answers once it is up.
    retry: BLOCK_STATUS_RETRIES,
    retryDelay: (attempt) => Math.min(5000 * 2 ** attempt, 60_000),
  });
  return useAuthorBlocked(authorId, fallback === true || (ask && blocked === true));
}

/**
 * The Blocked list as the engine read it, with this device's decisions on
 * top: accounts unblocked here leave (also when a followed block list still
 * blocks them), accounts blocked here come first.
 */
export function useBlockedList(viewerId: string, listed: readonly BlockedUserDTO[]): BlockedUserDTO[] {
  const byKey = useBlockDecisions((s) => s.byKey);
  return useMemo(() => {
    const prefix = `${viewerId}:`;
    const decided = new Map<string, Decision>();
    for (const [key, decision] of Object.entries(byKey)) {
      if (key.startsWith(prefix)) decided.set(key.slice(prefix.length), decision);
    }
    const ownBlock = (d: Decision | undefined) => d === undefined || (d.blocked && !d.listOnly);
    const kept = listed.filter((user) => ownBlock(decided.get(user.id)));
    const shown = new Set(kept.map((user) => user.id));
    const added = [...decided.values()].flatMap((d) => (ownBlock(d) && d.user && !shown.has(d.user.id) ? [d.user] : []));
    return [...added.reverse(), ...kept];
  }, [byKey, viewerId, listed]);
}

function decide(viewerId: string, authorId: string, decision: Decision | undefined): void {
  useBlockDecisions.setState(({ byKey }) => {
    const next = { ...byKey };
    const key = decisionKey(viewerId, authorId);
    if (decision === undefined) delete next[key];
    else next[key] = decision;
    return { byKey: next };
  });
}

/** Every cached profile of the user (by id and by DPNS name) shows `blocks`. Returns the undo. */
function patchProfiles(userId: string, blocks: boolean): () => void {
  const previous: [readonly unknown[], ProfileDTO][] = [];
  for (const [key, data] of queryClient.getQueriesData<ProfileDTO | null>({ queryKey: queryKeys.profile.all })) {
    // Profile details only: `[...root, 'profile', idOrName]`.
    if (key.length !== queryKeys.profile.all.length + 1 || !data?.viewer || data.id !== userId) continue;
    if (data.viewer.blocks === blocks) continue;
    previous.push([key, data]);
    queryClient.setQueryData(key, { ...data, viewer: { ...data.viewer, blocks } }, {
      updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt,
    });
  }
  return () => {
    for (const [key, data] of previous) queryClient.setQueryData(key, data);
  };
}

const refetch = (queryKey: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
};

/** Queries under `prefix` for one id: the detail itself (`[...prefix, id]`) and `[...prefix, id, part]`. */
const detailOr = (prefix: readonly unknown[], part: string): InvalidateQueryFilters => ({
  queryKey: prefix,
  predicate: ({ queryKey }) => {
    const segment = queryKey[prefix.length + 1];
    return segment === undefined || segment === part;
  },
});

/**
 * Everything the engine filters by block status as it builds it: lists, a
 * post with its thread, a profile with its posts. Not a post's stats, poll
 * or report check, which don't depend on it.
 */
const BLOCK_FILTERED: InvalidateQueryFilters[] = [
  { queryKey: queryKeys.feed.all },
  { queryKey: queryKeys.explore.all },
  { queryKey: queryKeys.bookmarks },
  { queryKey: queryKeys.notificationsAll },
  { queryKey: queryKeys.blockStatusAll },
  detailOr(queryKeys.post.all, 'thread'),
  detailOr(queryKeys.profile.all, 'posts'),
];

/**
 * After a confirmed block or unblock. A block needs nothing read now (this
 * device's decision already hides the author everywhere), so lists are only
 * marked stale for their next showing; an unblock reads what is on screen
 * again, where the engine had left the author's posts out.
 */
function refetchFiltered(block: boolean): void {
  refetch(queryKeys.blocked);
  for (const filters of BLOCK_FILTERED) {
    queryClient.invalidateQueries({ ...filters, refetchType: block ? 'none' : 'active' }).catch(() => undefined);
  }
}

export interface BlockVars {
  /** The signed-in viewer, whose decision this is. */
  viewerId: string;
  userId: string;
  /** Block (`true`) or unblock. */
  block: boolean;
  /** The public note (block only, at most 280 characters). */
  message?: string;
  /** Block only: who it is, for the Blocked list's row until the engine lists them. */
  user?: Pick<BlockedUserDTO, 'username' | 'displayName' | 'avatar'>;
  /** Who, as the screen shows them ("@bob"), for its toasts. */
  handle?: string;
}


/**
 * Messages follow the account's blocks by themselves (PRD SAFE-01, SAFE-02):
 * on DM v5 the engine blocks or unblocks them there once the block or
 * unblock is confirmed (also when a check confirms it after a relaunch),
 * and catches up with the account's block list at every start, so one Block
 * covers Messages too and none outlives a block that never landed
 * (RC16-A-02). Until then the conversation shows this device's decision
 * (`useConversationBlocked`). This re-reads Messages' status for Message
 * settings' Blocked list.
 */
function refreshMessages(): void {
  messagesChanged();
  refreshDm();
}

function applyBlock(vars: BlockVars): () => void {
  const { viewerId, userId, block, message, user } = vars;
  const before = useBlockDecisions.getState().byKey[decisionKey(viewerId, userId)];
  const row: BlockedUserDTO | undefined =
    block && user ? { ...user, id: userId, resolved: true, message: message ?? null } : undefined;
  decide(viewerId, userId, { blocked: block, user: row });
  const undoProfiles = patchProfiles(userId, block);
  // The decision lives in memory; the cached posts carry it across a relaunch (SR-25).
  const undoPosts = setAuthorBlocked(userId, block);
  return () => {
    decide(viewerId, userId, before);
    undoProfiles();
    undoPosts();
    refetch(queryKeys.profile.detail(userId));
  };
}

const targetIdentity = (ticket: WriteTicket) => (ticket.target as { identityId?: string } | null)?.identityId;

/** "@alice" for the toasts: the handle given, else the row being blocked, else the cached profile; null when unknown. */
function handleOf({ userId, user, handle }: BlockVars): string | null {
  if (handle) return handle;
  const username = user?.username ?? queryClient.getQueryData<ProfileDTO | null>(queryKeys.profile.detail(userId))?.username;
  return username ? `@${username}` : null;
}

/**
 * Block or unblock (`safety.block` / `safety.unblock`), one at a time per
 * user. Optimistic: the author's content goes (or comes back) at once, and
 * a failure (or a check proving it never landed) brings everything back.
 * Only a confirmed write says "Blocked @x", reaches Messages (the engine
 * follows it there, `refreshMessages`), and reads the lists the engine filters by block
 * status again; one not confirmed yet stays busy ("Blocking…") while the
 * app checks it. An unblock that leaves a followed block list blocking the
 * user fails with `STILL_BLOCKED`: the posts stay hidden, the Blocked list
 * drops the own block that is gone (and Messages with it), and the toast
 * says why.
 */
const blockKey = (userId: string) => `block:${userId}`;

/**
 * Whether a block or unblock of `userId` may still land: `'blocking'`,
 * `'unblocking'`, or null. While it may, the screens show it as busy and hold
 * back the opposite action (`blockWrite.serial`). It settles once confirmed,
 * refused, or checked: normally within about two minutes, longer only while
 * Dash Platform can't be read.
 */
export function useBlockBusy(userId: string | undefined): 'blocking' | 'unblocking' | null {
  const intent = useLandingIntent(userId ? blockKey(userId) : undefined);
  if (intent === true) return 'blocking';
  if (intent === false) return 'unblocking';
  return null;
}

/** The ticket of a block or unblock of `userId` that may still land (`useLandingTicket`), for "Check again". */
export function useBlockTicket(userId: string | undefined): WriteTicket | null {
  return useLandingTicket(userId ? blockKey(userId) : undefined);
}

/**
 * Whether a conversation with `peerId` shows them as blocked (the
 * composer's banner, the menu's Unblock): this device's block decision when
 * it made one, as the profile and the Blocked list show it, else what
 * Messages say (`flagged`, which on DM v5 also counts a block made only in
 * Messages), and what they say again once that decision has settled (it
 * was confirmed, or a choice was made in Messages here) and a read of
 * Messages begun since has answered (a choice made in Messages alone after
 * it then shows, from this device or another); a read begun before may
 * still show Messages from before. A block that fails or never lands takes the
 * banner with it, and Messages only follow a block once it is confirmed (`refreshMessages`),
 * so none outlives it (RC16-A-02). An unblock still on its way keeps it:
 * Messages block them until it is confirmed.
 */
export function useConversationBlocked(peerId: string | undefined, flagged: boolean): boolean {
  const viewerId = useViewerId();
  const decided = useBlockDecisions((s) => (viewerId && peerId ? s.byKey[decisionKey(viewerId, peerId)] : undefined));
  const busy = useBlockBusy(peerId);
  if (busy === 'unblocking') return true;
  // Blocked only by a followed list: Messages were lifted with the own block (`onFailed`), so they decide.
  if (!decided || decided.listOnly || (decided.messagesDecide && busy === null)) return flagged;
  return decided.blocked;
}

export const blockWrite: WriteSpec<BlockVars> = {
  key: ({ userId }) => blockKey(userId),
  // A block and an unblock of one user never overlap: the opposite action waits until the first can't land.
  // Its key is never contested, so nothing has to be reconciled from the chain afterwards (Messages included).
  serial: (vars) => (vars.block ? copy.toast.stillUnblocking(handleOf(vars)) : copy.toast.stillBlocking(handleOf(vars))),
  submit: (api, { userId, block, message }) =>
    block ? api.safety.block(userId, message ? { message } : null) : api.safety.unblock(userId),
  optimistic: applyBlock,
  // Never reached for a serial key; if it were, this device's decision would outrank the status read back.
  reconcile: ({ viewerId, userId }) => decide(viewerId, userId, undefined),
  intent: ({ block }) => block,
  matches: (ticket, { userId, block }) => ticket.op === (block ? 'block' : 'unblock') && targetIdentity(ticket) === userId,
  onConfirmed: (_ticket, vars) => {
    const { viewerId, userId, block } = vars;
    const decided = useBlockDecisions.getState().byKey[decisionKey(viewerId, userId)];
    if (decided?.blocked === block && !decided.listOnly) decide(viewerId, userId, settledNow(decided));
    refreshMessages();
    refetchFiltered(block);
    const handle = handleOf(vars) ?? 'this account';
    toast.success(block ? copy.toast.blocked(handle) : copy.toast.unblocked(handle));
  },
  // The own block is gone, but the user stays blocked: their posts stay hidden, their Blocked row goes.
  onFailed: (ticket, { viewerId, userId, block }) => {
    if (block || ticket.error?.code !== 'STILL_BLOCKED') return;
    decide(viewerId, userId, { blocked: true, listOnly: true });
    refreshMessages();
    refetch(queryKeys.blocked);
  },
  failureText: (ticket) => (ticket.error?.code === 'STILL_BLOCKED' ? copy.toast.stillBlocked : null),
  failureMessage: (vars) => copy.toast.blockFailed(vars.block, handleOf(vars)),
};

/**
 * Where the account's block on `peerId` comes from, or null when it isn't
 * blocked. A failed read falls back to this device's decision, and rejects
 * without one: guessing "not blocked" would lift only Messages on an Unblock
 * and still say "Unblocked".
 */
async function accountBlockOf(viewerId: string, peerId: string): Promise<BlockSourceDTO | null> {
  try {
    return (await engine.api.safety.blockedBy([peerId]))[peerId] ?? null;
  } catch (error) {
    const decided = useBlockDecisions.getState().byKey[decisionKey(viewerId, peerId)];
    if (!decided) throw error;
    if (!decided.blocked) return null;
    return decided.listOnly ? 'list' : 'self';
  }
}

/** Peers whose conversation Block or Unblock is reading the account's block: a repeat tap does nothing meanwhile. */
const conversationReads = new Set<string>();

async function whileReading<T>(peerId: string, idle: T, run: () => Promise<T>): Promise<T> {
  if (conversationReads.has(peerId)) return idle;
  conversationReads.add(peerId);
  try {
    return await run();
  } finally {
    conversationReads.delete(peerId);
  }
}

/**
 * "Block" from a DM v5 conversation, which shows it while Messages don't
 * block them. Not blocked yet (or the account's block can't be read): 'sheet',
 * for the Block sheet (which blocks in Messages too). Already blocked on the
 * account (a block from before Block covered Messages, or made on web): only
 * Messages is left, so it blocks there now, with the same "Blocked @x".
 * 'done' too for a repeat tap while the first is still reading.
 */
export function blockFromConversation(viewerId: string, peerId: string, handle: string): Promise<'sheet' | 'done'> {
  return whileReading(peerId, 'done' as const, async () => {
    const source = await accountBlockOf(viewerId, peerId).catch(() => null);
    if (source === null) return 'sheet';
    await setBlockedInMessages(peerId, true, copy.toast.blocked(handle));
    return 'done';
  });
}

/**
 * "Unblock" from a DM v5 conversation, which shows it for a block in
 * Messages: the account's own block goes too when there is one (it lifts
 * Messages with it), else only the block in Messages (one made in Messages
 * on web). The same "Unblocked @x" either way. When the account's block
 * can't be read, nothing changes and the toast asks to try again.
 */
export function unblockFromConversation(viewerId: string, peerId: string, handle: string): Promise<void> {
  return whileReading(peerId, undefined, async () => {
    let source: BlockSourceDTO | null;
    try {
      source = await accountBlockOf(viewerId, peerId);
    } catch (error) {
      appendLog('warn', 'host', `Reading the block before an unblock failed: ${errorMessage(error)}`);
      errorFeedback();
      toast.error(copy.toast.unblockFailed(handle));
      return;
    }
    if (source === 'self') {
      sendWrite(blockWrite, { viewerId, userId: peerId, block: false, handle });
    } else {
      await setBlockedInMessages(peerId, false, copy.toast.unblocked(handle));
    }
  });
}
