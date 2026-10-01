import { scopedKey } from '@/lib/storage-scope'

/**
 * Synchronous in-memory Web Storage for the engine.
 *
 * `lib/` reads and writes `localStorage` synchronously, so the engine cannot
 * hand those calls to async native storage. Each area is a Map, hydrated
 * before lib loads from the snapshot the host injects (`takeInjectedSnapshot`),
 * and every write is reported through `onChange` for the host to write
 * through. Where the host keeps each area (ADR-001 E1, decided for M4):
 *
 *  - `local`: an ENCRYPTED MMKV instance, one per network. Its 32-byte key is
 *    generated on first launch and kept in the Keychain/Keystore
 *    (this-device-only, available after first unlock).
 *  - `secure`: the Keychain/Keystore, one item per key. These are the keys
 *    under `SECURE_KEY_PREFIXES`: lib/secure-storage's private keys, the
 *    private-feed seed and keys, and the upload-provider credentials.
 *
 * `sessionStorage` is memory-only: a session lasts as long as the engine.
 */

export type StorageArea = 'local' | 'secure'

export interface StorageChange {
  area: StorageArea
  key: string
  /** `null` when the key was removed. */
  value: string | null
}

export interface StorageSnapshot {
  local?: Record<string, string>
  secure?: Record<string, string>
}

type ChangeListener = (change: StorageChange) => void

/**
 * Key prefixes (before the deployment scope) whose values are secrets and go
 * to the secure area: lib/secure-storage (`yappr_secure_`: private keys,
 * encryption keys), lib/services/private-feed-key-store (`yappr:pf:`: the
 * feed seed, path keys, cached CEKs), and the Pinata/Storacha upload
 * credentials (lib/upload/providers/*\/credential-storage).
 */
export const SECURE_KEY_PREFIXES: readonly string[] = ['yappr_secure_', 'yappr:pf:', 'yappr_pinata_', 'yappr_storacha_']

const scopedSecurePrefixes = SECURE_KEY_PREFIXES.map(scopedKey)

/** Whether `key` (as lib writes it, scope included) belongs to the secure area. */
export function isSecureStorageKey(key: string): boolean {
  return scopedSecurePrefixes.some(prefix => key.startsWith(prefix))
}

/** A Map-backed implementation of the DOM `Storage` interface. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()
  /** `key(i)` loops in lib are O(n) per call without this; dropped on every add or delete. */
  private keyCache: string[] | null = null

  /**
   * @param forwardMissingDeletes report a delete even for a key this map does
   *   not hold. The secure area needs it: the engine holds only the active
   *   account's secrets, and signing another account out deletes that
   *   account's keys by name, which the host must still remove.
   */
  constructor(
    private readonly onWrite?: (key: string, value: string | null) => void,
    private readonly forwardMissingDeletes = false
  ) {}

  get length(): number {
    return this.items.size
  }

  key(index: number): string | null {
    this.keyCache ??= Array.from(this.items.keys())
    return this.keyCache[index] ?? null
  }

  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null
  }

  setItem(key: string, value: string): void {
    const k = String(key)
    const v = String(value)
    if (!this.items.has(k)) this.keyCache = null
    this.items.set(k, v)
    this.onWrite?.(k, v)
  }

  removeItem(key: string): void {
    const k = String(key)
    if (this.items.delete(k)) this.keyCache = null
    else if (!this.forwardMissingDeletes) return
    this.onWrite?.(k, null)
  }

  clear(): void {
    for (const key of Array.from(this.items.keys())) this.removeItem(key)
  }

  /** Replace the contents without reporting writes (hydration from the host). */
  load(entries: Record<string, string>): void {
    this.items.clear()
    this.keyCache = null
    for (const [key, value] of Object.entries(entries)) this.items.set(key, String(value))
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.items)
  }

  [name: string]: unknown
}

/**
 * `localStorage` as lib sees it: one Storage over the plain and secure maps,
 * so `key(i)` and `length` still enumerate everything.
 */
