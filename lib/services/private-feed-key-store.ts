/**
 * This device's private-feed keys (social v17, crypto v2), one entry per
 * identity and feed, under `yappr:pf:` (secure storage on mobile,
 * mobile/engine/src/shims/storage.ts):
 *
 *     o:<ownerId>:<feed>                 the owner's seed of one of their feeds, its key generation and revocations
 *     f:<viewerId>:<ownerId>:<feed>      a member's grant keys for someone's feed: path keys, current CEK, history key
 *     h:<viewerId>:<ownerId>:<feed>      a closed feed's final CEK and history key, reached through a carry walk
 *
 * The first identity in every key is the account the entry belongs to, so one
 * account's keys are never read for another on a shared device, and signing
 * out clears only that account's ({@link clearIdentity}).
 */

import { scopedKey } from '@/lib/storage-scope'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { logger } from '@/lib/logger'
import type { NodeKey } from '@/lib/private-feed/crypto'

const PREFIX = scopedKey('yappr:pf:')

/** The owner's own keys of one feed. */
export interface OwnerFeedKeys {
  seed: Uint8Array
  /** The feed's current key generation (1 + its revocations). */
  keyGeneration: number
  /** Revoked leaves, in revocation order: they fix every node's version. */
  revokedLeaves: number[]
  treeCapacity: number
  maxKeyGeneration: number
}

/** A member's keys for someone else's feed, from its grant and the rekeys since. */
export interface MemberFeedKeys {
  /** When the grant these keys came from was written (its `$createdAt`). */
  grantedAt: number
  leafIndex: number
  keyGeneration: number
  cek: Uint8Array
  history: Uint8Array
  pathKeys: NodeKey[]
  treeCapacity: number
  maxKeyGeneration: number
}

/** A closed feed's last CEK and history key: enough to read all of it and walk further back. */
export interface HistoryFeedKeys {
  finalKeyGeneration: number
  cek: Uint8Array
  history: Uint8Array
}

const b64 = bytesToBase64
const unb64 = (value: unknown) => base64ToBytes(String(value))

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function read<T>(key: string, decode: (raw: Record<string, unknown>) => T): T | null {
  const raw = storage()?.getItem(PREFIX + key)
  if (!raw) return null
  try {
    return decode(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return null
  }
}

function write(key: string, value: Record<string, unknown>): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value))
  } catch (error) {
    logger.error('PrivateFeedKeyStore: could not store a key', error)
  }
}

function keysWith(prefix: string): string[] {
  const store = storage()
  if (!store) return []
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (key?.startsWith(PREFIX + prefix)) keys.push(key.slice(PREFIX.length))
  }
  return keys
}

const ownerKey = (ownerId: string, feed: number) => `o:${ownerId}:${feed}`
const memberKey = (viewerId: string, ownerId: string, feed: number) => `f:${viewerId}:${ownerId}:${feed}`
const historyKeyName = (viewerId: string, ownerId: string, feed: number) => `h:${viewerId}:${ownerId}:${feed}`

const encodeNodeKeys = (keys: readonly NodeKey[]) => keys.map((k) => ({ n: k.nodeId, v: k.version, k: b64(k.key) }))
const decodeNodeKeys = (value: unknown): NodeKey[] => {
  if (!Array.isArray(value)) throw new Error('path keys')
  return value.map((k: { n: number; v: number; k: string }) => ({ nodeId: k.n, version: k.v, key: unb64(k.k) }))
}

class PrivateFeedKeyStore {
  private listeners = new Set<() => void>()

  /** Observe key changes in this tab and others (member and history keys; no key material is emitted). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(PREFIX)) listener()
    }
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
    return () => {
      this.listeners.delete(listener)
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
    }
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener())
  }

  // ---- owner ----

  ownerKeys(ownerId: string, feed: number): OwnerFeedKeys | null {
    return read(ownerKey(ownerId, feed), (raw) => ({
      seed: unb64(raw.seed),
      keyGeneration: Number(raw.gen),
      revokedLeaves: (raw.revoked as number[]).map(Number),
      treeCapacity: Number(raw.cap),
      maxKeyGeneration: Number(raw.max),
    }))
  }

  storeOwnerKeys(ownerId: string, feed: number, keys: OwnerFeedKeys): void {
    write(ownerKey(ownerId, feed), {
      seed: b64(keys.seed), gen: keys.keyGeneration, revoked: keys.revokedLeaves, cap: keys.treeCapacity, max: keys.maxKeyGeneration,
    })
    this.changed()
  }

  /** The feeds of `ownerId` whose seed this device holds, newest first. */
  ownerFeeds(ownerId: string): number[] {
    return keysWith(`o:${ownerId}:`).map((key) => Number(key.split(':')[2])).filter(Number.isInteger).sort((a, b) => b - a)
  }

