/**
 * The user's `dmSelfState` (docs/DM_V5.md §5.5): load, decrypt, edit, and save
 * with the 40106 merge-and-retry, coalescing and the lifetime cap.
 *
 * - Edits are coalesced: `markDirty` schedules one save `COALESCE_MS` later;
 *   the engine also flushes on `visibilitychange`/`pagehide` and immediately
 *   when the user starts a conversation (`flush`).
 * - A save refused as stale (40106) or duplicate (40105, another device
 *   created the document first) re-reads, merges (`mergeSelfStates`) and saves
 *   again.
 * - Entries are never dropped. A conversation that would push the state past
 *   the one-document cap stays in `overflow`: shown, polled, never saved, and
 *   `capReached` is set so the UI can say so.
 * - The scan-cursor rule lives in `setScanCursor`: the saved cursor never
 *   passes an invite whose conversation is in `overflow`. Moving the cursor
 *   alone never triggers a save: it rides along with the next real one.
 * - A saved state from a newer client is never overwritten; one that does
 *   not decrypt at all is rebuilt by lost-state recovery (§9) and replaced.
 */

import { bytesEqual } from '@/lib/bytes'
import { logger } from '@/lib/logger'
import {
  decryptSelfState,
  emptySelfState,
  encryptSelfState,
  mergeSelfStates,
  selfStateFits,
  type SelfStateFields,
} from '@/lib/dm/self-state'
import type {
  BlockEntry,
  DirectConversation,
  GroupConversation,
  IdentityId,
  RetentionSetting,
  SelfState,
} from '@/lib/dm/types'
import type { ChainSelfState, DmChain } from './types'

/** Coalescing delay for background edits (read positions, blocks, settings). */
export const COALESCE_MS = 5 * 60_000
const MAX_SAVE_ATTEMPTS = 5

/**
 * `unreadable`: the saved state does not decrypt (a bug or a changed key): it
 * is rebuilt (§9) and replaced. `newer`: it decrypts but was written by a
 * newer client: it is never overwritten.
 */
export type SelfStateStatus = 'idle' | 'loaded' | 'missing' | 'unreadable' | 'newer'

const isNewerFormat = (error: unknown) => error instanceof Error && /Unsupported self-state version/.test(error.message)

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const defaultScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

type Entry = DirectConversation | GroupConversation

interface OverflowEntry {
  entry: Entry
  /** `$createdAt` of the invite this conversation was found from, if any (the scan-cursor rule). */
  inviteAt: number | null
}

const sameDirect = (a: DirectConversation, b: DirectConversation) => bytesEqual(a.peer, b.peer)
const sameGroup = (a: GroupConversation, b: GroupConversation) => bytesEqual(a.gid, b.gid) && bytesEqual(a.owner, b.owner)
const isGroup = (entry: Entry): entry is GroupConversation => 'gid' in entry

export class SelfStateStore {
  state: SelfState = emptySelfState()
  status: SelfStateStatus = 'idle'
  private doc: { id: string; revision: number } | null = null
  private overflow: OverflowEntry[] = []
  /** Blocks that did not fit: applied on this device, not saved. */
  private unsavedBlocks: BlockEntry[] = []
  private dirty = false
  private version = 0
  private timer: unknown = null
  private saving: Promise<boolean> | null = null
  /** Called after a remote state was merged in, so the engine can resync. */
  onMerged: (() => void) | null = null
  /**
   * Runs a coalesced (timer-driven) save. The engine routes it through its
   * serial queue so a background save never races a send for the identity
   * nonce; direct `flush()` calls must already be on that queue.
   */
  runSave: (save: () => Promise<boolean>) => Promise<boolean> = (save) => save()

  constructor(
    private readonly chain: DmChain,
    private readonly stateKey: Uint8Array,
    private readonly scheduler: Scheduler = defaultScheduler
  ) {}

  get capReached(): boolean {
    return this.overflow.length > 0
  }

  get isDirty(): boolean {
    return this.dirty
  }

