import { TtlMap } from '@/lib/caches/ttl-map'
import { hasAppConnectSession } from '@/lib/app-connect/memory-keys'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { privateFeedClientSupported } from '@/lib/contract-topology'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { getPublicKey } from '@/lib/crypto/keys'
import { normalizeBytes } from '@/lib/bytes'
import { DEFAULT_FEED_CAPS } from '@/lib/private-feed/crypto'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { followService } from '@/lib/services/follow-service'
import { identityService } from '@/lib/services/identity-service'
import { privateFeedFollowerService, type AccessStatus } from '@/lib/services/private-feed-follower-service'
import { canBringHistory, estimateRenewal, renewPrivateFeed, runMove, adoptUnfinishedMove, RENEWED_ELSEWHERE } from '@/lib/services/private-feed-move'
import { loadMove, moveProgress } from '@/lib/services/private-feed-move-job'
import { decryptPostOrReply, privateContentOf } from '@/lib/services/private-feed-reader'
import {
  answeredThrough, fetchCurrentFeed, fetchFeeds, fetchFollowRequest, fetchGrant, fetchGrantsTo, mainFeeds, type FollowRequestDocument,
} from '@/lib/services/private-feed-reads'
import { getEncryptionSource } from '@/lib/services/reply-service'
import { MESSAGES, privateFeedService, type PrivateFeedResult } from '@/lib/services/private-feed-service'
import { loadUserSummaries, readFailure, requireViewer, viewerId } from '../dto/hydrate'
import { privatePostOf, rememberPrivatePost, type PrivatePostRecord } from '../dto/private-content'
import { RpcError } from '../protocol/envelope'
import { assertId, badRequest, notSent, relationProbe, signer, ticketIdentity } from '../writes/handler-kit'
import { NotSentError, type TicketStore, type WriteHandler, type WriteResult, type WriteRunContext } from '../writes/tickets'
import type { WriteOp, WriteTicket } from '../writes/types'
import type { UserSummaryDTO } from './dto'
import { readPostOrReply } from './posts'

/**
 * Private feeds (social v17, docs/YAPPR_PRIVATE_FEED_SPEC.md and
 * lib/services/private-feed-*), the same protocol web runs: lib's owner,
 * follower, reader and move services do every read, every key operation and
 * every write. The engine only maps their answers to DTOs and tickets.
 *
 * Keys: the private feed's seed and a member's grant keys live in lib's key
 * store (`yappr:pf:`, the host's secure storage). Opening them takes the
 * account's messaging key, read with lib's `getEncryptionKeyBytes`: on a
 * wallet (App Connect) sign-in the key the wallet granted, held in memory
 * from the key ring; on a key sign-in a stored one, where lib allows it.
 * Nothing here derives or stores a messaging key (D38).
 */

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * Why a private post does not open for this viewer (web's
 * `PrivatePostContent` locked and error states):
 * - `signed-out`: sign in to see it;
 * - `needs-key`: the viewer can read it (their own feed, or an approved
 *   follower), but this device does not hold their messaging key
 *   (`messagingKey` says how to get it);
 * - `key-changed`: access was granted to a messaging key this account no
 *   longer uses: ask again;
 * - `none`: not a follower of this private feed (never asked, or left);
 * - `pending`: asked, and not answered yet;
 * - `revoked`: the owner removed the viewer and they have not asked again;
 * - `renewing`: the owner renewed the feed and is moving followers over;
 * - `history`: from before the viewer could see this feed (or, for the
 *   owner, before a renewal without a history link);
 * - `failed`: a read failed, or the content does not open (try again);
 * - `unsupported`: this network has no private feeds.
 */
export type PrivateLockReason =
  | 'signed-out' | 'needs-key' | 'key-changed' | 'none' | 'pending' | 'revoked' | 'renewing' | 'history' | 'failed' | 'unsupported'