  // ---- member ----

  memberKeys(viewerId: string, ownerId: string, feed: number): MemberFeedKeys | null {
    return read(memberKey(viewerId, ownerId, feed), (raw) => ({
      grantedAt: Number(raw.at),
      leafIndex: Number(raw.leaf),
      keyGeneration: Number(raw.gen),
      cek: unb64(raw.cek),
      history: unb64(raw.h),
      pathKeys: decodeNodeKeys(raw.path),
      treeCapacity: Number(raw.cap),
      maxKeyGeneration: Number(raw.max),
    }))
  }

  storeMemberKeys(viewerId: string, ownerId: string, feed: number, keys: MemberFeedKeys): void {
    write(memberKey(viewerId, ownerId, feed), {
      at: keys.grantedAt, leaf: keys.leafIndex, gen: keys.keyGeneration, cek: b64(keys.cek), h: b64(keys.history),
      path: encodeNodeKeys(keys.pathKeys), cap: keys.treeCapacity, max: keys.maxKeyGeneration,
    })
    this.changed()
  }

  /** Every feed `viewerId` holds member keys for, as `{ ownerId, feed }`. */
  memberFeeds(viewerId: string): { ownerId: string; feed: number }[] {
    return keysWith(`f:${viewerId}:`).map((key) => {
      const [, , ownerId, feed] = key.split(':')
      return { ownerId, feed: Number(feed) }
    }).filter(({ ownerId, feed }) => !!ownerId && Number.isInteger(feed))
  }

  /** The newest of `ownerId`'s feeds `viewerId` holds member keys for, or null. */
  newestMemberFeed(viewerId: string, ownerId: string): number | null {
    const feeds = this.memberFeeds(viewerId).filter((entry) => entry.ownerId === ownerId).map((entry) => entry.feed)
    return feeds.length > 0 ? Math.max(...feeds) : null
  }

  // ---- history ----

  historyKeys(viewerId: string, ownerId: string, feed: number): HistoryFeedKeys | null {
    return read(historyKeyName(viewerId, ownerId, feed), (raw) => ({
      finalKeyGeneration: Number(raw.gen), cek: unb64(raw.cek), history: unb64(raw.h),
    }))
  }

  storeHistoryKeys(viewerId: string, ownerId: string, feed: number, keys: HistoryFeedKeys): void {
    write(historyKeyName(viewerId, ownerId, feed), { gen: keys.finalKeyGeneration, cek: b64(keys.cek), h: b64(keys.history) })
    this.changed()
  }

  /**
   * True when this device holds keys that read `ownerId`'s feed `feed` at
   * `keyGeneration` without any network read: the owner's seed, a member's
   * keys at that generation or later, or a closed feed's history entry.
   */
  canReadLocally(viewerId: string, ownerId: string, feed: number, keyGeneration: number): boolean {
    if (viewerId === ownerId && this.ownerKeys(ownerId, feed)) return true
    const member = this.memberKeys(viewerId, ownerId, feed)
    if (member && member.keyGeneration >= keyGeneration) return true
    const history = this.historyKeys(viewerId, ownerId, feed)
    return !!history && history.finalKeyGeneration >= keyGeneration
  }

  /** Remove every entry belonging to `identityId`: its own feeds' seeds and what it holds of others' feeds. */
  clearIdentity(identityId: string): void {
    const store = storage()
    if (!store) return
    for (const key of [...keysWith(`o:${identityId}:`), ...keysWith(`f:${identityId}:`), ...keysWith(`h:${identityId}:`)]) {
      store.removeItem(PREFIX + key)
    }
    this.changed()
  }
}

export const privateFeedKeyStore = new PrivateFeedKeyStore()
export { PrivateFeedKeyStore }
