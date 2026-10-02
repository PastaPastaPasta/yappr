import type { BlockedUserDTO, ProfileDTO, WriteTicket } from '@engine/api';
import { type InvalidateQueryFilters } from '@tanstack/react-query';
import { useMemo } from 'react';
import { create } from 'zustand';

import { queryKeys } from '~/data/keys';
import { setAuthorBlocked } from '~/data/optimistic';
import { useEngineQuery, type EngineRemote } from '~/data/queries';
import { useSessionStore, useViewerId } from '~/data/session';
import { type WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';

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

/** How often a failed block-status read is asked again (about 2.5 minutes in all). */
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
}

function applyBlock({ viewerId, userId, block, message, user }: BlockVars): () => void {
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

/**
 * Block or unblock (`safety.block` / `safety.unblock`), one at a time per
 * user. Optimistic: the author's content goes (or comes back) at once.
 * Confirmed, the lists the engine filters by block status are read again.
 * An unblock that leaves a followed block list blocking the user fails with
 * `STILL_BLOCKED`: the posts stay hidden, the Blocked list drops the own
 * block that is gone, and the toast says why.
 */
export const blockWrite: WriteSpec<BlockVars> = {
  key: ({ userId }) => `block:${userId}`,
  submit: (api, { userId, block, message }) =>
    block ? api.safety.block(userId, message ? { message } : null) : api.safety.unblock(userId),
  optimistic: applyBlock,
  intent: ({ block }) => block,
  matches: (ticket, { userId, block }) => ticket.op === (block ? 'block' : 'unblock') && targetIdentity(ticket) === userId,
  onConfirmed: (_ticket, { block }) => refetchFiltered(block),
  // The own block is gone, but the user stays blocked: their posts stay hidden, their Blocked row goes.
  onFailed: (ticket, { viewerId, userId, block }) => {
    if (block || ticket.error?.code !== 'STILL_BLOCKED') return;
    decide(viewerId, userId, { blocked: true, listOnly: true });
    refetch(queryKeys.blocked);
  },
  failureText: (ticket) => (ticket.error?.code === 'STILL_BLOCKED' ? copy.toast.stillBlocked : null),
  noun: 'block',
  failureMessage: copy.toast.blockFailed,
};
