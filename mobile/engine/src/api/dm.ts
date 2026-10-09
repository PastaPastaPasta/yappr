import { YAPPR_DM_V5_CONTRACT_ID, dmIsV5, keyNetwork } from '@/lib/constants'
import { deriveEncryptionKey, validateDerivedKeyMatchesIdentity } from '@/lib/crypto/key-derivation'
import { validateEncryptionKey } from '@/lib/crypto/key-validation'
import { parsePrivateKey, privateKeyToWif } from '@/lib/crypto/wif'
import { getPrivateKey, storeEncryptionKey, storeEncryptionKeyType } from '@/lib/secure-storage'
import { getDmEngine, MAX_GROUP_MEMBERS, stopDmEngine } from '@/lib/services/dm-v5'
import { splitText } from '@/lib/services/dm-v5/util'
import { directMessageService } from '@/lib/services/direct-message-service'
import { settleSupersededReplaces } from '@/lib/services/identity-nonce'
import { identityService } from '@/lib/services/identity-service'
import { findEncryptionKey, hasEncryptionKeyOnIdentity } from '@/lib/crypto/encryption-key-lookup'
import { base58ToBytes, getCurrentUserId } from '@/lib/services/sdk-helpers'
import { TtlMap } from '@/lib/caches/ttl-map'
import { logger } from '@/lib/logger'
import { RpcError } from '../protocol/envelope'
import { badCursor, cursorInt, cursorString, decodeCursor } from '../dto/cursor'
import { loadUserSummaries, notSupported } from '../dto/hydrate'
import { nextPage } from '../dto/paging'
import { createLegacyBackend, type LegacyDmService, type LegacyReads } from '../dm/legacy'
import { BLOCK_SETTLING_MS, createV5Backend, SEND_GAVE_UP, type DmEngineSource } from '../dm/v5'
import type { ConversationRow } from '../dm/changes'
import type { ConversationDTO, DmBackendKind, DmGroupAction, DmRetention, DmStatusDTO, MessageDTO } from '../dm/types'
import type { AppLifecycleState } from '../shims/lifecycle'
import type { SessionEvents } from './session'
import { NotSentError, type ProbeKit, type ProbeResult, type TicketStore, type WriteResult } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'
import { avatarFromField, type AuthorDTO, type Page } from './dto'
import { onOwnBlocks, ownBlocks, type OwnBlocksListener } from './own-blocks'

export type * from '../dm/types'

/** Newest-first slices (ENGINE.md §6.3). */
const DM_PAGE_SIZE = 50
const GROUP_NAME_MAX = 100
const RETENTIONS: readonly DmRetention[] = ['30d', '90d', '1y', 'never']
/** Peer names and avatars are kept this long for the session (web's `useUserDetails` cache). */
const AUTHOR_TTL_MS = 10 * 60_000
/** How long sign-out and account switch wait for the DM state to save. */
const STOP_FLUSH_WAIT_MS = 10_000
/** ENGINE.md §9.3: the host holds a backgrounded app for the flush at most this long. */
const LIFECYCLE_FLUSH_WAIT_MS = 2_000
/** lib's group name limit (`groups.ts` MAX_NAME_BYTES). */
const GROUP_NAME_MAX_BYTES = 200
/** One send is at most this many messages (each part is a paid write; about 80 KB of text). */
const MAX_SEND_PARTS = 20
/** A sent message's block time can trail its ticket by this much. */
const SENT_MATCH_SLACK_MS = 60_000
/**
 * A `dm.send` call still before its ticket this long after it started is
 * refused: the host gives a send's text back to the composer when no ticket
 * shows 60 s after it (`UNTICKETED_WAIT_MS`), so none may appear later.
 */
const SEND_SUBMIT_DEADLINE_MS = 45_000
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
  /** Default: strict invite reads and lib's block status. */
  legacyReads?: LegacyReads
  /** The engine's plain storage, where DM v5 keeps its per-device state. Default: `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Default: lib's signed-in identity. */
  viewer?: () => string | null
  /** Names and avatars for peers. Default: `loadUserSummaries`. */
  authors?: (ids: string[]) => Promise<Map<string, AuthorDTO>>
  /**
   * The session module's identities whose stored secrets this engine never
   * hydrated (`SessionModuleOptions.unhydrated`): unlocking one never derives
   * a key over an encryption key it cannot see; the key must be entered.
   */
  unhydrated?: ReadonlySet<string>
  coalesceMs?: number
  /** The account's own block list, which DM v5 Messages follow. Default: `own-blocks.ts`. */
  accountBlocks?: AccountBlocks
}