  /** Read and decrypt the saved state. `missing` and `unreadable` both start from an empty state (§9). */
  async load(): Promise<SelfStateStatus> {
    const remote = await this.chain.selfState()
    if (!remote) {
      this.status = 'missing'
      return this.status
    }
    this.doc = { id: remote.id, revision: remote.revision }
    try {
      this.state = await decryptSelfState(this.stateKey, remote.fields)
      this.status = 'loaded'
    } catch (error) {
      this.status = isNewerFormat(error) ? 'newer' : 'unreadable'
      logger.warn(`DM v5 self-state cannot be read (${this.status}); rebuilding it:`, error)
    }
    return this.status
  }

  /**
   * Pick up another device's saves: re-read, and merge when the revision moved
   * or the document is a different one (deleted and created again elsewhere).
   * Returns true when something was merged.
   */
  async refresh(): Promise<boolean> {
    const remote = await this.chain.selfState()
    if (!remote || (this.doc && remote.id === this.doc.id && remote.revision <= this.doc.revision)) return false
    return this.mergeRemote(remote)
  }

  private async mergeRemote(remote: ChainSelfState): Promise<boolean> {
    let saved: SelfState
    try {
      saved = await decryptSelfState(this.stateKey, remote.fields)
    } catch (error) {
      if (isNewerFormat(error)) this.status = 'newer'
      return false
    }
    this.doc = { id: remote.id, revision: remote.revision }
    const merged = mergeSelfStates(saved, this.state)
    this.state = this.fitByOverflow(merged, saved)
    this.version++
    this.onMerged?.()
    return true
  }

  /**
   * Move entries only this device has into `overflow` until the merged state
   * fits again: conversations first, then block entries. Entries the saved
   * state holds leave `overflow`.
   */
  private fitByOverflow(merged: SelfState, saved: SelfState): SelfState {
    this.overflow = this.overflow.filter(({ entry }) =>
      isGroup(entry) ? !merged.groups.some((g) => sameGroup(g, entry)) : !merged.directs.some((d) => sameDirect(d, entry))
    )
    while (!selfStateFits(merged)) {
      const localGroup = merged.groups.findIndex((g) => !saved.groups.some((s) => sameGroup(s, g)))
      if (localGroup >= 0) {
        this.overflow.push({ entry: merged.groups.splice(localGroup, 1)[0], inviteAt: null })
        continue
      }
      const localDirect = merged.directs.findIndex((d) => !saved.directs.some((s) => sameDirect(s, d)))
      if (localDirect >= 0) {
        this.overflow.push({ entry: merged.directs.splice(localDirect, 1)[0], inviteAt: null })
        continue
      }
      const localBlock = merged.blocks.findIndex((b) => !saved.blocks.some((s) => bytesEqual(s.id, b.id)))
      if (localBlock < 0) break
      this.unsavedBlocks.push(merged.blocks.splice(localBlock, 1)[0])
    }
    return merged
  }

  // ---------------------------------------------------------------------------
  // Reads

  directs(): DirectConversation[] {
    return [...this.state.directs, ...this.overflow.map((o) => o.entry).filter((e): e is DirectConversation => !isGroup(e))]
  }

  groups(): GroupConversation[] {
    return [...this.state.groups, ...this.overflow.map((o) => o.entry).filter(isGroup)]
  }

  findDirect(peer: IdentityId): DirectConversation | null {
    return this.directs().find((d) => bytesEqual(d.peer, peer)) ?? null
  }

  findGroup(owner: IdentityId, gid: Uint8Array): GroupConversation | null {
    return this.groups().find((g) => bytesEqual(g.owner, owner) && bytesEqual(g.gid, gid)) ?? null
  }

  /** The store's current object for the same conversation (a merge replaces entry objects). */
  resolve<E extends Entry>(entry: E): E {
    const found = isGroup(entry) ? this.findGroup(entry.owner, entry.gid) : this.findDirect(entry.peer)
    return (found ?? entry) as E
  }

  isSaved(entry: Entry): boolean {
    const current = this.resolve(entry)
    return !this.overflow.some((o) => o.entry === current) && (isGroup(current) ? this.state.groups : this.state.directs).some((e) => e === current)
  }

  // ---------------------------------------------------------------------------
  // Edits

