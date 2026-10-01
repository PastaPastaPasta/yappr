import { scopedKey } from '@/lib/storage-scope'
import type { KvOp } from '../protocol/envelope'

/**
 * Synchronous in-memory Web Storage for the engine (ENGINE.md §9.1).
 *
 * `lib/` reads and writes `localStorage` synchronously, so the engine cannot
 * hand those calls to async native storage. Each area is a Map, hydrated
 * before lib loads from the snapshot the host injects (`takeInjectedSnapshot`).
 * Writes apply to the Map at once and are written through in batches: one per
 * area per microtask, coalesced per key against the value before the batch
 * (last write wins; a set that leaves the value unchanged, or a key set and
 * removed while absent before, produces no op). The coalescing matters: the
 * vendored secret store probes `setItem`/`removeItem('__storage_test__')` on
 * every access. A removal in the secure area is always forwarded, even for a
 * key the engine never held (signing out a non-hydrated account).
 *
 * Where the host keeps each area (ADR-001 E1, decided for M4):
 *  - `local` (`kv` batches): an ENCRYPTED MMKV instance, one per network. Its
 *    32-byte key is generated on first launch and kept in the
 *    Keychain/Keystore (this-device-only, available after first unlock).
 *    Applied on arrival, no acknowledgement.
 *  - `secure` (`skv` batches): the Keychain/Keystore, one item per key. These
 *    are the keys under `SECURE_KEY_PREFIXES`. The host acknowledges each
 *    batch once written (`ack(seq)`); `secureDurable()` waits for that, so a
 *    sign-in is only reported once its keys are durable.
 *
 * `sessionStorage` is memory-only: a session lasts as long as the engine.
 */

export type StorageArea = 'local' | 'secure'

/** One write-through batch. `seq` is shared by both areas and strictly increasing. */
export interface StorageBatch {
  area: StorageArea
  seq: number
  ops: KvOp[]
}

export interface StorageSnapshot {
  local?: Record<string, string>
  secure?: Record<string, string>
}

type BatchListener = (batch: StorageBatch) => void

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

/**
 * Called on every mutation with the value before and after it. A removal of
 * an absent key arrives as (null, null) only when the store reports those.
 */
type WriteObserver = (key: string, previous: string | null, next: string | null) => void

