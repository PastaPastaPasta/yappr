import * as SecureStore from 'expo-secure-store';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { createMMKV, deleteMMKV, type MMKV } from 'react-native-mmkv';
import { create } from 'zustand';

import { appendLog, errorMessage } from '~/engine/logs';
import { newEncryptionKey } from '~/engine/storage/engine-storage';

/**
 * Unsent composer text per account and conversation (PRD DM-04, QA E-20).
 *
 * The screens read it from memory. It is also kept on the device, so it
 * survives a kill: it is message content and the app's own MMKV is not
 * encrypted, so it goes to an encrypted MMKV instance of its own, whose
 * AES-256 key is in the Keychain / Keystore (this device only), like the
 * engine's storage. Saved 500 ms after a change and whenever the app leaves
 * the foreground, as compose drafts are (PRD COMP-09), and at once when one
 * is sent. An account's drafts are read when one of its conversations opens,
 * and deleted when it signs out (`forgetDmDrafts`, PRD AUTH-11).
 */
interface DraftsState {
  byKey: Record<string, string>;
  set: (identityId: string, key: string, text: string) => void;
  /** Puts a failed send's text back, ahead of anything typed since. */
  restore: (identityId: string, key: string, text: string) => void;
  /** Drops every draft from memory (the account changed); what was typed is saved first. */
  clearAll: () => void;
}

const SEPARATOR = '\u0000';
const slot = (identityId: string, key: string) => `${identityId}${SEPARATOR}${key}`;

const SAVE_DELAY_MS = 500;
const STORE_ID = 'yappr.dm-drafts';
const KEY_NAME = 'yappr.mmkv-key.dm-drafts';
const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'pr.yap.app.engine-keys',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
const storeKey = (identityId: string) => `drafts.${identityId}`;

let store: MMKV | null = null;
let opening: Promise<MMKV> | null = null;
/** Accounts whose saved drafts are in memory: memory is then the whole truth for them. */
const loaded = new Set<string>();
/**
 * Before an account's saved drafts are in memory: the conversations whose
 * draft was cleared or sent meanwhile, so the saved copy never comes back.
 */
const cleared = new Map<string, Set<string>>();
/** Accounts with changes not saved yet. */
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let listening = false;

function openStore(): Promise<MMKV> {
  opening ??= (async () => {
    let key = await SecureStore.getItemAsync(KEY_NAME, KEY_OPTIONS);
    if (!key) {
      // No key (a first launch): whatever an earlier key encrypted can never be read again.
      deleteMMKV(STORE_ID);
      key = newEncryptionKey();
      await SecureStore.setItemAsync(KEY_NAME, key, KEY_OPTIONS);
    }
    store = createMMKV({ id: STORE_ID, encryptionKey: key, encryptionType: 'AES-256' });
    return store;
  })().catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** Runs `work` on the store: now once it is open, else once it opens, in call order. */
function withStore(work: (opened: MMKV) => void): void {
  if (store) {
    work(store);
    return;
  }
  openStore()
    .then(work)
    .catch((error: unknown) => appendLog('warn', 'host', `Message drafts storage failed: ${errorMessage(error)}`));
}

function readSaved(opened: MMKV, identityId: string): Record<string, string> {
  try {
    const parsed = JSON.parse(opened.getString(storeKey(identityId)) ?? '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''),
    );
  } catch {
    return {};
  }
}

function draftsOf(byKey: Record<string, string>, identityId: string): Record<string, string> {
  const prefix = `${identityId}${SEPARATOR}`;
  return Object.fromEntries(
    Object.entries(byKey)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, text]) => [key.slice(prefix.length), text]),
  );
}

