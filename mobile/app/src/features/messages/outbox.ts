import type { MessageDTO, WriteTicket } from '@engine/api';
import { useMemo } from 'react';
import { create } from 'zustand';

import { onEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { checkWrite, errorCode, retryWrite, runWrite, type WriteSpec } from '~/data/writes';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { lightImpact } from '~/ui/haptics';
import { toast } from '~/ui/toast';

import { isPartOfSend, type OutboxStatus, type TimelineMessage } from './dm-model';
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
  useOutbox.setState(({ entries }) => ({ entries: [...entries, entry] }));
  lightImpact();
  const result = await runWrite(sendSpec, { entryId: entry.id, key, text });
  switch (result.status) {
    case 'submitted':
      applyTicket(entry.id, result.ticket);
      return;
    case 'refused':
      remove(entry.id);
      useDrafts.getState().restore(identityId, key, text);
      return;
    case 'unknown':
      // The engine restarted under the call: it may have gone out. A check settles it.
      update(entry.id, { state: 'unconfirmed' });
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
    // No ticket to check (the engine never answered): the message list shows whether it went out.
    queryClient.invalidateQueries({ queryKey: queryKeys.dm.messages(entry.key) }).catch(() => undefined);
    toast("Still checking. If it doesn't show, send it again.");
    return;
  }
  remove(entry.id);
  useDrafts.getState().restore(entry.identityId, entry.key, entry.text);
}

/** Forgets every local send and draft (sign-out): their plaintext must not outlive the session. */
export function clearLocalMessages(): void {
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

/**
 * The conversation with this device's sends merged in: a send the engine
 * already holds (the same text, mine, not there when it was sent) shows as
 * the engine's message; the rest show as local bubbles after them. `sending`
 * is true while any send is on its way.
 */
export function mergeOutbox(
  messages: readonly TimelineMessage[],
  entries: readonly OutboxEntry[],
): { messages: TimelineMessage[]; sending: boolean; landed: string[] } {
  const claimed = new Set<string>();
  const local: TimelineMessage[] = [];
  const landed: string[] = [];
  let sending = false;
  for (const entry of entries) {
    const before = new Set(entry.before);
    const matches = messages.filter(
      (m) =>
        m.own &&
        !m.outbox &&
        !before.has(m.id) &&
        !claimed.has(m.id) &&
        m.at.getTime() >= entry.after &&
        isPartOfSend(m, entry.text),
    );
    if (matches.length > 0) {
      for (const m of matches) claimed.add(m.id);
      if (entry.state === 'sending') sending = true;
      else landed.push(entry.id);
      continue;
    }
    if (entry.state === 'sending') sending = true;
    local.push({
      id: entry.id,
      sender: entry.identityId,
      text: entry.text.trim(),
      at: new Date(entry.createdAt),
      own: true,
      pending: entry.state === 'sending',
      outbox: statusOf(entry),
    });
  }
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

/** Forgets sends the engine's own messages now show (called after a merge). */
export function forgetLanded(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  useOutbox.setState(({ entries }) => ({ entries: entries.filter((e) => !gone.has(e.id)) }));
}

/** Logs and swallows: sends report their own failures on the bubble and in a toast. */
export function sendInBackground(identityId: string, key: string, text: string): void {
  sendMessage(identityId, key, text).catch((error: unknown) => {
    appendLog('warn', 'host', `DM send failed: ${errorMessage(error)}`);
  });
}
