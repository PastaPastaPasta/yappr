import type { WriteTicket } from '@engine/api';
import { router } from 'expo-router';
import { create } from 'zustand';

import { syncStorage } from '~/state/storage';

/**
 * PRD AUTH-14: accounts whose stored key no longer signs. A write that fails
 * for want of a key (`NO_KEY`: the key is gone from this device) or because
 * Platform refused it (`KEY_REVOKED`: disabled, no longer on the identity,
 * expired) marks its account "Sign in again", across launches. Reads keep
 * working; write controls open the sign-in flow for that account instead
 * (`requireAuth`). A fresh sign-in of the account clears the mark
 * (`session.ts`), and so does signing it out.
 */

/** UX_SPEC §5.1 `session.expired`. */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

const STORAGE_KEY = 'yappr.session.expired';

function load(): string[] {
  try {
    const stored: unknown = JSON.parse(syncStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export const useExpiredSessions = create<{ ids: readonly string[] }>()(() => ({ ids: load() }));

function save(ids: readonly string[]): void {
  if (ids.length > 0) syncStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  else syncStorage.removeItem(STORAGE_KEY);
  useExpiredSessions.setState({ ids });
}

export function markSessionExpired(identityId: string): void {
  const { ids } = useExpiredSessions.getState();
  if (!ids.includes(identityId)) save([...ids, identityId]);
}

export function clearSessionExpired(identityId: string): void {
  const { ids } = useExpiredSessions.getState();
  if (ids.includes(identityId)) save(ids.filter((id) => id !== identityId));
}

export function isSessionExpired(identityId: string | null): boolean {
  return identityId !== null && useExpiredSessions.getState().ids.includes(identityId);
}

/** Whether `identityId` is marked "Sign in again"; re-renders when that changes. */
export function useSessionExpired(identityId: string | null): boolean {
  return useExpiredSessions((s) => identityId !== null && s.ids.includes(identityId));
}

/** Messages' writes: their `NO_KEY` is the device's Messages encryption key (unlock), not the session. */
const ENCRYPTION_KEY_OPS: ReadonlySet<WriteTicket['op']> = new Set(['dm.send', 'dm.group']);

/** Whether a failed write says the account's stored key no longer signs. */
export function failedForSession(ticket: Pick<WriteTicket, 'op' | 'error'>): boolean {
  const code = ticket.error?.code;
  return code === 'KEY_REVOKED' || (code === 'NO_KEY' && !ENCRYPTION_KEY_OPS.has(ticket.op));
}

let reauthHandler: ((identityId: string) => void) | null = null;

/**
 * The auth feature's "sign in again" flow (`features/auth/accounts.ts`
 * `reauthenticate`), registered once by `AuthGates`, so the data layer can
 * open it without depending on the feature.
 */
export function setReauthHandler(handler: (identityId: string) => void): () => void {
  reauthHandler = handler;
  return () => {
    if (reauthHandler === handler) reauthHandler = null;
  };
}

/** Open the sign-in flow for `identityId` (plain sign-in when no flow is registered). */
export function signInAgain(identityId: string): void {
  if (reauthHandler) reauthHandler(identityId);
  else router.push('/sign-in');
}
