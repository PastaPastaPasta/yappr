import type { EngineErrorData, WriteState, WriteTicket } from '@engine/api';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import { config } from '~/config';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { errorFeedback } from '~/ui/haptics';
import { toast, type ToastAction } from '~/ui/toast';

import { isOffline } from './connectivity';
import { onEngineEvent } from './events';
import { queryKeys } from './keys';
import type { EngineRemote } from './queries';
import { recheck, reconcile, resetReconciler, stopReconciling, ticketJob } from './reconcile';
import { promptSignIn } from './require-auth';
import { useSessionStore } from './session';
import { SESSION_EXPIRED_MESSAGE, failedForSession, markSessionExpired, signInAgain } from './session-expiry';

/** Writes: tickets, rollback and toasts. The rules are in src/data/README.md ("Writes"). */

export interface WriteSpec<V> {
  /** Submit the write and resolve with its ticket: `(api, target) => api.engage.like(target)`. */
  submit: (api: EngineRemote, vars: V) => Promise<WriteTicket>;
  /**
   * Writes with the same key (`like:<postId>`) go one at a time: `run` while
   * the last one is still pending does nothing. Retry applies only to the
   * latest write for a key.
   */
  key?: (vars: V) => string;
  /** Apply the optimistic change and return its undo (`setViewerState` and friends). */
  optimistic?: (vars: V) => () => void;
  /**
   * Apply the change again, to the queries named only (by hash): a read that
   * landed while the write was on its way (queued, or its call still running)
   * may predate it, and would otherwise put the old state back over the
   * change until the next read.
   */
  reapply?: (vars: V, queries: ReadonlySet<string>) => void;
  /**
   * The write's failure sentence ("Couldn't like this post. Try again."),
   * for a refusal and for a write a check proved absent alike, unless the
   * engine's code has its own (`writeFailureText`). A function words it per
   * write ("Couldn't unlike this post. Try again.").
   */
  failureMessage: string | ((vars: V) => string);
  onConfirmed?: (ticket: WriteTicket, vars: V) => void;
  /**
   * The failure toast for a ticket, when the write has something more
   * specific to say than the default (a partly posted thread); null falls
   * back to the default.
   */
  failureText?: (ticket: WriteTicket, vars: V) => string | null;
  /**
   * The failure toast's action, when the write has a better one than Retry
   * (a post whose image link can't be read: Edit, to fix the link); null
   * keeps the default.
   */
  failureAction?: (ticket: WriteTicket, vars: V) => ToastAction | null;
  /**
   * A failure that is nobody's fault and needs no fix (a report withdrawn
   * that was already gone): its toast is neutral, with no error haptic and
   * no action.
   */
  failureNeutral?: (ticket: WriteTicket, vars: V) => boolean;
  /**
   * The latest write for its key failed, after its optimistic change was
   * undone: for a failure that changed state anyway (an unblock that deleted
   * the own block, but a followed block list still blocks).
   */
  onFailed?: (ticket: WriteTicket, vars: V) => void;
  /**
   * What the write asks for (`like ? 'liked' : 'unliked'`). A write made
   * while one with the same key is pending is queued; if it asks for what
   * the pending one asked, the queue is dropped instead (a like, unlike,
   * like run sends one like).
   */
  intent?: (vars: V) => unknown;
  /**
   * Recognises this write's ticket after an engine restart or timeout cut
   * the call short (the engine restores the ticket as `unconfirmed` on its
   * next boot), so the tracker can follow it again.
   */
  matches?: (ticket: WriteTicket, vars: V) => boolean;
  /**
   * The tracker adopted `ticket` for this cut-short write (`matches`): for a
   * screen that keeps its own record of the write, so it can follow the
   * ticket from here (a DM's outbox bubble).
   */
  onAdopted?: (ticket: WriteTicket, vars: V) => void;
  /**
   * The engine refused the call itself (validation, `NOT_SUPPORTED`,
   * `QUOTE_HAS_TEXT`, ...): no ticket was made. Return true when handled;
   * otherwise a failure toast shows. `NOT_SIGNED_IN` opens the sign-in sheet.
   */
  onRejected?: (error: unknown, vars: V) => boolean;
}

interface Tracked {
  spec: WriteSpec<unknown>;
  vars: unknown;
  key: string | undefined;
  undo: (() => void) | null;
  /** The last ticket state acted on, so a repeated event doesn't toast twice. */
  handled: string;
}

/**
 * What `runWrite` did:
 * - `submitted`: the engine took it (`ticket` follows it from here);
 * - `queued`: a write with the same key was pending; this one is sent once
 *   that settles (or dropped, if it asked for the same thing);
 * - `refused`: the engine refused the call; the change was undone and the
 *   user told (or `onRejected` / the sign-in sheet handled it);
 * - `unknown`: the engine restarted or timed out under the call, so it may
 *   have landed. The change stays, and the tracker adopts the ticket the
 *   engine restores on its next boot.
 */
export type WriteResult =
  | { status: 'submitted'; ticket: WriteTicket }
  | { status: 'queued' }
  | { status: 'refused'; error: unknown }
  | { status: 'unknown'; error: unknown };

const tracked = new Map<string, Tracked>();
/**
 * Every ticket a write has followed this session, kept after it settles: it
 * is that write's, so a cut-short write never adopts it (a later write's
 * ticket that landed, listed again by `writes.list`).
 */
