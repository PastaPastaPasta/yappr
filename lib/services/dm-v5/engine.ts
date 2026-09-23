/**
 * The DM v5 engine: one per signed-in identity. It owns the runtime context,
 * runs the §6.3 loop on its cadence (every 30 s, every few seconds while a
 * thread is open, once on open), serialises every chain operation, and
 * exposes plain, base58-keyed views for the UI.
 *
 * It never touches the SDK directly: it is handed a `DmChain`.
 */

import bs58 from 'bs58'
import type { IdentityId, RetentionSetting } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import {
  isMember,
  members,
  newestText,
  timeline,
  unreadCount,
  type Conv,
  type GroupConv,
  type HeldMessage,
} from './conversation'
import { attachSaved, createContext, isMe, type DmContext } from './context'
import { ensureStarted, openDirect } from './directs'
import { applyGroups } from './group-apply'
import { addMember, createGroup, endGroup, leaveGroup, removeMember, renameGroup, resendKeys } from './groups'
import { LocalCache } from './local-cache'
import { pollOnce } from './loop'
import { pollStreams, runDeferred } from './poller'
import { recoverLostState, type RecoveryProgress } from './recovery'
import type { Scheduler } from './self-state-store'
import { sendContent } from './sender'
import { SWEEP_INTERVAL_MS, sweep } from './sweep'
import type { DmChain, KeyValueStore } from './types'
import { pointerKey, splitText, type Exclusive } from './util'

export const BACKGROUND_POLL_MS = 30_000
export const OPEN_POLL_MS = 4_000

// ---------------------------------------------------------------------------
// Views

export interface MessageView {
  /** Stable per message: sender, epoch, week and index. */
  id: string
  senderId: string
  text: string
  createdAt: number
  own: boolean
  pending: boolean
}

export interface ConversationView {
  /** `d:<hex peer>` or `g:<hex owner>:<hex gid>`: stable across reloads. */
  key: string
  kind: 'direct' | 'group'
  /** Peer id for a 1:1; owner id for a group. */
  peerId: string
  name: string
  memberIds: string[]
  isOwner: boolean
  lastMessage: MessageView | null
  lastActivity: number
  unread: number
  hidden: boolean
  /** Newly found conversation that could not be saved (the self-state cap). */
  unsaved: boolean
  /** Groups: I cannot read it (ask the owner to resend keys), I was removed, or it ended. */
  unreadable: boolean
  removed: boolean
  ended: boolean
  blocked: boolean
  /** Opened in the UI but nothing sent yet. */
  draft: boolean
}

export interface EngineSnapshot {
  ready: boolean
  conversations: ConversationView[]
  unreadTotal: number
  capReached: boolean
  retention: RetentionSetting
  blocked: string[]
  recovery: RecoveryProgress | null
  error: string | null
  /** The one-time §10 notice about earlier (v3/v4) conversations was dismissed on this device. */
  migrationNoticeSeen: boolean
}

// ---------------------------------------------------------------------------

export interface EngineOptions {
  chain: DmChain
  identityId: IdentityId
  encPriv: Uint8Array
  kv: KeyValueStore
  /** Storage key for the per-device cache. */
  cacheKey: string
  scheduler?: Scheduler
}

export class DmEngine {
  readonly ctx: DmContext
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private started = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private openKey: string | null = null
  private recovery: RecoveryProgress | null = null
  private error: string | null = null
  private snapshot: EngineSnapshot | null = null
  private sweeping = false

  constructor(options: EngineOptions) {
    this.ctx = createContext({
      chain: options.chain,
      identityId: options.identityId,
      encPriv: options.encPriv,
      cache: new LocalCache(options.kv, options.cacheKey),
      scheduler: options.scheduler,
      changed: () => this.emit(),
    })
    const { store } = this.ctx
    store.onMerged = () => {
      this.run(() => attachSaved(this.ctx)).catch((error) => logger.warn('DM v5: resync after merge failed:', error))
    }
    // Coalesced saves go through the queue too, so they never race a send for the identity nonce.
    store.runSave = this.exclusive
  }