/** A Map-backed implementation of the DOM `Storage` interface. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()
  /** `key(i)` loops in lib are O(n) per call without this; dropped on every add or delete. */
  private keyCache: string[] | null = null

  constructor(
    private readonly onWrite?: WriteObserver,
    private readonly reportAbsentRemovals = false
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
    const previous = this.items.get(k) ?? null
    if (previous === null) this.keyCache = null
    this.items.set(k, v)
    this.onWrite?.(k, previous, v)
  }

  removeItem(key: string): void {
    const k = String(key)
    const previous = this.items.get(k) ?? null
    if (previous === null) {
      if (this.reportAbsentRemovals) this.onWrite?.(k, null, null)
      return
    }
    this.items.delete(k)
    this.keyCache = null
    this.onWrite?.(k, previous, null)
  }

  clear(): void {
    for (const key of Array.from(this.items.keys())) this.removeItem(key)
  }

  /** Add entries without reporting writes (hydration from the host). */
  load(entries: Iterable<[string, string]>): void {
    this.keyCache = null
    for (const [key, value] of entries) this.items.set(key, String(value))
  }

  reset(): void {
    this.items.clear()
    this.keyCache = null
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

/** The pending state of one key in the current batch. */
interface PendingKey {
  before: string | null
  after: string | null
  /** A secure removal of a key the engine did not hold: forwarded even though nothing changed here. */
  forceDelete: boolean
}

/** Collects one area's writes until the batch is flushed. */
class AreaBatch {
  private readonly pending = new Map<string, PendingKey>()

  record(key: string, previous: string | null, next: string | null): void {
    const entry = this.pending.get(key) ?? { before: previous, after: previous, forceDelete: false }
    entry.after = next
    if (previous === null && next === null) entry.forceDelete = true
    this.pending.set(key, entry)
  }

  get isEmpty(): boolean {
    return this.pending.size === 0
  }

  take(): KvOp[] {
    const ops: KvOp[] = []
    for (const [key, { before, after, forceDelete }] of this.pending) {
      if (after !== before) ops.push(after === null ? ['del', key] : ['set', key, after])
      else if (forceDelete && after === null) ops.push(['del', key])
    }
    this.pending.clear()
    return ops
  }
}

export interface EngineStorage {
  localStorage: Storage
  sessionStorage: Storage
  /**
   * Replace both persisted areas with the host's snapshot, without reporting
   * writes. Each key is routed by its prefix, whatever area the host filed it
   * under; the keys filed under the wrong one are returned.
   */
  hydrate(snapshot: StorageSnapshot): { misrouted: string[] }
  /**
   * Subscribe to write-through batches. Batches flushed before the first
   * subscriber are queued and delivered to it.
   */
  onBatch(listener: BatchListener): () => void
  /** The host wrote the secure batch `seq`. */
  ack(seq: number): void
  /** Flush now, then resolve once every secure batch so far is acknowledged. */
  secureDurable(): Promise<void>
  snapshot(): Required<StorageSnapshot>
}

export interface EngineStorageOptions {
  isSecureKey?: (key: string) => boolean
  /** How a flush is scheduled; a microtask by default. */
  schedule?: (flush: () => void) => void
}

export function createEngineStorage(options: EngineStorageOptions = {}): EngineStorage {
  const isSecureKey = options.isSecureKey ?? isSecureStorageKey
  const schedule = options.schedule ?? queueMicrotask
  const listeners = new Set<BatchListener>()
  let queued: StorageBatch[] | null = []
  let seq = 0
  let scheduled = false
  const batches: Record<StorageArea, AreaBatch> = { local: new AreaBatch(), secure: new AreaBatch() }
  const unacked = new Set<number>()
  const waiters: { seqs: Set<number>; resolve: () => void }[] = []

  const emit = (batch: StorageBatch) => {
    if (batch.area === 'secure') unacked.add(batch.seq)
    if (queued) queued.push(batch)
    else listeners.forEach(listener => listener(batch))
  }

  const flush = () => {
    scheduled = false
    for (const area of ['local', 'secure'] as const) {
      if (batches[area].isEmpty) continue
      const ops = batches[area].take()
      if (ops.length > 0) emit({ area, seq: ++seq, ops })
    }
  }

  const observer = (area: StorageArea): WriteObserver => (key, previous, next) => {
    batches[area].record(key, previous, next)
    if (!scheduled) {
      scheduled = true
      schedule(flush)
    }
  }

  const plain = new MemoryStorage(observer('local'))
  const secure = new MemoryStorage(observer('secure'), true)

  return {
    localStorage: new RoutedStorage(plain, secure, isSecureKey),
    sessionStorage: new MemoryStorage(),
    hydrate(snapshot) {
      plain.reset()
      secure.reset()
      const misrouted: string[] = []
      for (const [given, entries] of [['local', snapshot.local], ['secure', snapshot.secure]] as const) {
        for (const [key, value] of Object.entries(entries ?? {})) {
          const area: StorageArea = isSecureKey(key) ? 'secure' : 'local'
          if (area !== given) misrouted.push(key)
          ;(area === 'secure' ? secure : plain).load([[key, value]])
        }
      }
      return { misrouted }
    },
    onBatch(listener) {
      listeners.add(listener)
      if (queued) {
        const backlog = queued
        queued = null
        backlog.forEach(listener)
      }
      return () => { listeners.delete(listener) }
    },
    ack(acked) {
      unacked.delete(acked)
      for (let i = waiters.length - 1; i >= 0; i--) {
        waiters[i].seqs.delete(acked)
        if (waiters[i].seqs.size === 0) waiters.splice(i, 1)[0].resolve()
      }
    },
    secureDurable() {
      flush()
      if (unacked.size === 0) return Promise.resolve()
      return new Promise(resolve => waiters.push({ seqs: new Set(unacked), resolve }))
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
