import type { EngineErrorData, WriteState, WriteTicket } from '@engine/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { errorFeedback } from '~/ui/haptics';
import { toast } from '~/ui/toast';

import { onEngineEvent } from './events';
import type { EngineRemote } from './queries';
import { promptSignIn } from './require-auth';

/**
 * Writes (src/data/README.md, ENGINE.md §7). Every engine write returns a
 * `WriteTicket` at once (`pending`) and reports each transition as
 * `write.status`. `submitWrite` / `useWrite` apply an optimistic change,
 * follow the ticket, and on the way:
 *
 * - `confirmed`: keep the change, run `onConfirmed`.
 * - `failed`: undo the change, error haptic, toast the engine's message
 *   (or the spec's), with "Retry" when the engine allows one (PRD G-4).
 * - `unconfirmed`: it may have landed, so the change stays (PRD G-3); a toast
 *   offers "Check again". A check that proves it absent undoes the change
 *   and offers "Retry". Nothing is ever retried automatically.
 */

export type WriteStatus = 'idle' | WriteState;

export interface WriteSpec<V> {
  /** Submit the write and resolve with its ticket: `(api, target) => api.engage.like(target)`. */
  submit: (api: EngineRemote, vars: V) => Promise<WriteTicket>;
  /**
   * Writes with the same key (`like:<postId>`) go one at a time: `run` while
   * the last one is still pending does nothing. Retry and "check again"
   * apply only to the latest write for a key.
   */
  key?: (vars: V) => string;
  /** Apply the optimistic change and return its undo (`setViewerState` and friends). */
  optimistic?: (vars: V) => () => void;
  /** Names the write in "Your {noun} didn't go through. Try again." */
  noun: string;
  /** The failure toast when the engine has no specific message ("Failed to update like. Please try again."). */
  failureMessage: string;
  onConfirmed?: (ticket: WriteTicket, vars: V) => void;
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
/** Keys whose submit hasn't returned a ticket yet. */
const submitting = new Set<string>();

/** Every ticket this app has seen, by id (`write.status` and submit/check/retry results). */
export const useWriteTickets = create<{ byId: Record<string, WriteTicket> }>()(() => ({ byId: {} }));

const MAX_TICKETS = 200;

const time = (date: Date | string | null | undefined) => (date ? new Date(date).getTime() : 0);

/** Records a ticket unless a newer copy is already known; returns the newest. */
function record(ticket: WriteTicket): WriteTicket {
  const known = useWriteTickets.getState().byId[ticket.id];
  if (known && time(known.updatedAt) > time(ticket.updatedAt)) return known;
  useWriteTickets.setState(({ byId }) => {
    const next = { ...byId, [ticket.id]: ticket };
    const ids = Object.keys(next);
    // Oldest first: drop settled tickets nobody follows.
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TICKETS))) {
      if (!tracked.has(id)) delete next[id];
    }
    return { byId: next };
  });
  return ticket;
}

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

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

/** Acts on a ticket's state once per change. */
function settle(ticket: WriteTicket): void {
  const entry = tracked.get(ticket.id);
  if (!entry) return;
  const signature = `${ticket.state}:${ticket.retryable}:${time(ticket.updatedAt)}:${time(ticket.lastCheckedAt)}`;
  if (entry.handled === signature) return;
  entry.handled = signature;

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
      errorFeedback();
      toast.error(failureText(ticket.error, spec.failureMessage), { action: retry });
      return;
    case 'unconfirmed':
      if (ticket.retryable) {
        // A check proved it did not land.
        if (latest) undo(entry);
        errorFeedback();
        toast.error(`Your ${spec.noun} didn't go through. Try again.`, { action: retry });
      } else {
        toast('Not confirmed yet', {
          action: { label: 'Check again', onPress: () => checkWrite(ticket.id) },
        });
      }
  }
}

function receive(ticket: WriteTicket): WriteTicket {
  const newest = record(ticket);
  settle(newest);
  return newest;
}

let stopTracking: (() => void) | null = null;

/** Follows `write.status` for the app's lifetime. Started by `startDataLayer` (and on the first write). */
export function startWriteTracking(): () => void {
  stopTracking ??= onEngineEvent('write.status', receive);
  return () => {
    stopTracking?.();
    stopTracking = null;
  };
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
  const revert = spec.optimistic?.(vars) ?? null;
  try {
    const ticket = await spec.submit(engine.api, vars);
    tracked.set(ticket.id, { spec: spec as WriteSpec<unknown>, vars, key, undo: revert, handled: '' });
    if (key !== undefined) latestByKey.set(key, ticket.id);
    // `write.status` may have overtaken the call's answer: settle on the newest copy.
    return receive(ticket);
  } catch (error) {
    revert?.();
    if (errorCode(error) === 'NOT_SIGNED_IN') {
      promptSignIn();
    } else if (!spec.onRejected?.(error, vars)) {
      appendLog('warn', 'host', `Write refused: ${errorMessage(error)}`);
      errorFeedback();
      toast.error(spec.failureMessage);
    }
    return null;
  } finally {
    if (key !== undefined) submitting.delete(key);
  }
}

/** "Check again" for an unconfirmed write (`writes.check`); the result is acted on as a `write.status`. */
export async function checkWrite(ticketId: string): Promise<WriteTicket | null> {
  try {
    const ticket = await engine.api.writes.check(ticketId);
    const entry = tracked.get(ticketId);
    // Asked again: say again, even when nothing changed.
    if (entry) entry.handled = '';
    return receive(ticket);
  } catch (error) {
    toast.error(`Couldn't check: ${errorMessage(error)}`);
    return null;
  }
}

/** Re-sends a write the engine proved did not land (`writes.retry`), re-applying its optimistic change. */
export async function retryWrite(ticketId: string): Promise<WriteTicket | null> {
  const entry = tracked.get(ticketId);
  if (entry && !entry.undo && entry.spec.optimistic) entry.undo = entry.spec.optimistic(entry.vars);
  try {
    return receive(await engine.api.writes.retry(ticketId));
  } catch (error) {
    if (entry) undo(entry);
    errorFeedback();
    toast.error(entry ? entry.spec.failureMessage : errorMessage(error));
    return null;
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
  status: WriteStatus;
  check: () => Promise<WriteTicket | null>;
  retry: () => Promise<WriteTicket | null>;
}

/**
 * A write with its live status, for a screen that shows it (a follow button,
 * the compose sheet's write-status row):
 *
 *   const follow = useWrite(followWrite);
 *   follow.run(userId); follow.status; // 'idle' | 'pending' | 'confirmed' | ...
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
