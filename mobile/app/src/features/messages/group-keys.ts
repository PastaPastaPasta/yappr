import type { WriteTicket } from '@engine/api';
import { AppState, type AppStateStatus } from 'react-native';

import { onEngineEvent } from '~/data/events';
import { useSessionStore } from '~/data/session';
import { errorCode, writeTicketOf } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { toast } from '~/ui/toast';

/**
 * Group keys a creation could not send (PRD DM-06, UX_SPEC §4.21, agent-isms
 * #8): the owner's app sends them again by itself, so nobody is asked to
 * "resend keys".
 *
 * Only members a creation proved it missed are queued (`dm.createdGroup`'s
 * `failed`: their 1:1 or their grant failed). Each gets at most
 * `MAX_ATTEMPTS` resends, `BACKOFF_MS` apart, run when the group opens, when
 * the app comes back to the foreground, and once each backoff has passed.
 * A resend is a `dm.group` write the engine runs on the group's serial queue
 * with its 5-minute deadline (#666): while its call still runs (pending, or
 * `STILL_SENDING` past the deadline) nothing else is sent for that member,
 * so one never races another. A refusal that proves the member is no longer
 * missing a key (the group ended, they left or were removed) drops them.
 *
 * Background upkeep, not a user's write: it calls the engine itself rather
 * than through the write tracker, whose every failure is a toast. The user
 * hears only the end: "1 member hasn't been added yet." with Retry, once the
 * attempts are used up. It lives in memory: after the app is killed, a
 * member still without the key sees "Waiting for access…", and the owner
 * has "Re-invite" in the group's member menu.
 */

export const MAX_ATTEMPTS = 3;
/** The wait after a failed attempt before the next one: 30 s, then 2 min. */
export const BACKOFF_MS: readonly number[] = [30_000, 120_000];

interface Missing {
  viewerId: string;
  groupKey: string;
  memberId: string;
  attempts: number;
  /** Not before this time (ms). */
  nextAt: number;
  /** The resend whose outcome is awaited, as last heard of. */
  ticket: WriteTicket | null;
  /** When it was sent (ms). */
  sentAt: number;
  /** A resend call that has not answered with its ticket yet. */
  submitting: boolean;
}

const missing = new Map<string, Missing>();
const slot = (groupKey: string, memberId: string) => `${groupKey}\u0000${memberId}`;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopListening: (() => void) | null = null;

/** The resend's call still runs, so its answer is still to come (`stillRunning` in data/writes). */
const inFlight = (ticket: WriteTicket | null) =>
  ticket?.state === 'pending' || (ticket?.state === 'unconfirmed' && ticket.error?.code === 'STILL_SENDING');

/**
 * A resend still "running" this long after it was sent has outlived the
 * engine's `dm.group` deadline (5 min, #666) by a margin: the engine is asked
 * for its ticket, in case its last word never reached the app (a restart).
 */
const STALE_MS = 6 * 60_000;

/** The newer of the app's copy of a resend's ticket (kept by `write.status`) and this queue's own. */
function latest(entry: Missing): WriteTicket | null {
  const own = entry.ticket;
  const app = own ? writeTicketOf(own.id) : null;
  return own && app && new Date(app.updatedAt).getTime() > new Date(own.updatedAt).getTime() ? app : own;
}

/** Refusals that say the member no longer needs the key from this group (BAD_REQUEST: ended, left, removed, not the owner). */
const NOT_NEEDED = new Set(['BAD_REQUEST', 'NOT_SUPPORTED']);

const activeViewer = () => useSessionStore.getState().session?.identityId ?? null;

function listen(): void {
  if (stopListening) return;
  let foreground = AppState.currentState === 'active';
  const appState = AppState.addEventListener('change', (next: AppStateStatus) => {
    const back = next === 'active' && !foreground;
    foreground = next === 'active';
    if (back) resendMissingKeys();
  });
  const stopEvents = onEngineEvent('write.status', (ticket) => {
    for (const entry of missing.values()) {
      if (entry.ticket?.id === ticket.id) {
        entry.ticket = ticket;
        resendMissingKeys(entry.groupKey);
        return;
      }
    }
  });
  stopListening = () => {
    appState.remove();
    stopEvents();
  };
}

function stopIfIdle(): void {
  if (missing.size > 0) return;
  stopListening?.();
  stopListening = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** One wake-up at the earliest backoff still to pass. */
function scheduleNext(now: number): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const waits = [...missing.values()]
    .filter((entry) => !entry.ticket && !entry.submitting && entry.nextAt > now)
    .map((entry) => entry.nextAt - now);
  if (waits.length === 0) return;
  timer = setTimeout(() => {
    timer = null;
    resendMissingKeys();
  }, Math.min(...waits));
}

/** "1 member hasn't been added yet." with Retry, once a group's attempts are used up (UX_SPEC §5.8 dm.group.keysFailed). */
function giveUp(viewerId: string, groupKey: string, memberIds: string[]): void {
  appendLog('warn', 'host', `Group keys: gave up resending to ${memberIds.length} member(s)`);
  const n = memberIds.length;
  toast.error(n === 1 ? "1 member hasn't been added yet." : `${n} members haven't been added yet.`, {
    action: { label: 'Retry', onPress: () => queueKeyResend(viewerId, groupKey, memberIds) },
  });
}