/** Reads of the account's own block list (`own-blocks.ts`). */
export interface AccountBlocks {
  /** Read the list whole now; a read that succeeds reaches every `subscribe` listener. Rejects when it fails. */
  refresh(identityId: string): Promise<unknown>
  subscribe(listener: OwnBlocksListener): () => void
}

const libBlocks: AccountBlocks = { refresh: ownBlocks, subscribe: onOwnBlocks }

/** The result of `dm.unlock` (PRD DM-02). */
export type DmUnlockResult =
  | { unlocked: true; status: DmStatusDTO }
  /** `no-key-on-identity`: the identity has no encryption key at all; `not-derivable`: enter it. */
  | { unlocked: false; reason: 'no-key-on-identity' | 'not-derivable' }

const libEngines: DmEngineSource = { engineFor: getDmEngine, release: (_identityId, engine) => stopDmEngine(engine) }

interface SendArgs {
  identityId: string
  key: string
  text: string
  /** My messages in the conversation when it was sent (ids). */
  before: string[]
}

/** A group's creation: its key and the members who did not get the key yet ("Resend keys"). */
export interface DmCreatedGroup {
  key: string
  failed: string[]
}

type GroupCreate = { action: 'create'; name: string; memberIds: string[]; /** Groups I held at submit. */ before: string[] }

interface GroupArgs {
  identityId: string
  request: DmGroupAction | GroupCreate
}

/** `work`, but resolving after `ms` at the latest; its failure is logged, never thrown. */
function bounded(work: Promise<unknown>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })
  const done = work.then(() => undefined, error => logger.warn(`${what} failed:`, error))
  return Promise.race([done, limit]).finally(() => clearTimeout(timer))
}

function placeholderAuthor(id: string): AuthorDTO {
  return { id, username: null, displayName: `User ${id.slice(-6)}`, avatar: avatarFromField(undefined, id), resolved: false }
}

async function loadAuthors(ids: string[]): Promise<Map<string, AuthorDTO>> {
  const users = await loadUserSummaries(ids, { viewerFollows: false })
  return new Map([...users].map(([id, { username, displayName, avatar, resolved }]) => [id, { id, username, displayName, avatar, resolved }]))
}

