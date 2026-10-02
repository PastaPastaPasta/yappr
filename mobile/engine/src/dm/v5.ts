import type { RetentionSetting } from '@/lib/dm/types'
import { NoEncryptionKeyError, type ConversationView, type DmEngine, type EngineSnapshot, type MessageView } from '@/lib/services/dm-v5'
import { GroupError } from '@/lib/services/dm-v5/groups'
import { logger } from '@/lib/logger'
import { scopedKey } from '@/lib/storage-scope'
import { RpcError } from '../protocol/envelope'
import type { AppLifecycleState } from '../shims/lifecycle'
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
  return [scopedKey(`yappr_dm_v5:${identityId}`), retentionKey(identityId)]
}

/**
 * A "Reclaim message fees" choice made here and not saved yet. lib keeps
 * blocks and read positions in its cache until they are saved, but not
 * this, so a save that fails before the app is killed would lose it (SR-23).
 */
const retentionKey = (identityId: string) => scopedKey(`yappr_engine_dm_retention:${identityId}`)

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

/** A send in progress: its broadcasts, and my messages the conversation held at the latest one. */
interface SendAttempt {
  key: string
  broadcasts: number
  heldAtBroadcast: number
}

const ownMessages = (engine: DmEngine, key: string): number => engine.messages(key).filter(m => m.own).length

function toMessageDTO(view: MessageView): MessageDTO {
  return { id: view.id, sender: view.senderId, text: view.text, at: new Date(view.createdAt), own: view.own, pending: view.pending }
}

function toRow(view: ConversationView): ConversationRow {
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
    lastMessage: last ? { text: last.text, at: new Date(last.createdAt), own: last.own } : null,
    lastActivity: view.lastActivity > 0 ? new Date(view.lastActivity) : null,
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

const rowsOf = (snapshot: EngineSnapshot): ConversationRow[] => snapshot.conversations.map(toRow)

const conversationOf = (engine: DmEngine, key: string): ConversationView | undefined =>
  engine.getSnapshot().conversations.find(view => view.key === key)

function view(engine: DmEngine): DmView {
  const snapshot = engine.getSnapshot()
  return {
    rows: rowsOf(snapshot),
    ready: snapshot.ready,
    error: snapshot.error,
    messages: key => engine.messages(key).map(toMessageDTO),
  }
}

/**
 * DM v5 behind `dm.*` (docs/DM_V5.md): one `DmEngine` per signed-in
 * identity, which runs its own loop (30 s, 4 s while a conversation is open,
 * lib's `engine.ts`) and keeps its own state. This starts it for the session,
 * maps its views to DTOs and its notifications to events, and stops it with
 * a flush when the session ends. Mirrors `components/messages/messages-v5.tsx`.
 */
export function createV5Backend(options: { source: DmEngineSource; emit: DmEmit; coalesceMs?: number; storage?: KeyValueArea }) {
  const tracker = createChangeTracker({ emit: options.emit, coalesceMs: options.coalesceMs })
  const storage = (): KeyValueArea => options.storage ?? localStorage
  let current: { identityId: string; engine: DmEngine; unsubscribe: () => void } | null = null
  /** Saves still running for engines already stopped: their end rewrites lib's cache. */
  const flushes = new Map<string, Promise<unknown>>()
  /** Sends run one at a time here, so a broadcast seen during one is its own (or, harmlessly, a group write's). */
  let sending: Promise<unknown> = Promise.resolve()
  let attempt: SendAttempt | null = null
  const watched = new WeakSet<DmEngine>()

  /**
   * Count `createMessage` broadcasts on the engine's chain for the send in
   * progress. lib sends a long text part by part inside one call and reports
   * a failure without saying whether the failing part was broadcast; this
   * tells (SR-17).
   */
  function watchBroadcasts(running: DmEngine): void {
    if (watched.has(running)) return
    watched.add(running)
    const { chain } = running.ctx
    const createMessage = chain.createMessage.bind(chain)
    chain.createMessage = (tag, body) => {
      if (attempt) {
        attempt.broadcasts += 1
        attempt.heldAtBroadcast = ownMessages(running, attempt.key)
      }
      return createMessage(tag, body)
    }
  }

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
    }
    const unsubscribe = engine.subscribe(() => {
      restoreOnceLoaded()
      tracker.changed(() => (current?.engine === engine ? view(engine) : null))
    })
    current = { identityId, engine, unsubscribe }
    restoreOnceLoaded()
    engine.start().catch(error => logger.warn('DM v5 engine failed to start:', error))
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
        ...unreadCounts(snapshot ? rowsOf(snapshot) : []),
        capReached: snapshot?.capReached ?? false,
        // Like web's settings dialog, never show the default in place of a setting not loaded yet.
        retention: snapshot?.ready ? snapshot.retention : null,
        blocked: snapshot?.blocked ?? [],
        recovery: recovery && recovery.phase !== 'done' ? { ...recovery, phase: recovery.phase } : null,
        error: snapshot?.error ?? null,
      }
    },

    async rows(identityId: string): Promise<ConversationRow[]> {
      return rowsOf(engine(identityId).getSnapshot())
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
     * failure before the failing part was broadcast (a read, the group's
     * state) is a `NotSentError`: nothing of that part can land, so it is
     * failed, not "maybe sent".
     */
    async send(identityId: string, key: string, text: string): Promise<WriteResult> {
      const running = engine(identityId)
      watchBroadcasts(running)
      const turn = sending.then(async () => {
        const current: SendAttempt = { key, broadcasts: 0, heldAtBroadcast: 0 }
        attempt = current
        try {
          await running.send(key, text)
        } catch (error) {
          // No broadcast at all, or the part last broadcast is held (it landed) and the next failed before its own.
          if (current.broadcasts === 0 || ownMessages(running, key) > current.heldAtBroadcast) throw new NotSentError(error)
          throw error
        } finally {
          if (attempt === current) attempt = null
        }
      })
      sending = turn.catch(() => undefined)
      await turn
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

    /** The group a management action targets: it must exist, and only its owner manages members. */
    assertGroupAction(identityId: string, request: DmGroupAction): void {
      const found = conversationOf(readyEngine(identityId), request.key)
      if (found?.kind !== 'group') throw new RpcError('Group not found', 'BAD_REQUEST')
      if (found.ended || found.removed) throw new RpcError('This group is no longer active', 'BAD_REQUEST')
      const ownerOnly = request.action !== 'leave'
      if (ownerOnly !== found.isOwner) {
        throw new RpcError(found.isOwner ? 'The owner ends the group instead of leaving it' : 'Only the group owner can do this', 'BAD_REQUEST')
      }
    },
  }
}
