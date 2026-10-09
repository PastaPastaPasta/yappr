import bs58 from 'bs58'
import type { RetentionSetting } from '@/lib/dm/types'
import { NoEncryptionKeyError, type ConversationView, type DmEngine, type MessageView } from '@/lib/services/dm-v5'
import type { Conv } from '@/lib/services/dm-v5/conversation'
import { GroupError } from '@/lib/services/dm-v5/groups'
import { YAPPR_DM_V5_CONTRACT_ID } from '@/lib/constants'
import { isTimeoutError } from '@/lib/error-utils'
import { settleSupersededReplaces } from '@/lib/services/identity-nonce'
import { logger } from '@/lib/logger'
import { scopedKey } from '@/lib/storage-scope'
import { RpcError } from '../protocol/envelope'
import type { AppLifecycleState } from '../shims/lifecycle'
import { classify } from '../writes/classify'
import { NotSentError, type ProbeResult, type WriteResult } from '../writes/tickets'
import { createChangeTracker, unreadCounts, type ConversationRow, type DmEmit, type DmView } from './changes'
import type { DmGroupAction, DmStatusDTO, MessageDTO } from './types'

/** Where the v5 engine comes from: lib's per-identity registry in the app, an in-memory chain in tests. */
export interface DmEngineSource {
  /** The running engine for the identity (created on first use), or null without an encryption key on this device. */
  engineFor(identityId: string): DmEngine | null
  /**
   * Stop and forget `engine` if it is still the identity's current one (lib's
   * `stopDmEngine`, which starts a flush without waiting for it). Never
   * touches another identity's engine.
   */
  release(identityId: string, engine: DmEngine): void
}

type KeyValueArea = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * What DM v5 keeps in the engine's plain storage for an identity: lib's
 * per-device cache (`lib/services/dm-v5/index.ts` names it), which holds who
 * the account talks to, its blocks and read positions. Sign-out removes it
 * (PRD AUTH-11).
 */
export function dmLocalKeys(identityId: string): string[] {
  return [scopedKey(`yappr_dm_v5:${identityId}`), retentionKey(identityId), blocksKey(identityId), followedKey(identityId)]
}

/**
 * A "Reclaim message fees" choice made here and not saved yet. lib keeps
 * blocks and read positions in its cache until they are saved, but not
 * this, so a save that fails before the app is killed would lose it (SR-23).
 */
const retentionKey = (identityId: string) => scopedKey(`yappr_engine_dm_retention:${identityId}`)

/**
 * Blocks in Messages asked for while this device had no encryption key, or
 * before the saved state loaded: a Block made from a profile also blocks in
 * Messages (PRD SAFE-01), so it is kept here and applied once it can be.
 */
const blocksKey = (identityId: string) => scopedKey(`yappr_engine_dm_blocks:${identityId}`)

/**
 * The people this device blocked in Messages because the account blocks
 * them (PRD SAFE-01), each with the account block it followed: its
 * `$createdAt`, or `LOCAL` for one confirmed here (or read without one)
 * whose `$createdAt` it has not read yet. Only these are lifted when the
 * account's block goes. A block made in Messages alone (web's conversation
 * menu) is never in it, so following the account's blocks never lifts one.
 */
const followedKey = (identityId: string) => scopedKey(`yappr_engine_dm_account_blocks:${identityId}`)

const LOCAL = 'local'
type Followed = Map<string, number | typeof LOCAL>

function readFollowed(storage: KeyValueArea, identityId: string): Followed {
  try {
    const value = JSON.parse(storage.getItem(followedKey(identityId)) ?? '{}') as unknown
    // Earlier builds kept only the ids.
    if (Array.isArray(value)) return new Map(value.filter((id): id is string => typeof id === 'string').map(id => [id, LOCAL]))
    if (value && typeof value === 'object') {
      return new Map(Object.entries(value).filter((entry): entry is [string, number | typeof LOCAL] =>
        entry[1] === LOCAL || Number.isFinite(entry[1])))
    }
  } catch {
    // Unreadable: nothing followed yet.
  }
  return new Map()
}

function writeFollowed(storage: KeyValueArea, identityId: string, followed: Followed): void {
  storage.setItem(followedKey(identityId), JSON.stringify(Object.fromEntries(followed)))
}

/** A choice kept for later: block or unblock, and when it was made (a newer one from another device wins). */
interface PendingBlock {
  blocked: boolean
  changedAt: number
}