/** Saves now what changed: on the background, a kill can follow at any moment. */
export function flushDmDrafts(): void {
  clearTimeout(timer);
  timer = undefined;
  if (dirty.size === 0) return;
  const { byKey } = useDrafts.getState();
  // Taken now: memory may be cleared (an account change) before the store opens.
  const writes = Array.from(dirty, (identityId) => ({
    identityId,
    drafts: draftsOf(byKey, identityId),
    whole: loaded.has(identityId),
    gone: new Set(cleared.get(identityId)),
  }));
  dirty.clear();
  withStore((opened) => {
    for (const { identityId, drafts, whole, gone } of writes) {
      // Typed before the saved drafts were read: keep the other conversations' saved ones, not those cleared since.
      const saved = whole ? {} : readSaved(opened, identityId);
      gone.forEach((key) => delete saved[key]);
      const all = { ...saved, ...drafts };
      if (Object.keys(all).length > 0) opened.set(storeKey(identityId), JSON.stringify(all));
      else opened.remove(storeKey(identityId));
    }
  });
}

function changed(identityId: string): void {
  dirty.add(identityId);
  if (!listening) {
    listening = true;
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushDmDrafts();
    });
  }
  clearTimeout(timer);
  timer = setTimeout(flushDmDrafts, SAVE_DELAY_MS);
}

/** Before the account's saved drafts are read: a cleared draft stays cleared, a typed one wins anyway. */
function noteCleared(identityId: string, key: string, isCleared: boolean): void {
  if (loaded.has(identityId)) return;
  const keys = cleared.get(identityId) ?? new Set<string>();
  if (isCleared) keys.add(key);
  else keys.delete(key);
  if (keys.size > 0) cleared.set(identityId, keys);
  else cleared.delete(identityId);
}

export const useDrafts = create<DraftsState>()((set) => ({
  byKey: {},
  set: (identityId, key, text) => {
    noteCleared(identityId, key, !text);
    set(({ byKey }) => {
      const next = { ...byKey };
      if (text) next[slot(identityId, key)] = text;
      else delete next[slot(identityId, key)];
      return { byKey: next };
    });
    changed(identityId);
  },
  restore: (identityId, key, text) => {
    noteCleared(identityId, key, false);
    set(({ byKey }) => {
      const current = byKey[slot(identityId, key)]?.trim();
      return { byKey: { ...byKey, [slot(identityId, key)]: current ? `${text.trim()}\n${current}` : text.trim() } };
    });
    changed(identityId);
  },
  clearAll: () => {
    flushDmDrafts();
    loaded.clear();
    cleared.clear();
    set({ byKey: {} });
  },
}));

/** Reads an account's saved drafts into memory, once; text typed meanwhile wins. */
function loadDmDrafts(identityId: string): void {
  if (loaded.has(identityId)) return;
  withStore((opened) => {
    if (loaded.has(identityId)) return;
    loaded.add(identityId);
    const saved = readSaved(opened, identityId);
    const gone = cleared.get(identityId);
    cleared.delete(identityId);
    useDrafts.setState(({ byKey }) => {
      const next = { ...byKey };
      for (const [key, text] of Object.entries(saved)) if (!gone?.has(key)) next[slot(identityId, key)] ??= text;
      return { byKey: next };
    });
  });
}

/** The account signed out: its unsent text goes, from memory and from the device (PRD AUTH-11). */
export function forgetDmDrafts(identityId: string): void {
  dirty.delete(identityId);
  loaded.delete(identityId);
  cleared.delete(identityId);
  useDrafts.setState(({ byKey }) => ({
    byKey: Object.fromEntries(Object.entries(byKey).filter(([key]) => !key.startsWith(`${identityId}${SEPARATOR}`))),
  }));
  withStore((opened) => opened.remove(storeKey(identityId)));
}

/**
 * Takes the draft to send it: read at call time (two quick taps send it once)
 * and cleared, saved at once, so a crash right after the send never brings
 * the sent text back as a draft.
 */
export function takeDraft(identityId: string, key: string): string {
  const text = useDrafts.getState().byKey[slot(identityId, key)] ?? '';
  if (text) {
    useDrafts.getState().set(identityId, key, '');
    flushDmDrafts();
  }
  return text;
}

/** The conversation's unsent text, with the account's saved drafts read in on first use. */
export function useDraft(identityId: string | null, key: string): string {
  useEffect(() => {
    if (identityId) loadDmDrafts(identityId);
  }, [identityId]);
  return useDrafts((s) => (identityId ? (s.byKey[slot(identityId, key)] ?? '') : ''));
}
