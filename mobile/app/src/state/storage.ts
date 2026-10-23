import { createMMKV } from 'react-native-mmkv';

/**
 * App-wide key-value store (MMKV), unencrypted. Not for secrets: private keys
 * and anything the web keeps under `yappr_secure_` belong in expo-secure-store.
 */
const storage = createMMKV({ id: 'yappr' });

/**
 * The web-Storage-shaped adapter that zustand's `persist` and TanStack
 * Query's persister both accept.
 */
export const syncStorage = {
  getItem: (key: string) => storage.getString(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => {
    storage.remove(key);
  },
};

/** Removes every key that starts with `prefix` (an account's data, when it signs out). */
export function removeKeysWithPrefix(prefix: string): void {
  for (const key of storage.getAllKeys()) {
    if (key.startsWith(prefix)) storage.remove(key);
  }
}