const isPendingBlock = (value: unknown): value is PendingBlock =>
  typeof value === 'object' && value !== null &&
  typeof (value as PendingBlock).blocked === 'boolean' && Number.isFinite((value as PendingBlock).changedAt)

/** Peer id → the latest choice for that peer. */
function readPendingBlocks(storage: KeyValueArea, identityId: string): Record<string, PendingBlock> {
  try {
    const value = JSON.parse(storage.getItem(blocksKey(identityId)) ?? 'null') as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, PendingBlock] => isPendingBlock(entry[1])))
    }
  } catch {
    // Unreadable: nothing to restore.
  }
  return {}
}

/**
 * Block or unblock `peerId` unless that already stands (an unblock of
 * someone never blocked writes nothing). Returns whether it changed anything.
 */
/** Block or unblock `peerId` in Messages unless they already are, stamped no earlier than `notBefore`. */
function applyBlock(running: DmEngine, peerId: string, blocked: boolean, notBefore = 0): boolean {
  if (running.getSnapshot().blocked.includes(peerId) === blocked) return false
  running.setBlocked(peerId, blocked, notBefore)
  return true
}

/** When the saved state last changed the block on `peerId` (any device), or 0 when it never did. */
function savedBlockChange(running: DmEngine, peerId: string): number {
  return running.ctx.store.state.blocks.find(entry => bs58.encode(entry.id) === peerId)?.changedAt ?? 0
}

interface PendingRetention {
  retention: RetentionSetting
  updatedAt: number
}

const RETENTIONS: readonly RetentionSetting[] = ['30d', '90d', '1y', 'never']

function readPendingRetention(storage: KeyValueArea, identityId: string): PendingRetention | null {
  try {
    const value = JSON.parse(storage.getItem(retentionKey(identityId)) ?? 'null') as Partial<PendingRetention> | null
    if (value && RETENTIONS.includes(value.retention as RetentionSetting) && Number.isSafeInteger(value.updatedAt)) {
      return { retention: value.retention as RetentionSetting, updatedAt: value.updatedAt as number }
    }
  } catch {
    // Unreadable: nothing to restore.
  }
  return null
}

/**
 * How long a send may take before it is given up as not sent, unless it has
 * broadcast something by then (an invite or a message). It runs from the
 * moment the send's ticket starts: the wait for an earlier send, the settle
 * of lib's pending replaces (which waits for the account's write lock, held
 * by any write in progress through its confirmation), lib's queue, and every
 * read and build before the broadcast all count. A send is about four DAPI round trips
 * (about 2 s); this allows three consecutive 8 s SDK timeouts
 * (`evo-sdk-service` `timeoutMs`). It stays under the 45 s a send may take
 * to get its ticket (`SEND_SUBMIT_DEADLINE_MS`) and the 60 s after which a
 * ticket reads "still sending" (`PENDING_DEADLINE_MS`) or the app gives the
 * text back (`UNTICKETED_WAIT_MS`): a send that never got out reads "Not
 * delivered" with a retry, not a lasting "Sending" (RC16-A-03).
 */
export const SEND_BUDGET_MS = 30_000

/**
 * The pause before a send whose read before its broadcast failed on the
 * connection tries once more: the SDK rebuilds its connection in the
 * background after such a failure, and `getSdk` waits for the rebuild
 * (RC16-A-05).
 */
export const SEND_REATTEMPT_PAUSE_MS = 2_000

/** A send given up before anything went out: the same words wherever a send takes too long. */
export const SEND_GAVE_UP = "Sending took too long, so it wasn't sent. Try again."

/**
 * A send in progress: how many broadcasts it made (its conversation's
 * invite, each message), counted just before each goes out, past every read
 * and build before it (lib's `beforeBroadcast`, called by `createDocument`
 * at its broadcast), and whether it was given up as not sent (it may
 * broadcast nothing from then on). Only this send's own broadcasts count:
 * lib runs group grants, leaves and re-keys through the same chain, and none
 * of them is this send's.
 */
interface SendAttempt {
  broadcasts: number
  abandoned: boolean
}

/**
 * Whether a send that failed before broadcasting anything tries once more:
 * the connection failed (`NETWORK`) or a read timed out (`TIMEOUT`),
 * typically the first request after the network came back, on connections
 * the stall left dead. Nothing went out, so it cannot duplicate.
 */
