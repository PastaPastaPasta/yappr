import type { MessageDTO, WriteTicket } from '@engine/api';
import { useMemo } from 'react';
import { create } from 'zustand';

import { onEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import {
  adoptRestoredWrites,
  checkWrite,
  errorCode,
  isFollowedWrite,
  retryWrite,
  runWrite,
  type WriteSpec,
} from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { lightImpact } from '~/ui/haptics';
import { toast } from '~/ui/toast';

import { chronological, isPartOfSend, type OutboxStatus, type TimelineMessage } from './dm-model';
import { useDrafts } from './drafts';

/**
 * Sends of this device (PRD DM-04): each shows as a bubble at once, follows
 * its `dm.send` ticket ("Sending…", then the engine's own message takes its
 * place), and stays on screen with its error when it fails ("Failed · Tap to
 * retry"). Memory only: the text is decrypted content (src/data/README.md).
 */

export type OutboxState = 'sending' | 'confirmed' | 'failed' | 'unconfirmed';

export interface OutboxEntry {
  id: string;
  identityId: string;
  key: string;
  text: string;
  createdAt: number;
  /** My messages in the conversation when it was sent: none of them can be this send. */
  before: string[];
  /**
   * The newest message time held when it was sent, in the engine's clock (the
   * chain's, which can differ from the device's): this send is no older.
   */
  after: number;
  ticketId: string | null;
  state: OutboxState;
  retryable: boolean;
}

export const useOutbox = create<{ entries: OutboxEntry[] }>()(() => ({ entries: [] }));

let nextId = 1;
/** Bumped by `clearLocalMessages`: a send that settles after it belongs to a session that is gone. */
let generation = 0;

function update(id: string, patch: Partial<OutboxEntry>): void {
  useOutbox.setState(({ entries }) => ({ entries: entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
}

function remove(id: string): void {
  useOutbox.setState(({ entries }) => ({ entries: entries.filter((e) => e.id !== id) }));
}

function applyTicket(entryId: string, ticket: Pick<WriteTicket, 'id' | 'state' | 'retryable'>): void {
  update(entryId, {
    ticketId: ticket.id,
    state: ticket.state === 'pending' ? 'sending' : ticket.state,
    retryable: ticket.retryable,
  });
  if (ticket.state !== 'pending') {
    const entry = useOutbox.getState().entries.find((e) => e.id === entryId);
    if (entry) queryClient.invalidateQueries({ queryKey: queryKeys.dm.messages(entry.key) }).catch(() => undefined);
  }
}

let following: (() => void) | null = null;

/** Follows `dm.send` tickets for the app's lifetime (started on the first send). */
function followTickets(): void {
  following ??= onEngineEvent('write.status', (ticket) => {
    if (ticket.op !== 'dm.send') return;
    const entry = useOutbox.getState().entries.find((e) => e.ticketId === ticket.id);
    if (entry) applyTicket(entry.id, ticket);
  });
}

interface SendVars {
  entryId: string;
  key: string;
  text: string;
}

const sendSpec: WriteSpec<SendVars> = {
  submit: (api, { key, text }) => api.dm.send(key, text),
  // Every send is its own write: two messages in a row never queue behind each other.
  key: ({ entryId }) => `dm.send:${entryId}`,
  noun: 'message',
  failureMessage: 'Failed to send message. Please try again.',
  // The bubble says it ("Not confirmed · Tap to check"); a toast on top would repeat it.
  announceUnconfirmed: false,
  matches: (ticket, { key }) =>
    ticket.op === 'dm.send' && !!ticket.target && 'conversationKey' in ticket.target && ticket.target.conversationKey === key,
  // The cut-short send's bubble follows the restored ticket: "Tap to check" and retry act on it.
  onAdopted: (ticket, { entryId }) => applyTicket(entryId, ticket),
  onRejected: (error) => {
    // Refused before anything went out: the text is back in the composer, and the lock asks for the key.
    if (errorCode(error) === 'NO_KEY') {
      queryClient.invalidateQueries({ queryKey: queryKeys.dm.status }).catch(() => undefined);
      toast.error('Unlock your messages to send them.');
      return true;
    }
    if (errorCode(error) === 'BAD_REQUEST') {
      toast.error(errorMessage(error));
      return true;
    }
    return false;
  },
};

/** My messages the engine holds for `key` (the loaded pages), and the newest message time. */
function heldMessages(key: string): { before: string[]; after: number } {
  const data = queryClient.getQueryData<{ pages: { items: MessageDTO[] }[] }>(queryKeys.dm.messages(key));
  const items = (data?.pages ?? []).flatMap((page) => page.items);
  return {
    before: items.filter((m) => m.own).map((m) => m.id),
    after: items.reduce((newest, m) => Math.max(newest, new Date(m.at).getTime()), 0),
  };
}

/**
 * Sends `text` to conversation `key` (DM-04): a bubble at once and a light
 * haptic. A send the engine refuses outright puts the text back in the
 * composer (PRD G-4: composer text is never lost).
 */
export async function sendMessage(identityId: string, key: string, text: string): Promise<void> {
  followTickets();
  const entry: OutboxEntry = {
    id: `local:${nextId++}`,
    identityId,
    key,
    text,
    createdAt: Date.now(),
    ...heldMessages(key),
    ticketId: null,
    state: 'sending',
    retryable: false,
  };
  const sentIn = generation;
  useOutbox.setState(({ entries }) => ({ entries: [...entries, entry] }));
  lightImpact();
  const result = await runWrite(sendSpec, { entryId: entry.id, key, text });
  // Signed out or switched accounts meanwhile: the plaintext must not come back.
  if (sentIn !== generation) return;
  switch (result.status) {
    case 'submitted':
      applyTicket(entry.id, result.ticket);
      return;
    case 'refused':
      remove(entry.id);
      useDrafts.getState().restore(identityId, key, text);
      return;
    case 'unknown':
      // The engine restarted under the call: it may have gone out. A check settles it, once the
      // tracker adopts the ticket the engine restores (`onAdopted`), unless it already has.
      if (useOutbox.getState().entries.find((e) => e.id === entry.id)?.ticketId === null) {
        update(entry.id, { state: 'unconfirmed' });
      }
      return;
    case 'queued':
      return;
  }
}

/**
 * A failed bubble was tapped (DM-04): retry once the engine proved it absent,
 * "check again" while it may have landed, or put the text back in the
 * composer when the engine won't retry it.
 */
export async function resolveFailed(entryId: string): Promise<void> {
  const entry = useOutbox.getState().entries.find((e) => e.id === entryId);
  if (!entry) return;
  if (entry.retryable && entry.ticketId) {
    update(entry.id, { state: 'sending' });
    const ticket = await retryWrite(entry.ticketId);
    if (ticket) applyTicket(entry.id, ticket);
    else update(entry.id, { state: entry.state });
    return;
  }
  if (entry.state === 'unconfirmed' && entry.ticketId) {
    const ticket = await checkWrite(entry.ticketId);
    if (ticket) applyTicket(entry.id, ticket);
    return;
  }
  if (entry.state === 'unconfirmed') {
    await resolveUnticketed(entry);
    return;
  }
  // A long send refused part way: only the parts that did not go out come back (the rest is in the conversation).
  const unsent = unsentText(entry);
  remove(entry.id);
  if (unsent) useDrafts.getState().restore(entry.identityId, entry.key, unsent);
}

/** A cut-short call's ticket is made after the call started (one device clock; a margin for rounding). */
const TICKET_SKEW_MS = 1_000;
/**
 * How long a cut-short send may still get its ticket: the engine keeps
 * running a call the host stopped waiting for (its reads before submitting).
 */
export const UNTICKETED_WAIT_MS = 60_000;

/**
 * "Tap to check" on a send whose call was cut short before it answered with
 * a ticket (SR-16). The ticket the engine made is followed from here; when
 * the engine has none for it, the send never started, so its text goes back
 * to the composer (PRD G-4).
 */
async function resolveUnticketed(entry: OutboxEntry): Promise<void> {
  let tickets: WriteTicket[];
  try {
    // Follows the send's ticket, if the engine made one (`onAdopted`).
    await adoptRestoredWrites();
    tickets = await engine.api.writes.list();
  } catch (error) {
    appendLog('warn', 'host', `Checking a message failed: ${errorMessage(error)}`);
    toast.error("Couldn't check. Try again in a moment.");
    return;
  }
  const current = useOutbox.getState().entries.find((e) => e.id === entry.id);
  if (!current) return;
  if (current.ticketId) {
    const ticket = await checkWrite(current.ticketId);
    if (ticket) applyTicket(current.id, ticket);
    return;
  }
  const unclaimed = tickets.some(
    (t) =>
      sendSpec.matches?.(t, { entryId: entry.id, key: entry.key, text: entry.text }) === true &&
      new Date(t.createdAt).getTime() >= entry.createdAt - TICKET_SKEW_MS &&
      // Another send's (one that landed may be gone from the outbox, its ticket still listed).
      !isFollowedWrite(t.id),
  );
  if (unclaimed || Date.now() - entry.createdAt < UNTICKETED_WAIT_MS) {
    queryClient.invalidateQueries({ queryKey: queryKeys.dm.messages(entry.key) }).catch(() => undefined);
    toast('Still checking. Tap again in a moment.');
    return;
  }
  remove(entry.id);
  useDrafts.getState().restore(entry.identityId, entry.key, entry.text);
  toast("This message wasn't sent. It's back in the message box.");
}

/**
 * The part of a send's text that is not in the conversation: all of it,
 * unless a long send failed after its first parts went out.
 */
function unsentText(entry: OutboxEntry): string {
  const data = queryClient.getQueryData<{ pages: { items: MessageDTO[] }[] }>(queryKeys.dm.messages(entry.key));
  const before = new Set(entry.before);
  const mine = chronological((data?.pages ?? []).flatMap((page) => page.items)).filter(
    (m) => m.own && !before.has(m.id) && m.at.getTime() >= entry.after,
  );
  const { cursor } = partsOfSend(mine, entry.text);
  return entry.text.trim().slice(cursor);
}

/** Forgets every local send and draft (sign-out): their plaintext must not outlive the session. */
export function clearLocalMessages(): void {
  generation += 1;
  useOutbox.setState({ entries: [] });
  useDrafts.getState().clearAll();
}

function statusOf(entry: OutboxEntry): OutboxStatus {
  switch (entry.state) {
    case 'sending':
      return 'sending';
    case 'confirmed':
      return 'sent';
    case 'failed':
      return entry.retryable ? 'failed-retry' : 'failed-edit';
    case 'unconfirmed':
      return entry.retryable ? 'failed-retry' : 'unconfirmed';
  }
}

/** Which entries claim engine messages first: one that went out before one that may not have. */
const CLAIM_ORDER: Record<OutboxState, number> = { confirmed: 0, sending: 1, unconfirmed: 2, failed: 3 };

/**
 * The engine messages that make up a send of `text`: the same text, or for a
 * send v5 split into parts, parts that put together give the whole text.
 * `complete` is false while a part is missing (one landed, a later one
 * failed); `cursor` is where the text the parts cover ends.
 */
function partsOfSend(
  candidates: readonly TimelineMessage[],
  text: string,
): { taken: TimelineMessage[]; complete: boolean; cursor: number } {
  const sent = text.trim();
  const pool = candidates.filter((m) => isPartOfSend(m, text));
  const taken: TimelineMessage[] = [];
  const at = (cursor: number) => pool.findIndex((m) => m.text.length > 0 && sent.startsWith(m.text, cursor));
  let cursor = 0;
  while (cursor < sent.length) {
    let index = at(cursor);
    if (index < 0) {
      // A retry sends the rest of a long text trimmed, so a part may start past the spaces at the cut.
      const spaces = /^\s+/.exec(sent.slice(cursor))?.[0].length ?? 0;
      if (spaces > 0) index = at((cursor += spaces));
    }
    if (index < 0) break;
    const [part] = pool.splice(index, 1);
    taken.push(part);
    cursor += part.text.length;
  }
  return { taken, complete: cursor === sent.length, cursor };
}

/** A send the engine's own messages now show, and the messages that are it. */
export interface LandedSend {
  id: string;
  messageIds: string[];
}

/**
 * The conversation with this device's sends merged in: a send the engine
 * already holds (the same text, mine, not there when it was sent) shows as
 * the engine's message; the rest show as local bubbles after them. A send
 * that failed or is unconfirmed stays a local bubble until every part of it
 * is there. `sending` is true while any send is on its way.
 */
export function mergeOutbox(
  messages: readonly TimelineMessage[],
  entries: readonly OutboxEntry[],
): { messages: TimelineMessage[]; sending: boolean; landed: LandedSend[] } {
  const claimed = new Set<string>();
  const shown = new Set<string>();
  const landed: LandedSend[] = [];
  const sending = entries.some((e) => e.state === 'sending');
  const byClaimOrder = [...entries].sort((a, b) => CLAIM_ORDER[a.state] - CLAIM_ORDER[b.state]);
  for (const entry of byClaimOrder) {
    const before = new Set(entry.before);
    const { taken, complete } = partsOfSend(
      messages.filter(
        (m) => m.own && !m.outbox && !before.has(m.id) && !claimed.has(m.id) && m.at.getTime() >= entry.after,
      ),
      entry.text,
    );
    for (const m of taken) claimed.add(m.id);
    if (complete && entry.state !== 'sending') {
      landed.push({ id: entry.id, messageIds: taken.map((m) => m.id) });
    }
    // On its way or out: the engine's messages stand for it. Failed or unconfirmed: only all of it does.
    const covered = taken.length > 0 && (complete || entry.state === 'sending' || entry.state === 'confirmed');
    if (covered) shown.add(entry.id);
  }
  const local: TimelineMessage[] = entries
    .filter((entry) => !shown.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      sender: entry.identityId,
      text: entry.text.trim(),
      at: new Date(entry.createdAt),
      own: true,
      pending: entry.state === 'sending',
      outbox: statusOf(entry),
    }));
  return { messages: [...messages, ...local], sending, landed };
}

/** This conversation's local sends, for the signed-in account. */
export function useOutboxFor(identityId: string | null, key: string): OutboxEntry[] {
  const entries = useOutbox((s) => s.entries);
  return useMemo(
    () => entries.filter((e) => e.identityId === identityId && e.key === key),
    [entries, identityId, key],
  );
}

/**
 * Forgets sends the engine's own messages now show (called after a merge).
 * Their messages stay theirs: the conversation's other sends count them as
 * there before, so a later merge never hands them to a second identical send.
 */
export function forgetLanded(landed: readonly LandedSend[]): void {
  if (landed.length === 0) return;
  const gone = new Map(landed.map((l) => [l.id, l.messageIds]));
  const conversationOf = (e: OutboxEntry) => `${e.identityId}\u0000${e.key}`;
  useOutbox.setState(({ entries }) => {
    const taken = new Map<string, string[]>();
    for (const e of entries) {
      const ids = gone.get(e.id);
      if (ids) taken.set(conversationOf(e), [...(taken.get(conversationOf(e)) ?? []), ...ids]);
    }
    return {
      entries: entries
        .filter((e) => !gone.has(e.id))
        .map((e) => {
          const ids = taken.get(conversationOf(e));
          return ids ? { ...e, before: [...e.before, ...ids] } : e;
        }),
    };
  });
}

/** Logs and swallows: sends report their own failures on the bubble and in a toast. */
export function sendInBackground(identityId: string, key: string, text: string): void {
  sendMessage(identityId, key, text).catch((error: unknown) => {
    appendLog('warn', 'host', `DM send failed: ${errorMessage(error)}`);
  });
}