/** How this device gets the account's messaging key: `ready` holds it; `allow-in-wallet`: renew the wallet sign-in with messaging allowed; `unavailable`: a key sign-in without one (sign in with the wallet). */
export type MessagingKeyDTO = 'ready' | 'allow-in-wallet' | 'unavailable'

export type PrivatePostDTO =
  | {
    state: 'open'
    /** The decrypted text (an encrypted post's image link is inside it). */
    text: string
    /** Whose private feed it belongs to: the author, or for a reply in a private thread the thread root's author. */
    feedOwnerId: string
    own: boolean
    /** The owner's own post: how many private followers can read it; null when that read failed. */
    followerCount: number | null
  }
  | {
    state: 'locked'
    reason: PrivateLockReason
    feedOwnerId: string
    own: boolean
    /** With `needs-key`: how to get the messaging key. */
    messagingKey: MessagingKeyDTO
  }

/** Where the viewer stands with someone's private feed (`privateFeed.access`, web's `PrivateFeedAccessButton`). */
export interface PrivateAccessDTO {
  /** The owner has a private feed. */
  hasFeed: boolean
  /** `self` for the viewer's own feed; otherwise lib's `AccessStatus`. */
  status: AccessStatus | 'self'
  messagingKey: MessagingKeyDTO
}

/** The owner's settings (web's `PrivateFeedSettings` and dashboard). */
export type PrivateFeedOverviewDTO =
  | {
    enabled: false
    messagingKey: MessagingKeyDTO
    /** How many private followers a new feed has room for. */
    capacity: number
  }
  | {
    enabled: true
    messagingKey: MessagingKeyDTO
    /** When the first feed was opened. */
    since: Date
    followers: number
    /** The current feed's stored caps (R-M30) and their use. */
    capacity: number
    removals: number
    maxRemovals: number
    /** The feed's seed is sealed to a messaging key this account no longer uses: renew it to keep posting privately. */
    keyRotated: boolean
    /** 90% of its room taken, or within 10 removals of its limit (design §7.7): offer renewing. */
    nearlyFull: boolean
    /** A follower move after a renewal, unfinished: private posting, approvals and removals wait for it (PF4). */
    move: { done: number; total: number; error: string | null } | null
  }

export interface PrivateRequestDTO {
  user: UserSummaryDTO
  requestedAt: Date
  /** A follower asking again after their grant (removed, or their messaging key changed). */
  renewal: boolean
}

export interface PrivateFollowerDTO {
  user: UserSummaryDTO
  grantedAt: Date
}

/** What renewing would do (web's `RenewPrivateFeedDialog`). */
export interface PrivateRenewalDTO {
  followers: number
  credits: number
  usd: number
  /** Whether older private posts can come along: `no` only when the old feed's secret is out of reach for good (PF5). */
  canBringHistory: 'yes' | 'no' | 'unknown'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The messaging key the private feed services are given; never derived here (D38). */
const messagingKeyOf = (identityId: string): Uint8Array | undefined => getEncryptionKeyBytes(identityId) ?? undefined

function messagingKeyStatus(identityId: string): MessagingKeyDTO {
  if (getEncryptionKeyBytes(identityId)) return 'ready'
  return hasAppConnectSession(identityId) ? 'allow-in-wallet' : 'unavailable'
}

function requireSupport(): void {
  if (!privateFeedClientSupported()) throw new RpcError('Private feeds are not available on this network', 'NOT_SUPPORTED')
}

/** A read of lib's that throws, as the engine's categorized read failure. */
async function read<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    throw readFailure(error)
  }
}

/** A private post or reply by id: the engine's copy of what it handed the host, else read again. */
async function privatePost(id: string): Promise<PrivatePostRecord | null> {
  const known = privatePostOf(id)
  if (known) return known
  const post = await readPostOrReply(id)
  // Remembered, so a reply to it is known to be private (`draftIsPrivate`).
  if (post) rememberPrivatePost(post)
  return post
}