function reattempts(error: unknown, attempt: SendAttempt): boolean {
  if (attempt.broadcasts > 0 || attempt.abandoned) return false
  const { code } = classify(error)
  return code === 'NETWORK' || code === 'TIMEOUT'
}

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/**
 * `turn`'s outcome, or, `SEND_BUDGET_MS` after the send started with nothing
 * broadcast, a retryable not-sent failure (`NETWORK`): the attempt is given
 * up, so lib's call, which runs on until its own requests end, broadcasts
 * nothing more (`beforeBroadcast` refuses). Once anything went out, part of
 * the send may land: this stops timing and waits for lib's answer, and the
 * ticket reads "still sending" in the meantime (`PENDING_DEADLINE_MS`).
 */
function withinBudget(turn: Promise<void>, attempt: SendAttempt): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (attempt.broadcasts > 0) return
      attempt.abandoned = true
      reject(new NotSentError(new RpcError(SEND_GAVE_UP, 'NETWORK')))
    }, SEND_BUDGET_MS)
    turn.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** My messages in `key` held on trust and not read back yet (`MessageView.pending`), counted without building the views. */
function pendingIn(engine: DmEngine, key: string): number {
  const conv = engine.ctx.convs.get(key)
  return conv ? Array.from(conv.held.values()).filter(held => held.local === true).length : 0
}

/** `at` is the time to show (my send: when I sent it, QA D-L4i-007); the order is lib's, by block time. */
function toMessageDTO(view: MessageView): MessageDTO {
  return { id: view.id, sender: view.senderId, text: view.text, at: new Date(view.shownAt), own: view.own, pending: view.pending }
}

/**
 * When a conversation last changed, for the inbox order (PRD DM-01). lib
 * counts a group with no message from its read position, which is 0 for one
 * joined but never opened; such a group is placed by when this device joined
 * it, instead of with no time at all.
 */
function lastActivityOf(view: ConversationView, conv: Conv | undefined): Date | null {
  if (view.lastActivity > 0) return new Date(view.lastActivity)
  const joinedAt = conv?.kind === 'group' ? conv.entry.anchorChangedAt : 0
  return joinedAt > 0 ? new Date(joinedAt) : null
}

function toRow(view: ConversationView, conv: Conv | undefined): ConversationRow {
  const group = view.kind === 'group'
  const last = view.lastMessage
  return {
    key: view.key,
    backend: 'v5',
    kind: view.kind,
    peerId: group ? null : view.peerId,
    ownerId: group ? view.peerId : null,
    name: group ? view.name : null,
    members: group ? view.memberIds : [],
    isOwner: view.isOwner,
    lastMessage: last ? { text: last.text, at: new Date(last.shownAt), own: last.own } : null,
    lastActivity: lastActivityOf(view, conv),
    unread: view.unread,
    flags: {
      hidden: view.hidden,
      unreadable: view.unreadable,
      removed: view.removed,
      ended: view.ended,
      blocked: view.blocked,
      unsaved: view.unsaved,
      draft: view.draft,
    },
    peerReadAt: null,
  }
}

const rowsOf = (engine: DmEngine): ConversationRow[] =>
  engine.getSnapshot().conversations.map(view => toRow(view, engine.ctx.convs.get(view.key)))

const conversationOf = (engine: DmEngine, key: string): ConversationView | undefined =>
  engine.getSnapshot().conversations.find(view => view.key === key)

function view(engine: DmEngine): DmView {
  const snapshot = engine.getSnapshot()
  return {
    rows: rowsOf(engine),
    ready: snapshot.ready,
    error: snapshot.error,
    messages: key => engine.messages(key).map(toMessageDTO),
    pendingIn: key => pendingIn(engine, key),
    heldIn: key => engine.ctx.convs.get(key)?.held.size ?? 0,
  }
}

/**
 * DM v5 behind `dm.*` (docs/DM_V5.md): one `DmEngine` per signed-in
 * identity, which runs its own loop (30 s, 4 s while a conversation is open,
 * lib's `engine.ts`) and keeps its own state. This starts it for the session,
 * maps its views to DTOs and its notifications to events, and stops it with
 * a flush when the session ends. Mirrors `components/messages/messages-v5.tsx`.
 */
/**
 * A block list read this soon after a block or unblock settled may not
 * show it yet (a lagging node): that write, not the read, decides the
 * person's block in Messages meanwhile.
 */
export const BLOCK_SETTLING_MS = 10 * 60_000

/** The account's own block list, read whole: each blocked person, and when the block was made (block time, ms). */
export type AccountBlockList = ReadonlyMap<string, number>

