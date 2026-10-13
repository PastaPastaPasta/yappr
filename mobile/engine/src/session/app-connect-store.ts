import type { AppConnectSession } from 'platform-auth'
import type { KeyRingBackend } from '@/lib/app-connect/key-ring-store'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { scopedKey } from '@/lib/storage-scope'

/**
 * Where lib's App Connect key ring (`lib/app-connect/key-ring-store.ts`) lives
 * in the engine, which has no IndexedDB: the engine's synchronous storage,
 * which the host writes through to the device.
 *
 *  - The session record and its wrapped keys go to the secure area
 *    (Keychain/Keystore) under a key that names the identity, so the host
 *    files them in that account's bucket: a parked account keeps its ring,
 *    a boot hydrates only the active account's, and signing an account out
 *    removes it with the account's other secrets.
 *  - The pending sign-in request (wrapped too) goes to the secure area.
 *  - The connection id and the wrapping key go to the plain area, an
 *    encrypted MMKV instance whose own key is in the Keychain. Both are per
 *    device and network and survive sign-out, as on web. What protects the
 *    keys at rest is the Keychain/Keystore and the encrypted MMKV; wrapping
 *    keeps the ring's keys apart from the key that opens them, as on web.
 *
 * The ring holds one session per network, as on web: writing one removes
 * any other identity's ring this engine holds (only the active account's is
 * ever hydrated, so that is never a parked account's).
 *
 * Every operation runs synchronously against the storage after its one
 * await, so each read-check-write below is atomic within the engine.
 */

const DEVICE_KEY = scopedKey('yappr_ac_device_key')
const connectionKey = (network: string) => scopedKey(`yappr_ac_connection_${network}`)
const ringPrefix = (network: string) => scopedKey(`yappr_secure_ac_ring_${network}_`)
const secretKey = (network: string, name: string) => scopedKey(`yappr_secure_ac_secret_${network}_${name.replace(/[^A-Za-z0-9]/g, '_')}`)

const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/
const HEX_32 = /^[0-9a-f]{64}$/

type StoredSlot = { kind: 'ring'; network: string } | { kind: 'item'; key: string }
type Slot = { kind: 'device' } | StoredSlot

function slotOf(key: string): Slot {
  if (key === 'device-key') return { kind: 'device' }
  const [kind, network, ...rest] = key.split(':')
  if (!network) throw new Error(`Unknown key ring entry: ${kind}`)
  if (kind === 'session' && rest.length === 0) return { kind: 'ring', network }
  if (kind === 'connection' && rest.length === 0) return { kind: 'item', key: connectionKey(network) }
  if (kind === 'secret' && rest.length > 0) return { kind: 'item', key: secretKey(network, rest.join(':')) }
  throw new Error(`Unknown key ring entry: ${kind}`)
}

/** JSON with the types the ring stores: bigint (budgets), Uint8Array (IVs) and ArrayBuffer (ciphertexts). */
function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return { $bigint: item.toString() }
    if (item instanceof Uint8Array) return { $bytes: bytesToHex(item) }
    if (item instanceof ArrayBuffer) return { $buffer: bytesToHex(new Uint8Array(item)) }
    return item
  })
}

/** A fresh array (offset 0, its own buffer); `hexToBytes` refuses the empty string. */
const fromHex = (hex: string): Uint8Array<ArrayBuffer> => (hex === '' ? new Uint8Array() : new Uint8Array(hexToBytes(hex)))

function decode(raw: string): unknown {
  return JSON.parse(raw, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const tagged = item as Record<string, unknown>
    if (Object.keys(tagged).length !== 1) return item
    if (typeof tagged.$bigint === 'string') return BigInt(tagged.$bigint)
    if (typeof tagged.$bytes === 'string') return fromHex(tagged.$bytes)
    if (typeof tagged.$buffer === 'string') return fromHex(tagged.$buffer).buffer
    return item
  })
}

/** The identity whose ring a stored record is. */
function ringIdentity(value: unknown): string {
  const identityId = (value as { session?: Pick<AppConnectSession, 'identityId'> } | undefined)?.session?.identityId
  if (typeof identityId !== 'string' || !IDENTITY_ID.test(identityId)) throw new Error('A key ring record must name its identity')
  return identityId
}

