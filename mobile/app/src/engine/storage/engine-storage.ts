import type { StorageBatch } from '@engine/rpc/client';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createMMKV, deleteMMKV, type MMKV } from 'react-native-mmkv';

import { syncStorage } from '~/state/storage';

import {
  chunkKey,
  encodeSecureKey,
  identityOfKey,
  SECURE_CHUNK_CHARS,
  SHARED_BUCKET,
} from './secure-keys';

/**
 * Where the engine's `localStorage` lives on the device (ENGINE.md §9.1,
 * §9.2; ADR-001 E1 as amended):
 *
 * - The plain area (`kv` batches) is an encrypted MMKV instance per network,
 *   `yappr.engine.<networkKey>`. Its 32-byte AES-256 key is generated on first
 *   launch and kept in the Keychain/Keystore, this device only.
 * - The secure area (`skv` batches: `yappr_secure_*`, `yappr:pf:*`, upload
 *   credentials) is expo-secure-store, one item per key (long values split
 *   into chunks), under `pr.yap.app.secrets.<networkKey>`. SecureStore cannot
 *   list its keys, so an index of names (never values), grouped by identity,
 *   is kept in the app MMKV as `mobile.secure-index.<networkKey>`.
 */

export interface StorageSnapshot {
  local: Record<string, string>;
  secure: Record<string, string>;
}

export interface StorageStats {
  localKeys: number;
  secureKeys: number;
  identities: number;
  /** UTF-16 length of the last snapshot handed to the engine. */
  snapshotChars: number;
}

/** identity (or SHARED_BUCKET) → storage key → number of SecureStore items it occupies. */
type SecureIndex = Record<string, Record<string, number>>;

/** lib's session record (lib/auth/platform-auth-adapters.ts `toStoredSession`). */
const SESSION_KEY = 'yappr_session';

const MMKV_KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'pr.yap.app.engine-keys',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * 32 random bytes, each mapped onto a 64-character alphabet (256 is a multiple
 * of 64, so the mapping is unbiased): 32 bytes of key material for AES-256
 * and 192 bits of entropy, as an ASCII string MMKV takes byte for byte.
 */
function newEncryptionKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from(getRandomBytes(32), (byte) => alphabet[byte % 64]).join('');
}

export interface EngineStorage {
  /** Opens (on first launch: creates) the encrypted instance. Idempotent. */
  open(): Promise<void>;
  /**
   * The engine's hydration snapshot: every plain key, plus the secure keys of
   * the shared bucket and of `identityId` (default: the session's identity),
   * so two accounts' secrets are never in the engine together.
   */
  snapshot(identityId?: string | null): Promise<StorageSnapshot>;
  /** Apply one write-through batch; a secure batch's Promise resolves once it is durable. */
  apply(batch: StorageBatch): void | Promise<void>;
  /** Resolves once every secure write so far has settled. */
  idle(): Promise<void>;
  /** Deletes this network's engine data: the MMKV instance, its key, every indexed secret. */
  reset(): Promise<void>;
  stats(): StorageStats;
}