const followed = new Set<string>();

function track(id: string, entry: Tracked): void {
  tracked.set(id, entry);
  followed.add(id);
}

/** Whether a write of this session follows, or followed, ticket `id`. */
export function isFollowedWrite(id: string): boolean {
  return followed.has(id);
}
const latestByKey = new Map<string, string>();
/**
 * Keys with writes that overlapped: one was sent while another for the key
 * may still have landed. Their optimistic changes are stacked on each other,
 * so undoing one can put back another that never landed, or take away one
 * that did: a failure among them reads the chain instead (`readChain`).
 * Cleared once no write for the key may still land, and the chain has been
 * read back into the cache (`repairFromChain`).
 */
const contested = new Set<string>();
/** Keys whose chain read (`repairFromChain`) is still on its way, with how many. */
const repairing = new Map<string, number>();
/**
 * Per key, every cached query its writes' optimistic changes (and their
 * `reapply`) wrote, recorded as they write it, whatever the helper: a
 * profile by id or by name, the viewer's own, an author inside a feed or a
 * post. Kept while a write for the key may land or the key is contested;
 * `repairFromChain` takes them.
 */
const touched = new Map<string, Set<string>>();

/** Runs an optimistic change (or a `reapply`) for `key`, recording each query it writes. */
function touching<T>(key: string | undefined, change: () => T): T {
  if (key === undefined) return change();
  const hashes = touched.get(key) ?? new Set<string>();
  touched.set(key, hashes);
  const stop = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'success' && event.action.manual) hashes.add(event.query.queryHash);
  });
  try {
    return change();
  } finally {
    stop();
  }
}

/** A write, as the queue and the tracker hold it. */
interface WriteOf {
  spec: WriteSpec<unknown>;
  vars: unknown;
}

/**
 * Keys whose submit or retry hasn't answered yet, with the write that asks.
 * Each call marks its key with its own token and clears only that mark: a
 * queued write released while the call settles marks the key itself.
 */
const submitting = new Map<string, WriteOf & { token: symbol; retryOf?: string; since?: number }>();

/**
 * The call marked for `key` whose outcome is still unknown: a submit (it has
 * no ticket yet), or a Retry whose ticket has not settled since the Retry
 * began (or runs on, `STILL_SENDING`). A Retry whose attempt the engine has
 * already reported settled is not on its way while its call answers: its
 * change is not put back on reads, nothing queues behind it, and it no
 * longer may land.
 */
function callOnItsWay(key: string) {
  const call = submitting.get(key);
  if (!call || call.retryOf === undefined) return call;
  const ticket = useWriteTickets.getState().byId[call.retryOf];
  if (!ticket || time(ticket.updatedAt) <= (call.since ?? 0)) return call;
  return stillRunning(ticket) ? call : undefined;
}

/**
 * Marks `key` busy for one call; the result clears the mark if it is still
 * that call's. `retryOf` names the ticket a Retry call is for: that call is
 * the ticket's own, not a newer write. `since` is when that ticket last
 * changed before the Retry, to tell its new attempt's outcome from the old.
 */
function markSubmitting(key: string | undefined, write: WriteOf, retryOf?: string, since?: number): () => void {
  if (key === undefined) return () => undefined;
  const token = Symbol(key);
  submitting.set(key, { ...write, token, retryOf, since });
  return () => {
    if (submitting.get(key)?.token === token) submitting.delete(key);
  };
}

interface Waiting extends WriteOf {
  key: string | undefined;
  /** Its optimistic change, applied when it was made. */
  undo: (() => void) | null;
  at: number;
}

/** The latest write per key made while another with that key was pending. */
const queued = new Map<string, Waiting>();
/** Writes whose call an engine restart or timeout cut short, until their ticket shows up. */
let orphans: Waiting[] = [];
const ORPHAN_MS = 10 * 60_000;
/** A restored ticket was made by the call that was cut short, so not long before it (clock skew). */
const ORPHAN_SKEW_MS = 5_000;

/** The engine went away under the call: it may or may not have run. */
const OUTCOME_UNKNOWN = new Set(['ENGINE_RESTARTED', 'ENGINE_DISCONNECTED', 'ENGINE_TIMEOUT', 'RPC_TIMEOUT']);

/** Every ticket this app has seen, by id. */
const useWriteTickets = create<{ byId: Record<string, WriteTicket> }>()(() => ({ byId: {} }));

const MAX_TICKETS = 200;

const time = (date: Date | null | undefined) => (date ? new Date(date).getTime() : 0);

/**
 * The write's call still runs: pending, or unconfirmed by the engine's
 * deadline (`STILL_SENDING`, PRD G-3) while it waits on the network. Its
 * answer will settle it, so its key stays busy.
 */
const stillRunning = (ticket: WriteTicket | undefined) =>
  ticket?.state === 'pending' || (ticket?.state === 'unconfirmed' && ticket.error?.code === 'STILL_SENDING');

/** The engine error code of a rejected call (`RemoteError.code`), if any. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Stores a ticket and returns the copy to act on. The engine emits every
 * transition as `write.status` before it answers the call, so an event
 * always replaces what is held, and a call's answer only fills in a ticket
 * no event has reported yet.
 */
