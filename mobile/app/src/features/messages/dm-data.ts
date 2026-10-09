import type { ConversationDTO, DmStatusDTO, MessageDTO, SettingsDTO, UserSummaryDTO } from '@engine/api';
import { useEffect, useMemo, useRef } from 'react';

import { useEngineEvent } from '~/data/events';
import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery, type EngineRemote } from '~/data/queries';
import { lastIdentity, useCapabilities, useSession } from '~/data/session';
import { errorCode } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';

import { clearLocalMessages } from './outbox';
import { useAppActive } from './use-app-active';

/**
 * The Messages data (PRD DM-01 – DM-14): status, inbox, conversation pages
 * and member names over `dm.*`, kept live by `dm.changed` / `dm.message`.
 * Never persisted: decrypted text must not reach MMKV (src/data/README.md).
 */

/** DM-13: the badge follows the notifications poll, every 30 s in the foreground. */
export const STATUS_POLL_MS = 30_000;
/** Legacy re-reads the inbox only when asked: at most every 30 s while it shows (ENGINE `dm`). */
export const LEGACY_INBOX_POLL_MS = 30_000;

/** `ENGINE_BUSY`: v5's saved state has not loaded yet. Worth waiting for; nothing else is. */
function retryDm(failures: number, error: unknown): boolean {
  if (errorCode(error) === 'ENGINE_BUSY') return failures < 20;
  if (errorCode(error) === 'NO_KEY' || errorCode(error) === 'BAD_REQUEST') return false;
  return failures < 1;
}
const retryDelay = (failures: number) => Math.min(1000 * 2 ** failures, 4000);

/** Signed in, or (before the engine restores) signed in last time (PRD G-2). */
export function useDmViewer(): { signedIn: boolean; viewerId: string | null } {
  const { status, identityId } = useSession();
  const provisional = status === 'unknown' ? lastIdentity() : null;
  return { signedIn: status === 'signed-in' || provisional !== null, viewerId: identityId ?? provisional };
}

/** `v5` or `legacy`; null on a first launch before the engine reports it. */
export function useDmBackend(): 'v5' | 'legacy' | null {
  return useCapabilities()?.dm ?? null;
}

/** `dm.status`: the lock, readiness, unread counts and (v5) settings. */
export function useDmStatus(enabled: boolean) {
  const active = useAppActive();
  return useEngineQuery<DmStatusDTO>(queryKeys.dm.status, (api) => api.dm.status(), {
    enabled,
    retry: retryDm,
    retryDelay,
    refetchInterval: active ? STATUS_POLL_MS : false,
    staleTime: 5_000,
  });
}

/** `dm.conversations`: every conversation, hidden ones flagged. */
/** Reads of the inbox begun so far, and the newest of them that has answered. */
let inboxReadsBegun = 0;
let inboxReadAnswered = 0;

/** How many reads of the inbox have begun: one numbered above this begins after now. */
export function inboxReadsSoFar(): number {
  return inboxReadsBegun;
}

/** The newest read of the inbox that has answered, by its number ({@link inboxReadsSoFar}). */
export function inboxReadHeld(): number {
  return inboxReadAnswered;
}

/** `dm.conversations`, numbered: what it answers is Messages as they stood when it began. */
async function readInbox(api: EngineRemote): Promise<ConversationDTO[]> {
  const read = ++inboxReadsBegun;
  const rows = await api.dm.conversations();
  inboxReadAnswered = Math.max(inboxReadAnswered, read);
  return rows;
}

export function useConversations(enabled: boolean, legacyPolling = false) {
  return useEngineQuery<ConversationDTO[]>(queryKeys.dm.conversations, readInbox, {
    enabled,
    retry: retryDm,
    retryDelay,
    staleTime: 5_000,
    refetchInterval: legacyPolling ? LEGACY_INBOX_POLL_MS : false,
  });
}

/** One conversation's row, from the inbox. */
export function useConversation(key: string, enabled: boolean): ConversationDTO | undefined {
  const { data } = useConversations(enabled);
  return useMemo(() => data?.find((c) => c.key === key), [data, key]);
}

/** `dm.messages`: newest first, 50 a page; older pages load on demand. */
export function useMessages(key: string, enabled: boolean) {
  return useEngineInfiniteQuery<MessageDTO>(
    queryKeys.dm.messages(key),
    (api, cursor) => api.dm.messages(key, cursor),
    { enabled: enabled && !!key, retry: retryDm, retryDelay, staleTime: 2_000 },
  );
}

/** Names and avatars for member ids (`profiles.batch`, at most 100), by id. */
export function usePeople(ids: readonly string[], enabled = true) {
  const sorted = useMemo(() => Array.from(new Set(ids)).sort().slice(0, 100), [ids]);
  const query = useEngineQuery<UserSummaryDTO[]>(queryKeys.dm.people(sorted), (api) => api.profiles.batch(sorted), {
    enabled: enabled && sorted.length > 0,
    staleTime: 10 * 60_000,
  });
  const byId = useMemo(() => new Map((query.data ?? []).map((user) => [user.id, user])), [query.data]);
  return { ...query, byId };
}