  /**
   * Add a conversation. Returns false when it does not fit (the cap): it is
   * kept in `overflow` and shown, but not saved.
   */
  addDirect(entry: DirectConversation, inviteAt: number | null = null): boolean {
    if (this.findDirect(entry.peer)) return true
    return this.add(entry, inviteAt, () => this.state.directs.push(entry), () => this.state.directs.pop())
  }

  addGroup(entry: GroupConversation): boolean {
    if (this.findGroup(entry.owner, entry.gid)) return true
    return this.add(entry, null, () => this.state.groups.push(entry), () => this.state.groups.pop())
  }

  private add(entry: Entry, inviteAt: number | null, push: () => void, pop: () => void): boolean {
    push()
    if (selfStateFits(this.state)) {
      this.markDirty()
      return true
    }
    pop()
    this.overflow.push({ entry, inviteAt })
    return false
  }

  /** Edit a conversation's read or hidden position. Positions only move forward (they merge by maximum). */
  touch(entry: Entry, patch: { readAt?: number; hiddenAt?: number }): void {
    const current = this.resolve(entry)
    let changed = false
    for (const target of current === entry ? [entry] : [current, entry]) {
      if (patch.readAt !== undefined && patch.readAt > target.readAt) {
        target.readAt = patch.readAt
        changed = true
      }
      if (patch.hiddenAt !== undefined && patch.hiddenAt > target.hiddenAt) {
        target.hiddenAt = patch.hiddenAt
        changed = true
      }
    }
    if (changed && this.isSaved(current)) this.markDirty()
  }

  /** A group's anchor key changes: an older epoch's grant turned up, or a re-add across a removal gap (§5.5). */
  replaceGroupEntry(entry: GroupConversation, next: GroupConversation): void {
    const current = this.resolve(entry)
    Object.assign(current, next)
    if (current !== entry) Object.assign(entry, next)
    if (this.isSaved(current)) this.markDirty()
  }

  private allBlocks(): BlockEntry[] {
    return [...this.state.blocks, ...this.unsavedBlocks]
  }

  isBlocked(id: IdentityId): boolean {
    return this.allBlocks().some((b) => b.blocked && bytesEqual(b.id, id))
  }

  blockedIds(): IdentityId[] {
    return this.allBlocks().filter((b) => b.blocked).map((b) => b.id)
  }

  setBlocked(id: IdentityId, blocked: boolean, now: number): void {
    const existing = this.allBlocks().find((b) => bytesEqual(b.id, id))
    const changedAt = Math.max(now, (existing?.changedAt ?? 0) + 1)
    if (existing) {
      existing.blocked = blocked
      existing.changedAt = changedAt
      if (this.state.blocks.includes(existing)) this.markDirty()
      return
    }
    const entry: BlockEntry = { id, blocked, changedAt }
    this.state.blocks.push(entry)
    if (selfStateFits(this.state)) {
      this.markDirty()
      return
    }
    // The block still applies on this device; it just cannot be saved (the cap).
    this.state.blocks.pop()
    this.unsavedBlocks.push(entry)
  }

  setRetention(retention: RetentionSetting, now: number): void {
    this.state.settings = { retention, updatedAt: Math.max(now, this.state.settings.updatedAt + 1) }
    this.markDirty()
  }

  /**
   * Move the invite scan position. It never passes an invite whose
   * conversation is only in `overflow` (not saved), so a later scan finds that
   * invite again (§5.5). It is only ever written together with the
   * conversations found up to it, because both live in this one state.
   */
  setScanCursor(cursor: number): void {
    const unsaved = this.overflow.map((o) => o.inviteAt).filter((at): at is number => at !== null)
    // Never dirty on its own: a scan that found nothing for me must not cost a write (§5.5).
    this.state.inviteScanCursor = unsaved.length > 0 ? Math.min(cursor, ...unsaved) : cursor
  }

  /** Claim group number `n` (it is never reused, §4.4). */
  claimGroupNumber(n: number): void {
    if (n + 1 > this.state.nextGroupNumber) {
      this.state.nextGroupNumber = n + 1
      this.markDirty()
    }
  }

  // ---------------------------------------------------------------------------
  // Saving

  markDirty(): void {
    this.dirty = true
    this.version++
    this.armTimer()
  }

