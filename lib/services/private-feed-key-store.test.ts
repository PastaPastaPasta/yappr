import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateFeedKeyStore } from './private-feed-key-store';
import { scopedKey } from '../storage-scope';

let store: PrivateFeedKeyStore;
let storage: Map<string, string>;
const pathKeys = [{ nodeId: 1, version: 1, key: new Uint8Array(32) }];
const cek = new Uint8Array(32);

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  });
  store = new PrivateFeedKeyStore();
});
afterEach(() => vi.unstubAllGlobals());

describe('private reply key readiness', () => {
  it('requires both path keys and a CEK covering the requested post epoch', () => {
    expect(store.hasKeysForEpoch('owner', 2)).toBe(false);
    store.storePathKeys('owner', pathKeys);
    expect(store.hasKeysForEpoch('owner', 2)).toBe(false);
    store.storeCachedCEK('owner', 1, cek);
    expect(store.hasKeysForEpoch('owner', 2)).toBe(false);
    expect(store.hasKeysForEpoch('owner', 1)).toBe(true);
    expect(store.hasKeysForEpoch('different-owner', 1)).toBe(false);
    store.storeCachedCEK('owner', 2, cek);
    expect(store.hasKeysForEpoch('owner', 2)).toBe(true);
    expect(store.hasKeysForEpoch('owner', 1)).toBe(true);
  });

  it('notifies subscribers when normal recovery and catch-up change readiness', () => {
    const readiness: boolean[] = [];
    const unsubscribe = store.subscribeFollowerKeys(() => readiness.push(store.hasKeysForEpoch('owner', 2)));
    store.initializeFollowerState('owner', pathKeys, 1, cek);
    expect(readiness.at(-1)).toBe(false);
    store.storeCachedCEK('owner', 2, cek);
    expect(readiness.at(-1)).toBe(true);
    store.clearFeedKeys('owner');
    expect(readiness.at(-1)).toBe(false);
    unsubscribe();
    const count = readiness.length;
    store.initializeFollowerState('owner', pathKeys, 2, cek);
    expect(readiness).toHaveLength(count);
  });

  it('notifies when all keys are cleared, including logout cleanup', () => {
    store.initializeFollowerState('owner', pathKeys, 2, cek);
    const listener = vi.fn();
    const unsubscribe = store.subscribeFollowerKeys(listener);
    store.clearAllKeys();
    expect(listener).toHaveBeenCalledOnce();
    expect(store.hasKeysForEpoch('owner', 2)).toBe(false);
    unsubscribe();
  });

  it('observes relevant cross-tab storage changes and removes the listener on unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribeFollowerKeys(listener);
    const dispatch = (key: string | null) => window.dispatchEvent(Object.assign(new Event('storage'), { key }));
    dispatch('unrelated-setting');
    expect(listener).not.toHaveBeenCalled();
    dispatch(scopedKey('yappr:pf:cached_cek:owner'));
    dispatch(scopedKey('yappr:pf:path_keys:owner'));
    dispatch(null);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    dispatch(null);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
