import type { ConversationDTO, WriteTicket } from '@engine/api';
import { router } from 'expo-router';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { onEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { writeTicketOf } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { errorFeedback, lightImpact } from '~/ui/haptics';
import { toast } from '~/ui/toast';

import { readErrorMessage, refreshDm } from './dm-data';

/** Opens a conversation on the Messages tab's stack. */
export function openConversationScreen(key: string): void {
  router.push({ pathname: '/messages/[conversationId]', params: { conversationId: key } });
}

function failed(what: string, error: unknown): void {
  appendLog('warn', 'host', `${what} failed: ${errorMessage(error)}`);
  errorFeedback();
  toast.error(readErrorMessage(error) ?? "That didn't work. Please try again.");
}

/**
 * Conversations this device holds out of the inbox list before the engine
 * does (PRD DM-09): one being archived while its Undo is offered, and a
 * group just left. The inbox lists them under "Archived", as the engine's
 * own hidden ones. Memory only: the engine's state is the lasting truth.
 */
export const useLocallyHidden = create<{ keys: Readonly<Record<string, true>> }>()(() => ({ keys: {} }));

export function hideLocally(key: string): void {
  useLocallyHidden.setState(({ keys }) => ({ keys: { ...keys, [key]: true } }));
}

export function unhideLocally(key: string): void {
  useLocallyHidden.setState(({ keys }) =>
    keys[key] ? { keys: Object.fromEntries(Object.entries(keys).filter(([hidden]) => hidden !== key)) } : { keys },
  );
}

/** As long as Undo is offered (the toast's own time, so Undo never outlives it). */
export const ARCHIVE_UNDO_MS = 6_000;

/** Archives waiting out their Undo, by conversation key. */
const archiving = new Map<string, { identityId: string; timer: ReturnType<typeof setTimeout> }>();
let leavingForeground: { remove: () => void } | null = null;

/** Takes an archive off the waiting list; null when it was not on it (undone, or saved already). */
function takeArchive(key: string): { identityId: string } | null {
  const pending = archiving.get(key);
  if (!pending) return null;
  clearTimeout(pending.timer);
  archiving.delete(key);
  if (archiving.size === 0) {
    leavingForeground?.remove();
    leavingForeground = null;
  }
  return pending;
}

/** Saves an archive whose Undo has passed (or the app left the foreground): the engine's `dm.hide`. */
async function commitArchive(key: string): Promise<void> {
  const pending = takeArchive(key);
  if (!pending) return;
  // Archived by an account that is no longer active: the engine would hide it for another one.
  if (useSessionStore.getState().session?.identityId !== pending.identityId) {
    unhideLocally(key);
    return;
  }
  try {
    await engine.api.dm.hide(key);
    // Shown as archived by the engine's own flag from the next read on (and back when a message arrives).
    await queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations });
  } catch (error) {
    appendLog('warn', 'host', `Archiving a conversation failed: ${errorMessage(error)}`);
    errorFeedback();
    toast.error("Couldn't archive the conversation. Try again.");
  } finally {
    unhideLocally(key);
  }
}

/**
 * A group just left (PRD DM-08): out of the inbox at once, while the leave
 * (`ticketId`) goes out. Back if the leave fails (the tracker says so), or
 * if the account changes first; once it is confirmed the engine keeps it out
 * itself. An outcome that stays unknown keeps it out for this session: lib
 * hides a group it sees left.
 */
export function hideWhileLeaving(key: string, ticketId: string): void {
  hideLocally(key);
  const identityId = useSessionStore.getState().session?.identityId ?? null;
  let done = false;
  let stopEvents = () => {};
  let stopSession = () => {};
  const finish = (refresh: boolean) => {
    done = true;
    stopEvents();
    stopSession();
    if (!refresh) {
      unhideLocally(key);
      return;
    }
    queryClient
      .invalidateQueries({ queryKey: queryKeys.dm.conversations })
      .catch(() => undefined)
      .finally(() => unhideLocally(key));
  };
  const settle = (ticket: WriteTicket | null) => {
    if (done || ticket?.id !== ticketId) return;
    // Proved not to have left (the tracker says "Couldn't leave the group"); a failure that may have landed stays out.
    const notLeft = ticket.state === 'failed' ? ticket.error?.outcome !== 'unknown' : ticket.state === 'unconfirmed' && ticket.retryable;
    if (notLeft) finish(false);
    else if (ticket.state === 'confirmed') finish(true);
  };
  stopEvents = onEngineEvent('write.status', settle);
  stopSession = useSessionStore.subscribe((state) => {
    if ((state.session?.identityId ?? null) !== identityId) finish(false);
  });
  // It may have settled before this listened (a refusal answered with the ticket).
  settle(writeTicketOf(ticketId));
}

/**
 * PRD DM-09 "Archive conversation" (v5), with no confirmation: it leaves the
 * list at once with "Conversation archived" and Undo. It is saved once Undo
 * has passed, or as the app leaves the foreground; the engine brings it
 * back when a new message arrives.
 */
export function archiveConversation(conversation: Pick<ConversationDTO, 'key'>): void {
  const identityId = useSessionStore.getState().session?.identityId;
  const { key } = conversation;
  if (!identityId || archiving.has(key)) return;
  hideLocally(key);
  lightImpact();
  const timer = setTimeout(() => {
    commitArchive(key).catch(() => undefined);
  }, ARCHIVE_UNDO_MS);
  archiving.set(key, { identityId, timer });
  leavingForeground ??= AppState.addEventListener('change', (next) => {
    if (next === 'active') return;
    for (const pending of [...archiving.keys()]) commitArchive(pending).catch(() => undefined);
  });
  toast('Conversation archived', {
    duration: ARCHIVE_UNDO_MS,
    action: {
      label: 'Undo',
      onPress: () => {
        if (takeArchive(key)) unhideLocally(key);
      },
    },
  });
}

/**
 * Block or unblock someone in Messages (v5 DM-10, the encrypted self-state):
 * their messages and group invitations are ignored. Saved at once. `done`
 * is the toast (Message settings' "Unblock" says "User unblocked").
 */
export async function setBlockedInMessages(peerId: string, blocked: boolean, done?: string): Promise<void> {
  try {
    await engine.api.dm.setBlocked(peerId, blocked);
    lightImpact();
    toast.success(done ?? (blocked ? 'User blocked' : 'User unblocked'));
    refreshDm();
  } catch (error) {
    failed(blocked ? 'Blocking' : 'Unblocking', error);
  }
}

/**
 * The Messages half of a profile Block or Unblock on DM v5 (PRD SAFE-01,
 * SAFE-02), silent: the block's own toast speaks for both. The engine writes
 * nothing when it already stands, and keeps it until Messages unlock on a
 * device without the encryption key. Called once the account's block is
 * confirmed; a failure is only logged.
 */
export async function syncMessagesBlock(peerId: string, blocked: boolean): Promise<void> {
  try {
    await engine.api.dm.setBlocked(peerId, blocked);
    refreshDm();
  } catch (error) {
    appendLog('warn', 'host', `${blocked ? 'Blocking' : 'Unblocking'} in Messages failed: ${errorMessage(error)}`);
  }
}
