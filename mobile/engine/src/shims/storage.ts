/**
 * Synchronous in-memory Web Storage for the engine.
 *
 * `lib/` reads and writes `localStorage` synchronously, so the engine cannot
 * hand those calls to async native storage. Instead each area is a Map that
 * is hydrated before lib loads from the host's snapshot (see
 * `takeInjectedSnapshot`) (MMKV for `local`, the
 * Keychain/Keystore for `secure`) and that reports every write back through
 * `onChange`, so the host writes it through. Keys under `lib/secure-storage`'s
 * prefix (`yappr_secure_`, after the deployment scope) are kept out of the
 * plain area and reported as `secure`, so private keys never land in MMKV.
 *
 * `sessionStorage` is memory-only: a session lasts as long as the engine.
 *
 * The host namespaces snapshots per network; the engine bundle is built for
 * one network, so it never sees another network's keys.
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

/** A Map-backed implementation of the DOM `Storage` interface. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  constructor(private readonly onWrite?: (key: string, value: string | null) => void) {}

  get length(): number {
    return this.items.size
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null
  }

  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null
  }

  setItem(key: string, value: string): void {
    const k = String(key)
    const v = String(value)
    this.items.set(k, v)
    this.onWrite?.(k, v)
  }

  removeItem(key: string): void {
    const k = String(key)
    if (!this.items.delete(k)) return
    this.onWrite?.(k, null)
  }

  clear(): void {
    for (const key of Array.from(this.items.keys())) this.removeItem(key)
  }

  /** Replace the contents without reporting writes (hydration from the host). */
  load(entries: Record<string, string>): void {
    this.items.clear()
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
    return [...Object.keys(this.plain.entries()), ...Object.keys(this.secure.entries())][index] ?? null
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
  /** Subscribe to write-through changes. */
  onChange(listener: ChangeListener): () => void
  snapshot(): Required<StorageSnapshot>
}

/**
 * Build the storage pair. `isSecureKey` decides which keys belong to the
 * secure area; the engine passes lib/secure-storage's scoped prefix.
 */
export function createEngineStorage(isSecureKey: (key: string) => boolean): EngineStorage {
  const listeners = new Set<ChangeListener>()
  const notify = (change: StorageChange) => listeners.forEach(listener => listener(change))

  const plain = new MemoryStorage((key, value) => notify({ area: 'local', key, value }))
  const secure = new MemoryStorage((key, value) => notify({ area: 'secure', key, value }))

  const local = new RoutedStorage(plain, secure, isSecureKey)

  return {
    localStorage: local,
    sessionStorage: new MemoryStorage(),
    hydrate(snapshot) {
      plain.load(snapshot.local ?? {})
      secure.load(snapshot.secure ?? {})
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot() {
      return { local: plain.entries(), secure: secure.entries() }
    },
  }
}

declare global {
  /**
   * The host's persisted snapshot for this network, set by
   * `injectedJavaScriptBeforeContentLoaded` so it exists before engine.js
   * runs. lib reads storage at module scope (zustand `persist` in
   * lib/store.ts), so hydrating any later would be too late.
   */
  var __YAPPR_ENGINE_STORAGE__: StorageSnapshot | undefined
}

/** Take (and remove from the global scope) the snapshot the host injected before load. */
export function takeInjectedSnapshot(target: typeof globalThis = globalThis): StorageSnapshot {
  const snapshot = target.__YAPPR_ENGINE_STORAGE__ ?? {}
  delete target.__YAPPR_ENGINE_STORAGE__
  return snapshot
}

/**
 * Replace `globalThis.localStorage`/`sessionStorage`. WebKit and Chromium
 * define them as configurable getters on `window`, so redefining works; in
 * Node they do not exist and are simply added.
 */
export function installEngineStorage(storage: EngineStorage, target: typeof globalThis = globalThis): void {
  for (const [name, value] of [['localStorage', storage.localStorage], ['sessionStorage', storage.sessionStorage]] as const) {
    Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: false })
  }
}
