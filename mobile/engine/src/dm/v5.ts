import { NoEncryptionKeyError, type ConversationView, type DmEngine, type EngineSnapshot, type MessageView } from '@/lib/services/dm-v5'
import { GroupError } from '@/lib/services/dm-v5/groups'
import { logger } from '@/lib/logger'
import { RpcError } from '../protocol/envelope'
import type { AppLifecycleState } from '../shims/lifecycle'
import type { WriteResult } from '../writes/tickets'
import { createChangeTracker, unreadCounts, type ConversationRow, type DmEmit, type DmView } from './changes'
import type { DmGroupAction, DmStatusDTO, MessageDTO } from './types'

/** Where the v5 engine comes from: lib's per-identity registry in the app, an in-memory chain in tests. */
export interface DmEngineSource {
  /** The running engine for the identity (created on first use), or null without an encryption key on this device. */
  engineFor(identityId: string): DmEngine | null
  /** Forget the engine (lib's `stopDmEngine`). */
  release(): void
}

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
export function createV5Backend(options: { source: DmEngineSource; emit: DmEmit; coalesceMs?: number }) {
  const tracker = createChangeTracker({ emit: options.emit, coalesceMs: options.coalesceMs })
  let current: { identityId: string; engine: DmEngine; unsubscribe: () => void } | null = null

  /** The engine for `identityId`, started on first use; null while the device has no encryption key for it. */
  function engineOf(identityId: string): DmEngine | null {
    const engine = options.source.engineFor(identityId)
    if (current && (current.identityId !== identityId || current.engine !== engine)) {
      // lib replaced it (a different key), or the identity changed without a session event.
      current.unsubscribe()
      current = null
    }
    if (!engine || current) return engine
    tracker.reset()
    const unsubscribe = engine.subscribe(() => tracker.changed(() => (current?.engine === engine ? view(engine) : null)))
    current = { identityId, engine, unsubscribe }
    engine.start().catch(error => logger.warn('DM v5 engine failed to start:', error))
    return engine
  }

  function engine(identityId: string): DmEngine {
    const found = engineOf(identityId)
    if (!found) throw new RpcError('Messages are locked: this device has no encryption key for the account (dm.unlock)', 'NO_KEY')
    return found
  }

  return {
    kind: 'v5' as const,
    engine,

    activate(identityId: string): void {
      engineOf(identityId)
    },

    /** Stop polling, save pending self-state edits (sign-out, account switch), then drop the engine. */
    async deactivate(): Promise<void> {
      const stopping = current
      current = null
      tracker.reset()
      if (!stopping) return
      stopping.unsubscribe()
      stopping.engine.stop()
      await stopping.engine.flush()
      options.source.release()
    },

    /**
     * Background: resolve once the self-state flush lib starts on `pagehide`
     * is done (a flush queues behind it). Active: poll now, not at the next tick.
     */
    async lifecycle(state: AppLifecycleState): Promise<void> {
      const running = current?.engine
      if (!running) return
      if (state === 'background') await running.flush()
      if (state === 'active') running.tick().catch(error => logger.warn('DM v5 poll failed:', error))
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
      return engine(identityId).messages(key).map(toMessageDTO)
    },

    /** The thread on screen: polled now and every 4 s, own streams included, deferred history resumed. `null` closes it. */
    open(identityId: string, key: string | null): Promise<void> {
      return engine(identityId).openConversation(key)
    },

    async markRead(identityId: string, key: string): Promise<void> {
      engine(identityId).markRead(key)
    },

    /** Refusals known before a ticket is issued; the engine re-checks them, these give the host a code. */
    assertSendable(identityId: string, key: string): void {
      const running = engine(identityId)
      if (!running.ctx.convs.has(key)) throw new RpcError('Conversation not found', 'BAD_REQUEST')
      // A closed draft is in `convs` but not in the snapshot: it passes.
      const found = conversationOf(running, key)
      if (found?.blocked) throw new RpcError('Unblock this person to message them.', 'BAD_REQUEST')
      if (found?.removed) throw new RpcError('You are no longer a member of this group.', 'BAD_REQUEST')
      if (found?.ended) throw new RpcError('This group has ended.', 'BAD_REQUEST')
    },

    /**
     * `DmEngine.send` settles uncertain broadcasts itself (it reads the slot
     * back), so a resolve is `confirmed` and a reject is classified
     * (ENGINE.md §7.1). Long text goes out as several messages (§5.7).
     */
    async send(identityId: string, key: string, text: string): Promise<WriteResult> {
      await engine(identityId).send(key, text)
      return { state: 'confirmed' }
    },

    async startDirect(identityId: string, peerId: string): Promise<string> {
      try {
        return await engine(identityId).startDirect(peerId)
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

    /** The group a management action targets: it must exist, and only its owner manages members. */
    assertGroupAction(identityId: string, request: DmGroupAction): void {
      const found = conversationOf(engine(identityId), request.key)
      if (found?.kind !== 'group') throw new RpcError('Group not found', 'BAD_REQUEST')
      if (found.ended || found.removed) throw new RpcError('This group is no longer active', 'BAD_REQUEST')
      const ownerOnly = request.action !== 'leave'
      if (ownerOnly !== found.isOwner) {
        throw new RpcError(found.isOwner ? 'The owner ends the group instead of leaving it' : 'Only the group owner can do this', 'BAD_REQUEST')
      }
    },
  }
}
