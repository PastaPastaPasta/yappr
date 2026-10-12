import type { AppConnectSession } from 'platform-auth'
import { bytesToHex } from '@/lib/bytes'

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
 */

export interface KeyRingBackend {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

interface WrappedKey {
  iv: Uint8Array
  data: ArrayBuffer
}

interface StoredRing {
  session: AppConnectSession
  wrapped: Record<string, WrappedKey>
}

const DEVICE_KEY = 'device-key'
const connectionKey = (network: string) => `connection:${network}`
const sessionKey = (network: string) => `session:${network}`
const encoder = new TextEncoder()

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Ties a wrapped key to its slot, so a blob moved to another identity or ref does not unwrap. */
function wrapAad(session: Pick<AppConnectSession, 'network' | 'identityId'>, keyRef: string): ArrayBuffer {
  return toArrayBuffer(encoder.encode(`yappr:app-connect:key-ring:v1|${session.network}|${session.identityId}|${keyRef}`))
}

export class AppConnectKeyRingStore {
  private deviceKeyPromise: Promise<CryptoKey> | null = null

  constructor(
    private readonly backend: KeyRingBackend,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    private readonly random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes),
  ) {}

  private deviceKey(): Promise<CryptoKey> {
    this.deviceKeyPromise ??= (async () => {
      const existing = await this.backend.get<CryptoKey>(DEVICE_KEY)
      if (existing) return existing
      const created = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await this.backend.put(DEVICE_KEY, created)
      return created
    })().catch((error: unknown) => {
      this.deviceKeyPromise = null
      throw error
    })
    return this.deviceKeyPromise
  }

  /** This browser's connection id for `network` (hex), created on first use and kept across logouts. */
  async connectionId(network: string): Promise<string> {
    const existing = await this.backend.get<string>(connectionKey(network))
    if (typeof existing === 'string' && /^[0-9a-f]{32}$/.test(existing)) return existing
    const created = bytesToHex(this.random(new Uint8Array(16)))
    await this.backend.put(connectionKey(network), created)
    return created
  }

  /**
   * Stores `session` with its private keys (by keyRef). Every keyRef the
   * session names must have a key. The caller still owns `privateKeys` and
   * should wipe them afterwards.
   */
  async save(session: AppConnectSession, privateKeys: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const refs = [...session.authKeys.map((key) => key.keyRef), ...session.encKeys.map((key) => key.keyRef)]
    const deviceKey = await this.deviceKey()
    const wrapped: Record<string, WrappedKey> = {}
    for (const ref of refs) {
      const privateKey = privateKeys.get(ref)
      if (!privateKey) throw new Error(`no private key for ${ref}`)
      const iv = this.random(new Uint8Array(12))
      const plaintext = toArrayBuffer(privateKey)
      try {
        wrapped[ref] = {
          iv,
          data: await this.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: wrapAad(session, ref) }, deviceKey, plaintext),
        }
      } finally {
        new Uint8Array(plaintext).fill(0)
      }
    }
    const record: StoredRing = { session, wrapped }
    await this.backend.put(sessionKey(session.network), record)
  }

  async load(network: string): Promise<AppConnectSession | null> {
    const record = await this.backend.get<StoredRing>(sessionKey(network))
    return record?.session ?? null
  }

  /** Replaces the stored session record (refreshed budgets, a disabled key) and keeps the wrapped keys. */
  async updateSession(session: AppConnectSession): Promise<void> {
    const record = await this.backend.get<StoredRing>(sessionKey(session.network))
    if (!record || record.session.identityId !== session.identityId) return
    await this.backend.put(sessionKey(session.network), { ...record, session })
  }

  /** The private key behind `keyRef` (the caller wipes it after use), or null when it is not stored. */
  async privateKey(session: Pick<AppConnectSession, 'network' | 'identityId'>, keyRef: string): Promise<Uint8Array | null> {
    const record = await this.backend.get<StoredRing>(sessionKey(session.network))
    if (!record || record.session.identityId !== session.identityId) return null
    const wrapped = record.wrapped[keyRef]
    if (!wrapped) return null
    const deviceKey = await this.deviceKey()
    try {
      return new Uint8Array(await this.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(wrapped.iv), additionalData: wrapAad(session, keyRef) },
        deviceKey,
        wrapped.data,
      ))
    } catch {
      return null
    }
  }

  /** Forgets the session and its keys; the connection id stays. */
  async clear(network: string): Promise<void> {
    await this.backend.delete(sessionKey(network))
  }
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
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = action(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request.result as T)
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    })
  }
  return {
    get: <T>(key: string) => run<T | undefined>('readonly', (store) => store.get(key)),
    put: async (key, value) => {
      await run('readwrite', (store) => store.put(value, key))
    },
    delete: async (key) => {
      await run('readwrite', (store) => store.delete(key))
    },
  }
}