/** An identity's messaging public key, from its identity keys (lib's lookup: the anchor key on App Connect builds). */
function identityMessagingKey(identityId: string, options?: { fresh?: boolean }): Promise<Uint8Array | null> {
  return resolveEncryptionPublicKey(identityId, async () => (await identityService.getIdentity(identityId, options))?.publicKeys ?? null)
}

/** How many private followers the owner's own post reaches, kept briefly (web shows it under each own post). */
const followerCounts = new TtlMap<string, number>(60_000)

async function followerCountOf(ownerId: string): Promise<number | null> {
  const known = followerCounts.get(ownerId)
  if (known !== undefined) return known
  try {
    const count = await privateFeedService.getPrivateFollowerCount(ownerId)
    followerCounts.set(ownerId, count)
    return count
  } catch {
    return null
  }
}

/** The 33-byte key to seal a requester's grant to (web's `PrivateFeedFollowRequests.handleApprove`). */
async function requesterKey(request: FollowRequestDocument): Promise<Uint8Array | null> {
  // Legacy builds may take the key the request carries; App Connect builds read the requester's current anchor key.
  if (request.publicKey && !isAppConnectBuild()) {
    const carried = normalizeBytes(request.publicKey)
    if (carried) return carried
  }
  return identityMessagingKey(request.$ownerId, { fresh: true })
}