function record(ticket: WriteTicket, from: 'event' | 'call'): WriteTicket {
  const known = useWriteTickets.getState().byId[ticket.id];
  if (known && from === 'call') return known;
  useWriteTickets.setState(({ byId }) => {
    const next = { ...byId, [ticket.id]: ticket };
    const ids = Object.keys(next);
    // Oldest first: drop tickets nobody follows.
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TICKETS))) {
      if (!tracked.has(id)) delete next[id];
    }
    return { byId: next };
  });
  return ticket;
}

/** PRD G-1: a write tapped while the OS reports no connectivity. */
export const OFFLINE_MESSAGE = "You're offline. Try again when you're connected.";

/**
 * The mobile copy for the engine codes that have something the user can act
 * on (PRD G-4, G-5; UX_SPEC §5.4 "Write failures"). Every other code
 * (consensus details, sponsor fees, the engine's own restarts) says the
 * write's own failure sentence. Web's `categorizeError` text never reaches a
 * toast: it goes to diagnostics (`logFailure`).
 */
const FAILURE_COPY: Partial<Record<EngineErrorData['code'], string>> = {
  INSUFFICIENT_CREDITS: "You don't have enough credits for this. Top up from your Dash wallet.",
  INSUFFICIENT_YAPP: 'You need YAPP for this.',
  NOT_OWNER: "You can't do this from this account.",
  MODERATION_BARRED: "You can't do this from this account.",
  TARGET_GONE: 'This post no longer exists.',
  APP_OUTDATED: 'Update Yappr and try again.',
  STALE: 'Update Yappr and try again.',
  BUILD_DEFECT: 'Something went wrong. Nothing was charged. Please report this.',
  MEDIA_UNREADABLE: "That image link didn't work. Edit the post to fix or remove it.",
};

/** A failed write's message: the mobile copy for its code, else the write's own sentence (`fallback`). */
export function writeFailureText(error: EngineErrorData | null, fallback: string): string {
  return (error && FAILURE_COPY[error.code]) ?? fallback;
}

/** A spec's failure sentence for these vars. */
function failureSentence<V>(spec: WriteSpec<V>, vars: V): string {
  return typeof spec.failureMessage === 'function' ? spec.failureMessage(vars) : spec.failureMessage;
}

/** Diagnostics only: what the engine said about a failed write (its code, consensus code and web's text). */
function logFailure(ticket: WriteTicket): void {
  const { error } = ticket;
  if (!error) return;
  const consensus = error.consensusCode === null ? '' : ` ${error.consensusCode}`;
  appendLog('warn', 'host', `Write ${ticket.op} ${ticket.id} ${ticket.state}: ${error.code}${consensus}: ${error.userMessage}`);
}

/** "Get YAPP" (PRD G-5): where YAPP is bought, for this variant's network. */
const openYapprWeb: ToastAction = {
  label: 'Get YAPP',
  onPress: () => {
    WebBrowser.openBrowserAsync(`https://yap.pr${config.webBasePath}`).catch((error: unknown) =>
      appendLog('warn', 'host', `Opening yap.pr failed: ${errorMessage(error)}`),
    );
  },
};

function isLatest(id: string, entry: Tracked): boolean {
  return !entry.key || latestByKey.get(entry.key) === id;
}

function undo(entry: Tracked): void {
  entry.undo?.();
  entry.undo = null;
}

function fail(message: string, action?: ToastAction): void {
  errorFeedback();
  toast.error(message, { action });
}

/** Acts on a ticket's state once per change. */
function settle(ticket: WriteTicket): void {
  const key = tracked.get(ticket.id)?.key;
  settleTicket(ticket);
  if (key === undefined || ticket.state === 'pending') return;
  endContest(key);
  // Nothing for the key may land or be repaired: a plain undo is right again, and its copies need no repair.
  if (!contested.has(key) && !landingFor(key)) touched.delete(key);
}