/**
 * Forgets `identityId`'s ring on `network` even when this engine never held
 * it (a parked account's is not hydrated): the storage shim forwards the
 * removal, and the host deletes it from that account's bucket.
 */
export function forgetEngineRing(storage: Pick<Storage, 'removeItem'>, network: string, identityId: string): void {
  storage.removeItem(ringPrefix(network) + identityId)
}

export function engineKeyRingBackend(storage: Storage): KeyRingBackend {
  let deviceKey: Promise<CryptoKey> | null = null

  function loadDeviceKey(): Promise<CryptoKey> {
    deviceKey ??= (async () => {
      let hex = storage.getItem(DEVICE_KEY)
      if (!hex || !HEX_32.test(hex)) {
        hex = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))
        storage.setItem(DEVICE_KEY, hex)
      }
      const raw = fromHex(hex)
      try {
        return await globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      } finally {
        raw.fill(0)
      }
    })().catch((error: unknown) => {
      deviceKey = null
      throw error
    })
    return deviceKey
  }

  /** The storage keys of `network`'s rings this engine holds. */
  function ringKeys(network: string): string[] {
    const prefix = ringPrefix(network)
    const keys: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    return keys
  }

  function readItem(key: string): unknown {
    const raw = storage.getItem(key)
    if (raw === null) return undefined
    try {
      return decode(raw)
    } catch {
      // An unreadable entry is no entry: the ring treats it as absent.
      return undefined
    }
  }

  /** The ring the engine holds for `network` (the newest grant, should there ever be two), and where. */
  function readRing(network: string): { key: string; value: unknown } | undefined {
    let found: { key: string; value: unknown; grantedAt: number } | undefined
    for (const key of ringKeys(network)) {
      const value = readItem(key)
      const grantedAt = (value as { session?: { grantedAt?: unknown } } | undefined)?.session?.grantedAt
      if (typeof grantedAt !== 'number') continue
      if (!found || grantedAt > found.grantedAt) found = { key, value, grantedAt }
    }
    return found
  }

  function read(slot: StoredSlot): unknown {
    return slot.kind === 'ring' ? readRing(slot.network)?.value : readItem(slot.key)
  }

  function write(slot: StoredSlot, value: unknown): void {
    if (slot.kind === 'item') {
      storage.setItem(slot.key, encode(value))
      return
    }
    const key = ringPrefix(slot.network) + ringIdentity(value)
    for (const other of ringKeys(slot.network)) if (other !== key) storage.removeItem(other)
    storage.setItem(key, encode(value))
  }

  function remove(slot: StoredSlot): void {
    if (slot.kind === 'item') storage.removeItem(slot.key)
    else for (const key of ringKeys(slot.network)) storage.removeItem(key)
  }

  /** The device key is the engine's own: the store only reads it (and, finding one, never offers its own). */
  function storedSlot(key: string): StoredSlot {
    const slot = slotOf(key)
    if (slot.kind === 'device') throw new Error('The engine keeps its own key ring device key')
    return slot
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const slot = slotOf(key)
      if (slot.kind === 'device') return await loadDeviceKey() as T
      return read(slot) as T | undefined
    },
    async put(key, value) {
      write(storedSlot(key), value)
    },
    async delete(key) {
      remove(storedSlot(key))
    },
    async deleteIf(key, predicate) {
      const slot = storedSlot(key)
      if (slot.kind === 'item') {
        const current = readItem(slot.key)
        if (current === undefined || !predicate(current)) return false
        storage.removeItem(slot.key)
        return true
      }
      // Only the ring that matched: never another identity's.
      const found = readRing(slot.network)
      if (!found || !predicate(found.value)) return false
      storage.removeItem(found.key)
      return true
    },
    async updateIf(key, predicate, next) {
      const slot = storedSlot(key)
      const current = read(slot)
      if (current === undefined || !predicate(current)) return false
      write(slot, next(current))
      return true
    },
    async putIf(key, predicate, value) {
      const slot = slotOf(key)
      if (slot.kind === 'device') return loadDeviceKey()
      const current = read(slot)
      if (!predicate(current)) return current
      write(slot, value)
      return value
    },
  }
}
