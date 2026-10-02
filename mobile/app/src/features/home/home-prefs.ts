import type { RankingWindow } from '@engine/api';
import type { FeedTab } from '@engine/api/feed';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { syncStorage } from '~/state/storage';

export type FeedSort = 'recent' | 'top';

/** Home's tab, sort and Top window, remembered per account (PRD FEED-03, PD-12). */
export interface HomePrefs {
  tab: FeedTab;
  sort: FeedSort;
  window: RankingWindow;
}

export const DEFAULT_PREFS: HomePrefs = { tab: 'forYou', sort: 'recent', window: 'all' };

/** The account a preference belongs to; signed out has its own. */
export const accountKey = (identityId: string | null) => identityId ?? 'signed-out';

/** Remembering a few accounts is plenty; the oldest are dropped past this. */
const MAX_ACCOUNTS = 20;

/** A persisted value we can trust, field by field, else the default. */
export function toHomePrefs(value: unknown): HomePrefs {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof HomePrefs, unknown>>;
  return {
    tab: v.tab === 'following' ? 'following' : 'forYou',
    sort: v.sort === 'top' ? 'top' : 'recent',
    window: v.window === 'today' ? 'today' : 'all',
  };
}

function toAccounts(value: unknown): Record<string, HomePrefs> {
  const accounts = (value as { accounts?: unknown } | null | undefined)?.accounts;
  if (typeof accounts !== 'object' || accounts === null) return {};
  return Object.fromEntries(Object.entries(accounts).map(([key, prefs]) => [key, toHomePrefs(prefs)]));
}

interface HomePrefsState {
  accounts: Record<string, HomePrefs>;
  set: (account: string, patch: Partial<HomePrefs>) => void;
}

export const useHomePrefsStore = create<HomePrefsState>()(
  persist(
    (set) => ({
      accounts: {},
      set: (account, patch) =>
        set(({ accounts }) => {
          const { [account]: current = DEFAULT_PREFS, ...others } = accounts;
          // Most recent last, so the oldest are the first entries dropped.
          const kept = Object.entries(others).slice(-(MAX_ACCOUNTS - 1));
          return { accounts: { ...Object.fromEntries(kept), [account]: { ...current, ...patch } } };
        }),
    }),
    {
      name: 'yappr.home',
      version: 1,
      storage: createJSONStorage(() => syncStorage),
      partialize: (state) => ({ accounts: state.accounts }),
      migrate: (persisted) => ({ accounts: toAccounts(persisted) }),
      merge: (persisted, current) => ({ ...current, accounts: toAccounts(persisted) }),
    },
  ),
);

/** The account's remembered Home, and its setter. */
export function useHomePrefs(account: string): [HomePrefs, (patch: Partial<HomePrefs>) => void] {
  const prefs = useHomePrefsStore((s) => s.accounts[account]) ?? DEFAULT_PREFS;
  const setPrefs = useHomePrefsStore((s) => s.set);
  return [prefs, (patch) => setPrefs(account, patch)];
}