  // -------------------------------------------------------------------------
  // Subscription (useSyncExternalStore-compatible)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): EngineSnapshot => {
    if (!this.snapshot) this.snapshot = this.buildSnapshot()
    return this.snapshot
  }

  private emit(): void {
    this.snapshot = null
    this.ctx.cache.persist()
    this.listeners.forEach((listener) => listener())
  }

  /** Serialise every chain operation: the loop and user actions share streams and self-state. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result.finally(() => this.emit())
  }

  private readonly exclusive: Exclusive = (task) => this.run(task)

  // -------------------------------------------------------------------------
  // Lifecycle

  /**
   * Load the self-state and start polling. A failed load (a DAPI timeout) is
   * reported and retried by the next poll rather than stopping the engine.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.tick()
  }

  /** The first successful load: the saved conversations, and recovery when the state is lost (§9). */
  private async ensureLoaded(): Promise<void> {
    const { store } = this.ctx
    if (store.status !== 'idle') return
    const status = await store.load()
    this.ctx.scanCursor = store.state.inviteScanCursor
    await attachSaved(this.ctx)
    if (status !== 'loaded' && (await this.ctx.chain.hasWritten().catch(() => false))) {
      // The user has written DM v5 documents but has no readable self-state: rebuild (§9).
      this.startRecovery()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ctx.store.cancelTimer()
  }

  /** Save pending self-state edits now (page hidden or closed, §5.5), on the queue. */
  flush(): Promise<boolean> {
    return this.run(() => this.ctx.store.flush()).catch((error) => {
      logger.warn('DM v5 self-state flush failed:', error)
      return false
    })
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.tick().catch((error) => logger.warn('DM v5 poll failed:', error))
    }, this.openKey ? OPEN_POLL_MS : BACKGROUND_POLL_MS)
  }

  /** One poll now, then reschedule. */
  async tick(): Promise<void> {
    try {
      await this.run(async () => {
        await this.ensureLoaded()
        await pollOnce(this.ctx)
      })
      this.error = null
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Could not load messages'
      logger.warn('DM v5 poll failed:', error)
    } finally {
      this.emit()
      this.schedule()
      this.maybeSweep()
    }
  }

  /** At most once a day: plan on the queue, then delete one message per queued task (each is a write). */
  private maybeSweep(): void {
    const { ctx } = this
    if (this.sweeping || this.stopped || this.recovery || ctx.store.status === 'idle' || !ctx.chain.canWrite()) return
    if (ctx.store.state.settings.retention === 'never') return
    if (ctx.chain.now() - ctx.cache.lastSweep < SWEEP_INTERVAL_MS) return
    this.sweeping = true
    sweep(ctx, this.exclusive, () => this.stopped)
      .then((deleted) => {
        if (deleted > 0) logger.info(`DM v5 sweep reclaimed ${deleted} message(s)`)
      })
      .catch((error) => logger.warn('DM v5 sweep failed:', error))
      .finally(() => {
        this.sweeping = false
        this.emit()
      })
  }

  private startRecovery(): void {
    if (this.recovery) return
    this.recovery = { phase: 'invites', done: 0, total: 0, found: 0 }
    recoverLostState(
      this.ctx,
      this.exclusive,
      (progress) => {
        this.recovery = progress.phase === 'done' ? null : progress
        this.emit()
      },
      () => this.stopped
    ).catch((error) => logger.warn('DM v5 recovery failed:', error))
  }

  // -------------------------------------------------------------------------
  // Views

  private convByKey(key: string): Conv {
    const conv = this.ctx.convs.get(key)
    if (!conv) throw new Error('Conversation not found')
    return conv
  }

  private isBlockedId = (id: IdentityId): boolean => this.ctx.store.isBlocked(id)

  private messageView(held: HeldMessage): MessageView | null {
    if (held.content.type !== 'text') return null
    return {
      id: pointerKey(held.sender, held.pointer),
      senderId: bs58.encode(held.sender),
      text: held.content.text,
      createdAt: held.createdAt,
      own: isMe(this.ctx, held.sender),
      pending: held.local === true,
    }
  }

  private conversationView(conv: Conv): ConversationView | null {
    const { ctx } = this
    const visible = (held: { sender: IdentityId }) => !this.isBlockedId(held.sender)
    const last = newestText(conv, visible)
    const lastActivity = last?.createdAt ?? conv.entry.readAt
    const blocked = conv.kind === 'direct' && this.isBlockedId(conv.peer)
    const hidden = conv.entry.hiddenAt > 0 && (!last || last.createdAt <= conv.entry.hiddenAt)
    if (conv.kind === 'direct') {
      if (conv.draft && this.openKey !== conv.key) return null
      // A 1:1 that holds only grants stays out of the inbox (the group shows instead) until its first text (§6.2).
      const onlyGrants = !last && !ctx.cache.hasText(conv.key) && Array.from(conv.held.values()).some((m) => m.content.type === 'grant')
      if (onlyGrants) return null
    } else if (ctx.cache.hasLeft(conv.key) && (conv.removed || !isMember(conv, ctx.me.id, ctx.me.id))) {
      return null
    }
    const memberIds = members(conv, ctx.me.id).map((id) => bs58.encode(id))
    return {
      key: conv.key,
      kind: conv.kind,
      peerId: bs58.encode(conv.kind === 'direct' ? conv.peer : conv.owner),
      name: conv.kind === 'group' ? conv.lastRoster?.name ?? '' : '',
      memberIds,
      isOwner: conv.kind === 'group' && isMe(ctx, conv.owner),
      lastMessage: last ? this.messageView(last) : null,
      lastActivity: lastActivity || 0,
      unread: blocked ? 0 : unreadCount(conv, ctx.me.id, this.isBlockedId),
      hidden,
      unsaved: conv.kind === 'direct' ? !conv.draft && !ctx.store.isSaved(conv.entry) : !ctx.store.isSaved(conv.entry),
      unreadable: conv.kind === 'group' && conv.unreadable,
      removed: conv.kind === 'group' && conv.removed,
      ended: conv.kind === 'group' && conv.ended,
      blocked,
      draft: conv.kind === 'direct' && conv.draft,
    }
  }

  private buildSnapshot(): EngineSnapshot {
    const conversations = Array.from(this.ctx.convs.values())
      .map((conv) => this.conversationView(conv))
      .filter((view): view is ConversationView => view !== null)
      .sort((a, b) => b.lastActivity - a.lastActivity)
    return {
      ready: this.ctx.store.status !== 'idle',
      conversations,
      unreadTotal: conversations.filter((c) => !c.hidden).reduce((total, c) => total + c.unread, 0),
      capReached: this.ctx.store.capReached,
      retention: this.ctx.store.state.settings.retention,
      blocked: this.ctx.store.blockedIds().map((id) => bs58.encode(id)),
      recovery: this.recovery,
      error: this.error,
      migrationNoticeSeen: this.ctx.cache.migrationNoticeSeen,
    }
  }

  messages(key: string): MessageView[] {
    const conv = this.ctx.convs.get(key)
    if (!conv) return []
    return timeline(conv)
      .filter((held) => !this.isBlockedId(held.sender) || isMe(this.ctx, held.sender))
      .map((held) => this.messageView(held))
      .filter((view): view is MessageView => view !== null)
  }

  // -------------------------------------------------------------------------
  // Actions

  /** Open a thread: poll it now and every few seconds, own streams included; resume deferred history. */
  async openConversation(key: string | null): Promise<void> {
    const previous = this.openKey ? this.ctx.convs.get(this.openKey) : null
    if (previous) previous.open = false
    this.openKey = key
    const conv = key ? this.ctx.convs.get(key) : null
    if (!conv) {
      this.schedule()
      this.emit()
      return
    }
    conv.open = true
    conv.deepProbe = true
    await this.run(async () => {
      if (conv.kind === 'group') await applyGroups(this.ctx, [conv])
      await pollStreams(this.ctx, conv)
      await runDeferred(this.ctx, conv)
    })
    this.schedule()
  }

  /** Mark everything up to the newest message read (§5.5: coalesced into the next self-state save). */
  markRead(key: string): void {
    const conv = this.ctx.convs.get(key)
    if (!conv) return
    const newest = timeline(conv).at(-1)
    if (newest) this.ctx.store.touch(conv.entry, { readAt: newest.createdAt })
    this.emit()
  }

  /** Open (without writing anything) a 1:1 with `peerId`. Returns its key. */
  async startDirect(peerId: string): Promise<string> {
    const peer = bs58.decode(peerId)
    const conv = await this.run(() => openDirect(this.ctx, peer))
    return conv.key
  }

  /** Send text, split into messages of at most one size class (§5.7). */
  async send(key: string, text: string): Promise<void> {
    const conv = this.convByKey(key)
    const pieces = splitText(text.trim())
    if (pieces.length === 0) return
    await this.run(async () => {
      if (conv.kind === 'direct') {
        if (this.ctx.store.isBlocked(conv.peer)) throw new Error('Unblock this person to message them.')
        await ensureStarted(this.ctx, conv)
      }
      for (const text of pieces) await sendContent(this.ctx, conv, { type: 'text', text })
    })
  }

  /** "Delete conversation": hide it until a newer message arrives (§5.5). */
  hide(key: string): void {
    const conv = this.convByKey(key)
    const newest = timeline(conv).at(-1)
    // Hidden up to the newest message held: anything newer, even one already on its way, un-hides it.
    const at = newest?.createdAt ?? this.ctx.chain.now()
    this.ctx.store.touch(conv.entry, { hiddenAt: at, readAt: newest?.createdAt ?? 0 })
    this.emit()
  }

  setBlocked(peerId: string, blocked: boolean): void {
    this.ctx.store.setBlocked(bs58.decode(peerId), blocked, this.ctx.chain.now())
    this.emit()
  }

  setRetention(retention: RetentionSetting): void {
    this.ctx.store.setRetention(retention, this.ctx.chain.now())
    this.emit()
    this.flush().catch((error) => logger.warn('DM v5: saving retention failed:', error))
  }

  async createGroup(name: string, memberIds: string[]): Promise<{ key: string; failed: string[] }> {
    const created = await this.run(() => createGroup(this.ctx, name, memberIds.map((id) => bs58.decode(id))))
    return { key: created.conv.key, failed: created.failed.map((id) => bs58.encode(id)) }
  }

  private group(key: string): GroupConv {
    const conv = this.convByKey(key)
    if (conv.kind !== 'group') throw new Error('Not a group')
    return conv
  }

  addMember(key: string, memberId: string): Promise<void> {
    return this.run(() => addMember(this.ctx, this.group(key), bs58.decode(memberId)))
  }

  removeMember(key: string, memberId: string): Promise<void> {
    return this.run(() => removeMember(this.ctx, this.group(key), bs58.decode(memberId)))
  }

  renameGroup(key: string, name: string): Promise<void> {
    return this.run(() => renameGroup(this.ctx, this.group(key), name))
  }

  endGroup(key: string): Promise<void> {
    return this.run(() => endGroup(this.ctx, this.group(key)))
  }

  resendKeys(key: string, memberId: string): Promise<void> {
    return this.run(() => resendKeys(this.ctx, this.group(key), bs58.decode(memberId)))
  }

  async leaveGroup(key: string): Promise<void> {
    const conv = this.group(key)
    await this.run(() => leaveGroup(this.ctx, conv))
    this.ctx.cache.noteLeft(conv.key)
    this.ctx.store.touch(conv.entry, { hiddenAt: this.ctx.chain.now() })
  }

  dismissMigrationNotice(): void {
    this.ctx.cache.migrationNoticeSeen = true
    this.emit()
  }
}
