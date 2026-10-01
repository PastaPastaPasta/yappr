import type { StorageBatch } from '@engine/rpc/client';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createMMKV, deleteMMKV, type MMKV } from 'react-native-mmkv';

import {
  identityInKey,
  isAuthKeyOf,
  SECURE_CHUNK_CHARS,
  secureItemName,
  SHARED_BUCKET,
  type Slot,
} from './secure-keys';

/**
 * Where the engine's `localStorage` lives on the device (ENGINE.md §9.1,
 * §9.2; ADR-001 E1 as amended):
 *
 * - The plain area (`kv` batches) is an encrypted MMKV instance per network,
 *   `yappr.engine.<networkKey>`. Its 32-byte AES-256 key is generated on first
 *   launch and kept in the Keychain/Keystore, this device only.
 * - The secure area (`skv` batches: `yappr_secure_*`, `yappr:pf:*`, upload
 *   credentials) is expo-secure-store under `pr.yap.app.secrets.<networkKey>`.
 *   Each value is filed in a bucket: the identity its key names, else the
 *   account signed in when it was written (lib's private-feed keys name no
 *   identity), else the shared bucket. A boot hydrates the shared bucket and
 *   the session's, so two accounts' secrets are never in the engine together.
 * - SecureStore cannot list its items, so an index of key names (never
 *   values) per bucket lives in a second encrypted MMKV instance,
 *   `yappr.engine-index.<networkKey>`.
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

/** Where a secure value's items are: `n` chunks in `slot`. */
interface Stored {
  n: number;
  slot: Slot;
}

/** bucket (identity or SHARED_BUCKET) → storage key → its items. */
type SecureIndex = Record<string, Record<string, Stored>>;

/** lib's session record (lib/auth/platform-auth-adapters.ts `toStoredSession`). */
const SESSION_KEY = 'yappr_session';
const INDEX_KEY = 'index';

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

function chunk(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length || i === 0; i += SECURE_CHUNK_CHARS) {
    chunks.push(value.slice(i, i + SECURE_CHUNK_CHARS));
  }
  return chunks;
}

export interface EngineStorage {
  /** Opens (on first launch: creates) the encrypted instances. Idempotent. */
  open(): Promise<void>;
  /**
   * The engine's hydration snapshot: every plain key, plus the secure keys of
   * the shared bucket and of `identityId` (default: the session's identity).
   * Waits for secure writes still in flight (a crashed engine's last batch).
   */
  snapshot(identityId?: string | null): Promise<StorageSnapshot>;
  /** Apply one write-through batch; a secure batch's Promise resolves once it is durable. */
  apply(batch: StorageBatch): void | Promise<void>;
  /** Resolves once every secure write so far has settled. */
  idle(): Promise<void>;
  /** Deletes this network's engine data: the MMKV instances, their key, every indexed secret. */
  reset(): Promise<void>;
  stats(): StorageStats;
}

