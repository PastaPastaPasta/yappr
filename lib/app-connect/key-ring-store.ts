import type { AppConnectSession } from 'platform-auth'
import { bytesToHex } from '@/lib/bytes'
import { toArrayBuffer } from '@/lib/crypto/aes-gcm'

/**
 * Where an App Connect session lives in the browser: the session record (key
 * ids, bounds, limits, no secrets) plus each private key wrapped with AES-GCM
 * under a non-extractable device key that never leaves the browser's key
 * store. This protects keys at rest and in profile sync; it does not protect
 * them from script running in the page (XSS), which can use the device key.
 *
 * The connection id (16 random bytes per browser and network) is kept apart
 * from the session and survives logout, so the next login supersedes this
 * browser's previous grant instead of piling keys up on the identity.
 *
 * The pending sign-in request (whose ephemeral key opens the wallet's answer)
 * is wrapped the same way, so a reload or the wallet's return page can resume
 * it without the key ever sitting in plain storage.
 */

export interface KeyRingBackend {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** Deletes `key` only when `predicate` holds for its value, atomically. True when it deleted. */
  deleteIf(key: string, predicate: (value: unknown) => boolean): Promise<boolean>
  /** Replaces `key`'s value with `next(value)` only when `predicate` holds for it, atomically. True when it wrote. */
  updateIf(key: string, predicate: (value: unknown) => boolean, next: (value: unknown) => unknown): Promise<boolean>
  /** Writes `value` at `key` only when `predicate` holds for its current value, atomically. Resolves to what `key` holds afterwards. */
  putIf(key: string, predicate: (current: unknown) => boolean, value: unknown): Promise<unknown>
}

interface WrappedBytes {
  iv: Uint8Array
  data: ArrayBuffer
}

interface StoredRing {
  session: AppConnectSession
  wrapped: Record<string, WrappedBytes>
}

/** Which stored session a clear may remove: any for this identity, or only one exact grant. */
export interface SessionMatch {
  identityId: string
  grantedAt?: number
  /** With `grantedAt`: the grant's newest auth key id, which tells apart two grants stored in the same millisecond. */
  grantKeyId?: number
}

/** A grant's newest auth key id. A later wallet grant registers its keys after the earlier one's, so its ids are higher. */
export function grantKeyId(session: Pick<AppConnectSession, 'authKeys'>): number {
  return session.authKeys.reduce((max, key) => Math.max(max, key.keyId), -1)
}

/** The match for exactly this grant. */
export function exactGrant(session: AppConnectSession): SessionMatch {
  return { identityId: session.identityId, grantedAt: session.grantedAt, grantKeyId: grantKeyId(session) }
}

/** Whether `a` is a newer grant than `b`: stored later, or at the same time with newer keys. */
export function isNewerGrant(a: AppConnectSession, b: AppConnectSession): boolean {
  return a.grantedAt !== b.grantedAt ? a.grantedAt > b.grantedAt : grantKeyId(a) > grantKeyId(b)
}

const DEVICE_KEY = 'device-key'
const connectionKey = (network: string) => `connection:${network}`
const sessionKey = (network: string) => `session:${network}`
const secretKey = (network: string, name: string) => `secret:${network}:${name}`
const encoder = new TextEncoder()

const isConnectionId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

function sessionMatches(value: unknown, match: SessionMatch): boolean {
  const session = (value as StoredRing | undefined)?.session
  return session?.identityId === match.identityId &&
    (match.grantedAt === undefined || session.grantedAt === match.grantedAt) &&
    (match.grantKeyId === undefined || grantKeyId(session) === match.grantKeyId)
}

export class AppConnectKeyRingStore {
  private deviceKeyPromise: Promise<CryptoKey> | null = null

  constructor(
    private readonly backend: KeyRingBackend,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    /** `length` random bytes (allocated here, so the array is backed by a plain ArrayBuffer). */
    private readonly random: (length: number) => Uint8Array = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  ) {}

  private deviceKey(): Promise<CryptoKey> {
    this.deviceKeyPromise ??= (async () => {
      const existing = await this.backend.get<CryptoKey>(DEVICE_KEY)
      if (existing) return existing
      const created = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      // Two tabs initialising at once both end up with whichever key was stored first.
      return (await this.backend.putIf(DEVICE_KEY, (current) => current === undefined, created)) as CryptoKey
    })().catch((error: unknown) => {
      this.deviceKeyPromise = null
      throw error
    })
    return this.deviceKeyPromise
  }