function settleTicket(ticket: WriteTicket): void {
  const entry = tracked.get(ticket.id);
  if (!entry) return;
  const signature = `${ticket.state}:${ticket.retryable}:${time(ticket.updatedAt)}:${time(ticket.lastCheckedAt)}`;
  if (entry.handled === signature) return;
  entry.handled = signature;
  // Diagnostics' log: what happened to each write (op and state only).
  appendLog('info', 'host', `Write ${ticket.op} ${ticket.id}: ${ticket.state}${ticket.error ? ` (${ticket.error.code})` : ''}`);

  const { spec } = entry;
  const latest = isLatest(ticket.id, entry);
  const retry = latest && ticket.retryable ? { label: 'Retry', onPress: () => retryWrite(ticket.id) } : undefined;
  // Short of YAPP, nothing but getting more helps (PRD G-5); never a retry.
  const action = ticket.error?.code === 'INSUFFICIENT_YAPP' ? openYapprWeb : retry;

  switch (ticket.state) {
    case 'pending':
      return;
    case 'confirmed':
      entry.undo = null;
      tracked.delete(ticket.id);
      spec.onConfirmed?.(ticket, entry.vars);
      if (latest) release(entry.key, true);
      return;
    case 'failed': {
      // The account's stored key no longer signs (AUTH-14; `receive` marked it): a retry would fail the same way.
      const sessionFailed = failedForSession(ticket);
      if (ticket.error?.outcome === 'unknown' && !sessionFailed) {
        // Final, yet it may have landed (PRD G-3): the change stays and nothing is said, as for an
        // unconfirmed write; the next refresh shows the chain's truth (a post's card says it itself).
        logFailure(ticket);
        entry.undo = null;
        tracked.delete(ticket.id);
        if (latest) release(entry.key, true);
        return;
      }
      // Final unless the engine allows a retry.
      if (!ticket.retryable || sessionFailed) tracked.delete(ticket.id);
      const say = () => {
        if (sessionFailed) {
          failSessionExpired(signerOf(ticket));
          return;
        }
        const text = spec.failureText?.(ticket, entry.vars) ?? writeFailureText(ticket.error, failureSentence(spec, entry.vars));
        if (spec.failureNeutral?.(ticket, entry.vars)) toast(text);
        else fail(text, spec.failureAction?.(ticket, entry.vars) ?? action);
      };
      if (isContested(entry)) {
        readChain(ticket, entry, say);
        return;
      }
      // An older intent's failure: a newer write for this key decides the state, and says its own outcome.
      if (!latest) return;
      undo(entry);
      spec.onFailed?.(ticket, entry.vars);
      if (!sessionFailed) logFailure(ticket);
      say();
      // The undo restored what a queued write (the opposite toggle) asked for.
      release(entry.key, false);
      return;
    }
    case 'unconfirmed':
      if (ticket.retryable && isContested(entry)) {
        readChain(ticket, entry, () => fail(absentText(ticket, entry), retryOf(ticket)));
        return;
      }
      if (!latest) return;
      if (ticket.retryable) {
        // A check proved it did not land: the same sentence as a refusal.
        logFailure(ticket);
        undo(entry);
        spec.onFailed?.(ticket, entry.vars);
        fail(absentText(ticket, entry), retryOf(ticket));
        release(entry.key, false);
      } else if (!stillRunning(ticket)) {
        // It may have landed (PRD G-3): nothing to say, the reconciler checks it (`watch`). Send the
        // newer intent, which is harmless if it did not. Not while its call still runs: the newer one
        // would race it, so it waits for the call's answer.
        release(entry.key, true);
      }
  }
}

const retryOf = (ticket: WriteTicket): ToastAction => ({ label: 'Retry', onPress: () => retryWrite(ticket.id) });

/** A write a check proved absent: the same sentence as a refusal. */
const absentText = (ticket: WriteTicket, entry: Tracked) =>
  entry.spec.failureText?.(ticket, entry.vars) ?? failureSentence(entry.spec, entry.vars);

/** A write that may still land: on its way, or unconfirmed with no check proving it absent. */
const mayLand = (ticket: WriteTicket | undefined) =>
  ticket?.state === 'pending' || (ticket?.state === 'unconfirmed' && !ticket.retryable);

/**
 * Whether a write for `key` other than ticket `except` may still land (or is
 * on its way), or the cache is still being read back from the chain for it:
 * until then it may show a change no write made, which a new write's undo
 * would capture.
 */
function landingFor(key: string, except?: string): boolean {
  if (callOnItsWay(key) || repairing.has(key) || orphans.some((orphan) => orphan.key === key)) return true;
  const byId = useWriteTickets.getState().byId;
  for (const [id, entry] of tracked) {
    if (id !== except && entry.key === key && mayLand(byId[id])) return true;
  }
  return false;
}

/** A write for `key` is about to be sent: if another may still land, the key's writes overlap. */
function contest(key: string | undefined, except?: string): void {
  if (key !== undefined && landingFor(key, except)) contested.add(key);
}

function endContest(key: string): void {
  if (!landingFor(key)) contested.delete(key);
}

const isContested = (entry: Tracked) => entry.key !== undefined && contested.has(entry.key);

/**
 * When a chain read that did not succeed (it failed, or an optimistic change
 * cancelled it) is tried again; after these, the app's own next read of it
 * (focus, reconnect, NET-03's retry, the screen shown again) still counts.
 */
export const REPAIR_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000];

/** What `resetWriteTracking` stops: every chain read still waited for. */
const repairs = new Set<() => void>();

/**
 * Reads every engine query again for a contested key, and keeps the key
 * contested until each query on screen has been read successfully since: a
 * failed read leaves the optimistic data in place, so it repairs nothing,
 * and neither does a read an optimistic change cancelled (`updateCache`) or
 * a manual `setQueryData`. Such reads are tried again (`REPAIR_RETRY_MS`,
 * not while offline); meanwhile a write on the key is reconciled by reading
 * the chain, never by its captured snapshot. A query dropped from the cache
 * needs no repair. Every copy the key's writes changed (`touched`) that no
 * screen shows is dropped first: nothing would read it back, and a later
 * write's undo could take its never-landed change as the state to restore.
 */