/** The account a block or unblock ticket names. */
function blockTarget(ticket: WriteTicket): string | null {
  const id = (ticket.target as { identityId?: unknown } | null)?.identityId
  return typeof id === 'string' ? id : null
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
  const { emit, tickets } = options
  const accountBlocks = options.accountBlocks ?? libBlocks
  /**
   * Set by `hooks.stop` (sign-out, account switch) until a session starts
   * again: the outgoing account's keys may still be readable for a moment,
   * and nothing may restart its messages.
   */
  let halted = false
  const backend = (options.backend ?? (dmIsV5() ? 'v5' : 'legacy')) === 'v5'
    ? createV5Backend({
      source: options.v5Source ?? libEngines,
      emit,
      coalesceMs: options.coalesceMs,
      storage: options.storage,
      // Once per engine start (sign-in, restore, unlock): Messages catch up with blocks confirmed while the app was closed.
      onStarted: identityId => {
        accountBlocks.refresh(identityId)
          .catch(error => logger.warn('DM v5: reading the account\'s blocks failed; Messages keep theirs for now:', error))
      },
      settling: blocksSettling,
    })
    : createLegacyBackend({ service: options.legacyService ?? directMessageService, emit, coalesceMs: options.coalesceMs, reads: options.legacyReads })

  /**
   * People with a block or unblock from this device that may still land, or settled lately (one a check proved
   * never landed counts as settled when proved); null when unreadable.
   */
  function blocksSettling(): Set<string> | null {
    const lately = Date.now() - BLOCK_SETTLING_MS
    try {
      return new Set(tickets.list().flatMap(ticket => {
        if (ticket.op !== 'block' && ticket.op !== 'unblock') return []
        const open = ticket.state === 'pending' || (ticket.state === 'unconfirmed' && !ticket.retryable)
        if (!open && ticket.updatedAt.getTime() < lately) return []
        const target = blockTarget(ticket)
        return target ? [target] : []
      }))
    } catch (error) {
      logger.warn('DM v5: reading block writes failed:', error)
      return null
    }
  }

  // Messages follow the account's blocks (DM-10). Legacy: a settled block or unblock re-reads them.
  // DM v5: a confirmed block or unblock (or an unblock that deleted the own block but leaves a followed
  // list blocking, STILL_BLOCKED) reaches Messages, also when a check confirms it after a relaunch.
  tickets.observe(ticket => {
    if ((ticket.op !== 'block' && ticket.op !== 'unblock') || ticket.state === 'pending') return
    if (backend.kind === 'legacy') {
      backend.blocksChanged()
      return
    }
    const peerId = blockTarget(ticket)
    const identityId = viewer()
    if (!peerId || halted || !identityId || ticket.identityId !== identityId) return
    if (ticket.state === 'confirmed') {
      const made = ticket.documents.find(document => document.type === 'block' && document.action === 'create')
      backend.followAccountBlock(identityId, peerId, ticket.op === 'block', made?.id)
    }
    else if (ticket.op === 'unblock' && ticket.state === 'failed' && ticket.error?.code === 'STILL_BLOCKED') {
      backend.followAccountBlock(identityId, peerId, false)
    }
  })
  // Every whole read of the account's block list (this start's, the Blocked screen's) keeps Messages in step.
  // Never unsubscribed: the dm module lives as long as the engine, and checks the backend and viewer on each read.
  accountBlocks.subscribe((identityId, blocks) => {
    if (backend.kind !== 'v5' || halted || identityId !== viewer()) return
    backend.followAccountBlocks(identityId, new Map(blocks.map(({ blockedId, id, createdAt }) => [blockedId, { id, createdAt }])))
  })
  const authors = new TtlMap<string, AuthorDTO>(AUTHOR_TTL_MS)
  const fetchAuthors = options.authors ?? loadAuthors

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

  /**
   * My message ids each `dm.send` ticket accounts for (created by its run, or
   * proved by its check), so one ticket's message never proves another's.
   */
  const claimed = new Map<string, string>()
  const claimKey = (conversation: string, messageId: string) => `${conversation}\u0000${messageId}`
  const partsOf = (text: string) => (backend.kind === 'v5' ? splitText(text.trim()) : [text.trim()])

  /** My messages in `key` that are not in `before` and not another ticket's, oldest first. */
  async function freshOwn(args: SendArgs, ticketId: string, since: number): Promise<MessageDTO[]> {
    const before = new Set(args.before)
    return (await backend.messages(args.identityId, args.key)).filter(m => {
      const owner = claimed.get(claimKey(args.key, m.id))
      return m.own && !before.has(m.id) && (owner === undefined || owner === ticketId) && m.at.getTime() >= since
    })
  }

  /**
   * A long v5 send that failed part way: the messages its ticket makes (the
   * parts, re-split past the ones already out, since lib trims what it
   * sends) and how many are out, so a retry sends only the rest (SR-18).
   */
  const partial = new Map<string, { identityId: string; parts: string[]; sent: number }>()
  const partsFor = (args: SendArgs, ticketId: string) => partial.get(ticketId)?.parts ?? partsOf(args.text)

  /**
   * After a v5 send failed: claim and record the parts that went out before
   * it did. True when every part is out (lib failed after the last one was
   * held), so the send is delivered and a retry would send it again.
   */
  async function notePartlySent(args: SendArgs, ticketId: string): Promise<boolean> {
    if (backend.kind !== 'v5' || halted) return false
    const parts = partsFor(args, ticketId)
    const pool = await freshOwn(args, ticketId, 0)
    let sent = 0
    for (const part of parts) {
      const index = pool.findIndex(m => m.text === part)
      if (index < 0) break
      claimed.set(claimKey(args.key, pool.splice(index, 1)[0].id), ticketId)
      sent += 1
    }
    if (sent === parts.length) return true
    if (sent > 0) partial.set(ticketId, { identityId: args.identityId, parts: [...parts.slice(0, sent), ...partsOf(parts.slice(sent).join(''))], sent })
    return false
  }

  /** Claim, for `ticketId`, one fresh message per part; false when a part has none. */
  function claimParts(args: SendArgs, ticketId: string, fresh: MessageDTO[]): boolean {
    const pool = [...fresh]
    const taken: MessageDTO[] = []
    for (const part of partsFor(args, ticketId)) {
      const index = pool.findIndex(m => m.text === part)
      if (index < 0) return false
      taken.push(...pool.splice(index, 1))
    }
    for (const m of taken) claimed.set(claimKey(args.key, m.id), ticketId)
    return true
  }

  /**
   * Ticket runs refuse while stopped (a retry must never send on an outgoing
   * account), and ask for a missing key. Before a v5 write, an SDK-signed
   * replace (a roster or self-state save) whose answer was lost but which the
   * DM engine has since seen land stops holding writes back: lib keeps it
   * pending for 15 minutes otherwise, and every DM write in between fails
   * PENDING_WRITE (`settleSupersededReplaces`). A send settles them itself
   * (`settle: false`), inside its own time budget: the settle waits for the
   * account's write lock, which a stalled write holds.
   */
  async function running<T>(identityId: string, work: () => Promise<T>, { settle = true }: { settle?: boolean } = {}): Promise<T> {
    if (halted) throw new NotSentError(new RpcError('Messages are stopped while the account changes', 'RESTART_REQUIRED'))
    if (settle && backend.kind === 'v5') {
      await settleSupersededReplaces(identityId, YAPPR_DM_V5_CONTRACT_ID)
        .catch(error => logger.debug('DM: could not settle pending replaces:', error))
    }
    try {
      return await work()
    } catch (error) {
      // Locked since the ticket was issued: nothing went out, and the host is asked for the key (NO_KEY).
      const cause = error instanceof NotSentError ? error.cause : error
      if (cause instanceof RpcError && cause.code === 'NO_KEY') throw new NotSentError(new Error(`Private key not found: ${cause.message}`))
      throw error
    }
  }

  /**
   * A v5 write's call still runs (past its deadline: a stall). lib's DM v5
   * engine runs its writes and its reads (`pollOwn`, the roster) on one
   * queue, so a read now would wait behind the hung call: "check again"
   * answers at once instead, and the call's own answer settles the ticket.
   * (Legacy reads do not queue behind its sends.)
   */
  const stillSending = (kit: ProbeKit) => backend.kind === 'v5' && kit.sinceSettled() === null
  const STILL_SENDING_PROBE: ProbeResult = { state: 'unknown', error: new Error('Still sending. Check again in a moment.') }

  options.tickets.register<SendArgs>('dm.send', {
    run: async (args, ctx) => {
      const id = ctx.ticket.id
      // A retry after a long send failed part way sends only the parts that did not go out.
      const earlier = partial.get(id)
      const text = earlier ? earlier.parts.slice(earlier.sent).join('') : args.text
      let result: WriteResult
      try {
        result = await running(args.identityId, () => backend.send(args.identityId, args.key, text), { settle: false })
      } catch (error) {
        const delivered = await notePartlySent(args, id).catch(cause => {
          logger.debug('DM send: could not record the parts sent:', cause)
          return false
        })
        if (!delivered) throw error
        logger.debug('DM send: failed after every part was out, so it is sent:', error)
        result = { state: 'confirmed' }
      }
      // Which of my messages this send made, so no other ticket's check counts them. Best effort:
      // the message is out, so a failed read here must never fail the ticket (or start an engine
      // while messages are stopping).
      if (!halted) {
        await freshOwn(args, id, 0)
          .then(fresh => claimParts(args, id, fresh))
          .catch(error => logger.debug('DM send: could not record the sent messages:', error))
      }
      partial.delete(id)
      return result
    },
    /**
     * "Check again": re-read my messages in the conversation from the chain,
     * then look for every part of the text among those that were not there
     * at submit and that no other send accounts for (an earlier identical "ok"
     * never counts). Absence proves nothing, and after a restart the text is
     * gone (never persisted), so only `applied` is ever proved. Not while
     * the send still runs (`stillSending`).
     */
    async probe(ticket, args, kit) {
      if (!args) return { state: 'unknown', error: new Error('The app restarted before this was confirmed. Open the conversation to see whether it was sent.') }
      if (halted) return { state: 'unknown', error: new Error('Messages are stopped while the account changes') }
      if (stillSending(kit)) return STILL_SENDING_PROBE
      await backend.readBack(args.identityId, args.key)
      const fresh = await freshOwn(args, ticket.id, ticket.createdAt.getTime() - SENT_MATCH_SLACK_MS)
      return claimParts(args, ticket.id, fresh)
        ? { state: 'applied' }
        : { state: 'unknown', error: new Error('Not in the conversation yet. Check again in a moment.') }
    },
    persistArgs: false,
  })

  /** How long a group write may run without a word before it reads unconfirmed (`WriteHandler.deadlineMs`). */
  const GROUP_DEADLINE_MS = 5 * 60_000
  /** Group creations: their result for `createdGroup`, and the one running (a second waits for it). */
  const createdGroups = new Map<string, DmCreatedGroup>()
  let creating: string | null = null
  const PENDING_CREATE = 'submitting'

  options.tickets.register<GroupArgs>('dm.group', {
    run: async ({ identityId, request }, ctx) => {
      try {
        return await running(identityId, async () => {
          const groups = v5('Groups')
          if (request.action !== 'create') return groups.group(identityId, request)
          createdGroups.set(ctx.ticket.id, await groups.createGroup(identityId, request.name, request.memberIds))
          return { state: 'confirmed' }
        })
      } finally {
        if (creating === ctx.ticket.id) creating = null
      }
    },
    async probe(ticket, args, kit) {
      if (!args || halted) return { state: 'unknown', error: new Error('This change can no longer be checked here') }
      if (stillSending(kit)) return STILL_SENDING_PROBE
      const groups = v5('Groups')
      const { request } = args
      if (request.action !== 'create') return groups.probeGroup(args.identityId, request)
      const key = await groups.findCreated(args.identityId, request.name, request.memberIds, request.before)
      if (!key) return { state: 'unknown', error: new Error('The group does not show yet. Check again in a moment.') }
      createdGroups.set(ticket.id, { key, failed: [] })
      return { state: 'applied' }
    },
    persistArgs: false,
    // A creation writes the roster and a key for each of up to 100 members, and reports nothing
    // until it is done: a minute without a word is no sign of a stall here.
    deadlineMs: GROUP_DEADLINE_MS,
  })

  function groupNameOf(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!name || name.length > GROUP_NAME_MAX || new TextEncoder().encode(name).length > GROUP_NAME_MAX_BYTES) {
      throw new RpcError(`A group name is 1 to ${GROUP_NAME_MAX} characters`, 'BAD_REQUEST')
    }
    return name
  }

  /** Still the session that started an awaited call: nothing may be stored for an account that signed out meanwhile. */
  function assertStill(identityId: string): void {
    if (viewer() !== identityId) throw new RpcError('The account changed', 'NOT_SIGNED_IN')
    if (halted) throw new RpcError('Messages are stopped while the account changes', 'RESTART_REQUIRED')
  }

  function groupTicket(request: DmGroupAction): WriteTicket {
    const identityId = session()
    const groups = v5('Groups')
    groups.assertGroupAction(identityId, request)
    return options.tickets.submit<GroupArgs>({ op: 'dm.group', args: { identityId, request }, target: { conversationKey: request.key } })
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

    /**
     * The inbox, by last activity (PRD DM-01). Hidden (v5 "deleted") conversations are included, flagged.
     * Before the first list has loaded it rejects (`ENGINE_BUSY` while loading, else the load's failure).
     */
    async conversations(): Promise<ConversationDTO[]> {
      return withPeers(await backend.rows(session()))
    },

    /**
     * Check for new messages now (pull to refresh, "Try again"), including a
     * first load that failed. Resolves when the check is done; a failed check
     * shows in `status().error`, and its changes arrive as `dm.changed`.
     */
    async refresh(): Promise<void> {
      await backend.refresh(session())
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
        // The anchor can go (the retention sweep): fall back to its time, keeping messages that share
        // it (parts of one send often do); the host dedupes by id.
        end = index >= 0 ? index : all.filter(message => message.at.getTime() <= at).length
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
      const calledAt = Date.now()
      const identityId = session()
      const conversation = keyOf(key)
      if (typeof text !== 'string' || !text.trim()) throw new RpcError('The message is empty', 'BAD_REQUEST')
      if (backend.kind === 'v5' && splitText(text.trim()).length > MAX_SEND_PARTS) {
        throw new RpcError(`The message is too long: at most ${MAX_SEND_PARTS} parts`, 'BAD_REQUEST')
      }
      await backend.assertSendable(identityId, conversation)
      // What is already mine, so "check again" never mistakes an earlier identical message for this one.
      const before = (await backend.messages(identityId, conversation)).filter(m => m.own).map(m => m.id)
      assertStill(identityId)
      if (Date.now() - calledAt > SEND_SUBMIT_DEADLINE_MS) throw new RpcError(SEND_GAVE_UP, 'NETWORK')
      return options.tickets.submit<SendArgs>({ op: 'dm.send', args: { identityId, key: conversation, text, before }, target: { conversationKey: conversation } })
    },

    /** Open (or find) the 1:1 with `peerId` without writing anything: the first send starts it. Returns its key. */
    async startDirect(peerId: string): Promise<string> {
      const identityId = session()
      const peer = identityIdOf(peerId, 'user ID')
      if (peer === identityId) throw new RpcError("You can't message yourself", 'BAD_REQUEST')
      return backend.startDirect(identityId, peer)
    },

    /**
     * Create a group of up to 100 members, the creator included: a `dm.group`
     * ticket (many paid writes: the roster, then a grant per member). Once it
     * is confirmed, `createdGroup(ticket.id)` gives the key and the members who
     * did not get the key yet ("Resend keys"). One creation at a time: a
     * second while one runs is `ENGINE_BUSY`, so a repeated tap never makes a
     * duplicate group.
     */
    async createGroup(name: string, memberIds: string[]): Promise<WriteTicket> {
      const identityId = session()
      const groups = v5('Groups')
      groups.engine(identityId) // A locked device answers NO_KEY before any argument check.
      const groupName = groupNameOf(name)
      if (!Array.isArray(memberIds)) throw new RpcError('memberIds must be a list', 'BAD_REQUEST')
      const members = Array.from(new Set(memberIds.map(id => identityIdOf(id, 'member ID')))).filter(id => id !== identityId)
      if (members.length === 0) throw new RpcError('Pick at least one member.', 'BAD_REQUEST')
      if (members.length + 1 > MAX_GROUP_MEMBERS) throw new RpcError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`, 'BAD_REQUEST')
      if (creating) throw new RpcError('A group is still being created', 'ENGINE_BUSY')
      // Held across the read below, so a second tap in the meantime is refused too.
      creating = PENDING_CREATE
      try {
        const before = (await backend.rows(identityId)).filter(row => row.kind === 'group').map(row => row.key)
        const request: GroupCreate = { action: 'create', name: groupName, memberIds: members, before }
        const ticket = options.tickets.submit<GroupArgs>({ op: 'dm.group', args: { identityId, request }, target: null })
        creating = ticket.id
        return ticket
      } catch (error) {
        creating = null
        throw error
      }
    },

    /** The group a confirmed `createGroup` ticket made, or null (unknown ticket, not done yet, or after a restart). */
    async createdGroup(ticketId: string): Promise<DmCreatedGroup | null> {
      return createdGroups.get(ticketId) ?? null
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
      await v5('Deleting conversations').hide(session(), keyOf(key))
    },

    /**
     * v5: block in Messages (their messages and group invitations are
     * ignored). Saved at once, and a no-op when it already stands. Locked or
     * still loading, it applies once the saved state has loaded, so a profile
     * Block always reaches Messages (PRD SAFE-01). Resolves whether it changed
     * anything, so the host undoes only its own change.
     */
    async setBlocked(peerId: string, blocked: boolean): Promise<boolean> {
      if (typeof blocked !== 'boolean') throw new RpcError('blocked must be true or false', 'BAD_REQUEST')
      return v5('Blocking in Messages').setBlocked(session(), identityIdOf(peerId, 'user ID'), blocked)
    },

    /** v5 "Reclaim message fees" (PRD DM-12). */
    async setRetention(retention: DmRetention): Promise<void> {
      if (!RETENTIONS.includes(retention)) throw new RpcError(`retention is one of ${RETENTIONS.join(', ')}`, 'BAD_REQUEST')
      v5('Reclaiming message fees').setRetention(session(), retention)
    },

    /**
     * Unlock messages on this device (PRD DM-02, web's encryption-key
     * modal). Without `key`: derive it from the sign-in key, which works when
     * the identity's encryption key was derived that way. With `key` (WIF or
     * 64 hex; sensitive, never logged): check it against the identity's
     * encryption key and store it (`KEY_INVALID` when it does not match).
     */
    async unlock(input: { key?: string } | null = {}): Promise<DmUnlockResult> {
      const identityId = session()
      // A failed read is never "no key": lib's identity read throws on network failures (cached for the checks below).
      const identity = await identityService.getIdentity(identityId)
      if (!identity) throw new RpcError('The identity was not found', 'IDENTITY_NOT_FOUND')
      if (!hasEncryptionKeyOnIdentity(identity.publicKeys)) return { unlocked: false, reason: 'no-key-on-identity' }
      if (input?.key === undefined) {
        if (options.unhydrated?.has(identityId)) return { unlocked: false, reason: 'not-derivable' }
        const authKey = getPrivateKey(identityId)
        if (!authKey) return { unlocked: false, reason: 'not-derivable' }
        const derived = deriveEncryptionKey(parsePrivateKey(authKey).privateKey, identityId)
        if (!(await validateDerivedKeyMatchesIdentity(derived, identityId))) return { unlocked: false, reason: 'not-derivable' }
        assertStill(identityId)
        storeEncryptionKey(identityId, privateKeyToWif(derived, keyNetwork(), true))
        storeEncryptionKeyType(identityId, 'derived')
      } else {
        const key = String(input.key).trim()
        const validation = await validateEncryptionKey(key, identityId)
        if (!validation.isValid) {
          if (validation.errorType === 'IDENTITY_NOT_FOUND') throw new RpcError(validation.error || 'Could not fetch identity data', 'NETWORK')
          if (validation.noKeyOnIdentity) return { unlocked: false, reason: 'no-key-on-identity' }
          throw new RpcError(validation.error || 'Invalid key', 'KEY_INVALID')
        }
        // lib accepts any of the identity's encryption keys, but messages (and every peer) use only
        // the one `findEncryptionKey` picks: another key would unlock an inbox nobody can write to.
        const messagingKey = findEncryptionKey(identity.publicKeys)
        if (messagingKey && validation.keyId !== messagingKey.id) {
          throw new RpcError(`This is not the encryption key messages use: enter key ${messagingKey.id} instead`, 'KEY_INVALID')
        }
        assertStill(identityId)
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
        // Runs inside the session's announcement: a DM failure must never fail a sign-in.
        try {
          backend.activate(current.identityId)
        } catch (error) {
          logger.warn('Starting messages failed:', error)
        }
      }
    },
    /**
     * Before sign-out or an account switch: stop polling and save pending
     * state while the keys are still there. Bounded, because sign-out works
     * offline: an unsaved edit stays in the engine's local cache.
     */
    stop: (): Promise<void> => {
      halted = true
      return bounded(backend.deactivate(), STOP_FLUSH_WAIT_MS, 'Stopping messages')
    },
    /** The sign-out that `stop` prepared failed: the account stays signed in, and so do its messages. */
    resume: (): void => {
      halted = false
    },
    /** `identityId` signed out: nothing of its messages may stay on the device (PRD AUTH-11). */
    forget: (identityId: string): void => {
      backend.forget(identityId)
      for (const [ticketId, entry] of partial) if (entry.identityId === identityId) partial.delete(ticketId)
    },
    /** AppState: `background` resolves once the DM flush is done, or after the host's background budget. */
    lifecycle: (state: AppLifecycleState): Promise<void> => bounded(backend.lifecycle(state), LIFECYCLE_FLUSH_WAIT_MS, 'The DM lifecycle'),
  }

  return { api, hooks }
}