/** What an access status means for a private post that did not open (web `attemptDecryption`'s last step). */
const ACCESS_LOCK: Record<AccessStatus, PrivateLockReason> = {
  pending: 'pending',
  renewing: 'renewing',
  revoked: 'revoked',
  // Approved, and still nothing opens it: it predates what the grant reaches.
  approved: 'history',
  'approved-no-keys': 'history',
  none: 'none',
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Web `PrivatePostContent.attemptDecryption`, as a DTO. */
async function readPrivatePost(id: string, rootOwnerHint?: string): Promise<PrivatePostDTO> {
  const post = await read(() => privatePost(id))
  const fallbackOwner = post?.rootOwnerId ?? rootOwnerHint ?? post?.author.id ?? ''
  const locked = (reason: PrivateLockReason, feedOwnerId: string, viewer: string | null): PrivatePostDTO => ({
    state: 'locked', reason, feedOwnerId, own: viewer === feedOwnerId, messagingKey: viewer ? messagingKeyStatus(viewer) : 'unavailable',
  })
  const viewer = viewerId()
  if (!privateFeedClientSupported()) return locked('unsupported', fallbackOwner, viewer)
  if (!post || !privateContentOf(post)) return locked('failed', fallbackOwner, viewer)
  if (!viewer) return locked('signed-out', fallbackOwner, null)

  const key = messagingKeyOf(viewer)
  let opened: Awaited<ReturnType<typeof decryptPostOrReply>>
  try {
    opened = await decryptPostOrReply(post, viewer, key, rootOwnerHint)
  } catch {
    return locked('failed', fallbackOwner, viewer)
  }
  if (!opened) return locked('failed', fallbackOwner, viewer)
  const { outcome, feedOwnerId } = opened
  const own = viewer === feedOwnerId
  const lock = (reason: PrivateLockReason) => locked(reason, feedOwnerId, viewer)
  if (outcome.ok) {
    return { state: 'open', text: outcome.text, feedOwnerId, own, followerCount: own ? await followerCountOf(feedOwnerId) : null }
  }
  switch (outcome.reason) {
    // The key here and still no opening: the grant was sealed to another messaging key.
    case 'needs-key': return lock(key && !own ? 'key-changed' : 'needs-key')
    case 'revoked': return lock('revoked')
    case 'history-unavailable': return lock('history')
    case 'failed': return lock('failed')
    case 'no-access': break
  }
  if (own) return lock('needs-key')
  try {
    return lock(ACCESS_LOCK[await privateFeedFollowerService.getAccessStatus(feedOwnerId, viewer)])
  } catch {
    return lock('failed')
  }
}

export const privateFeedReads = {
  /**
   * A private post or reply for the viewer (web's `PrivatePostContent`):
   * decrypted, or why not. `rootOwnerHint`: who started the thread, for a
   * reply whose root is gone. Keys this device lacks are recovered with the
   * messaging key on the way (catching up on removals, a grant, a renewal's
   * history link), as on web. Resolves `locked` `failed` for a read that
   * failed; rejects only when the post itself could not be read.
   */
  async read(id: string, rootOwnerHint?: string): Promise<PrivatePostDTO> {
    assertId(id, 'id')
    if (rootOwnerHint !== undefined) assertId(rootOwnerHint, 'rootOwnerHint')
    return readPrivatePost(id, rootOwnerHint)
  },

  /**
   * Whether a reply to the private post or reply `id` is private: its thread
   * root is private, so the reply is encrypted to the root's feed (web's
   * `useInheritedEncryption`). A private reply under a public root is not:
   * the replier chooses. Rejects when the thread cannot be read (the root
   * deleted, or a failed read), so compose never guesses.
   */
  async replySource(id: string): Promise<{ private: boolean }> {
    assertId(id, 'id')
    requireSupport()
    const post = await read(() => privatePost(id))
    if (!post) throw new RpcError('This post could not be found', 'TARGET_GONE')
    if (post.encryptedContent === undefined) return { private: false }
    return { private: (await read(() => getEncryptionSource(post))) !== null }
  },

  /** Where the viewer stands with `ownerId`'s private feed. Rejects when the reads fail. */
  async access(ownerId: string): Promise<PrivateAccessDTO> {
    assertId(ownerId, 'ownerId')
    const viewer = requireViewer('Private feeds')
    const messagingKey = messagingKeyStatus(viewer)
    if (!privateFeedClientSupported()) return { hasFeed: false, status: 'none', messagingKey }
    const feed = await read(() => fetchCurrentFeed(ownerId))
    if (ownerId === viewer) return { hasFeed: feed !== null, status: 'self', messagingKey }
    if (!feed) return { hasFeed: false, status: 'none', messagingKey }
    return { hasFeed: true, status: await read(() => privateFeedFollowerService.getAccessStatus(ownerId, viewer)), messagingKey }
  },

  /** The viewer's own private feed, for Settings. A move no device finished is adopted, as web's settings do. */
  async overview(): Promise<PrivateFeedOverviewDTO> {
    requireSupport()
    const viewer = requireViewer('Your private feed')
    const messagingKey = messagingKeyStatus(viewer)
    const overview = await read(() => privateFeedService.getOverview(viewer))
    if (!overview) return { enabled: false, messagingKey, capacity: DEFAULT_FEED_CAPS.treeCapacity }
    // Best effort: a failed look leaves the move to the next one.
    await adoptUnfinishedMove(viewer).catch(() => 0)
    const job = loadMove(viewer)
    const followers = overview.followers.length
    const { treeCapacity, maxKeyGeneration } = overview.feed
    return {
      enabled: true,
      messagingKey,
      since: new Date(overview.feeds[overview.feeds.length - 1].createdAt),
      followers,
      capacity: treeCapacity,
      removals: overview.keyGeneration - 1,
      maxRemovals: maxKeyGeneration - 1,
      keyRotated: overview.keyRotated,
      nearlyFull: followers >= 0.9 * treeCapacity || overview.keyGeneration >= maxKeyGeneration - 10,
      move: job ? { ...moveProgress(job), error: job.error ?? null } : null,
    }
  },

  /** Requests waiting on the viewer, newest first (web's `PrivateFeedFollowRequests`). */
  async requests(): Promise<PrivateRequestDTO[]> {
    requireSupport()
    const viewer = requireViewer('Your private feed')
    const pending = await read(() => privateFeedService.getPendingRequests(viewer))
    const users = await loadUserSummaries(pending.map(request => request.$ownerId))
    return pending.flatMap(request => {
      const user = users.get(request.$ownerId)
      return user ? [{ user, requestedAt: new Date(request.$createdAt), renewal: request.renewal }] : []
    })
  },

  /** The current feed's private followers, newest first (web's `PrivateFeedFollowers`). */
  async followers(): Promise<PrivateFollowerDTO[]> {
    requireSupport()
    const viewer = requireViewer('Your private feed')
    const followers = await read(() => privateFeedService.getPrivateFollowers(viewer))
    const users = await loadUserSummaries(followers.map(follower => follower.recipientId))
    return followers
      .sort((a, b) => b.grantedAt - a.grantedAt)
      .flatMap(follower => {
        const user = users.get(follower.recipientId)
        return user ? [{ user, grantedAt: new Date(follower.grantedAt) }] : []
      })
  },

  /** What renewing would move and cost, and whether older posts can come along. */
  async renewal(): Promise<PrivateRenewalDTO> {
    requireSupport()
    const viewer = requireViewer('Your private feed')
    const [estimate, history] = await read(() => Promise.all([estimateRenewal(viewer), canBringHistory(viewer, messagingKeyOf(viewer))]))
    return { ...estimate, canBringHistory: history }
  },
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A private-feed service's answer as a ticket result. A refusal it names
 * (full, moving, withdrawn, ...) fails with its sentence (`PRIVATE_FEED`); a
 * write still being confirmed is `unconfirmed`; anything else is the write's
 * own error, classified as any write's (a timeout may have landed).
 */
function fromFeedResult(result: PrivateFeedResult): WriteResult {
  // Sent but not yet confirmed (a grant's create): its probe settles it.
  if (result.success) return { state: result.confirmed === false ? 'unconfirmed' : 'confirmed' }
  switch (result.errorCode) {
    case 'UNCONFIRMED': return { state: 'unconfirmed' }
    case 'SYNC_REQUIRED': return { state: 'failed', error: noMessagingKey() }
    case undefined: return { state: 'failed', error: new Error(result.error ?? 'The network did not accept this change') }
    default: return { state: 'failed', error: new RpcError(result.error ?? 'Your private feed could not be changed', 'PRIVATE_FEED') }
  }
}

const noMessagingKey = () => new RpcError('This needs your messaging key, which this phone does not hold', 'NO_MESSAGING_KEY')

/** The messaging key, before anything is sent: without it the write cannot be made here. */
function requireMessagingKey(identityId: string): Uint8Array {
  const key = messagingKeyOf(identityId)
  if (!key) throw new NotSentError(noMessagingKey())
  return key
}

/**
 * Whether `followerId` still holds a grant in force where a removal rekeys
 * (lib `revokeFollower`): the current feed, or the previous one while a
 * renewal's move has not reached them. Older feeds keep their grants (a
 * renewal without history), so they say nothing about a removal.
 */
async function holdsGrantInForce(ownerId: string, followerId: string): Promise<boolean> {
  const [current, previous] = mainFeeds(await fetchFeeds(ownerId, { fresh: true }))
  const held = await fetchGrantsTo(ownerId, followerId)
  const inForce = async (feed: number | undefined) => {
    const grant = feed === undefined ? undefined : held.find((candidate) => candidate.feed === feed)
    return grant !== undefined && !(await answeredThrough(grant)).revoked
  }
  if (held.some((grant) => grant.feed === current?.feed)) return inForce(current?.feed)
  return inForce(previous?.feed)
}

/**
 * lib's own sentences for a stopped follower move (`moveFollowers` in
 * lib/services/private-feed-move.ts, and the feed refusals it passes on);
 * any other pause (a thrown read's message) shows as {@link MOVE_PAUSED}.
 */
const MOVE_PAUSES = new Set([
  ...Object.values(MESSAGES).filter((message) => !message.startsWith('SYNC_REQUIRED:')),
  RENEWED_ELSEWHERE,
  'Enter your encryption key to finish moving your followers.',
  'Your renewed private feed is full.',
  "Waiting for the network to confirm a follower's access. Continue in a moment.",
  "Some of your old feed's access could not be cleaned up yet.",
  'The move paused.',
])
const MOVE_PAUSED = 'The move paused. Continue in a moment.'
const pauseText = (error: string | undefined): string => (error !== undefined && MOVE_PAUSES.has(error) ? error : MOVE_PAUSED)

/** `requestAccess`'s refusal when the owner has no private feed (lib/services/private-feed-follower-service.ts). */
const NO_FEED = 'This person has no private feed'

/** Margin for the chain's clock against the ticket's: a request made by this ticket is no older than this before it. */
const CLOCK_SKEW_MS = 60_000

interface OwnerArgs { ownerId: string }
/** `replacing`: the request standing when it was asked (Ask again replaces it), which never proves the new one landed. */
interface RequestArgs extends OwnerArgs { replacing?: string }
interface MemberArgs { memberId: string }
interface RenewArgs { bringHistory: boolean; fromFeed: number }

export function createPrivateFeedWrites(tickets: TicketStore) {
  const register = <A>(op: WriteOp, handler: WriteHandler<A>) => tickets.register<A>(op, { persistArgs: true, ...handler })

  register<Record<string, never>>('privateFeed.enable', {
    async run(_args, ctx) {
      const owner = signer(ctx)
      const key = requireMessagingKey(owner)
      ctx.stage('broadcasting')
      return fromFeedResult(await privateFeedService.enablePrivateFeed(owner, key))
    },
    probe: relationProbe(async ({ viewer }) => (await fetchCurrentFeed(viewer, { fresh: true })) !== null, true),
  })

  register<RequestArgs>('privateFeed.request', {
    async run({ ownerId }, ctx) {
      const me = signer(ctx)
      // The requester's messaging public key: from the key on this device, else the identity's (web's usePrivateFeedRequest).
      const held = messagingKeyOf(me)
      const publicKey = held ? getPublicKey(held) : await identityMessagingKey(me).catch(notSent)
      if (!publicKey) throw new NotSentError(noMessagingKey())
      ctx.stage('broadcasting')
      // Web follows the owner first, best effort: the request goes ahead either way.
      try {
        if (!(await followService.isFollowing(ownerId, me))) await followService.followUser(me, ownerId)
      } catch {
        // incidental to the request
      }
      const result = await privateFeedFollowerService.requestAccess(ownerId, me, publicKey)
      if (result.success) return { state: result.confirmed === false ? 'unconfirmed' : 'confirmed' }
      // Refused before anything was sent: the owner has no private feed (any more).
      if (result.error === NO_FEED) return { state: 'failed', error: new RpcError("This person doesn't have a private feed.", 'PRIVATE_FEED') }
      return { state: 'failed', error: new Error(result.error) }
    },
    probe: relationProbe<RequestArgs>(async ({ viewer, ticket, args }) => {
      const request = await fetchFollowRequest(ticketIdentity(ticket), viewer)
      if (request === null || request.$id === args?.replacing) return false
      return request.$createdAt >= ticket.createdAt.getTime() - CLOCK_SKEW_MS
    }, true),
  })

  register<OwnerArgs>('privateFeed.leave', {
    async run({ ownerId }, ctx) {
      ctx.stage('broadcasting')
      const result = await privateFeedFollowerService.leave(ownerId, signer(ctx))
      // Nothing to withdraw: it is gone already, which is what was asked.
      if (!result.success && result.error === 'No pending request found') return { state: 'confirmed' }
      return result.success ? { state: 'confirmed' } : { state: 'failed', error: new Error(result.error) }
    },
    probe: relationProbe<OwnerArgs>(async ({ viewer, ticket }) => (await fetchFollowRequest(ticketIdentity(ticket), viewer)) !== null, false),
  })

  register<MemberArgs>('privateFeed.approve', {
    async run({ memberId }, ctx) {
      const owner = signer(ctx)
      const request = await fetchFollowRequest(owner, memberId).catch(notSent)
      if (!request) throw new NotSentError(new RpcError('This person withdrew their request, so there is nothing to approve.', 'PRIVATE_FEED'))
      const publicKey = await requesterKey(request).catch(notSent)
      if (!publicKey) throw new NotSentError(new RpcError("This person hasn't set up messaging yet. You can approve them once they do.", 'PRIVATE_FEED'))
      ctx.stage('broadcasting')
      return fromFeedResult(await privateFeedService.approveFollower(owner, memberId, publicKey, messagingKeyOf(owner)))
    },
    // Approved: a grant in force in the current feed that answers the request still standing. A follower
    // who asks again (a new messaging key) still holds the old grant, which lib replaces; that one says nothing.
    probe: relationProbe<MemberArgs>(async ({ viewer, ticket }) => {
      const member = ticketIdentity(ticket)
      const [feed, request] = await Promise.all([fetchCurrentFeed(viewer, { fresh: true }), fetchFollowRequest(viewer, member)])
      const grant = feed ? await fetchGrant(viewer, feed.feed, member) : null
      if (grant === null || (request !== null && grant.createdAt < request.$createdAt)) return false
      return !(await answeredThrough(grant)).revoked
    }, true),
  })

  register<MemberArgs>('privateFeed.revoke', {
    async run({ memberId }, ctx) {
      const owner = signer(ctx)
      ctx.stage('broadcasting')
      return fromFeedResult(await privateFeedService.revokeFollower(owner, memberId, messagingKeyOf(owner)))
    },
    probe: relationProbe<MemberArgs>(async ({ viewer, ticket }) => holdsGrantInForce(viewer, ticketIdentity(ticket)), false),
  })

  /** Progress through a follower move, as the ticket's progress (a long move reports each follower). */
  const moveProgressTo = (ctx: WriteRunContext) => ({ done, total }: { done: number; total: number }) => ctx.progress(done, total)

  /**
   * A move that paused: its job keeps its place (a grant already written
   * counts as done when it runs again), and Settings offers to continue it.
   */
  const fromMoveResult = (result: PrivateFeedResult): WriteResult =>
    result.success || result.errorCode !== undefined
      ? fromFeedResult(result)
      : { state: 'failed', error: new RpcError(pauseText(result.error), 'PRIVATE_FEED') }

  register<RenewArgs>('privateFeed.renew', {
    async run({ bringHistory, fromFeed }, ctx) {
      const owner = signer(ctx)
      const key = requireMessagingKey(owner)
      ctx.stage('broadcasting')
      const result = await renewPrivateFeed(owner, key, { bringHistory }, moveProgressTo(ctx))
      if (result.success) return { state: 'confirmed' }
      // The new feed is there: the renewal landed, and only the move after it paused (its own ticket continues it).
      const renewed = await fetchCurrentFeed(owner, { fresh: true }).then((feed) => (feed?.feed ?? 0) > fromFeed, () => false)
      if (renewed) return { state: 'confirmed' }
      // A refusal the feed names is one; anything else (a timeout opening the feed) is classified as any write's.
      return result.errorCode !== undefined ? fromFeedResult(result) : { state: 'failed', error: new Error(result.error ?? 'The network did not accept this change') }
    },
    // Renewed: a newer feed than the one it renewed exists. The move after it is its own (`privateFeed.move`).
    probe: relationProbe<RenewArgs>(async ({ viewer, args }) => {
      if (!args) throw new Error('This renewal can no longer be checked')
      return ((await fetchCurrentFeed(viewer, { fresh: true }))?.feed ?? 0) > args.fromFeed
    }, true),
    // One grant per follower, each its own transition: a long move reports each, but a slow one may sit a while.
    deadlineMs: null,
  })

  register<Record<string, never>>('privateFeed.move', {
    async run(_args, ctx) {
      const owner = signer(ctx)
      const key = requireMessagingKey(owner)
      ctx.stage('broadcasting')
      return fromMoveResult(await runMove(owner, key, moveProgressTo(ctx)))
    },
    // Finished: the job this device keeps is gone (runMove clears it at the end). Reads only.
    probe: relationProbe(async ({ viewer }) => loadMove(viewer) === null, true),
    deadlineMs: null,
  })

  const submitAbout = <A>(op: WriteOp, args: A, identityId: string): WriteTicket => {
    requireSupport()
    return tickets.submit<A>({ op, args, target: { identityId } })
  }

  /** The other account a member write names, never the viewer. */
  const otherAccount = (id: unknown, what: string): string => {
    assertId(id, what)
    if (id === requireViewer('Private feeds')) throw badRequest('That is your own account')
    return id
  }

  return {
    /** Turn on the viewer's private feed (web's "Enable Private Feed"), sealed to their messaging key. */
    enable: async (): Promise<WriteTicket> => {
      const viewer = requireViewer('Turning on your private feed')
      return submitAbout<Record<string, never>>('privateFeed.enable', {}, viewer)
    },
    /** Ask `ownerId` for access to their private feed (following them first, as web does); also how a removed follower asks again. */
    request: async (ownerId: string): Promise<WriteTicket> => {
      const owner = otherAccount(ownerId, 'ownerId')
      const viewer = requireViewer('Requesting access')
      // Best effort: without it, a recent request still proves this one (as before).
      const standing = await fetchFollowRequest(owner, viewer).catch(() => null)
      return submitAbout<RequestArgs>('privateFeed.request', { ownerId: owner, ...(standing ? { replacing: standing.$id } : {}) }, ownerId)
    },
    /** Withdraw a pending request, or leave a private feed (PF8). */
    leave: async (ownerId: string): Promise<WriteTicket> => submitAbout<OwnerArgs>('privateFeed.leave', { ownerId: otherAccount(ownerId, 'ownerId') }, ownerId),
    /** Approve `memberId`'s request: a grant in the viewer's current feed. */
    approve: async (memberId: string): Promise<WriteTicket> => submitAbout<MemberArgs>('privateFeed.approve', { memberId: otherAccount(memberId, 'memberId') }, memberId),
    /** Remove `memberId` (a rekey): they can't read anything posted from now on. */
    revoke: async (memberId: string): Promise<WriteTicket> => submitAbout<MemberArgs>('privateFeed.revoke', { memberId: otherAccount(memberId, 'memberId') }, memberId),
    /**
     * Renew the viewer's private feed: new keys, room to grow, and every
     * follower moved over (`bringHistory`: older posts come along). The
     * ticket's progress counts followers moved.
     */
    renew: async (input: { bringHistory: boolean }): Promise<WriteTicket> => {
      if (typeof input?.bringHistory !== 'boolean') throw badRequest('bringHistory must be true or false')
      requireSupport()
      const viewer = requireViewer('Renewing your private feed')
      const current = await read(() => fetchCurrentFeed(viewer, { fresh: true }))
      if (!current) throw new RpcError('Turn on your private feed first.', 'PRIVATE_FEED')
      return submitAbout<RenewArgs>('privateFeed.renew', { bringHistory: input.bringHistory, fromFeed: current.feed }, viewer)
    },
    /** Continue a follower move that paused (`overview().move`). */
    continueMove: async (): Promise<WriteTicket> => {
      const viewer = requireViewer('Moving your private followers')
      return submitAbout<Record<string, never>>('privateFeed.move', {}, viewer)
    },
  }
}

export type { AccessStatus }
