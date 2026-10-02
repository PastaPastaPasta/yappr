import type { EngineErrorData, WriteState, WriteTicket } from '@engine/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { errorFeedback } from '~/ui/haptics';
import { toast, type ToastAction } from '~/ui/toast';

import { onEngineEvent } from './events';
import type { EngineRemote } from './queries';
import { promptSignIn } from './require-auth';

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
  /** Names the write in "Your {noun} didn't go through. Try again." */
  noun: string;
  /** The failure toast when the engine has no specific message ("Failed to update like. Please try again."). */
  failureMessage: string;
  /**
   * Toast "Not confirmed yet · Check again" when it goes `unconfirmed`
   * (default). Engagements set false: PRD G-3 counts them as done, and the
   * next refresh shows the chain's truth.
   */
  announceUnconfirmed?: boolean;
  onConfirmed?: (ticket: WriteTicket, vars: V) => void;
  /**
   * The failure toast for a ticket, when the write has something more
   * specific to say than the engine's message (a partly posted thread);
   * null falls back to the default.
   */
  failureText?: (ticket: WriteTicket, vars: V) => string | null;
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
 * Keys whose submit or retry hasn't answered yet, with what they ask for.
 * Each call marks its key with its own token and clears only that mark: a
 * queued write released while the call settles marks the key itself.
 */
const submitting = new Map<string, { token: symbol; intent: unknown }>();

/** Marks `key` busy for one call; the result clears the mark if it is still that call's. */
function markSubmitting(key: string | undefined, intent: unknown): () => void {
  if (key === undefined) return () => undefined;
  const token = Symbol(key);
  submitting.set(key, { token, intent });
  return () => {
    if (submitting.get(key)?.token === token) submitting.delete(key);
  };
}

interface Waiting {
  spec: WriteSpec<unknown>;
  vars: unknown;
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

/** categorizeError's copy (PRD G-4), unless it has nothing specific to say. */
function failureText(error: EngineErrorData | null, fallback: string): string {
  return error && error.code !== 'UNKNOWN' && error.userMessage ? error.userMessage : fallback;
}

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

  switch (ticket.state) {
    case 'pending':
      return;
    case 'confirmed':
      entry.undo = null;
      tracked.delete(ticket.id);
      spec.onConfirmed?.(ticket, entry.vars);
      if (latest) release(entry.key, true);
      return;
    case 'failed':
      // Final unless the engine allows a retry.
      if (!ticket.retryable) tracked.delete(ticket.id);
      // An older intent's failure: a newer write for this key decides the state, and says its own outcome.
      if (!latest) return;
      undo(entry);
      spec.onFailed?.(ticket, entry.vars);
      fail(spec.failureText?.(ticket, entry.vars) ?? failureText(ticket.error, spec.failureMessage), retry);
      // The undo restored what a queued write (the opposite toggle) asked for.
      release(entry.key, false);
      return;
    case 'unconfirmed':
      if (!latest) return;
      if (ticket.retryable) {
        // A check proved it did not land.
        undo(entry);
        fail(`Your ${spec.noun} didn't go through. Try again.`, retry);
        release(entry.key, false);
      } else {
        if (spec.announceUnconfirmed !== false) {
          toast('Not confirmed yet', {
            action: { label: 'Check again', onPress: () => checkWrite(ticket.id) },
          });
        }
        // It may have landed: send the newer intent, which is harmless if it did not.
        release(entry.key, true);
      }
  }
}

/** The pending write for `key` settled: send the write queued behind it, or drop it. */
function release(key: string | undefined, send: boolean): void {
  if (key === undefined) return;
  const next = queued.get(key);
  if (!next) return;
  queued.delete(key);
  if (send) runQueued(next).catch(() => undefined);
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

function receive(ticket: WriteTicket, from: 'event' | 'call'): WriteTicket {
  if (orphans.length > 0) adopt(ticket);
  const current = record(ticket, from);
  settle(current);
  return current;
}

let stopTracking: (() => void) | null = null;

/** Follows `write.status` for the app's lifetime. Started by `startDataLayer` (and on the first write). */
export function startWriteTracking(): () => void {
  stopTracking ??= onEngineEvent('write.status', (ticket) => receive(ticket, 'event'));
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
  queued.clear();
  orphans = [];
  useWriteTickets.setState({ byId: {} });
}

const NO_INTENT = Symbol('no intent');

/** What the write pending for `key` asks for, `NO_INTENT` when none is pending. */
function pendingIntent(key: string): unknown {
  const marked = submitting.get(key);
  if (marked) return marked.intent;
  const id = latestByKey.get(key);
  const entry = id === undefined ? undefined : tracked.get(id);
  if (!entry || useWriteTickets.getState().byId[id!]?.state !== 'pending') return NO_INTENT;
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
  const key = spec.key?.(vars);
  if (key !== undefined) {
    const pending = pendingIntent(key);
    if (pending !== NO_INTENT) {
      const undoQueued = spec.optimistic?.(vars) ?? null;
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
  const done = markSubmitting(key, spec.intent?.(vars));
  let revert = waiting.undo;
  try {
    revert ??= spec.optimistic?.(vars) ?? null;
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
      release(key, true);
      return { status: 'unknown', error };
    }
    revert?.();
    done();
    release(key, false);
    if (errorCode(error) === 'NOT_SIGNED_IN') {
      promptSignIn();
    } else if (!spec.onRejected?.(error, vars)) {
      appendLog('warn', 'host', `Write refused: ${errorMessage(error)}`);
      fail(spec.failureMessage);
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
 * After an engine boot: follow the tickets it restored for writes a restart
 * cut short (`writes.list`). Called by the data layer on every new engine.
 */
export async function adoptRestoredWrites(): Promise<void> {
  if (orphans.length === 0) return;
  for (const ticket of await engine.api.writes.list()) receive(ticket, 'call');
}

/** "Check again" for an unconfirmed write (`writes.check`); its `write.status` says the outcome. */
export async function checkWrite(ticketId: string): Promise<WriteTicket | null> {
  try {
    return receive(await engine.api.writes.check(ticketId), 'call');
  } catch (error) {
    appendLog('warn', 'host', `Check failed: ${errorMessage(error)}`);
    toast.error("Couldn't check. Try again in a moment.");
    return null;
  }
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
  if (!isLatest(ticketId, entry) || (key !== undefined && inFlight(key))) {
    toast('Already updated');
    return null;
  }
  const done = markSubmitting(key, entry.spec.intent?.(entry.vars));
  try {
    if (!entry.undo && entry.spec.optimistic) entry.undo = entry.spec.optimistic(entry.vars);
    return receive(await engine.api.writes.retry(ticketId), 'call');
  } catch (error) {
    undo(entry);
    appendLog('warn', 'host', `Retry refused: ${errorMessage(error)}`);
    fail(entry.spec.failureMessage);
    return null;
  } finally {
    done();
  }
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
  const check = useCallback(async () => (ticketId ? checkWrite(ticketId) : null), [ticketId]);
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
