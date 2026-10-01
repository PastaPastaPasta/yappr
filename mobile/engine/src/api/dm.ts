import { dmIsV5, keyNetwork } from '@/lib/constants'
import { deriveEncryptionKey, validateDerivedKeyMatchesIdentity } from '@/lib/crypto/key-derivation'
import { validateEncryptionKey } from '@/lib/crypto/key-validation'
import { parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { getPrivateKey, storeEncryptionKey, storeEncryptionKeyType } from '@/lib/secure-storage'
import { getDmEngine, MAX_GROUP_MEMBERS, stopDmEngine } from '@/lib/services/dm-v5'
import { splitText } from '@/lib/services/dm-v5/util'
import { directMessageService } from '@/lib/services/direct-message-service'
import { identityService } from '@/lib/services/identity-service'
import { base58ToBytes, getCurrentUserId } from '@/lib/services/sdk-helpers'
import { TtlMap } from '@/lib/caches/ttl-map'
import { logger } from '@/lib/logger'
import { RpcError } from '../protocol/envelope'
import { badCursor, cursorInt, cursorString, decodeCursor } from '../dto/cursor'
import { loadUserSummaries, notSupported } from '../dto/hydrate'
import { nextPage } from '../dto/paging'
import { createLegacyBackend, type LegacyDmService } from '../dm/legacy'
import { createV5Backend, type DmEngineSource } from '../dm/v5'
import type { ConversationRow } from '../dm/changes'
import type { ConversationDTO, DmBackendKind, DmGroupAction, DmRetention, DmStatusDTO, MessageDTO } from '../dm/types'
import type { AppLifecycleState } from '../shims/lifecycle'
import type { SessionEvents } from './session'
import type { TicketStore } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'
import { avatarFromField, type AuthorDTO, type Page } from './dto'

export type * from '../dm/types'

/** Newest-first slices (ENGINE.md §6.3). */
const DM_PAGE_SIZE = 50
const GROUP_NAME_MAX = 100
const RETENTIONS: readonly DmRetention[] = ['30d', '90d', '1y', 'never']
/** Peer names and avatars are kept this long for the session (web's `useUserDetails` cache). */
const AUTHOR_TTL_MS = 10 * 60_000
/** How long sign-out and account switch wait for the DM state to save. */
const STOP_FLUSH_WAIT_MS = 10_000
/** A sent message's block time can trail its ticket by this much. */
const SENT_MATCH_SLACK_MS = 60_000

export interface DmModuleOptions {
  emit(event: string, payload: unknown): void
  tickets: TicketStore
  /** Resolves once the host has stored every secure write so far (an unlocked key). Absent in Node. */
  secureDurable?: () => Promise<void>
  /** Default: `v5` when the build runs DM v5 (`dmIsV5()`), else legacy 1:1. */
  backend?: DmBackendKind
  /** Default: lib's registry (`getDmEngine` / `stopDmEngine`). */
  v5Source?: DmEngineSource
  /** Default: lib's `directMessageService`. */
  legacyService?: LegacyDmService
  /** Default: lib's signed-in identity. */
  viewer?: () => string | null
  /** Names and avatars for peers. Default: `loadUserSummaries`. */
  authors?: (ids: string[]) => Promise<Map<string, AuthorDTO>>
  coalesceMs?: number
}

/** The result of `dm.unlock` (PRD DM-02). */
export type DmUnlockResult =
  | { unlocked: true; status: DmStatusDTO }
  /** `no-key-on-identity`: the identity has no encryption key at all; `not-derivable`: enter it. */
  | { unlocked: false; reason: 'no-key-on-identity' | 'not-derivable' }

const libEngines: DmEngineSource = { engineFor: getDmEngine, release: stopDmEngine }

function placeholderAuthor(id: string): AuthorDTO {
  return { id, username: null, displayName: `User ${id.slice(-6)}`, avatar: avatarFromField(undefined, id), resolved: false }
}

async function loadAuthors(ids: string[]): Promise<Map<string, AuthorDTO>> {
  const users = await loadUserSummaries(ids, { viewerFollows: false })
  return new Map([...users].map(([id, { username, displayName, avatar, resolved }]) => [id, { id, username, displayName, avatar, resolved }]))
}

function identityIdOf(value: unknown, what: string): string {
  const bytes = typeof value === 'string' ? base58ToBytes(value) : null
  if (!bytes || bytes.length !== 32) throw new RpcError(`Invalid ${what}`, 'BAD_REQUEST')
  return value as string
}

function keyOf(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new RpcError('A conversation key is required', 'BAD_REQUEST')
  return value
}

/**
 * `dm.*` (ENGINE.md §6.3): direct messages over DM v5 on the devnet build
 * and legacy 1:1 (the v3 contract) on testnet, with the same DTOs. The
 * backend runs for the signed-in session: it starts on sign-in or restore,
 * and stops with a flush on sign-out and account switch (`hooks`, wired in
 * `api/index.ts`). Sends and group changes are write tickets; their
 * arguments (message text, group names) are never persisted.
 *
 * Returns the RPC surface (`api`) and the engine-internal `hooks`, which the
 * host can never call.
 */
export function createDmModule(options: DmModuleOptions) {
  const viewer = options.viewer ?? getCurrentUserId
  const { emit } = options
  const backend = (options.backend ?? (dmIsV5() ? 'v5' : 'legacy')) === 'v5'
    ? createV5Backend({ source: options.v5Source ?? libEngines, emit, coalesceMs: options.coalesceMs })
    : createLegacyBackend({ service: options.legacyService ?? directMessageService, emit, coalesceMs: options.coalesceMs })
  const authors = new TtlMap<string, AuthorDTO>(AUTHOR_TTL_MS)
  const fetchAuthors = options.authors ?? loadAuthors

  /**
   * Set by `hooks.stop` (sign-out, account switch) until a session starts
   * again: the outgoing account's keys may still be readable for a moment,
   * and nothing may restart its messages.
   */
  let halted = false

  /** The signed-in identity, with its backend started (a no-op once it runs; retried while locked). */
  function session(): string {
    const identityId = viewer()
    if (!identityId) throw new RpcError('Messages need a signed-in account', 'NOT_SIGNED_IN')
    if (halted) throw new RpcError('Messages are stopped while the account changes', 'RESTART_REQUIRED')
    backend.activate(identityId)
    return identityId
  }

  function v5(what: string) {
    if (backend.kind !== 'v5') throw notSupported(what)
    return backend
  }

  options.tickets.register<{ identityId: string; key: string; text: string }>('dm.send', {
    run: ({ identityId, key, text }) => backend.send(identityId, key, text),
    /**
     * "Check again": the text, in all its parts, among my messages since the
     * send. Absence proves nothing (the slot may not be read back yet), and
     * after a restart the text is gone (never persisted), so only `applied`
     * is ever proved.
     */
    async probe(ticket, args) {
      if (!args) return { state: 'unknown', error: new Error('The app restarted before this was confirmed. Open the conversation to see whether it was sent.') }
      const since = ticket.createdAt.getTime() - SENT_MATCH_SLACK_MS
      const mine = new Set((await backend.messages(args.identityId, args.key)).filter(m => m.own && m.at.getTime() >= since).map(m => m.text))
      const parts = backend.kind === 'v5' ? splitText(args.text.trim()) : [args.text.trim()]
      return parts.every(part => mine.has(part))
        ? { state: 'applied' }
        : { state: 'unknown', error: new Error('Not in the conversation yet. Check again in a moment.') }
    },
    persistArgs: false,
  })
  options.tickets.register<{ identityId: string; request: DmGroupAction }>('dm.group', {
    run: ({ identityId, request }) => v5('Groups').group(identityId, request),
    persistArgs: false,
  })

  function groupNameOf(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!name || name.length > GROUP_NAME_MAX) throw new RpcError(`A group name is 1 to ${GROUP_NAME_MAX} characters`, 'BAD_REQUEST')
    return name
  }

  function groupTicket(request: DmGroupAction): WriteTicket {
    const identityId = session()
    const groups = v5('Groups')
    groups.assertGroupAction(identityId, request)
    return options.tickets.submit({ op: 'dm.group', args: { identityId, request }, target: { conversationKey: request.key } })
  }

  async function withPeers(rows: ConversationRow[]): Promise<ConversationDTO[]> {
    authors.prune()
    const missing = Array.from(new Set(rows.flatMap(row => (row.peerId && !authors.has(row.peerId) ? [row.peerId] : []))))
    if (missing.length > 0) {
      const found = await fetchAuthors(missing).catch(() => new Map<string, AuthorDTO>())
      for (const [id, author] of found) if (author.resolved) authors.set(id, author)
    }
    return rows.map(({ peerId, ...row }) => ({ ...row, peer: peerId ? authors.get(peerId) ?? placeholderAuthor(peerId) : null }))
  }

  const api = {
    /** Unread counts, readiness, the lock, and (v5) retention, the block list and recovery progress. */
    async status(): Promise<DmStatusDTO> {
      return backend.status(session())
    },

    /** The inbox, by last activity (PRD DM-01). Hidden (v5 "deleted") conversations are included, flagged. */
    async conversations(): Promise<ConversationDTO[]> {
      return withPeers(await backend.rows(session()))
    },

    /** Conversations whose name, peer name, username or id, or loaded preview, contains `query` (PRD DM-01). */
    async search(query: string): Promise<ConversationDTO[]> {
      const needle = (typeof query === 'string' ? query : '').trim().toLowerCase()
      const all = await api.conversations()
      if (!needle) return all
      return all.filter(c => [c.name, c.peer?.displayName, c.peer?.username, c.peer?.id, c.lastMessage?.text]
        .some(field => field?.toLowerCase().includes(needle)))
    },

    /**
     * A conversation's messages, newest first, 50 a page; the cursor pages
     * back in time (PRD DM-03 "older messages load when scrolling up").
     */
    async messages(key: string, cursor?: string | null): Promise<Page<MessageDTO>> {
      const conversation = keyOf(key)
      const fields = decodeCursor<{ key: string; before: string; at: number }>(cursor, 'dm')
      if (fields && fields.key !== conversation) throw badCursor('issued for another conversation')
      const all = await backend.messages(session(), conversation)
      let end = all.length
      if (fields) {
        const before = cursorString(fields.before)
        const at = cursorInt(fields.at)
        const index = all.findIndex(message => message.id === before)
        // The anchor can go (the retention sweep): fall back to its time.
        end = index >= 0 ? index : all.filter(message => message.at.getTime() < at).length
      }
      const start = Math.max(0, end - DM_PAGE_SIZE)
      const oldest = all[start]
      return nextPage(all.slice(start, end).reverse(), 'dm', start > 0 ? { key: conversation, before: oldest.id, at: oldest.at.getTime() } : null)
    },

    /** The conversation on screen (polled every 4 s on v5, 3 s on legacy), or `null` when none is. */
    async open(key: string | null): Promise<void> {
      await backend.open(session(), key === null ? null : keyOf(key))
    },

    /** Mark everything read. Legacy writes a read receipt only with "Read receipts" on (PRD DM-11). */
    async markRead(key: string): Promise<void> {
      await backend.markRead(session(), keyOf(key))
    },

    /**
     * Send `text` (v5 splits text over 4081 bytes into several messages).
     * The ticket settles through `write.status`; the message itself shows
     * through `dm.changed` (`MessageDTO.pending` until read back on v5).
     */
    async send(key: string, text: string): Promise<WriteTicket> {
      const identityId = session()
      const conversation = keyOf(key)
      if (typeof text !== 'string' || !text.trim()) throw new RpcError('The message is empty', 'BAD_REQUEST')
      backend.assertSendable(identityId, conversation)
      return options.tickets.submit({ op: 'dm.send', args: { identityId, key: conversation, text }, target: { conversationKey: conversation } })
    },

    /** Open (or find) the 1:1 with `peerId` without writing anything: the first send starts it. Returns its key. */
    async startDirect(peerId: string): Promise<string> {
      const identityId = session()
      const peer = identityIdOf(peerId, 'user ID')
      if (peer === identityId) throw new RpcError("You can't message yourself", 'BAD_REQUEST')
      return backend.startDirect(identityId, peer)
    },

    /**
     * Create a group of up to 100 members, the creator included. Resolves
     * when the roster and the grants are written; `failed` lists members who
     * did not get the key yet ("Resend keys"). Big groups take long: give the
     * call a generous timeout.
     */
    async createGroup(name: string, memberIds: string[]): Promise<{ key: string; failed: string[] }> {
      const identityId = session()
      const groups = v5('Groups')
      groups.engine(identityId) // A locked device answers NO_KEY before any argument check.
      const groupName = groupNameOf(name)
      if (!Array.isArray(memberIds)) throw new RpcError('memberIds must be a list', 'BAD_REQUEST')
      const members = Array.from(new Set(memberIds.map(id => identityIdOf(id, 'member ID')))).filter(id => id !== identityId)
      if (members.length === 0) throw new RpcError('Pick at least one member.', 'BAD_REQUEST')
      if (members.length + 1 > MAX_GROUP_MEMBERS) throw new RpcError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`, 'BAD_REQUEST')
      return groups.createGroup(identityId, groupName, members)
    },

    async renameGroup(key: string, name: string): Promise<WriteTicket> {
      return groupTicket({ action: 'rename', key: keyOf(key), name: groupNameOf(name) })
    },

    async addMember(key: string, memberId: string): Promise<WriteTicket> {
      return groupTicket({ action: 'add', key: keyOf(key), memberId: identityIdOf(memberId, 'member ID') })
    },

    async removeMember(key: string, memberId: string): Promise<WriteTicket> {
      return groupTicket({ action: 'remove', key: keyOf(key), memberId: identityIdOf(memberId, 'member ID') })
    },

    /** Owner: write this member's group keys again (when they cannot read the group). */
    async resendKeys(key: string, memberId: string): Promise<WriteTicket> {
      return groupTicket({ action: 'resendKeys', key: keyOf(key), memberId: identityIdOf(memberId, 'member ID') })
    },

    /** Member: leave. The owner removes you the next time they open the app. */
    async leaveGroup(key: string): Promise<WriteTicket> {
      return groupTicket({ action: 'leave', key: keyOf(key) })
    },

    /** Owner: end the group for everyone. */
    async endGroup(key: string): Promise<WriteTicket> {
      return groupTicket({ action: 'end', key: keyOf(key) })
    },

    /** v5 "Delete conversation": hidden until a newer message arrives (PRD DM-09). Saved at once. */
    async hide(key: string): Promise<void> {
      v5('Deleting conversations').engine(session()).hide(keyOf(key))
    },

    /** v5: block in Messages (their messages and group invitations are ignored). Saved at once. */
    async setBlocked(peerId: string, blocked: boolean): Promise<void> {
      if (typeof blocked !== 'boolean') throw new RpcError('blocked must be true or false', 'BAD_REQUEST')
      v5('Blocking in Messages').engine(session()).setBlocked(identityIdOf(peerId, 'user ID'), blocked)
    },

    /** v5 "Reclaim message fees" (PRD DM-12). */
    async setRetention(retention: DmRetention): Promise<void> {
      if (!RETENTIONS.includes(retention)) throw new RpcError(`retention is one of ${RETENTIONS.join(', ')}`, 'BAD_REQUEST')
      v5('Reclaiming message fees').engine(session()).setRetention(retention)
    },

    /**
     * Unlock messages on this device (PRD DM-02, web's encryption-key
     * modal). Without `key`: derive it from the sign-in key, which works when
     * the identity's encryption key was derived that way. With `key` (WIF or
     * 64 hex; sensitive, never logged): check it against the identity's
     * encryption key and store it (`KEY_INVALID` when it does not match).
     */
    async unlock(input: { key?: string } = {}): Promise<DmUnlockResult> {
      const identityId = session()
      if (input.key === undefined) {
        if (!(await identityService.hasEncryptionKey(identityId))) return { unlocked: false, reason: 'no-key-on-identity' }
        const authKey = getPrivateKey(identityId)
        if (!authKey) return { unlocked: false, reason: 'not-derivable' }
        const derived = deriveEncryptionKey(parsePrivateKey(authKey).privateKey, identityId)
        if (!(await validateDerivedKeyMatchesIdentity(derived, identityId))) return { unlocked: false, reason: 'not-derivable' }
        storeEncryptionKey(identityId, privateKeyToWif(derived, keyNetwork(), true))
        storeEncryptionKeyType(identityId, 'derived')
      } else {
        const key = String(input.key).trim()
        const validation = await validateEncryptionKey(key, identityId)
        if (!validation.isValid) {
          if (validation.noKeyOnIdentity) return { unlocked: false, reason: 'no-key-on-identity' }
          throw new RpcError(validation.error || 'Invalid key', 'KEY_INVALID')
        }
        storeEncryptionKey(identityId, key)
      }
      await options.secureDurable?.()
      return { unlocked: true, status: await backend.status(session()) }
    },
  }

  const hooks = {
    /** `session.changed`: a session that starts starts messages; none stops them. Balance updates change nothing. */
    sessionChanged({ session: current, reason }: SessionEvents['session.changed']): void {
      if (!current) {
        backend.deactivate().catch(error => logger.warn('Stopping messages failed:', error))
      } else if (reason !== 'balance') {
        halted = false
        backend.activate(current.identityId)
      }
    },
    /**
     * Before sign-out or an account switch: stop polling and save pending
     * state while the keys are still there. Bounded, because sign-out works
     * offline: an unsaved edit stays in the engine's local cache.
     */
    stop: (): Promise<void> => {
      halted = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_FLUSH_WAIT_MS) })
      return Promise.race([backend.deactivate().catch(error => logger.warn('Stopping messages failed:', error)), bound]).finally(() => clearTimeout(timer))
    },
    /** AppState: `background` resolves once the DM flush is done. */
    lifecycle: (state: AppLifecycleState): Promise<void> => backend.lifecycle(state),
  }

  return { api, hooks }
}