class RoutedStorage implements Storage {
  constructor(
    private readonly plain: MemoryStorage,
    private readonly secure: MemoryStorage,
    private readonly isSecureKey: (key: string) => boolean
  ) {}

  private route(key: string): MemoryStorage {
    return this.isSecureKey(String(key)) ? this.secure : this.plain
  }

  get length(): number {
    return this.plain.length + this.secure.length
  }

  key(index: number): string | null {
    return index < this.plain.length ? this.plain.key(index) : this.secure.key(index - this.plain.length)
  }

  getItem(key: string): string | null {
    return this.route(key).getItem(key)
  }

  setItem(key: string, value: string): void {
    this.route(key).setItem(key, value)
  }

  removeItem(key: string): void {
    this.route(key).removeItem(key)
  }

  clear(): void {
    this.plain.clear()
    this.secure.clear()
  }

  [name: string]: unknown
}

export interface EngineStorage {
  localStorage: Storage
  sessionStorage: Storage
  /** Replace both persisted areas with the host's snapshot. Reports nothing back. */
  hydrate(snapshot: StorageSnapshot): void
  /**
   * Subscribe to write-through changes. Changes made before the first
   * subscriber (lib modules write while they load) are queued and delivered
   * to it.
   */
  onChange(listener: ChangeListener): () => void
  snapshot(): Required<StorageSnapshot>
}

/** Build the storage pair. `isSecureKey` decides which keys belong to the secure area. */
export function createEngineStorage(isSecureKey: (key: string) => boolean = isSecureStorageKey): EngineStorage {
  const listeners = new Set<ChangeListener>()
  let queued: StorageChange[] | null = []
  const notify = (change: StorageChange) => {
    if (queued) queued.push(change)
    else listeners.forEach(listener => listener(change))
  }

  const plain = new MemoryStorage((key, value) => notify({ area: 'local', key, value }))
  const secure = new MemoryStorage((key, value) => notify({ area: 'secure', key, value }), true)

  return {
    localStorage: new RoutedStorage(plain, secure, isSecureKey),
    sessionStorage: new MemoryStorage(),
    hydrate(snapshot) {
      plain.load(snapshot.local ?? {})
      secure.load(snapshot.secure ?? {})
    },
    onChange(listener) {
      listeners.add(listener)
      if (queued) {
        const backlog = queued
        queued = null
        backlog.forEach(listener)
      }
      return () => { listeners.delete(listener) }
    },
    snapshot() {
      return { local: plain.entries(), secure: secure.entries() }
    },
  }
}

/**
 * Where the host's persisted snapshot for this network arrives:
 * `window.__YAPPR_ENGINE_STORAGE__`, set by `injectedJavaScriptBeforeContentLoaded`
 * so it exists before engine.js runs. lib reads storage at module scope
 * (zustand `persist` in lib/store.ts), so hydrating any later would be too
 * late. The host must assign it as a property (`window.__YAPPR_ENGINE_STORAGE__ = …`),
 * not declare it with `var`.
 */
export interface SnapshotInjectionTarget {
  __YAPPR_ENGINE_STORAGE__?: StorageSnapshot
}

/** Take (and clear from the global scope) the snapshot the host injected before load. */
export function takeInjectedSnapshot(target: SnapshotInjectionTarget = globalThis as SnapshotInjectionTarget): StorageSnapshot {
  const snapshot = target.__YAPPR_ENGINE_STORAGE__ ?? {}
  try {
    delete target.__YAPPR_ENGINE_STORAGE__
  } catch {
    // A `var` declaration is non-configurable and strict mode throws on delete.
    target.__YAPPR_ENGINE_STORAGE__ = undefined
  }
  return snapshot
}

/**
 * Replace `globalThis.localStorage`/`sessionStorage`. WebKit and Chromium
 * define them as configurable getters on `window`, so redefining works; in
 * Node they do not exist and are simply added.
 */
export function installEngineStorage(storage: EngineStorage, target: object = globalThis): void {
  for (const [name, value] of [['localStorage', storage.localStorage], ['sessionStorage', storage.sessionStorage]] as const) {
    Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: false })
  }
}