export function createEngineStorage(networkKey: string): EngineStorage {
  const instanceId = `yappr.engine.${networkKey}`;
  const keyName = `yappr.mmkv-key.${networkKey}`;
  const indexName = `mobile.secure-index.${networkKey}`;
  const secureOptions: SecureStore.SecureStoreOptions = {
    keychainService: `pr.yap.app.secrets.${networkKey}`,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };

  let kv: MMKV | null = null;
  let opening: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();
  let snapshotChars = 0;

  const store = () => {
    if (!kv) throw new Error('Engine storage is not open');
    return kv;
  };

  const readIndex = (): SecureIndex => {
    const raw = syncStorage.getItem(indexName);
    return raw ? (JSON.parse(raw) as SecureIndex) : {};
  };
  const writeIndex = (index: SecureIndex) => syncStorage.setItem(indexName, JSON.stringify(index));
  const chunksOf = (index: SecureIndex, key: string) => index[identityOfKey(key)]?.[key] ?? 0;

  /** Item names of a key stored in `count` chunks: the first under the key itself. */
  const itemNames = (key: string, from: number, to: number) => {
    const encoded = encodeSecureKey(key);
    const names: string[] = [];
    for (let i = from; i < to; i++) names.push(i === 0 ? encoded : chunkKey(encoded, i));
    return names;
  };

  const deleteItems = (names: string[]) =>
    Promise.all(names.map((name) => SecureStore.deleteItemAsync(name, secureOptions)));

  const setSecret = async (key: string, value: string) => {
    const chunks: string[] = [];
    for (let i = 0; i < value.length || i === 0; i += SECURE_CHUNK_CHARS) {
      chunks.push(value.slice(i, i + SECURE_CHUNK_CHARS));
    }
    const names = itemNames(key, 0, chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(names[i], chunks[i], secureOptions);
    }
    const index = readIndex();
    const previous = chunksOf(index, key);
    (index[identityOfKey(key)] ??= {})[key] = chunks.length;
    writeIndex(index);
    if (previous > chunks.length) await deleteItems(itemNames(key, chunks.length, previous));
  };

  const deleteSecret = async (key: string) => {
    const index = readIndex();
    // An unindexed key may still hold a single item (written before an index reset).
    const count = Math.max(chunksOf(index, key), 1);
    await deleteItems(itemNames(key, 0, count));
    const bucket = index[identityOfKey(key)];
    if (bucket) {
      delete bucket[key];
      if (Object.keys(bucket).length === 0) delete index[identityOfKey(key)];
      writeIndex(index);
    }
  };

  const readSecret = async (key: string, count: number): Promise<string | null> => {
    const parts = await Promise.all(
      itemNames(key, 0, count).map((name) => SecureStore.getItemAsync(name, secureOptions)),
    );
    return parts.some((part) => part === null) ? null : parts.join('');
  };

  const applySecure = async (ops: StorageBatch['ops']) => {
    for (const op of ops) {
      if (op[0] === 'set') await setSecret(op[1], op[2]);
      else if (op[0] === 'del') await deleteSecret(op[1]);
      else for (const key of Object.values(readIndex()).flatMap(Object.keys)) await deleteSecret(key);
    }
  };

  const sessionIdentity = (): string | null => {
    const raw = kv?.getString(SESSION_KEY);
    if (!raw) return null;
    try {
      const id = (JSON.parse(raw) as { user?: { identityId?: unknown } }).user?.identityId;
      return typeof id === 'string' ? id : null;
    } catch {
      return null;
    }
  };

  return {
    open() {
      opening ??= (async () => {
        let key = await SecureStore.getItemAsync(keyName, MMKV_KEY_OPTIONS);
        if (!key) {
          // Data written under a lost key is unreadable; start the instance clean.
          deleteMMKV(instanceId);
          key = newEncryptionKey();
          await SecureStore.setItemAsync(keyName, key, MMKV_KEY_OPTIONS);
        }
        kv = createMMKV({ id: instanceId, encryptionKey: key, encryptionType: 'AES-256' });
      })().catch((error: unknown) => {
        opening = null;
        throw error;
      });
      return opening;
    },

    async snapshot(identityId = sessionIdentity()) {
      const plain = store();
      const local: Record<string, string> = {};
      for (const key of plain.getAllKeys()) {
        const value = plain.getString(key);
        if (value !== undefined) local[key] = value;
      }
      const index = readIndex();
      const secure: Record<string, string> = {};
      for (const bucket of [SHARED_BUCKET, identityId]) {
        if (bucket === null) continue;
        for (const [key, count] of Object.entries(index[bucket] ?? {})) {
          const value = await readSecret(key, count);
          if (value !== null) secure[key] = value;
        }
      }
      snapshotChars = JSON.stringify(local).length + JSON.stringify(secure).length;
      return { local, secure };
    },

    apply(batch) {
      if (batch.area === 'local') {
        const plain = store();
        for (const op of batch.ops) {
          if (op[0] === 'set') plain.set(op[1], op[2]);
          else if (op[0] === 'del') plain.remove(op[1]);
          else plain.clearAll();
        }
        return undefined;
      }
      const written = tail.then(() => applySecure(batch.ops));
      tail = written.catch(() => undefined);
      return written;
    },

    idle() {
      return tail;
    },

    async reset() {
      await tail;
      for (const key of Object.values(readIndex()).flatMap(Object.keys)) await deleteSecret(key);
      syncStorage.removeItem(indexName);
      kv?.clearAll();
      kv = null;
      opening = null;
      deleteMMKV(instanceId);
      await SecureStore.deleteItemAsync(keyName, MMKV_KEY_OPTIONS);
    },

    stats() {
      const index = readIndex();
      return {
        localKeys: kv?.getAllKeys().length ?? 0,
        secureKeys: Object.values(index).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0),
        identities: Object.keys(index).filter((id) => id !== SHARED_BUCKET).length,
        snapshotChars,
      };
    },
  };
}
