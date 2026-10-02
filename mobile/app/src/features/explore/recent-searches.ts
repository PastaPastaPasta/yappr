import { useSyncExternalStore } from 'react';

import { lastIdentity, useSession } from '~/data/session';
import { syncStorage } from '~/state/storage';

/**
 * Recent searches (PRD EXPL-08): the last 10 submitted queries and opened
 * people or tags, on this device, per account. Public data only (names and
 * tags anyone can read), so MMKV is fine.
 */
export type RecentSearch =
  | { kind: 'query'; q: string }
  | { kind: 'user'; id: string; name: string; username: string | null }
  | { kind: 'tag'; tag: string };

export const MAX_RECENT = 10;
const KEY_PREFIX = 'yappr.explore.recent.';
const SIGNED_OUT = 'signed-out';

/** The entry's identity: the same query, person or tag replaces its older copy. */
export function recentKey(entry: RecentSearch): string {
  switch (entry.kind) {
    case 'query':
      return `q:${entry.q.trim().toLowerCase()}`;
    case 'user':
      return `u:${entry.id}`;
    case 'tag':
      return `t:${entry.tag}`;
  }
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Stored data is untrusted (another build may have written it): keep only well-formed entries. */
function isRecent(value: unknown): value is RecentSearch {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  switch (entry.kind) {
    case 'query':
      return isString(entry.q);
    case 'user':
      return isString(entry.id) && isString(entry.name) && (entry.username === null || isString(entry.username));
    case 'tag':
      return isString(entry.tag);
    default:
      return false;
  }
}

const listeners = new Set<() => void>();
const snapshots = new Map<string, readonly RecentSearch[]>();
const EMPTY: readonly RecentSearch[] = [];

function read(account: string): readonly RecentSearch[] {
  const cached = snapshots.get(account);
  if (cached) return cached;
  let entries: readonly RecentSearch[] = EMPTY;
  try {
    const parsed: unknown = JSON.parse(syncStorage.getItem(KEY_PREFIX + account) ?? '[]');
    if (Array.isArray(parsed)) entries = parsed.filter(isRecent).slice(0, MAX_RECENT);
  } catch {
    entries = EMPTY;
  }
  snapshots.set(account, entries);
  return entries;
}

function write(account: string, entries: readonly RecentSearch[]): void {
  if (entries.length === 0) syncStorage.removeItem(KEY_PREFIX + account);
  else syncStorage.setItem(KEY_PREFIX + account, JSON.stringify(entries));
  snapshots.set(account, entries);
  for (const listener of listeners) listener();
}

/** Puts `entry` first, dropping its older copy and anything past the 10th. */
export function addRecent(account: string, entry: RecentSearch): void {
  const key = recentKey(entry);
  write(account, [entry, ...read(account).filter((e) => recentKey(e) !== key)].slice(0, MAX_RECENT));
}

export function removeRecent(account: string, entry: RecentSearch): void {
  const key = recentKey(entry);
  write(account, read(account).filter((e) => recentKey(e) !== key));
}

export function clearRecent(account: string): void {
  write(account, EMPTY);
}

export function getRecent(account: string): readonly RecentSearch[] {
  return read(account);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The storage bucket for the viewer: before the session restores, whoever was signed in last (PRD G-2). */
export function useRecentAccount(): string {
  const { status, identityId } = useSession();
  return (status === 'unknown' ? lastIdentity() : identityId) ?? SIGNED_OUT;
}

/** The viewer's recent searches, and the edits on them. */
export function useRecentSearches() {
  const account = useRecentAccount();
  const entries = useSyncExternalStore(subscribe, () => read(account));
  return {
    entries,
    add: (entry: RecentSearch) => addRecent(account, entry),
    remove: (entry: RecentSearch) => removeRecent(account, entry),
    clear: () => clearRecent(account),
  };
}
