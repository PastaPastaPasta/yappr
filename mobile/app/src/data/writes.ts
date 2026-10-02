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

const tracked = new Map<string, Tracked>();
const latestByKey = new Map<string, string>();
/** Keys whose submit or retry hasn't answered yet. */
const submitting = new Set<string>();

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
      return;
    case 'failed':
      if (latest) undo(entry);
      fail(spec.failureText?.(ticket, entry.vars) ?? failureText(ticket.error, spec.failureMessage), retry);
      return;
    case 'unconfirmed':
      if (ticket.retryable) {
        // A check proved it did not land.
        if (latest) undo(entry);
        fail(`Your ${spec.noun} didn't go through. Try again.`, retry);
      } else if (spec.announceUnconfirmed !== false) {
        toast('Not confirmed yet', {
          action: { label: 'Check again', onPress: () => checkWrite(ticket.id) },
        });
      }
  }
}

function receive(ticket: WriteTicket, from: 'event' | 'call'): WriteTicket {
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
  latestByKey.clear();
  useWriteTickets.setState({ byId: {} });
}

function inFlight(key: string): boolean {
  if (submitting.has(key)) return true;
  const id = latestByKey.get(key);
  return id !== undefined && useWriteTickets.getState().byId[id]?.state === 'pending';
}

/**
 * Submits a write outside React (a list cell's handler). Resolves with the
 * ticket, or null when it was skipped (same key in flight) or refused (the
 * change was undone and the user told).
 */
export async function submitWrite<V>(spec: WriteSpec<V>, vars: V): Promise<WriteTicket | null> {
  startWriteTracking();
  const key = spec.key?.(vars);
  if (key !== undefined) {
    if (inFlight(key)) return null;
    submitting.add(key);
  }
  let revert: (() => void) | null = null;
  try {
    revert = spec.optimistic?.(vars) ?? null;
    const ticket = await spec.submit(engine.api, vars);
    tracked.set(ticket.id, { spec: spec as WriteSpec<unknown>, vars, key, undo: revert, handled: '' });
    if (key !== undefined) latestByKey.set(key, ticket.id);
    // `write.status` may have overtaken the call's answer: settle on the newest copy.
    return receive(ticket, 'call');
  } catch (error) {
    revert?.();
    if (errorCode(error) === 'NOT_SIGNED_IN') {
      promptSignIn();
    } else if (!spec.onRejected?.(error, vars)) {
      appendLog('warn', 'host', `Write refused: ${errorMessage(error)}`);
      fail(spec.failureMessage);
    }
    return null;
  } finally {
    if (key !== undefined) submitting.delete(key);
  }
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
  if (key !== undefined) submitting.add(key);
  try {
    if (!entry.undo && entry.spec.optimistic) entry.undo = entry.spec.optimistic(entry.vars);
    return receive(await engine.api.writes.retry(ticketId), 'call');
  } catch (error) {
    undo(entry);
    appendLog('warn', 'host', `Retry refused: ${errorMessage(error)}`);
    fail(entry.spec.failureMessage);
    return null;
  } finally {
    if (key !== undefined) submitting.delete(key);
  }
}

/** A ticket by id, live. */
export function useWriteTicket(ticketId: string | null): WriteTicket | null {
  return useWriteTickets((s) => (ticketId ? (s.byId[ticketId] ?? null) : null));
}

export interface UseWrite<V> {
  /** Submit (see `submitWrite`); resolves with the ticket, or null when skipped or refused. */
  run: (vars: V) => Promise<WriteTicket | null>;
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

  const run = useCallback(async (vars: V) => {
    const submitted = await submitWrite(latest.current, vars);
    if (submitted) setTicketId(submitted.id);
    return submitted;
  }, []);
  const check = useCallback(async () => (ticketId ? checkWrite(ticketId) : null), [ticketId]);
  const retry = useCallback(async () => (ticketId ? retryWrite(ticketId) : null), [ticketId]);

  return { run, ticket, status: ticket?.state ?? 'idle', check, retry };
}

/**
 * Submits a write from a handler, toasting `submitted` once the engine has
 * taken it ("Reposted!"). Failures are the tracker's to report.
 */
export function sendWrite<V>(spec: WriteSpec<V>, vars: V, submitted?: string): void {
  submitWrite(spec, vars)
    .then((ticket) => {
      if (ticket && submitted) toast.success(submitted);
    })
    .catch((error: unknown) => appendLog('warn', 'host', `Write failed: ${errorMessage(error)}`));
}