/** Asks the engine for a stale resend's ticket; gone (the engine no longer has it) counts as an attempt used. */
function refresh(entry: Missing): void {
  const id = entry.ticket?.id;
  if (!id || entry.submitting) return;
  entry.submitting = true;
  engine.api.writes
    .get(id)
    .then((ticket) => {
      if (entry.ticket?.id !== id) return;
      // Gone from the engine (a restart that kept no record): an attempt used up.
      entry.ticket = ticket ?? { ...entry.ticket, state: 'failed', updatedAt: new Date() };
      // Still running: look again only after another stale period.
      if (inFlight(entry.ticket)) entry.sentAt = Date.now();
    })
    .catch((error: unknown) => appendLog('warn', 'host', `Group keys: reading a resend failed: ${errorMessage(error)}`))
    .finally(() => {
      entry.submitting = false;
      resendMissingKeys(entry.groupKey);
    });
}

async function submit(entry: Missing): Promise<void> {
  entry.submitting = true;
  entry.attempts += 1;
  try {
    entry.ticket = await engine.api.dm.resendKeys(entry.groupKey, entry.memberId);
    entry.sentAt = Date.now();
  } catch (error) {
    appendLog('warn', 'host', `Group keys: resend refused: ${errorMessage(error)}`);
    if (NOT_NEEDED.has(errorCode(error) ?? '')) {
      missing.delete(slot(entry.groupKey, entry.memberId));
    } else {
      entry.nextAt = Date.now() + BACKOFF_MS[Math.min(entry.attempts - 1, BACKOFF_MS.length - 1)];
    }
  } finally {
    entry.submitting = false;
  }
}

/**
 * Settles each queued member's last resend, then sends the next one that is
 * due: every group, or only `groupKey` (the group just opened). Never more
 * than one resend in flight per member, and never past `MAX_ATTEMPTS`.
 */
export function resendMissingKeys(groupKey?: string): void {
  const viewerId = activeViewer();
  const now = Date.now();
  const due: Missing[] = [];
  /** Groups with a member still on its way: their used-up members are told of together, once these settle. */
  const busy = new Set<string>();
  for (const [key, entry] of missing) {
    // Another account's queue waits until it is active again: the engine signs as the active one.
    if (entry.viewerId !== viewerId) continue;
    if (entry.submitting) {
      busy.add(entry.groupKey);
      continue;
    }
    if (entry.ticket) {
      const ticket = latest(entry);
      if (inFlight(ticket)) {
        if (now - entry.sentAt > STALE_MS) refresh(entry);
        busy.add(entry.groupKey);
        continue;
      }
      entry.ticket = null;
      if (ticket?.state === 'confirmed') {
        missing.delete(key);
        continue;
      }
      // Failed, proved absent, or unknown (an engine restart): an attempt used up.
      entry.nextAt = now + BACKOFF_MS[Math.min(entry.attempts - 1, BACKOFF_MS.length - 1)];
    }
    if (entry.attempts >= MAX_ATTEMPTS) continue;
    busy.add(entry.groupKey);
    if (entry.nextAt <= now && (groupKey === undefined || entry.groupKey === groupKey)) due.push(entry);
  }
  // Used up, in a group with nothing else on its way: one "{n} members haven't been added yet." for them all.
  const exhausted = new Map<string, string[]>();
  for (const [key, entry] of missing) {
    const done = entry.viewerId === viewerId && !entry.submitting && !entry.ticket && entry.attempts >= MAX_ATTEMPTS;
    if (!done || busy.has(entry.groupKey)) continue;
    missing.delete(key);
    exhausted.set(entry.groupKey, [...(exhausted.get(entry.groupKey) ?? []), entry.memberId]);
  }
  for (const [group, members] of exhausted) if (viewerId) giveUp(viewerId, group, members);
  // One per pass, and the next once the engine has answered this one: they run on its serial queue anyway.
  const next = due[0];
  if (next) {
    submit(next)
      .catch(() => undefined)
      .finally(() => resendMissingKeys(groupKey));
  }
  scheduleNext(now);
  stopIfIdle();
}

/**
 * The members a group creation could not give the key (`dm.createdGroup`'s
 * `failed`), or a Retry once the attempts were used up: resent from now on.
 */
export function queueKeyResend(viewerId: string, groupKey: string, memberIds: readonly string[]): void {
  if (memberIds.length === 0) return;
  for (const memberId of memberIds) {
    const key = slot(groupKey, memberId);
    if (missing.has(key)) continue;
    missing.set(key, { viewerId, groupKey, memberId, attempts: 0, nextAt: 0, ticket: null, sentAt: 0, submitting: false });
  }
  listen();
  resendMissingKeys(groupKey);
}

/**
 * Follows a group creation's ticket to its end, wherever the user is by then
 * (the form goes to the inbox on an unknown outcome): once confirmed, the
 * members it could not give the key are queued (`dm.createdGroup`). After an
 * engine restart the engine no longer knows them, and nothing is queued.
 */
export function followGroupCreation(viewerId: string, ticketId: string): void {
  let done = false;
  const settle = (ticket: WriteTicket | null) => {
    if (done || !ticket || ticket.id !== ticketId || inFlight(ticket)) return;
    if (ticket.state === 'unconfirmed' && !ticket.retryable) return; // Still unknown: the next word settles it.
    done = true;
    stop();
    if (ticket.state !== 'confirmed') return;
    engine.api.dm
      .createdGroup(ticketId)
      .then((created) => {
        if (created && activeViewer() === viewerId) queueKeyResend(viewerId, created.key, created.failed);
      })
      .catch((error: unknown) => appendLog('warn', 'host', `Group keys: reading the new group failed: ${errorMessage(error)}`));
  };
  const stop = onEngineEvent('write.status', settle);
  settle(writeTicketOf(ticketId));
}

/** Forgets the queue (tests). */
export function resetKeyResends(): void {
  missing.clear();
  stopIfIdle();
}