function repairFromChain(key: string | undefined): void {
  if (key !== undefined) repairing.set(key, (repairing.get(key) ?? 0) + 1);
  const cache = queryClient.getQueryCache();
  // A copy the key's writes changed that no screen shows would never be read back: it goes, so it is
  // read afresh when next shown, and can never hand a later write's undo a change that never landed.
  const copies = key === undefined ? undefined : touched.get(key);
  if (key !== undefined) touched.delete(key);
  for (const hash of copies ?? []) {
    const copy = cache.get(hash);
    if (copy && copy.getObserversCount() === 0) queryClient.removeQueries({ queryKey: copy.queryKey, exact: true });
  }
  const outstanding = new Set(
    cache
      .findAll({ queryKey: queryKeys.all })
      .filter((query) => query.getObserversCount() > 0)
      .map((query) => query.queryHash),
  );
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A read a write on its way put its change back over is not the chain's: still to repair.
  const listener = (queryHash: string, news: RepairNews) => {
    if (news === 'reapplied') return;
    outstanding.delete(queryHash);
    if (outstanding.size === 0) finish();
  };
  startWriteTracking();
  repairListeners.add(listener);
  const stopWatching = () => {
    repairListeners.delete(listener);
  };
  /** Stops this repair; `release` also lets the key's contest end (not on an account reset). */
  const stop = (release: boolean) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    stopWatching();
    repairs.delete(abandon);
    if (!release || key === undefined) return;
    const left = (repairing.get(key) ?? 1) - 1;
    if (left > 0) repairing.set(key, left);
    else repairing.delete(key);
    endContest(key);
  };
  function finish() {
    stop(true);
  }
  function abandon() {
    stop(false);
  }
  repairs.add(abandon);
  const retry = (attempt: number) => {
    if (over) return;
    if (outstanding.size === 0) {
      finish();
      return;
    }
    const delay = REPAIR_RETRY_MS[attempt];
    if (delay === undefined) return;
    timer = setTimeout(() => {
      if (over) return;
      const read = isOffline()
        ? Promise.resolve()
        : queryClient.refetchQueries({ queryKey: queryKeys.all, predicate: (query) => outstanding.has(query.queryHash) });
      read.catch(() => undefined).then(() => retry(attempt + 1)).catch(() => undefined);
    }, delay);
  };
  queryClient
    .invalidateQueries({ queryKey: queryKeys.all })
    .catch(() => undefined)
    .then(() => retry(0))
    .catch(() => undefined);
}

/**
 * A write's own change is to be taken back with no ticket to settle: its
 * call was refused, its Retry was refused, or it was queued and dropped.
 * When the key's writes overlap, its undo is taken against a state another
 * may have changed (a write proved absent while this one was being sent):
 * every engine query is read again instead (`repairFromChain`), and true
 * says so. Called once the write's own call is no longer marked, so the key
 * can stop being contested once that read is done.
 */
function readsChain(key: string | undefined): boolean {
  if (key === undefined || !contested.has(key)) return false;
  repairFromChain(key);
  return true;
}

/**
 * A write whose key's writes overlapped failed, or was proved absent. No
 * undo of any of them runs (nor `onFailed`): each was taken against a state
 * another may have changed. Every query is read again instead, so the screen
 * shows the chain (lib keeps a confirmed own write over a read from a node
 * behind; a read landing while a write's call still runs gets that write's
 * change back, `reapply`). Only the user's latest action for the key says
 * anything: its failure, with its Retry, which applies its change again on
 * top of what the chain shows.
 */
function readChain(ticket: WriteTicket, entry: Tracked, say: () => void): void {
  for (const other of tracked.values()) {
    if (other.key === entry.key) other.undo = null;
  }
  entry.undo = null;
  logFailure(ticket);
  repairFromChain(entry.key);
  // A newer write's call still runs (not this ticket's own Retry): that one is the latest action.
  const call = entry.key === undefined ? undefined : callOnItsWay(entry.key);
  const latestAction = isLatest(ticket.id, entry) && (call === undefined || call.retryOf === ticket.id);
  if (!latestAction) return;
  say();
  release(entry.key, false);
}

/**
 * Hands an unknown outcome to the reconciler (`./reconcile`), and takes it
 * back once the ticket settles: every unconfirmed ticket of the active
 * account, followed by a spec or not, is checked automatically (5, 20, 80
 * and 130 s after, then on foreground and on reads that show it).
 */
function watch(ticket: WriteTicket): void {
  const key = ticketJob(ticket.id);
  const active = useSessionStore.getState().session?.identityId ?? null;
  const othersTicket = ticket.identityId !== null && active !== null && ticket.identityId !== active;
  if (ticket.state !== 'unconfirmed' || ticket.retryable || othersTicket) {
    stopReconciling(key);
    return;
  }
  // Its call still runs past the engine's deadline: its answer settles it, so its checks never run out.
  const running = stillRunning(ticket);
  // What a read shows it by: the post it names or created, or (a message) its conversation.
  const target = ticket.target;
  const shown = [
    target && 'id' in target ? target.id : null,
    target && 'conversationKey' in target ? target.conversationKey : null,
    ...ticket.documents.map((d) => d.id),
  ];
  reconcile(key, {
    run: async () => {
      const checked = await checkWrite(ticket.id);
      return checked !== null && (checked.state !== 'unconfirmed' || checked.retryable);
    },
    shownIn: (ids) => shown.some((id) => id !== null && ids.has(id)),
    canExhaust: !running,
    episode: running ? 'running' : 'settled',
  });
}

/**
 * The pending write for `key` settled: send the write queued behind it, or
 * drop it. A dropped write's change was applied over the pending one's, so
 * neither undo can be trusted to restore what the chain holds (a profile
 * undo leaves a copy another change has moved on): the key is contested,
 * and the chain read back (`repairFromChain`).
 */
function release(key: string | undefined, send: boolean): void {
  if (key === undefined) return;
  const next = queued.get(key);
  if (!next) return;
  queued.delete(key);
  if (send) {
    runQueued(next).catch(() => undefined);
  } else if (next.undo) {
    contested.add(key);
    repairFromChain(key);
  }
}

