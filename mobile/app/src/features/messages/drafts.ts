import { create } from 'zustand';

/**
 * Unsent composer text per account and conversation (PRD DM-04). Kept in
 * memory only: it is message content, and the app's MMKV is not encrypted
 * (src/data/README.md), so a draft survives navigation but not a restart.
 */
interface DraftsState {
  byKey: Record<string, string>;
  set: (identityId: string, key: string, text: string) => void;
  /** Puts a failed send's text back, ahead of anything typed since. */
  restore: (identityId: string, key: string, text: string) => void;
  clearAll: () => void;
}

const slot = (identityId: string, key: string) => `${identityId}\u0000${key}`;

export const useDrafts = create<DraftsState>()((set) => ({
  byKey: {},
  set: (identityId, key, text) =>
    set(({ byKey }) => {
      const next = { ...byKey };
      if (text) next[slot(identityId, key)] = text;
      else delete next[slot(identityId, key)];
      return { byKey: next };
    }),
  restore: (identityId, key, text) =>
    set(({ byKey }) => {
      const current = byKey[slot(identityId, key)]?.trim();
      return { byKey: { ...byKey, [slot(identityId, key)]: current ? `${text.trim()}\n${current}` : text.trim() } };
    }),
  clearAll: () => set({ byKey: {} }),
}));

/** Takes the draft to send it: read at call time (two quick taps send it once) and cleared. */
export function takeDraft(identityId: string, key: string): string {
  const text = useDrafts.getState().byKey[slot(identityId, key)] ?? '';
  if (text) useDrafts.getState().set(identityId, key, '');
  return text;
}

export function useDraft(identityId: string | null, key: string): string {
  return useDrafts((s) => (identityId ? (s.byKey[slot(identityId, key)] ?? '') : ''));
}
