/**
 * An in-memory `DmChain` for the DM v5 unit tests: unique [tag] and
 * [$ownerId, handle] indexes, revision-checked replaces, and a settable clock.
 * Several `MemoryChain` views share one `MemoryLedger`, one per identity, so
 * tests can run two users (or two devices) against the same "network".
 */

import bs58 from 'bs58'
import { bytesEqual } from '@/lib/bytes'
import { getPublicKey } from '@/lib/crypto/keys'
import type { SelfStateFields } from '@/lib/dm/self-state'
import type { DmInvite, IdentityId } from '@/lib/dm/types'
import { createContext, type DmContext } from './context'
import { LocalCache } from './local-cache'
import type { Scheduler } from './self-state-store'
import type { ChainGroupDoc, ChainInvite, ChainMessage, ChainSelfState, DmChain, InvitePage, KeyValueStore, WriteOutcome } from './types'
import { hexId } from './util'

interface StoredSelfState {
  id: string
  owner: IdentityId
  revision: number
  fields: SelfStateFields
}

export class MemoryLedger {
  time = 1_790_000_000_000
  messages: ChainMessage[] = []
  invites: ChainInvite[] = []
  groupDocs: ChainGroupDoc[] = []
  selfStates: StoredSelfState[] = []
  keys = new Map<string, Uint8Array>()
  follows: Array<{ from: IdentityId; to: IdentityId }> = []
  private nextId = 1
  /** Queries served, by method, for assertions. */
  queries: Record<string, number> = {}

  id(): string {
    return `doc${this.nextId++}`
  }

  /** How far each write advances the clock. 0 puts several writes in one block (equal `$createdAt`). */
  step = 1000

  tick(): number {
    this.time += this.step
    return this.time
  }

  register(id: IdentityId, priv: Uint8Array | null): void {
    if (priv) this.keys.set(hexId(id), getPublicKey(priv))
  }

  count(method: string): void {
    this.queries[method] = (this.queries[method] ?? 0) + 1
  }
}

type Hook = (method: string, args: unknown[]) => WriteOutcome | null | undefined

export class MemoryChain implements DmChain {
  /** Return an outcome to replace a write entirely: nothing is stored (injected refusals, lost broadcasts). */
  hook: Hook | null = null
  /** The next N writes are applied but reported unconfirmed (the DAPI timeout that still landed). */
  unconfirmed = 0
  writable = true
  /** Backoff waits the client asked for (tests do not really wait). */
  sleeps: number[] = []

  constructor(
    readonly ledger: MemoryLedger,
    readonly me: IdentityId
  ) {}

  now(): number {
    return this.ledger.time
  }

  private override(method: string, args: unknown[]): WriteOutcome | null {
    return this.hook?.(method, args) ?? null
  }

  private applied(id: string): WriteOutcome {
    if (this.unconfirmed > 0) {
      this.unconfirmed--
      return { ok: true, id, confirmed: false }
    }
    return { ok: true, id, confirmed: true }
  }

  async messagesByTags(tags: Uint8Array[]): Promise<ChainMessage[]> {
    // The adapter splits into 100-tag queries; count them the same way.
    for (let i = 0; i < Math.max(1, Math.ceil(tags.length / 100)); i++) this.ledger.count('messagesByTags')
    return this.ledger.messages.filter((m) => tags.some((t) => bytesEqual(t, m.tag)))
  }

  async invitesSince(buckets: number[], since: number): Promise<ChainInvite[]> {
    this.ledger.count('invitesSince')
    return this.ledger.invites
      .filter((i) => buckets.includes(i.bucket) && i.createdAt >= since)
      .sort((a, b) => a.bucket - b.bucket || a.createdAt - b.createdAt)
  }

  async invitesNewestFirst(bucket: number, startAfter: string | null): Promise<InvitePage> {
    const all = this.ledger.invites.filter((i) => i.bucket === bucket).sort((a, b) => b.createdAt - a.createdAt)
    const from = startAfter ? all.findIndex((i) => i.id === startAfter) + 1 : 0
    const docs = all.slice(from, from + 2)
    return { docs, next: from + 2 < all.length ? docs[docs.length - 1].id : null }
  }

  async groupDocs(owner: IdentityId, handles: Uint8Array[]): Promise<ChainGroupDoc[]> {
    this.ledger.count('groupDocs')
    return this.ledger.groupDocs
      .filter((d) => bytesEqual(d.ownerId, owner) && handles.some((h) => bytesEqual(h, d.handle)))
      .map((d) => ({ ...d }))
  }

  async selfState(): Promise<ChainSelfState | null> {
    const doc = this.ledger.selfStates.find((s) => bytesEqual(s.owner, this.me))
    return doc ? { id: doc.id, revision: doc.revision, fields: { ...doc.fields } } : null
  }

  async hasWritten(): Promise<boolean> {
    const mine = (d: { ownerId: IdentityId }) => bytesEqual(d.ownerId, this.me)
    return this.ledger.messages.some(mine) || this.ledger.invites.some(mine) || this.ledger.groupDocs.some(mine) || this.ledger.selfStates.some((s) => bytesEqual(s.owner, this.me))
  }

  canWrite(): boolean {
    return this.writable
  }