/**
 * The pending write for `key` was cut short (an engine restart or timeout):
 * the write queued behind it is dropped, its change undone, and the user
 * told. Sending it could race the cut-short call if that still runs, or reach
 * the next engine, which signs as another account after a switch (SR-05).
 */
function dropQueued(key: string | undefined): void {
  const next = key === undefined ? undefined : queued.get(key);
  if (!next || key === undefined) return;
  queued.delete(key);
  if (!readsChain(key)) next.undo?.();
  fail(failureSentence(next.spec, next.vars));
}

/** An untracked ticket (restored after an engine restart): follow it if a cut-short write recognises it. */
function adopt(ticket: WriteTicket): void {
  if (followed.has(ticket.id)) return;
  const now = Date.now();
  orphans = orphans.filter((o) => now - o.at < ORPHAN_MS);
  const orphan = orphans.find(
    (o) => time(ticket.createdAt) >= o.at - ORPHAN_SKEW_MS && o.spec.matches?.(ticket, o.vars) === true,
  );
  if (!orphan) return;
  orphans = orphans.filter((o) => o !== orphan);
  track(ticket.id, { spec: orphan.spec, vars: orphan.vars, key: orphan.key, undo: orphan.undo, handled: '' });
  if (orphan.key !== undefined) {
    // Still the latest write for its key unless one was made after it.
    const latestId = latestByKey.get(orphan.key);
    const latest = latestId === undefined ? undefined : useWriteTickets.getState().byId[latestId];
    if (!latest || time(latest.createdAt) < orphan.at) latestByKey.set(orphan.key, ticket.id);
  }
  orphan.spec.onAdopted?.(ticket, orphan.vars);
}

/** The account a ticket was signed for (the active one when the engine did not say). */
function signerOf(ticket: Pick<WriteTicket, 'identityId'>): string | null {
  return ticket.identityId ?? useSessionStore.getState().session?.identityId ?? null;
}

/** "Your session has expired" with "Sign in" for that account (AUTH-14). */
function failSessionExpired(identityId: string | null): void {
  fail(SESSION_EXPIRED_MESSAGE, identityId ? { label: 'Sign in', onPress: () => signInAgain(identityId) } : undefined);
}

function receive(ticket: WriteTicket, from: 'event' | 'call'): WriteTicket {
  // Every write the app hears of, followed by a spec or not (AUTH-14): its account must sign in again.
  if (ticket.state === 'failed' && failedForSession(ticket)) {
    const signer = signerOf(ticket);
    if (signer) markSessionExpired(signer);
  }
  if (orphans.length > 0) adopt(ticket);
  const current = record(ticket, from);
  settle(current);
  watch(current);
  return current;
}

/**
 * The write on its way for `key`, whose change a read must not undo: the one
 * queued behind the pending write (the latest intent), else the one whose
 * call still runs.
 */
function onItsWay(key: string): WriteOf | undefined {
  const waiting = queued.get(key) ?? callOnItsWay(key);
  if (waiting) return waiting;
  const id = latestByKey.get(key);
  const entry = id === undefined ? undefined : tracked.get(id);
  return entry && stillRunning(useWriteTickets.getState().byId[id ?? '']) ? entry : undefined;
}

/**
 * A read just landed in query `hash`. Read from the chain before the writes
 * on their way landed, it shows what they change as it was: each puts its
 * change back on that read (`reapply`). A follow, then an unfollow queued
 * behind it, would otherwise read as followed again when the profile is
 * reopened, until a read after both.
 */
function keepChangesOverRead(hash: string): boolean {
  const keys = new Set([...queued.keys(), ...submitting.keys(), ...latestByKey.keys()]);
  const only = new Set([hash]);
  const read = () => queryClient.getQueryCache().get(hash)?.state.data;
  const before = read();
  for (const key of keys) {
    const write = onItsWay(key);
    if (write?.spec.reapply) touching(key, () => write.spec.reapply?.(write.vars, only));
  }
  return read() !== before;
}

/**
 * What each chain repair (`repairFromChain`) hears of a query, from the one
 * listener that also puts changes back over reads: `read` when a fetch
 * landed as the chain says, `reapplied` when a write on its way put its
 * change back over it (that read repaired nothing), `removed`.
 */
type RepairNews = 'read' | 'reapplied' | 'removed';
const repairListeners = new Set<(queryHash: string, news: RepairNews) => void>();

let stopTracking: (() => void) | null = null;

/**
 * Follows `write.status`, and the reads that land while writes are on their
 * way, for the app's lifetime. Started by `startDataLayer` (and on the first
 * write).
 */
export function startWriteTracking(): () => void {
  if (!stopTracking) {
    const stopTickets = onEngineEvent('write.status', (ticket) => receive(ticket, 'event'));
    const stopReads = queryClient.getQueryCache().subscribe((event) => {
      const hash = event.query.queryHash;
      if (event.type === 'removed') {
        repairListeners.forEach((listener) => listener(hash, 'removed'));
        return;
      }
      // A fetch's result; `setQueryData` (an optimistic change itself) is `manual`.
      if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
      const news: RepairNews = keepChangesOverRead(hash) ? 'reapplied' : 'read';
      repairListeners.forEach((listener) => listener(hash, news));
    });
    stopTracking = () => {
      stopTickets();
      stopReads();
    };
  }
  return () => {
    stopTracking?.();
    stopTracking = null;
  };
}