  private armTimer(): void {
    if (this.timer !== null) return
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null
      this.runSave(() => this.flush()).catch((error) => logger.warn('DM v5 self-state save failed:', error))
    }, COALESCE_MS)
  }

  /** Cancel a pending coalesced save (the engine stopped). */
  cancelTimer(): void {
    if (this.timer === null) return
    this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }

  /** Save now if anything changed. Resolves true when the saved state is current. */
  flush(): Promise<boolean> {
    this.cancelTimer()
    if (this.saving) return this.saving.then((ok) => (ok && this.dirty ? this.flush() : ok))
    if (!this.dirty) return Promise.resolve(true)
    // No signing key on this device: stay dirty rather than prompt from a background save.
    if (!this.chain.canWrite()) return Promise.resolve(false)
    // Never replace a state a newer client wrote.
    if (this.status === 'newer') return Promise.resolve(false)
    this.saving = this.save()
      .catch((error: unknown) => {
        logger.warn('DM v5 self-state save failed:', error)
        return false
      })
      .finally(() => {
        this.saving = null
        // A save that failed (a refusal, a read that threw, repeated races) must not strand the
        // edits until the page closes: try again on the coalescing timer.
        if (this.dirty && this.status !== 'newer') this.armTimer()
      })
    return this.saving
  }

  private async save(): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
      const version = this.version
      if (!selfStateFits(this.state)) {
        logger.warn('DM v5 self-state does not fit one document; not saving')
        return false
      }
      const fields = await encryptSelfState(this.stateKey, this.state)
      const doc = this.doc
      const outcome = doc ? await this.chain.replaceSelfState(doc, fields) : await this.chain.createSelfState(fields)
      // A write whose result is uncertain (the DAPI timeout) may have been refused on chain because
      // another device saved first (40106), or created the document first (40105). Treating it as
      // saved would drop this device's edits for good, so read it back: only our own fields (at the
      // next revision, for a replace) count as landed.
      let saved: { id: string; revision: number } | null = null
      if (outcome.ok && !outcome.confirmed) {
        // One read decides: our own fields (landed), another device's state (merge and save again),
        // or nothing new yet (stay dirty; flush re-arms the timer, and the next save, a 40106 or
        // 40105 if this one did land after all, merges).
        const remote = await this.chain.selfState()
        const landed = remote !== null && sameFields(remote.fields, fields) && (!doc || (remote.id === doc.id && remote.revision === doc.revision + 1))
        if (!landed) {
          if (!remote || (doc && remote.id === doc.id && remote.revision <= doc.revision)) return false
          if (!(await this.mergeRemote(remote))) {
            if (this.status === 'newer') return false
            // It does not decrypt at all: replace it with what this device holds (§9).
            this.doc = { id: remote.id, revision: remote.revision }
          }
          continue
        }
        saved = { id: remote.id, revision: remote.revision }
      }
      if (outcome.ok) {
        this.doc = saved ?? (doc ? { id: doc.id, revision: doc.revision + 1 } : { id: outcome.id, revision: 1 })
        this.status = 'loaded'
        if (this.version === version) this.dirty = false
        return !this.dirty
      }
      if (outcome.failure === 'other') {
        logger.warn('DM v5 self-state save refused:', outcome.error)
        return false
      }
      // My other device used the identity nonce first: nothing was written; it may have saved, so
      // re-read like a revision race.
      // Another device saved first (40106), or created the document first (40105): merge and retry.
      const remote = await this.chain.selfState()
      if (!remote) {
        this.doc = null
        continue
      }
      if (!(await this.mergeRemote(remote))) {
        if (this.status === 'newer') return false
        // It does not decrypt at all: replace it with what this device rebuilt (§9).
        this.doc = { id: remote.id, revision: remote.revision }
      }
    }
    logger.warn('DM v5 self-state save gave up after repeated revision races')
    return false
  }

}

const sameField = (a: Uint8Array | null, b: Uint8Array | null) => (a === null || b === null ? a === b : bytesEqual(a, b))

/** Byte-identical self-state fields (each save seals with a fresh IV, so only our own write matches). */
function sameFields(a: SelfStateFields, b: SelfStateFields): boolean {
  return sameField(a.blob, b.blob) && sameField(a.blob2, b.blob2) && sameField(a.blob3, b.blob3)
}