export interface V5BackendOptions {
  source: DmEngineSource
  emit: DmEmit
  coalesceMs?: number
  storage?: KeyValueArea
  /**
   * An engine started for `identityId` (sign-in, a restored session, an
   * unlock): read the account's own block list, for `followAccountBlocks`.
   */
  onStarted?: (identityId: string) => void
  /**
   * The people a block or unblock from this device may still be changing, or
   * just changed (a list read now may not show it yet): that write decides
   * their block in Messages (`followAccountBlock`), not a list read. Null
   * when they can't be told: then no list read changes Messages.
   */
  settling?: () => ReadonlySet<string> | null
}

export function createV5Backend(options: V5BackendOptions) {
  const tracker = createChangeTracker({ emit: options.emit, coalesceMs: options.coalesceMs })
  const storage = (): KeyValueArea => options.storage ?? localStorage
  let current: { identityId: string; engine: DmEngine; unsubscribe: () => void } | null = null
  /** The app is in the background: an engine started now (a session restored there) starts paused. */
  let backgrounded = false
  /** Saves still running for engines already stopped: their end rewrites lib's cache. */
  const flushes = new Map<string, Promise<unknown>>()
  /**
   * Each engine's sends, one at a time, so a send that tries once more
   * (RC16-A-05) never lets a later one overtake it. Per engine: a send
   * hanging on an old account's engine never holds up the next account's.
   */
  const lanes = new WeakMap<DmEngine, Promise<unknown>>()
  /** The account's block list, read before the saved state loaded: applied once it has. */
  let heldBlocks: { identityId: string; blocked: AccountBlockList } | null = null

  /** The engine for `identityId`, started on first use; null while the device has no encryption key for it. */
  function engineOf(identityId: string): DmEngine | null {
    const engine = options.source.engineFor(identityId)
    if (current && (current.identityId !== identityId || current.engine !== engine)) {
      // lib replaced it (a different key), the key is gone, or the identity changed without a
      // session event: stop the old one (a no-op if lib already did), so it never polls on.
      const old = current
      current = null
      old.unsubscribe()
      old.engine.stop()
      options.source.release(old.identityId, old.engine)
    }
    if (!engine || current) return engine
    tracker.reset()
    let loaded = false
    const restoreOnceLoaded = () => {
      if (loaded || !engine.getSnapshot().ready) return
      loaded = true
      restoreRetention(identityId, engine)
      restoreBlocks(identityId, engine)
      const held = heldBlocks
      heldBlocks = null
      if (held?.identityId === identityId) followBlocks(identityId, engine, held.blocked)
    }
    const unsubscribe = engine.subscribe(() => {
      restoreOnceLoaded()
      tracker.changed(() => (current?.engine === engine ? view(engine) : null))
    })
    current = { identityId, engine, unsubscribe }
    restoreOnceLoaded()
    engine.start().catch(error => logger.warn('DM v5 engine failed to start:', error))
    if (backgrounded) engine.pause()
    options.onStarted?.(identityId)
    return engine
  }

  /** Save the retention setting; once the saved state is current, the local copy has done its job. */
  function saveRetention(identityId: string, running: DmEngine): void {
    running.flush()
      .then(saved => {
        const pending = readPendingRetention(storage(), identityId)
        if (saved && pending && pending.updatedAt <= running.ctx.store.state.settings.updatedAt) storage().removeItem(retentionKey(identityId))
      })
      .catch(error => logger.warn('DM v5: saving retention failed:', error))
  }

  /** Once the saved state has loaded: re-apply a retention choice this device made but never saved, unless a newer one won. */
  function restoreRetention(identityId: string, running: DmEngine): void {
    const pending = readPendingRetention(storage(), identityId)
    if (!pending) return
    if (pending.updatedAt <= running.ctx.store.state.settings.updatedAt) {
      storage().removeItem(retentionKey(identityId))
      return
    }
    running.ctx.store.setRetention(pending.retention, pending.updatedAt)
    saveRetention(identityId, running)
  }

  function engine(identityId: string): DmEngine {
    const found = engineOf(identityId)
    if (!found) throw new RpcError('Messages are locked: this device has no encryption key for the account (dm.unlock)', 'NO_KEY')
    return found
  }

  /** Before the saved state loads, a conversation may not be known yet: retry later (`ENGINE_BUSY`). */
  function readyEngine(identityId: string): DmEngine {
    const running = engine(identityId)
    if (!running.getSnapshot().ready) throw new RpcError('Messages are still loading', 'ENGINE_BUSY')
    return running
  }

  /**
   * Once the saved state has loaded: apply the blocks asked for before it
   * could be (locked, or still loading), unless the saved state holds a
   * newer choice for that person, made on another device meanwhile (the
   * newer change wins, as in a merge).
   */
  function restoreBlocks(identityId: string, running: DmEngine): void {
    const pending = readPendingBlocks(storage(), identityId)
    storage().removeItem(blocksKey(identityId))
    for (const [peerId, { blocked, changedAt }] of Object.entries(pending)) {
      if (savedBlockChange(running, peerId) < changedAt) applyBlock(running, peerId, blocked, changedAt)
    }
  }

  /**
   * Messages follow the account's own blocks (PRD SAFE-01, SAFE-02): block
   * everyone on `blocked` (the whole list, as read) for each account block
   * this device has not followed yet, and lift the blocks it made for people
   * no longer on it. A block already standing in Messages is adopted, so the
   * account's unblock lifts it too. An account block already followed here
   * changes nothing, so a choice made in Messages since (Message settings'
   * Unblock) stands; a newer one (removed and made again) blocks them again.
   * One not followed here yet leaves unblocked someone Messages unblocked
   * after it was made, on another device (the newer change wins, as in a
   * merge). A block changed in Messages lately is never lifted by a read
   * (one from a node that has not caught up yet must not undo it). People
   * with a block or unblock of their own settling are left to it
   * (`followAccountBlock`).
   */
  function followBlocks(identityId: string, running: DmEngine, blocked: AccountBlockList): void {
    const settling = options.settling ? options.settling() : new Set<string>()
    if (!settling) return
    const followed = readFollowed(storage(), identityId)
    const standing = new Set(running.getSnapshot().blocked)
    let changed = false
    for (const [peerId, createdAt] of blocked) {
      if (settling.has(peerId)) continue
      const madeAt = Number.isFinite(createdAt) ? createdAt : LOCAL
      const seen = followed.get(peerId)
      if (seen === LOCAL) {
        // Followed when it was confirmed here: only its age is new.
        if (madeAt !== LOCAL) {
          followed.set(peerId, madeAt)
          changed = true
        }
        continue
      }
      // The account block already followed: a choice made in Messages since stands.
      if (seen !== undefined && (madeAt === LOCAL || madeAt <= seen)) continue
      // Not followed here yet (an unknown age counts as the newest): Messages block them,
      // unless Messages lifted their block after it was made, on another device.
      if (madeAt === LOCAL || standing.has(peerId) || savedBlockChange(running, peerId) <= madeAt) {
        applyBlock(running, peerId, true)
      }
      followed.set(peerId, madeAt)
      changed = true
    }
    const lately = running.ctx.chain.now() - BLOCK_SETTLING_MS
    for (const peerId of [...followed.keys()]) {
      if (blocked.has(peerId) || settling.has(peerId) || savedBlockChange(running, peerId) > lately) continue
      applyBlock(running, peerId, false)
      followed.delete(peerId)
      changed = true
    }
    if (changed) writeFollowed(storage(), identityId, followed)
  }

  /** `setBlocked`: now when the saved state has loaded, else kept for when it has; stamped no earlier than `notBefore`. */
  function blockInMessages(identityId: string, peerId: string, blocked: boolean, notBefore = 0): boolean {
    const running = engineOf(identityId)
    if (running?.getSnapshot().ready) return applyBlock(running, peerId, blocked, notBefore)
    const pending = { ...readPendingBlocks(storage(), identityId), [peerId]: { blocked, changedAt: Math.max(Date.now(), notBefore) } }
    storage().setItem(blocksKey(identityId), JSON.stringify(pending))
    return true
  }

  /** The engine holding conversation `key` (a closed draft is held but not in the snapshot). */
  function holding(identityId: string, key: string): DmEngine {
    const running = engine(identityId)
    if (running.ctx.convs.has(key)) return running
    if (!running.getSnapshot().ready) throw new RpcError('Messages are still loading', 'ENGINE_BUSY')
    throw new RpcError('Conversation not found', 'BAD_REQUEST')
  }

  return {
    kind: 'v5' as const,
    engine,

    activate(identityId: string): void {
      engineOf(identityId)
    },

    /**
     * Stop polling and drop the engine (sign-out, account switch), then wait
     * for its pending self-state save. Released first: a save that outlives
     * the caller's bound must never stop the next account's engine.
     */
    async deactivate(): Promise<void> {
      const stopping = current
      current = null
      heldBlocks = null
      tracker.reset()
      if (!stopping) return
      stopping.unsubscribe()
      stopping.engine.stop()
      options.source.release(stopping.identityId, stopping.engine)
      const saving = stopping.engine.flush()
      const { identityId } = stopping
      flushes.set(identityId, saving)
      try {
        await saving
      } finally {
        if (flushes.get(identityId) === saving) flushes.delete(identityId)
      }
    },

    /**
     * The identity signed out: remove what DM v5 keeps for it on this
     * device. A save still running for it (sign-out waits for it only so
     * long) rewrites lib's cache as it ends, so that is removed again then.
     */
    forget(identityId: string): void {
      const remove = () => {
        for (const key of dmLocalKeys(identityId)) storage().removeItem(key)
      }
      remove()
      flushes.get(identityId)?.finally(remove).catch(() => undefined)
    },

    /**
     * Background: stop polling (Android keeps the WebView's timers running,
     * and nothing but the DM flush may run there, PRD NET-08), and resolve
     * once the self-state flush lib starts on `pagehide` is done (a flush
     * queues behind it). Active: poll now, and on the cadence again.
     */
    async lifecycle(state: AppLifecycleState): Promise<void> {
      if (state !== 'inactive') backgrounded = state === 'background'
      const running = current?.engine
      if (!running) return
      if (state === 'background') {
        running.pause()
        await running.flush()
      }
      if (state === 'active') running.resume().catch(error => logger.warn('DM v5 poll failed:', error))
    },

    async status(identityId: string): Promise<DmStatusDTO> {
      const running = engineOf(identityId)
      const snapshot = running?.getSnapshot()
      const recovery = snapshot?.recovery
      return {
        backend: 'v5',
        locked: !running,
        ready: snapshot?.ready ?? false,
        ...unreadCounts(running ? rowsOf(running) : []),
        capReached: snapshot?.capReached ?? false,
        // Like web's settings dialog, never show the default in place of a setting not loaded yet.
        retention: snapshot?.ready ? snapshot.retention : null,
        blocked: snapshot?.blocked ?? [],
        recovery: recovery && recovery.phase !== 'done' ? { ...recovery, phase: recovery.phase } : null,
        error: snapshot?.error ?? null,
      }
    },

    /**
     * The inbox. Until the saved state has loaded there is no list to show:
     * `ENGINE_BUSY` while the first load runs, and its failure once it has
     * failed (retried by the next poll, or `refresh`), never an empty inbox
     * that reads as a first visit (G-2, G-11; legacy does the same).
     */
    async rows(identityId: string): Promise<ConversationRow[]> {
      const running = engine(identityId)
      const { ready, error } = running.getSnapshot()
      if (!ready && error) throw new RpcError(error, isTimeoutError(error) ? 'TIMEOUT' : 'NETWORK')
      if (!ready) throw new RpcError('Messages are still loading', 'ENGINE_BUSY')
      return rowsOf(running)
    },

    /** Poll now (pull to refresh, "Try again"): the first load too, if it failed. Its failure shows in `status`. */
    async refresh(identityId: string): Promise<void> {
      await engine(identityId).tick()
    },

    async messages(identityId: string, key: string): Promise<MessageDTO[]> {
      return holding(identityId, key).messages(key).map(toMessageDTO)
    },

    /** The thread on screen: polled now and every 4 s, own streams included, deferred history resumed. `null` closes it. */
    open(identityId: string, key: string | null): Promise<void> {
      return (key === null ? engine(identityId) : holding(identityId, key)).openConversation(key)
    },

    async markRead(identityId: string, key: string): Promise<void> {
      holding(identityId, key).markRead(key)
    },

    async hide(identityId: string, key: string): Promise<void> {
      holding(identityId, key).hide(key)
    },

    /**
     * Block or unblock in Messages: their messages and group invitations are
     * ignored. Saved at once; nothing is written when it already stands.
     * Without an encryption key on this device, or before the saved state has
     * loaded, it is kept on the device with when it was made, and applied once
     * the state loads unless a newer choice from another device is saved by
     * then. Sign-out drops it (AUTH-11): the host promises nothing about
     * Messages while they are locked here. Returns whether it changed
     * anything (kept for later counts as a change).
     */
    setBlocked(identityId: string, peerId: string, blocked: boolean): boolean {
      // Stamped after the account block followed here, whatever the DM clock says, so
      // another device that has not followed it yet reads this choice as the newer one.
      const seen = readFollowed(storage(), identityId).get(peerId)
      return blockInMessages(identityId, peerId, blocked, seen === undefined ? 0 : seen === LOCAL ? Date.now() : seen + 1)
    },

    /**
     * The account's own block list as just read, whole (never a failed or
     * partial read): Messages follow it (`followBlocks`). Applied once the
     * saved state has loaded; ignored while Messages are locked, or for
     * another account: the next engine start reads the list again.
     */
    followAccountBlocks(identityId: string, blocked: AccountBlockList): void {
      const running = current?.identityId === identityId ? current.engine : null
      if (!running) return
      if (running.getSnapshot().ready) followBlocks(identityId, running, blocked)
      else heldBlocks = { identityId, blocked }
    },

    /**
     * The account's own block on `peerId` was confirmed (`blocked`), or
     * confirmed gone: Messages block or unblock them too, now or once they
     * can (`setBlocked`), and this device remembers whether it blocked them
     * there for the account.
     */
    followAccountBlock(identityId: string, peerId: string, blocked: boolean): void {
      blockInMessages(identityId, peerId, blocked)
      const followed = readFollowed(storage(), identityId)
      if (blocked) followed.set(peerId, LOCAL)
      else followed.delete(peerId)
      writeFollowed(storage(), identityId, followed)
    },

    /** "Reclaim message fees": applied at once and saved now, kept on the device until the save lands. */
    setRetention(identityId: string, retention: RetentionSetting): void {
      const running = engine(identityId)
      running.setRetention(retention)
      const { updatedAt } = running.ctx.store.state.settings
      storage().setItem(retentionKey(identityId), JSON.stringify({ retention, updatedAt } satisfies PendingRetention))
      saveRetention(identityId, running)
    },

    /** Re-read my own messages in `key` from the chain, on the engine's queue ("check again"). */
    async readBack(identityId: string, key: string): Promise<void> {
      await holding(identityId, key).pollOwn(key)
    },

    /** Refusals known before a ticket is issued; the engine re-checks them, these give the host a code. */
    async assertSendable(identityId: string, key: string): Promise<void> {
      const running = holding(identityId, key)
      // A closed draft is in `convs` but not in the snapshot: it passes.
      const found = conversationOf(running, key)
      if (found?.blocked) throw new RpcError('Unblock this person to message them.', 'BAD_REQUEST')
      if (found?.removed) throw new RpcError('You are no longer a member of this group.', 'BAD_REQUEST')
      if (found?.ended) throw new RpcError('This group has ended.', 'BAD_REQUEST')
    },

    /**
     * `DmEngine.send` settles uncertain broadcasts itself (it reads the slot
     * back), so a resolve is `confirmed` and a reject is classified
     * (ENGINE.md §7.1). Long text goes out as several messages (§5.7). A
     * failure before the send broadcast anything (a read, the group's state,
     * a read inside `createDocument` before its broadcast) is a
     * `NotSentError`: nothing of it can land, so it is failed, not "maybe
     * sent". After any broadcast (the invite, an earlier part), it never is.
     * Its whole run, from the ticket's start, counts against
     * `SEND_BUDGET_MS`, including the settle of lib's pending replaces
     * before it (the host runs no other step before a send).
     */
    async send(identityId: string, key: string, text: string): Promise<WriteResult> {
      const running = engine(identityId)
      const current: SendAttempt = { broadcasts: 0, abandoned: false }
      const gaveUp = () => new NotSentError(new RpcError(SEND_GAVE_UP, 'NETWORK'))
      // Counts this send's own broadcasts, and refuses them once it was given up.
      const beforeBroadcast = () => {
        if (current.abandoned) throw new RpcError(SEND_GAVE_UP, 'NETWORK')
        current.broadcasts += 1
      }
      const turn = (lanes.get(running) ?? Promise.resolve()).then(async () => {
        // Given up while it waited behind an earlier send: never started.
        if (current.abandoned) throw gaveUp()
        // An SDK-signed replace (a roster or self-state save) whose answer was lost but which the
        // DM engine has since seen land stops holding writes back: lib keeps it pending for 15
        // minutes otherwise, and every DM write in between fails PENDING_WRITE. It waits for the
        // account's write lock, which a write in progress holds through its confirmation.
        await settleSupersededReplaces(identityId, YAPPR_DM_V5_CONTRACT_ID)
          .catch(error => logger.debug('DM: could not settle pending replaces:', error))
        // Given up while it waited for the lock: never sent.
        if (current.abandoned) throw gaveUp()
        try {
          try {
            await running.send(key, text, { beforeBroadcast })
          } catch (error) {
            if (!reattempts(error, current)) throw error
            logger.debug('DM send: the connection failed before anything went out; trying once more:', error)
            await pause(SEND_REATTEMPT_PAUSE_MS)
            if (current.abandoned) throw error
            await running.send(key, text, { beforeBroadcast })
          }
        } catch (error) {
          // Nothing broadcast (no invite, no message): nothing of it can land. After any broadcast,
          // a part may have gone out, so the failure is "may have been sent" and is checked.
          if (current.broadcasts === 0) throw new NotSentError(error)
          throw error
        }
      })
      // The lane stays busy until lib's call ends, even one given up: the next send never starts
      // beside it. A part that stalls after an earlier part went out is never given up (it may
      // land), so it holds this lane, and lib's queue, until lib answers; only the ticket's 60 s
      // deadline ("still sending", PENDING_DEADLINE_MS) covers that wait.
      lanes.set(running, turn.catch(() => undefined))
      await withinBudget(turn, current)
      return { state: 'confirmed' }
    },

    async startDirect(identityId: string, peerId: string): Promise<string> {
      try {
        // As web: not before the saved conversations are known (an unloaded store would start a duplicate).
        return await readyEngine(identityId).startDirect(peerId)
      } catch (error) {
        if (error instanceof NoEncryptionKeyError) throw new RpcError(error.message, 'BAD_REQUEST')
        throw error
      }
    },

    /** Resolves after the roster and grants are written; `failed` members did not get the key yet. */
    async createGroup(identityId: string, name: string, memberIds: string[]): Promise<{ key: string; failed: string[] }> {
      try {
        return await engine(identityId).createGroup(name, memberIds)
      } catch (error) {
        if (error instanceof GroupError) throw new RpcError(error.message, 'BAD_REQUEST')
        throw error
      }
    },

    async group(identityId: string, request: DmGroupAction): Promise<WriteResult> {
      const running = engine(identityId)
      switch (request.action) {
        case 'rename': await running.renameGroup(request.key, request.name); break
        case 'add': await running.addMember(request.key, request.memberId); break
        case 'remove': await running.removeMember(request.key, request.memberId); break
        case 'resendKeys': await running.resendKeys(request.key, request.memberId); break
        case 'leave': await running.leaveGroup(request.key); break
        case 'end': await running.endGroup(request.key); break
      }
      return { state: 'confirmed' }
    },

    /**
     * "Check again" for a group change: after a poll, the roster shows it
     * (renamed, member in or out, ended). Leaving and resending keys leave no
     * trace here to prove, so they stay unknown.
     */
    async probeGroup(identityId: string, request: DmGroupAction): Promise<ProbeResult> {
      const running = engine(identityId)
      await running.tick()
      const found = conversationOf(running, request.key)
      const applied = (() => {
        switch (request.action) {
          case 'rename': return found?.name === request.name
          case 'add': return found?.memberIds.includes(request.memberId) === true
          case 'remove': return found !== undefined && !found.memberIds.includes(request.memberId)
          case 'end': return found?.ended === true
          default: return false
        }
      })()
      return applied ? { state: 'applied' } : { state: 'unknown', error: new Error('The group does not show this change yet. Check again in a moment.') }
    },

    /**
     * "Check again" for a creation: after a poll, a group I own with this
     * name and these members that was not mine at submit. Returns its key.
     */
    async findCreated(identityId: string, name: string, memberIds: string[], before: string[]): Promise<string | null> {
      const running = engine(identityId)
      await running.tick()
      const known = new Set(before)
      const found = running.getSnapshot().conversations.find(view =>
        view.kind === 'group' && view.isOwner && !known.has(view.key) && view.name === name &&
        memberIds.every(id => view.memberIds.includes(id)))
      return found?.key ?? null
    },

    /** The group a management action targets: it must exist, only its owner manages members, and keys go only to members. */
    assertGroupAction(identityId: string, request: DmGroupAction): void {
      const found = conversationOf(readyEngine(identityId), request.key)
      if (found?.kind !== 'group') throw new RpcError('Group not found', 'BAD_REQUEST')
      if (found.ended || found.removed) throw new RpcError('This group is no longer active', 'BAD_REQUEST')
      const ownerOnly = request.action !== 'leave'
      if (ownerOnly !== found.isOwner) {
        throw new RpcError(found.isOwner ? 'The owner ends the group instead of leaving it' : 'Only the group owner can do this', 'BAD_REQUEST')
      }
      // Refused here, not in lib's run: there it is an unknown outcome, and the app's resend queue would keep at it.
      if (request.action === 'resendKeys' && !found.memberIds.includes(request.memberId)) {
        throw new RpcError('They are not in this group.', 'BAD_REQUEST')
      }
    },
  }
}