/**
 * Forgets every write: on an account change, whose engine restart never
 * reports the old account's tickets again, so none of them may keep a key
 * busy for the next account.
 */
export function resetWriteTracking(): void {
  tracked.clear();
  followed.clear();
  latestByKey.clear();
  contested.clear();
  for (const abandon of [...repairs]) abandon();
  repairing.clear();
  touched.clear();
  // A call of the old account still running reapplies nothing to the next one's reads (its answer clears only its own mark).
  submitting.clear();
  queued.clear();
  orphans = [];
  useWriteTickets.setState({ byId: {} });
  resetReconciler();
}

const NO_INTENT = Symbol('no intent');

/** What the write pending for `key` asks for, `NO_INTENT` when none is pending. */
function pendingIntent(key: string): unknown {
  const marked = callOnItsWay(key);
  if (marked) return marked.spec.intent?.(marked.vars);
  const id = latestByKey.get(key);
  const entry = id === undefined ? undefined : tracked.get(id);
  if (!entry || !stillRunning(useWriteTickets.getState().byId[id!])) return NO_INTENT;
  return entry.spec.intent?.(entry.vars);
}

const inFlight = (key: string) => pendingIntent(key) !== NO_INTENT;

/**
 * Submits a write outside React (a list cell's handler) and says what
 * happened (`WriteResult`). A write whose key is pending is queued behind
 * it, with its optimistic change applied at once.
 */
export async function runWrite<V>(spec: WriteSpec<V>, vars: V): Promise<WriteResult> {
  startWriteTracking();
  if (isOffline()) {
    // PRD G-1: no optimistic change, nothing sent.
    toast(OFFLINE_MESSAGE);
    return { status: 'refused', error: Object.assign(new Error(OFFLINE_MESSAGE), { code: 'OFFLINE' }) };
  }
  const key = spec.key?.(vars);
  if (key !== undefined) {
    const pending = pendingIntent(key);
    if (pending !== NO_INTENT) {
      const undoQueued = touching(key, () => spec.optimistic?.(vars) ?? null);
      if (spec.intent && pending !== undefined && spec.intent(vars) === pending) {
        // Back to what the pending write asks for: nothing more to send.
        queued.delete(key);
      } else {
        queued.set(key, { spec: spec as WriteSpec<unknown>, vars, key, undo: undoQueued, at: Date.now() });
      }
      return { status: 'queued' };
    }
  }
  return send({ spec: spec as WriteSpec<unknown>, vars, key, undo: null, at: Date.now() });
}

function runQueued(waiting: Waiting): Promise<WriteResult> {
  return send(waiting);
}

/** Sends a write; `waiting.undo` set means its optimistic change is already applied. */
async function send(waiting: Waiting): Promise<WriteResult> {
  const { spec, vars, key } = waiting;
  // A ticket the call made is no older than the call (a timeout answers long after the engine made it).
  const calledAt = Date.now();
  contest(key);
  const done = markSubmitting(key, { spec, vars });
  let revert = waiting.undo;
  try {
    revert ??= touching(key, () => spec.optimistic?.(vars) ?? null);
    const ticket = await spec.submit(engine.api, vars);
    track(ticket.id, { spec, vars, key, undo: revert, handled: '' });
    if (key !== undefined) latestByKey.set(key, ticket.id);
    done();
    // `write.status` may have overtaken the call's answer: settle on the newest copy.
    return { status: 'submitted', ticket: receive(ticket, 'call') };
  } catch (error) {
    if (OUTCOME_UNKNOWN.has(errorCode(error) ?? '')) {
      // It may have run (PRD G-3): keep the change, say nothing, and follow the ticket the engine restores.
      appendLog('warn', 'host', `Write cut short: ${errorMessage(error)}`);
      orphans.push({ spec, vars, key, undo: revert, at: calledAt });
      done();
      dropQueued(key);
      return { status: 'unknown', error };
    }
    done();
    release(key, false);
    if (!readsChain(key)) revert?.();
    if (errorCode(error) === 'NOT_SIGNED_IN') {
      promptSignIn();
    } else if (errorCode(error) === 'KEY_REVOKED') {
      // Refused before a ticket was made, for the key itself (AUTH-14).
      const signer = useSessionStore.getState().session?.identityId ?? null;
      if (signer) markSessionExpired(signer);
      failSessionExpired(signer);
    } else if (!spec.onRejected?.(error, vars)) {
      appendLog('warn', 'host', `Write refused: ${errorMessage(error)}`);
      fail(failureSentence(spec, vars));
    }
    return { status: 'refused', error };
  } finally {
    done();
  }
}

/**
 * `runWrite`, answering with the ticket, or null when the write was queued,
 * refused or cut short. Use `runWrite` to tell those apart.
 */
export async function submitWrite<V>(spec: WriteSpec<V>, vars: V): Promise<WriteTicket | null> {
  const result = await runWrite(spec, vars);
  return result.status === 'submitted' ? result.ticket : null;
}

/**
 * A ticket read straight from the engine (`writes.get`, `writes.list`):
 * recorded and acted on as a `write.status` would be, so one still
 * `unconfirmed` (from before a relaunch, which the engine does not report
 * again) is checked by the reconciler too. Returns the copy to act on.
 */
export function noteTicket(ticket: WriteTicket): WriteTicket {
  return receive(ticket, 'call');
}

