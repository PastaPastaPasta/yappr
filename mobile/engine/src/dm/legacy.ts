import { YAPPR_DM_CONTRACT_ID } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { blockService } from '@/lib/services/block-service'
import type { directMessageService } from '@/lib/services/direct-message-service'
import { queryRawDocuments } from '@/lib/services/document-service'
import type { DocumentOrderByClause, DocumentWhereClause } from '@/lib/services/sdk-helpers'
import { useSettingsStore } from '@/lib/store'
import type { Conversation, DirectMessage } from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import type { AppLifecycleState } from '../shims/lifecycle'
import type { WriteResult } from '../writes/tickets'
import { createChangeTracker, unreadCounts, type ConversationRow, type DmEmit } from './changes'
import type { DmStatusDTO, MessageDTO } from './types'

/** The part of lib's `directMessageService` the legacy backend drives (tests pass a fake). */
export type LegacyDmService = Pick<
  typeof directMessageService,
  'getConversations' | 'getConversationMessages' | 'pollNewMessages' | 'sendMessage' | 'markAsRead' | 'getOrCreateConversation' | 'getParticipantLastRead'
>

/** Reads beside lib's DM service (tests pass fakes). */
export interface LegacyReads {
  /**
   * Whether the account has any conversation invite (sent or received),
   * throwing when the read fails: lib answers a failed list read with `[]`,
   * so a first empty list is checked with this before it is believed.
   */
  hasConversations(identityId: string): Promise<boolean>
  /** Which of `ids` the account blocks (`checkBlockedBatch`: own blocks and followed lists). */
  blocked(identityId: string, ids: string[]): Promise<Map<string, boolean>>
}

const inviteQuery = (where: DocumentWhereClause[], orderBy: DocumentOrderByClause[]) =>
  queryRawDocuments({ dataContractId: YAPPR_DM_CONTRACT_ID, documentTypeName: 'conversationInvite', where, orderBy, limit: 1 })

const libReads: LegacyReads = {
  async hasConversations(identityId) {
    // The two indexes lib's `loadConversationIndex` lists conversations from.
    const [received, sent] = await Promise.all([
      inviteQuery([['recipientId', '==', identityId]], [['$createdAt', 'desc']]),
      inviteQuery([['$ownerId', '==', identityId]], [['recipientId', 'asc']]),
    ])
    return received.length > 0 || sent.length > 0
  },
  blocked: (identityId, ids) => blockService.checkBlockedBatch(identityId, ids),
}

/** `legacy-messages.tsx`: the open conversation is polled every 3 s. */
export const LEGACY_OPEN_POLL_MS = 3_000
/** The conversation list is re-read at most this often (the host asks with its 30 s notifications poll). */
export const LEGACY_LIST_TTL_MS = 30_000
/** `getConversationMessages` reads the oldest 100; later pages follow with `pollNewMessages`. */
const MAX_CATCH_UP_PAGES = 20
/** `legacy-messages.tsx`: a polled message replaces the optimistic one with the same text sent within a minute. */
const OPTIMISTIC_MATCH_MS = 60_000

const KEY_PREFIX = 'l:'
const legacyKey = (conversationId: string) => `${KEY_PREFIX}${conversationId}`
const conversationIdOf = (key: string) => (key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null)

interface Thread {
  messages: DirectMessage[]
  /** The last document read from the chain, never a local send: polling continues after it. */
  cursor: string | undefined
}

interface LegacyState {
  identityId: string
  conversations: Map<string, Conversation>
  /** Started with `startDirect` and not written to yet. */
  drafts: Set<string>
  listedAt: number
  listing: Promise<void> | null
  threads: Map<string, Thread>
  /** Thread loads under way, shared by concurrent `open`/`messages` calls. */
  loading: Map<string, Promise<Thread>>
  /** Read here without a receipt (or before one lands): newest message time read, per conversation. */
  readUpTo: Map<string, number>
  peerRead: Map<string, number>
  /** People the account blocks (SAFE-01): their conversations take no messages and count nothing unread (DM-10). */
  blocked: Set<string>
  openId: string | null
  timer: ReturnType<typeof setTimeout> | null
  paused: boolean
  error: string | null
}