/** `settings.get` (read receipts live there; DM-11). */
export function useDmSettings(enabled = true) {
  return useEngineQuery<SettingsDTO>(queryKeys.settings, (api) => api.settings.get(), { enabled });
}

/** Re-read the status, the inbox and the conversations that changed. */
export function refreshDm(changedKeys: readonly string[] = []): void {
  const done = (promise: Promise<unknown>) => {
    promise.catch(() => undefined);
  };
  done(queryClient.invalidateQueries({ queryKey: queryKeys.dm.status }));
  done(queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations }));
  for (const key of changedKeys) done(queryClient.invalidateQueries({ queryKey: queryKeys.dm.messages(key) }));
}

/**
 * Check for new messages now (pull to refresh, "Try again"), the first load
 * too if it failed, then re-read the status and the inbox. Never rejects: a
 * failed check shows in the status.
 */
export async function pollDm(): Promise<void> {
  await engine.api.dm.refresh().catch((error: unknown) => {
    appendLog('info', 'host', `dm.refresh failed: ${errorMessage(error)}`);
  });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.dm.status }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations }),
  ]).catch(() => undefined);
}

/**
 * The Messages tab badge (`useTabBadges`, DM-13): conversations with unread
 * messages, from `dm.status` (polled every 30 s in the foreground) and every
 * `dm.changed`. Also the one app-wide subscriber that keeps the inbox and
 * open conversations live. Hidden when signed out or locked.
 */
export function useMessagesBadge(): number {
  const { signedIn, viewerId } = useDmViewer();
  const status = useDmStatus(signedIn);

  useEngineEvent('dm.changed', ({ unreadTotal, unreadConversations, changedKeys, ready, error }) => {
    const previous = queryClient.getQueryData<DmStatusDTO>(queryKeys.dm.status);
    if (previous) {
      queryClient.setQueryData<DmStatusDTO>(queryKeys.dm.status, {
        ...previous,
        unreadTotal,
        unreadConversations,
        ready,
        error,
      });
    }
    // Readiness brings the rest of the status (retention, the block list) with it.
    if (!previous || previous.ready !== ready) refreshDm(changedKeys);
    else {
      queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations }).catch(() => undefined);
      for (const key of changedKeys) {
        queryClient.invalidateQueries({ queryKey: queryKeys.dm.messages(key) }).catch(() => undefined);
      }
    }
  });

  useEngineEvent('dm.message', ({ key }) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.dm.messages(key) }).catch(() => undefined);
    queryClient.invalidateQueries({ queryKey: queryKeys.dm.conversations }).catch(() => undefined);
  });

  // A new account starts from its own status (the cache reset drops the old one), and the
  // last account's unsent text and local sends go with it.
  const previousViewer = useRef(viewerId);
  useEffect(() => {
    if (previousViewer.current && previousViewer.current !== viewerId) clearLocalMessages();
    previousViewer.current = viewerId;
    if (viewerId) refreshDm();
  }, [viewerId]);

  if (!signedIn || !status.data || status.data.locked) return 0;
  return status.data.unreadConversations;
}

/** Tells the engine which conversation is on screen (fast polling), or none. */
export function openConversation(key: string | null): void {
  engine.api.dm.open(key).catch((error: unknown) => {
    appendLog('info', 'host', `dm.open failed: ${errorMessage(error)}`);
  });
}

/** Marks a conversation read; the next `dm.changed` settles the badge. */
export function markConversationRead(key: string): void {
  // Shown at once: the row and the badge drop it before the engine answers.
  queryClient.setQueryData<ConversationDTO[]>(queryKeys.dm.conversations, (rows) =>
    rows?.map((row) => (row.key === key && row.unread > 0 ? { ...row, unread: 0 } : row)),
  );
  engine.api.dm
    .markRead(key)
    .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.dm.status }))
    .catch((error: unknown) => {
      appendLog('info', 'host', `dm.markRead failed: ${errorMessage(error)}`);
      refreshDm();
    });
}

/** UX_SPEC §5.12, `lib/error-utils.ts`. */
export const UNAVAILABLE_MESSAGE = 'Dash Platform is temporarily unavailable. Please try again in a few moments.';

/** The categorized copy for a failed read (PRD G-11), or undefined for "Something went wrong" alone. */
export function readErrorMessage(error: unknown): string | undefined {
  switch (errorCode(error)) {
    case 'ENGINE_UNAVAILABLE':
    case 'ENGINE_RESTARTED':
    case 'ENGINE_DISCONNECTED':
    case 'ENGINE_HELLO_TIMEOUT':
    case 'RPC_TIMEOUT':
    case 'ENGINE_TIMEOUT':
    case 'UNAVAILABLE':
    case 'TIMEOUT':
      return UNAVAILABLE_MESSAGE;
    case 'ENGINE_BUSY':
      return 'Your messages are still loading. Try again in a moment.';
    case 'NETWORK':
      return 'Network error. Please check your connection and try again.';
    case 'NOT_SIGNED_IN':
      return 'Your session has expired. Please sign in again.';
    default:
      return undefined;
  }
}