export function createEngineStorage(networkKey: string): EngineStorage {
  const instanceId = `yappr.engine.${networkKey}`;
  const indexId = `yappr.engine-index.${networkKey}`;
  const keyName = `yappr.mmkv-key.${networkKey}`;
  const secureOptions: SecureStore.SecureStoreOptions = {
    keychainService: `pr.yap.app.secrets.${networkKey}`,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };

  let kv: MMKV | null = null;
  let indexStore: MMKV | null = null;
  let opening: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();
  let snapshotChars = 0;
  /** The last identity with a session: a sign-out's private-feed deletes still belong to it. */
  let lastActive: string | null = null;
  /**
   * The account the running engine was booted for. Its secrets stay its own
   * even after an in-engine account switch changes the session before the
   * restart; null when it booted signed out (a sign-in then decides).
   */
  let epochIdentity: string | null = null;

  const opened = () => {
    if (!kv || !indexStore) throw new Error('Engine storage is not open');
    return { kv, indexStore };
  };

  const readIndex = (): SecureIndex => {
    const raw = opened().indexStore.getString(INDEX_KEY);
    return raw ? (JSON.parse(raw) as SecureIndex) : {};
  };
  const writeIndex = (index: SecureIndex) => opened().indexStore.set(INDEX_KEY, JSON.stringify(index));

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

  const noteSession = () => {
    lastActive = sessionIdentity() ?? lastActive;
  };

  const names = (bucket: string, key: string, { n, slot }: Stored) =>
    Array.from({ length: n }, (_, i) => secureItemName(bucket, key, slot, i));

  const deleteItems = (items: string[]) =>
    Promise.all(items.map((name) => SecureStore.deleteItemAsync(name, secureOptions)));

  /** Whose secret a key without an identity is: decided when its batch arrives, not when it is written. */
  const ownerNow = () => epochIdentity ?? sessionIdentity();

  const setSecret = async (key: string, value: string, owner: string | null) => {
    const bucket = identityInKey(key) ?? owner ?? SHARED_BUCKET;
    const previous = readIndex()[bucket]?.[key];
    // Write the other slot, then point the index at it: a crash leaves the old value whole.
    const chunks = chunk(value);
    const next: Stored = { n: chunks.length, slot: previous?.slot === 'a' ? 'b' : 'a' };
    const items = names(bucket, key, next);
    for (let i = 0; i < chunks.length; i++) await SecureStore.setItemAsync(items[i], chunks[i], secureOptions);
    const index = readIndex();
    (index[bucket] ??= {})[key] = next;
    writeIndex(index);
    if (previous) await deleteItems(names(bucket, key, previous));
  };

  const removeFromBucket = async (bucket: string, key: string) => {
    const index = readIndex();
    const stored = index[bucket]?.[key];
    if (!stored) return;
    await deleteItems(names(bucket, key, stored));
    delete index[bucket][key];
    if (Object.keys(index[bucket]).length === 0) delete index[bucket];
    writeIndex(index);
  };

  const purgeBucket = async (bucket: string) => {
    for (const key of Object.keys(readIndex()[bucket] ?? {})) await removeFromBucket(bucket, key);
  };

  const deleteSecret = async (key: string, owner: string | null) => {
    const named = identityInKey(key);
    if (named) {
      await removeFromBucket(named, key);
      // Signing out an account that is not the active one deletes its keys by name;
      // its private-feed keys name no identity, so the whole bucket goes with it.
      if (named !== sessionIdentity() && isAuthKeyOf(key, named)) await purgeBucket(named);
      return;
    }
    const index = readIndex();
    const bucket = [owner, lastActive, SHARED_BUCKET].find((b) => b !== null && index[b]?.[key]);
    if (bucket !== undefined && bucket !== null) await removeFromBucket(bucket, key);
  };

  const readSecret = async (bucket: string, key: string, stored: Stored): Promise<string | null> => {
    const parts = await Promise.all(
      names(bucket, key, stored).map((name) => SecureStore.getItemAsync(name, secureOptions)),
    );
    return parts.some((part) => part === null) ? null : parts.join('');
  };

  const applySecure = async (ops: StorageBatch['ops'], owner: string | null) => {
    for (const op of ops) {
      if (op[0] === 'set') await setSecret(op[1], op[2], owner);
      else if (op[0] === 'del') await deleteSecret(op[1], owner);
      // localStorage.clear() in the engine: only what the engine holds, the shared and active buckets.
      else for (const bucket of [SHARED_BUCKET, owner]) if (bucket !== null) await purgeBucket(bucket);
    }
  };

  return {
    open() {
      opening ??= (async () => {
        let key = await SecureStore.getItemAsync(keyName, MMKV_KEY_OPTIONS);
        if (!key) {
          // Data written under a lost key is unreadable; start the instances clean.
          deleteMMKV(instanceId);
          deleteMMKV(indexId);
          key = newEncryptionKey();
          await SecureStore.setItemAsync(keyName, key, MMKV_KEY_OPTIONS);
        }
        kv = createMMKV({ id: instanceId, encryptionKey: key, encryptionType: 'AES-256' });
        indexStore = createMMKV({ id: indexId, encryptionKey: key, encryptionType: 'AES-256' });
        noteSession();
      })().catch((error: unknown) => {
        opening = null;
        throw error;
      });
      return opening;
    },

    async snapshot(identityId = sessionIdentity()) {
      await tail;
      epochIdentity = identityId;
      const plain = opened().kv;
      const local: Record<string, string> = {};
      for (const key of plain.getAllKeys()) {
        const value = plain.getString(key);
        if (value !== undefined) local[key] = value;
      }
      const index = readIndex();
      const secure: Record<string, string> = {};
      for (const bucket of new Set([SHARED_BUCKET, identityId])) {
        if (bucket === null) continue;
        for (const [key, stored] of Object.entries(index[bucket] ?? {})) {
          const value = await readSecret(bucket, key, stored);
          if (value !== null) secure[key] = value;
        }
      }
      snapshotChars = JSON.stringify(local).length + JSON.stringify(secure).length;
      return { local, secure };
    },

    apply(batch) {
      if (batch.area === 'local') {
        const plain = opened().kv;
        for (const op of batch.ops) {
          if (op[0] === 'set') plain.set(op[1], op[2]);
          else if (op[0] === 'del') plain.remove(op[1]);
          else plain.clearAll();
        }
        noteSession();
        return;
      }
      const owner = ownerNow();
      const written = tail.then(() => applySecure(batch.ops, owner));
      tail = written.catch(() => undefined);
      return written;
    },

    idle() {
      return tail;
    },

    async reset() {
      await tail;
      for (const bucket of Object.keys(readIndex())) await purgeBucket(bucket);
      kv?.clearAll();
      indexStore?.clearAll();
      kv = null;
      indexStore = null;
      opening = null;
      lastActive = null;
      epochIdentity = null;
      deleteMMKV(instanceId);
      deleteMMKV(indexId);
      await SecureStore.deleteItemAsync(keyName, MMKV_KEY_OPTIONS);
    },

    stats() {
      if (!kv || !indexStore) return { localKeys: 0, secureKeys: 0, identities: 0, snapshotChars };
      const index = readIndex();
      return {
        localKeys: kv.getAllKeys().length,
        secureKeys: Object.values(index).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0),
        identities: Object.keys(index).filter((id) => id !== SHARED_BUCKET).length,
        snapshotChars,
      };
    },
  };
}