/**
 * After an engine boot: follow the tickets it restored for writes a restart
 * cut short (`writes.list`). Called by the data layer on every new engine.
 */
export async function adoptRestoredWrites(): Promise<void> {
  if (orphans.length === 0) return;
  for (const ticket of await engine.api.writes.list()) receive(ticket, 'call');
}

/**
 * One check of an unconfirmed write (`writes.check`); its `write.status` says
 * the outcome. Quiet: the reconciler runs it, and a check that could not run
 * proves nothing (null), so it is simply run again later.
 */
export async function checkWrite(ticketId: string): Promise<WriteTicket | null> {
  try {
    return receive(await engine.api.writes.check(ticketId), 'call');
  } catch (error) {
    appendLog('warn', 'host', `Check failed: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Checks an unconfirmed write now, through the reconciler (its `checking`
 * state shows): a tap on a write whose automatic checks ran out. The
 * ticket as it stands after the check.
 */
export async function recheckWrite(ticketId: string): Promise<WriteTicket | null> {
  if ((await recheck(ticketJob(ticketId))) === null) return checkWrite(ticketId);
  return useWriteTickets.getState().byId[ticketId] ?? null;
}

/**
 * Re-sends a write the engine proved did not land (`writes.retry`), with its
 * optimistic change. Only the latest write for its key, and not while
 * another is in flight: an older toast's Retry would re-send an older intent.
 */
export async function retryWrite(ticketId: string): Promise<WriteTicket | null> {
  const entry = tracked.get(ticketId);
  if (!entry) return null;
  const { key } = entry;
  // A stale Retry (a newer write for its key decides the state, or one is on its way): nothing to do.
  if (!isLatest(ticketId, entry) || (key !== undefined && inFlight(key))) return null;
  if (isOffline()) {
    toast(OFFLINE_MESSAGE);
    return null;
  }
  contest(key, ticketId);
  const done = markSubmitting(key, { spec: entry.spec, vars: entry.vars }, ticketId, time(writeTicketOf(ticketId)?.updatedAt));
  try {
    const { optimistic } = entry.spec;
    if (!entry.undo && optimistic) entry.undo = touching(key, () => optimistic(entry.vars));
    return receive(await engine.api.writes.retry(ticketId), 'call');
  } catch (error) {
    done();
    if (readsChain(key)) entry.undo = null;
    else undo(entry);
    appendLog('warn', 'host', `Retry refused: ${errorMessage(error)}`);
    fail(failureSentence(entry.spec, entry.vars));
    return null;
  } finally {
    done();
  }
}

/** A ticket by id, as it stands now (outside React). */
export function writeTicketOf(ticketId: string): WriteTicket | null {
  return useWriteTickets.getState().byId[ticketId] ?? null;
}

/** A ticket by id, live. */
export function useWriteTicket(ticketId: string | null): WriteTicket | null {
  return useWriteTickets((s) => (ticketId ? (s.byId[ticketId] ?? null) : null));
}

export interface UseWrite<V> {
  /** Submit (see `submitWrite`); resolves with the ticket, or null when queued, refused or cut short. */
  run: (vars: V) => Promise<WriteTicket | null>;
  /** Submit and say what happened (see `runWrite`). */
  send: (vars: V) => Promise<WriteResult>;
  /** The last ticket this hook submitted, kept current by `write.status`. */
  ticket: WriteTicket | null;
  status: 'idle' | WriteState;
  /** Check the ticket now, quietly (the reconciler checks it on its own anyway). */
  check: () => Promise<WriteTicket | null>;
  retry: () => Promise<WriteTicket | null>;
}

/**
 * A write with its live status, for a screen that shows it (a follow button,
 * the compose sheet's write-status row):
 *
 *   const follow = useWrite(followWrite);
 *   follow.run({ authorId, follow: true }); follow.status; // 'idle' | 'pending' | 'confirmed' | ...
 *
 * List cells use `submitWrite` instead, so they don't subscribe per cell.
 */
export function useWrite<V>(spec: WriteSpec<V>): UseWrite<V> {
  const [ticketId, setTicketId] = useState<string | null>(null);
  const ticket = useWriteTicket(ticketId);
  const latest = useRef(spec);
  useEffect(() => {
    latest.current = spec;
  });

  const send = useCallback(async (vars: V) => {
    const result = await runWrite(latest.current, vars);
    if (result.status === 'submitted') setTicketId(result.ticket.id);
    return result;
  }, []);
  const run = useCallback(
    async (vars: V) => {
      const result = await send(vars);
      return result.status === 'submitted' ? result.ticket : null;
    },
    [send],
  );
  const check = useCallback(async () => (ticketId ? recheckWrite(ticketId) : null), [ticketId]);
  const retry = useCallback(async () => (ticketId ? retryWrite(ticketId) : null), [ticketId]);

  return { run, send, ticket, status: ticket?.state ?? 'idle', check, retry };
}

/**
 * Submits a write from a handler, toasting `submitted` once the engine has
 * taken it ("Reposted!"). Failures are the tracker's to report.
 */
export function sendWrite<V>(spec: WriteSpec<V>, vars: V, submitted?: string): void {
  runWrite(spec, vars)
    .then((result) => {
      if (result.status === 'submitted' && submitted) toast.success(submitted);
    })
    .catch((error: unknown) => appendLog('warn', 'host', `Write failed: ${errorMessage(error)}`));
}