  /** Wraps `plaintext` under the device key, bound to `label`; wipes its own copy of the plaintext. */
  private async wrap(plaintext: Uint8Array, label: string): Promise<WrappedBytes> {
    const iv = this.random(12)
    const copy = toArrayBuffer(plaintext)
    try {
      const additionalData = toArrayBuffer(encoder.encode(label))
      return { iv, data: await this.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData }, await this.deviceKey(), copy) }
    } finally {
      new Uint8Array(copy).fill(0)
    }
  }

  private async unwrap(wrapped: WrappedBytes, label: string): Promise<Uint8Array | null> {
    try {
      const additionalData = toArrayBuffer(encoder.encode(label))
      return new Uint8Array(await this.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(wrapped.iv), additionalData }, await this.deviceKey(), wrapped.data))
    } catch {
      return null
    }
  }

  /** This browser's connection id for `network` (hex), created on first use and kept across logouts. */
  async connectionId(network: string): Promise<string> {
    const existing = await this.backend.get<string>(connectionKey(network))
    if (isConnectionId(existing)) return existing
    const created = bytesToHex(this.random(16))
    const stored = await this.backend.putIf(connectionKey(network), (current) => !isConnectionId(current), created)
    if (!isConnectionId(stored)) throw new Error('could not store the connection id')
    return stored
  }

  /**
   * Stores `session` with its private keys (by keyRef). Every keyRef the
   * session names must have a key. The caller still owns `privateKeys` and
   * should wipe them afterwards.
   *
   * Never replaces a newer grant for the same identity that another tab stored
   * meanwhile: false when the store kept that one instead of `session`.
   */
  async save(session: AppConnectSession, privateKeys: ReadonlyMap<string, Uint8Array>): Promise<boolean> {
    const refs = [...session.authKeys.map((key) => key.keyRef), ...session.encKeys.map((key) => key.keyRef)]
    const wrapped: Record<string, WrappedBytes> = {}
    for (const ref of refs) {
      const privateKey = privateKeys.get(ref)
      if (!privateKey) throw new Error(`no private key for ${ref}`)
      wrapped[ref] = await this.wrap(privateKey, keyLabel(session, ref))
    }
    const record: StoredRing = { session, wrapped }
    const stored = await this.backend.putIf(sessionKey(session.network), (current) => {
      const existing = (current as StoredRing | undefined)?.session
      return !existing || existing.identityId !== session.identityId || !isNewerGrant(existing, session)
    }, record)
    return sessionMatches(stored, exactGrant(session))
  }

  async load(network: string): Promise<AppConnectSession | null> {
    const record = await this.backend.get<StoredRing>(sessionKey(network))
    return record?.session ?? null
  }

  /**
   * Replaces the stored record of this exact grant (refreshed budgets) and
   * keeps the wrapped keys. The read and the write are one transaction, so a
   * newer grant another tab stores meanwhile is never overwritten.
   */
  updateSession(session: AppConnectSession): Promise<boolean> {
    return this.backend.updateIf(
      sessionKey(session.network),
      (value) => sessionMatches(value, exactGrant(session)),
      (value) => ({ ...(value as StoredRing), session }),
    )
  }

  /** The private key behind `keyRef` (the caller wipes it after use), or null when it is not stored. */
  async privateKey(session: Pick<AppConnectSession, 'network' | 'identityId'>, keyRef: string): Promise<Uint8Array | null> {
    const record = await this.backend.get<StoredRing>(sessionKey(session.network))
    if (!record || record.session.identityId !== session.identityId) return null
    const wrapped = record.wrapped[keyRef]
    return wrapped ? this.unwrap(wrapped, keyLabel(session, keyRef)) : null
  }

  /**
   * Forgets the stored session and its keys if it is the one `match` names, so
   * a tab holding an older grant never deletes the grant another tab just
   * stored. The connection id stays.
   */
  clear(network: string, match: SessionMatch): Promise<boolean> {
    return this.backend.deleteIf(sessionKey(network), (value) => sessionMatches(value, match))
  }

  /** Stores a small secret (the pending sign-in request) wrapped under the device key. */
  async saveSecret(network: string, name: string, plaintext: Uint8Array): Promise<void> {
    await this.backend.put(secretKey(network, name), await this.wrap(plaintext, `yappr:app-connect:secret:v1|${network}|${name}`))
  }

  async loadSecret(network: string, name: string): Promise<Uint8Array | null> {
    const wrapped = await this.backend.get<WrappedBytes>(secretKey(network, name))
    return wrapped ? this.unwrap(wrapped, `yappr:app-connect:secret:v1|${network}|${name}`) : null
  }

  async deleteSecret(network: string, name: string): Promise<void> {
    await this.backend.delete(secretKey(network, name))
  }
}

/** Ties a wrapped key to its slot, so a blob moved to another identity or ref does not unwrap. */
function keyLabel(session: Pick<AppConnectSession, 'network' | 'identityId'>, keyRef: string): string {
  return `yappr:app-connect:key-ring:v1|${session.network}|${session.identityId}|${keyRef}`
}

/** A single-object-store IndexedDB backend; values are structured clones (CryptoKey, bigint and bytes included). */
export function indexedDbKeyRingBackend(databaseName: string): KeyRingBackend {
  const STORE = 'ring'
  let dbPromise: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable'))
    }).catch((error: unknown) => {
      dbPromise = null
      throw error
    })
    return dbPromise
  }
  const transaction = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      let result: T
      action(tx.objectStore(STORE), (value) => { result = value })
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  }
  return {
    get: <T>(key: string) => transaction<T | undefined>('readonly', (store, done) => {
      const request = store.get(key)
      request.onsuccess = () => done(request.result as T | undefined)
    }),
    put: (key, value) => transaction<void>('readwrite', (store) => { store.put(value, key) }),
    delete: (key) => transaction<void>('readwrite', (store) => { store.delete(key) }),
    deleteIf: (key, predicate) => transaction<boolean>('readwrite', (store, done) => {
      done(false)
      const request = store.get(key)
      request.onsuccess = () => {
        if (request.result !== undefined && predicate(request.result)) {
          store.delete(key)
          done(true)
        }
      }
    }),
    putIf: (key, predicate, value) => transaction<unknown>('readwrite', (store, done) => {
      const request = store.get(key)
      request.onsuccess = () => {
        if (predicate(request.result)) {
          store.put(value, key)
          done(value)
        } else {
          done(request.result)
        }
      }
    }),
    updateIf: (key, predicate, next) => transaction<boolean>('readwrite', (store, done) => {
      done(false)
      const request = store.get(key)
      request.onsuccess = () => {
        if (request.result !== undefined && predicate(request.result)) {
          store.put(next(request.result), key)
          done(true)
        }
      }
    }),
  }
}