  async createMessage(tag: Uint8Array, body: Uint8Array): Promise<WriteOutcome> {
    const forced = this.override('createMessage', [tag, body])
    if (forced) return forced
    if (this.ledger.messages.some((m) => bytesEqual(m.tag, tag))) {
      return { ok: false, failure: 'duplicate', error: 'Document has duplicate unique properties ["tag"] with other documents code=40105' }
    }
    const doc: ChainMessage = { id: this.ledger.id(), ownerId: this.me, createdAt: this.ledger.tick(), tag, body }
    this.ledger.messages.push(doc)
    return this.applied(doc.id)
  }

  async deleteMessage(id: string): Promise<WriteOutcome> {
    const index = this.ledger.messages.findIndex((m) => m.id === id && bytesEqual(m.ownerId, this.me))
    if (index < 0) return { ok: false, failure: 'other', error: 'not found' }
    this.ledger.messages.splice(index, 1)
    return { ok: true, id, confirmed: true }
  }

  async createInvite(invite: DmInvite): Promise<WriteOutcome> {
    const forced = this.override('createInvite', [invite])
    if (forced) return forced
    const doc: ChainInvite = { id: this.ledger.id(), ownerId: this.me, createdAt: this.ledger.tick(), ...invite }
    this.ledger.invites.push(doc)
    return { ok: true, id: doc.id, confirmed: true }
  }

  async createGroupDoc(handle: Uint8Array, blob: Uint8Array): Promise<WriteOutcome> {
    const forced = this.override('createGroupDoc', [handle, blob])
    if (forced) return forced
    if (this.ledger.groupDocs.some((d) => bytesEqual(d.ownerId, this.me) && bytesEqual(d.handle, handle))) {
      return { ok: false, failure: 'duplicate', error: 'duplicate unique properties ["$ownerId", "handle"] code=40105' }
    }
    const time = this.ledger.tick()
    const doc: ChainGroupDoc = { id: this.ledger.id(), ownerId: this.me, createdAt: time, updatedAt: time, handle, blob, revision: 1 }
    this.ledger.groupDocs.push(doc)
    return { ok: true, id: doc.id, confirmed: true }
  }

  async replaceGroupDoc(ref: { id: string; revision: number }, handle: Uint8Array, blob: Uint8Array): Promise<WriteOutcome> {
    const forced = this.override('replaceGroupDoc', [ref, handle, blob])
    if (forced) return forced
    const doc = this.ledger.groupDocs.find((d) => d.id === ref.id && bytesEqual(d.ownerId, this.me))
    if (!doc) return { ok: false, failure: 'other', error: 'not found' }
    if (doc.revision !== ref.revision) return { ok: false, failure: 'stale', error: 'has invalid revision code=40106' }
    doc.blob = blob
    doc.revision += 1
    doc.updatedAt = this.ledger.tick()
    return { ok: true, id: doc.id, confirmed: true }
  }

  async createSelfState(fields: SelfStateFields): Promise<WriteOutcome> {
    const forced = this.override('createSelfState', [fields])
    if (forced) return forced
    if (this.ledger.selfStates.some((s) => bytesEqual(s.owner, this.me))) {
      return { ok: false, failure: 'duplicate', error: 'duplicate unique properties ["$ownerId"] code=40105' }
    }
    const doc = { id: this.ledger.id(), owner: this.me, revision: 1, fields }
    this.ledger.selfStates.push(doc)
    this.ledger.tick()
    return { ok: true, id: doc.id, confirmed: true }
  }

  async replaceSelfState(ref: { id: string; revision: number }, fields: SelfStateFields): Promise<WriteOutcome> {
    const forced = this.override('replaceSelfState', [ref, fields])
    if (forced) return forced
    const doc = this.ledger.selfStates.find((s) => s.id === ref.id)
    if (!doc) return { ok: false, failure: 'other', error: 'not found' }
    if (doc.revision !== ref.revision) return { ok: false, failure: 'stale', error: 'has invalid revision code=40106' }
    doc.fields = fields
    doc.revision += 1
    this.ledger.tick()
    return { ok: true, id: doc.id, confirmed: true }
  }

  async encryptionKey(identity: IdentityId): Promise<Uint8Array | null> {
    return this.ledger.keys.get(hexId(identity)) ?? null
  }

  async contacts(): Promise<IdentityId[]> {
    const out: IdentityId[] = []
    for (const f of this.ledger.follows) {
      if (bytesEqual(f.from, this.me)) out.push(f.to)
      else if (bytesEqual(f.to, this.me)) out.push(f.from)
    }
    return out
  }
}

export class MapKv implements KeyValueStore {
  readonly map = new Map<string, string>()
  get(key: string): string | null {
    return this.map.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.map.set(key, value)
  }
}

/** A scheduler that never fires on its own: tests flush explicitly. */
export const manualScheduler: Scheduler = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
}

/** A fresh context for one user on a ledger. */
export function makeContext(ledger: MemoryLedger, id: IdentityId, encPriv: Uint8Array, kv: KeyValueStore = new MapKv()): { ctx: DmContext; chain: MemoryChain } {
  ledger.register(id, encPriv)
  const chain = new MemoryChain(ledger, id)
  const cache = new LocalCache(kv, `dm-v5:${bs58.encode(id)}`)
  const ctx = createContext({ chain, identityId: id, encPriv, cache, scheduler: manualScheduler })
  // Retry backoffs do not really wait in tests; the waits asked for are recorded on the chain.
  ctx.sleep = async (ms) => {
    chain.sleeps.push(ms)
  }
  // The device clock follows the ledger's in tests, so advancing `ledger.time` ages everything.
  ctx.clock = () => ledger.time
  return { ctx, chain }
}