const toMessageDTO = (message: DirectMessage, identityId: string): MessageDTO => ({
  id: message.id,
  sender: message.senderId,
  text: message.content,
  at: message.createdAt,
  own: message.senderId === identityId,
  pending: false,
})

const sendReceipts = () => useSettingsStore.getState().sendReadReceipts

/**
 * Legacy 1:1 messages behind `dm.*`, for the testnet build (the v3 contract,
 * PRD DM-11): no groups, no hiding, read receipts per the settings toggle.
 * Mirrors `components/messages/legacy-messages.tsx` over the same
 * `directMessageService` calls, with the same DTOs as DM v5.
 */
export function createLegacyBackend(options: { service: LegacyDmService; emit: DmEmit; coalesceMs?: number; reads?: LegacyReads }) {
  const { service } = options
  const reads = options.reads ?? libReads
  const tracker = createChangeTracker({ emit: options.emit, coalesceMs: options.coalesceMs })
  let state: LegacyState | null = null

  /** Drop the current state (its poll timer with it) for `next`. */
  function replaceState(next: LegacyState | null): void {
    if (state?.timer) clearTimeout(state.timer)
    state = next
    tracker.reset()
  }

  function stateFor(identityId: string): LegacyState {
    if (state?.identityId === identityId) return state
    const next: LegacyState = {
      identityId, conversations: new Map(), drafts: new Set(), listedAt: 0, listing: null, threads: new Map(), loading: new Map(),
      readUpTo: new Map(), peerRead: new Map(), blocked: new Set(), openId: null, timer: null, paused: false, error: null,
    }
    replaceState(next)
    return next
  }

  function conversationOf(current: LegacyState, key: string): Conversation {
    const id = conversationIdOf(key)
    const found = id === null ? undefined : current.conversations.get(id)
    if (found) return found
    // Never listed (the first read failed): not "no such conversation", which nothing would retry.
    if (current.listedAt === 0 && current.error) throw new RpcError(current.error, 'NETWORK')
    throw new RpcError('Conversation not found', 'BAD_REQUEST')
  }

  /** `conversationOf`, reading the list first if it has not loaded yet (a key restored after an engine restart). */
  async function conversationFor(current: LegacyState, key: string): Promise<Conversation> {
    if (current.listedAt === 0) await refreshList(current)
    return conversationOf(current, key)
  }

  /** As web: without read receipts v3's counts can never clear, so there is no badge. */
  function badge(current: LegacyState): { unreadTotal: number; unreadConversations: number } {
    return sendReceipts() ? unreadCounts(rowsOf(current)) : { unreadTotal: 0, unreadConversations: 0 }
  }

  function messagesOf(current: LegacyState, conversationId: string): MessageDTO[] {
    return (current.threads.get(conversationId)?.messages ?? []).map(message => toMessageDTO(message, current.identityId))
  }

  /**
   * v3 counts unread against my read receipt. A conversation whose newest
   * message is mine has nothing unread (as v4 lib does), and one read here
   * stays read until a newer message arrives.
   */
  function unreadOf(current: LegacyState, conversation: Conversation): number {
    const last = conversation.lastMessage
    if (!last || last.senderId === current.identityId || current.blocked.has(conversation.participantId)) return 0
    return last.createdAt.getTime() <= (current.readUpTo.get(conversation.id) ?? 0) ? 0 : conversation.unreadCount
  }

  function rowsOf(current: LegacyState): ConversationRow[] {
    return [...current.conversations.values()]
      // A draft shows only while it is open, as v5's do.
      .filter(conversation => !current.drafts.has(conversation.id) || current.openId === conversation.id)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(conversation => {
        const last = conversation.lastMessage
        const peerRead = current.peerRead.get(conversation.id)
        return {
          key: legacyKey(conversation.id),
          backend: 'legacy',
          kind: 'direct',
          peerId: conversation.participantId,
          ownerId: null,
          name: null,
          members: [],
          isOwner: false,
          lastMessage: last ? { text: last.content, at: last.createdAt, own: last.senderId === current.identityId } : null,
          lastActivity: last ? last.createdAt : null,
          unread: unreadOf(current, conversation),
          flags: {
            hidden: false, unreadable: false, removed: false, ended: false,
            blocked: current.blocked.has(conversation.participantId), unsaved: false, draft: current.drafts.has(conversation.id),
          },
          peerReadAt: peerRead !== undefined && sendReceipts() ? new Date(peerRead) : null,
        }
      })
  }

  function changed(): void {
    tracker.changed(() => {
      const current = state
      if (!current) return null
      return {
        rows: rowsOf(current),
        ready: current.listedAt > 0,
        error: current.error,
        // Nothing from someone blocked is announced (DM-10).
        messages: key => {
          const id = conversationIdOf(key) ?? ''
          const peer = current.conversations.get(id)?.participantId
          return peer && current.blocked.has(peer) ? [] : messagesOf(current, id)
        },
        unread: badge(current),
      }
    })
  }

  /** Re-read the conversation list when it is older than the TTL. */
  async function refreshList(current: LegacyState): Promise<void> {
    if (current.listedAt > 0 && Date.now() - current.listedAt < LEGACY_LIST_TTL_MS) return
    current.listing ??= (async () => {
      const fresh = await service.getConversations(current.identityId, { includeParticipantInfo: false })
      if (state !== current) return
      // lib reports a failed read as an empty list: never let that wipe conversations we hold, and
      // believe a first empty list only once a read that cannot fail silently agrees.
      if (fresh.length === 0) {
        const held = [...current.conversations.keys()].some(id => !current.drafts.has(id))
        const empty = held || current.listedAt > 0 || await reads.hasConversations(current.identityId).then(any => !any, () => false)
        if (state !== current) return
        if (held || !empty) {
          current.error = 'Could not load conversations'
          return
        }
      }
      for (const conversation of fresh) {
        current.drafts.delete(conversation.id)
        const held = current.conversations.get(conversation.id)
        // lib reports a conversation whose page failed as empty ("updated now", 0 unread): keep what we hold.
        if (!conversation.lastMessage && held?.lastMessage) continue
        const known = current.threads.get(conversation.id)?.messages.at(-1)
        // A message sent or polled here may be newer than the list's page.
        const lastMessage = known && known.createdAt > (conversation.lastMessage?.createdAt ?? new Date(0)) ? known : conversation.lastMessage
        current.conversations.set(conversation.id, { ...conversation, lastMessage, updatedAt: lastMessage?.createdAt ?? conversation.updatedAt })
      }
      current.listedAt = Date.now()
      current.error = null
      await refreshBlocked(current)
    })().finally(() => {
      current.listing = null
    })
    await current.listing
    changed()
  }

  /** Who of the people the account talks to it blocks. A failed read keeps what was known. */
  async function refreshBlocked(current: LegacyState): Promise<void> {
    const peers = [...new Set([...current.conversations.values()].map(c => c.participantId))]
    if (peers.length === 0) return
    try {
      const blocked = await reads.blocked(current.identityId, peers)
      if (state === current) current.blocked = new Set(peers.filter(id => blocked.get(id) === true))
    } catch (error) {
      logger.debug('Legacy DM: could not read who is blocked:', error)
    }
  }

  /** Merge messages into a thread (by id; a polled one replaces the optimistic copy of the same send). */
  function merge(current: LegacyState, conversationId: string, incoming: DirectMessage[]): void {
    const conversation = current.conversations.get(conversationId)
    const thread = current.threads.get(conversationId)
    if (!conversation || !thread) return
    const sameSend = (a: DirectMessage, b: DirectMessage) =>
      a.senderId === b.senderId && a.content === b.content && Math.abs(a.createdAt.getTime() - b.createdAt.getTime()) < OPTIMISTIC_MATCH_MS
    for (const message of incoming) {
      if (thread.messages.some(m => m.id === message.id)) continue
      if (message.id.startsWith('temp-')) {
        // A send answered without its id, after a poll already read it back.
        if (!thread.messages.some(m => sameSend(m, message))) thread.messages.push(message)
        continue
      }
      const optimistic = thread.messages.findIndex(m => m.id.startsWith('temp-') && sameSend(m, message))
      if (optimistic >= 0) thread.messages[optimistic] = message
      else thread.messages.push(message)
    }
    thread.messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const newest = thread.messages.at(-1)
    if (newest && newest.createdAt >= (conversation.lastMessage?.createdAt ?? new Date(0))) {
      current.conversations.set(conversation.id, { ...conversation, lastMessage: newest, updatedAt: newest.createdAt })
    }
  }

  /** The whole thread: the oldest 100, then every later page (`pollNewMessages` after the last one read). */
  function loadThread(current: LegacyState, conversation: Conversation): Promise<Thread> {
    const loaded = current.threads.get(conversation.id)
    if (loaded) return Promise.resolve(loaded)
    let loading = current.loading.get(conversation.id)
    if (!loading) {
      loading = readThread(current, conversation).finally(() => current.loading.delete(conversation.id))
      current.loading.set(conversation.id, loading)
    }
    return loading
  }

  async function readThread(current: LegacyState, conversation: Conversation): Promise<Thread> {
    const first = await service.getConversationMessages(conversation.id, current.identityId, conversation.participantId)
    const thread: Thread = { messages: first, cursor: first.at(-1)?.id }
    for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
      const next = await service.pollNewMessages(conversation.id, thread.cursor, current.identityId, conversation.participantId)
      if (next.messages.length === 0 || next.cursor === thread.cursor) break
      thread.messages.push(...next.messages)
      thread.cursor = next.cursor
    }
    if (state === current) current.threads.set(conversation.id, thread)
    return thread
  }

  async function readPeerReceipt(current: LegacyState, conversation: Conversation): Promise<void> {
    if (!sendReceipts()) return
    const lastRead = await service.getParticipantLastRead(conversation.id, conversation.participantId)
    // A failed read is null: keep what was seen; a receipt never moves back.
    if (lastRead !== null) current.peerRead.set(conversation.id, Math.max(current.peerRead.get(conversation.id) ?? 0, lastRead))
  }

  /** One poll of the open conversation: new messages after the cursor, and the other side's receipt. */
  async function pollOpen(current: LegacyState): Promise<void> {
    const conversation = current.openId ? current.conversations.get(current.openId) : undefined
    const thread = conversation && current.threads.get(conversation.id)
    if (!conversation || !thread) return
    const [page] = await Promise.all([
      service.pollNewMessages(conversation.id, thread.cursor, current.identityId, conversation.participantId),
      readPeerReceipt(current, conversation),
    ])
    if (state !== current || current.openId !== conversation.id) return
    thread.cursor = page.cursor
    merge(current, conversation.id, page.messages)
    changed()
  }

  function schedule(current: LegacyState): void {
    if (current.timer) clearTimeout(current.timer)
    current.timer = null
    if (!current.openId || current.paused || state !== current) return
    current.timer = setTimeout(() => {
      current.timer = null
      pollOpen(current)
        .catch(error => logger.debug('Legacy DM poll failed:', error))
        .finally(() => schedule(current))
    }, LEGACY_OPEN_POLL_MS)
  }

  return {
    kind: 'legacy' as const,

    activate(identityId: string): void {
      stateFor(identityId)
    },

    async deactivate(): Promise<void> {
      replaceState(null)
    },

    /** Legacy keeps nothing on the device for an account. */
    forget(): void {},

    /** No polling in the background (PRD: only the DM flush runs there); the open thread resumes on return. */
    async lifecycle(lifecycle: AppLifecycleState): Promise<void> {
      if (!state || lifecycle === 'inactive') return
      state.paused = lifecycle === 'background'
      schedule(state)
    },

    async status(identityId: string): Promise<DmStatusDTO> {
      const current = stateFor(identityId)
      await refreshList(current)
      return {
        backend: 'legacy', locked: false, ready: current.listedAt > 0,
        ...badge(current),
        capReached: false, retention: null, blocked: [], recovery: null, error: current.error,
      }
    },

    async rows(identityId: string): Promise<ConversationRow[]> {
      const current = stateFor(identityId)
      await refreshList(current)
      // The list never loaded: an error with "Try again", not an empty inbox (G-11).
      if (current.listedAt === 0 && current.error) throw new RpcError(current.error, 'NETWORK')
      return rowsOf(current)
    },

    /** A block or unblock settled: re-read who is blocked, so the conversation and its badge follow. */
    blocksChanged(): void {
      const current = state
      if (!current) return
      refreshBlocked(current).then(changed, error => logger.debug('Legacy DM: block refresh failed:', error))
    },

    async messages(identityId: string, key: string): Promise<MessageDTO[]> {
      const current = stateFor(identityId)
      const conversation = await conversationFor(current, key)
      await loadThread(current, conversation)
      return messagesOf(current, conversation.id)
    },

    async open(identityId: string, key: string | null): Promise<void> {
      const current = stateFor(identityId)
      const conversation = key === null ? null : await conversationFor(current, key)
      current.openId = conversation?.id ?? null
      schedule(current)
      changed()
      if (!conversation) return
      await Promise.all([loadThread(current, conversation), readPeerReceipt(current, conversation)])
      changed()
    },

    /** Read here; a receipt is written only with "Read receipts" on, and only when something was unread (as web). */
    async markRead(identityId: string, key: string): Promise<void> {
      const current = stateFor(identityId)
      const conversation = await conversationFor(current, key)
      const unread = unreadOf(current, conversation)
      current.readUpTo.set(conversation.id, conversation.lastMessage?.createdAt.getTime() ?? Date.now())
      changed()
      if (unread > 0 && sendReceipts() && !current.drafts.has(conversation.id)) {
        await service.markAsRead(conversation.id, identityId)
      }
    },

    async assertSendable(identityId: string, key: string): Promise<void> {
      const current = stateFor(identityId)
      const conversation = await conversationFor(current, key)
      if (current.blocked.has(conversation.participantId)) throw new RpcError('Unblock this person to message them.', 'BAD_REQUEST')
    },

    /** Re-read the conversation's messages after the last one read ("check again"). */
    async readBack(identityId: string, key: string): Promise<void> {
      const current = stateFor(identityId)
      const conversation = await conversationFor(current, key)
      const thread = await loadThread(current, conversation)
      const page = await service.pollNewMessages(conversation.id, thread.cursor, identityId, conversation.participantId)
      if (state !== current) return
      thread.cursor = page.cursor
      merge(current, conversation.id, page.messages)
      changed()
    },

    async send(identityId: string, key: string, text: string): Promise<WriteResult> {
      const current = stateFor(identityId)
      const conversation = await conversationFor(current, key)
      const result = await service.sendMessage(identityId, conversation.participantId, text.trim())
      if (!result.success || !result.message) return { state: 'failed', error: new Error(result.error ?? 'Failed to send message') }
      const sent = result.message
      if (state === current) {
        current.drafts.delete(conversation.id)
        // Only into a loaded thread: a stub would hide the history (`loadThread` returns what it holds).
        merge(current, conversation.id, [sent])
        if (!current.threads.has(conversation.id)) {
          const held = current.conversations.get(conversation.id)
          if (held) current.conversations.set(conversation.id, { ...held, lastMessage: sent, updatedAt: sent.createdAt })
        }
        current.readUpTo.set(conversation.id, sent.createdAt.getTime())
        changed()
      }
      const documents = sent.id.startsWith('temp-')
        ? []
        : [{ contractId: YAPPR_DM_CONTRACT_ID, type: 'directMessage', id: sent.id, action: 'create' as const, confirmed: true }]
      return { state: 'confirmed', documents }
    },

    async startDirect(identityId: string, peerId: string): Promise<string> {
      const current = stateFor(identityId)
      await refreshList(current)
      const existing = [...current.conversations.values()].find(c => c.participantId === peerId)
      if (existing) return legacyKey(existing.id)
      const { conversationId } = await service.getOrCreateConversation(identityId, peerId)
      if (!current.conversations.has(conversationId)) {
        current.conversations.set(conversationId, { id: conversationId, participantId: peerId, unreadCount: 0, updatedAt: new Date(Date.now()), lastMessage: null })
        current.drafts.add(conversationId)
      }
      return legacyKey(conversationId)
    },
  }
}

