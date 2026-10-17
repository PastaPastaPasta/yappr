/**
 * Private feeds, owner side (social v17: several write-once `privateFeed`
 * documents per identity; docs/SOCIAL_V17.md and the release audit's
 * private-feeds-multi-design.md).
 *
 * The owner writes into their CURRENT feed only: the highest-numbered feed of
 * the main audience (launch has no other). Every write first syncs against the
 * chain (sync-before-write): it re-reads the feed list, so a feed another
 * device opened is never written past, and the feed's newest key generation,
 * so a revocation made elsewhere is never undone. Caps are each feed's STORED
 * treeCapacity and maxKeyGeneration (R-M30), never constants.
 *
 * Renewal (a new feed: key rotation, compromise, caps, or the owner's choice)
 * and the follower move live in private-feed-move.ts.
 */

import { logger } from '@/lib/logger'
import { stateTransitionService } from './state-transition-service'
import { privateFeedKeyStore, type OwnerFeedKeys } from './private-feed-key-store'
import {
  fetchCurrentFeed, fetchFeeds, fetchFollowRequest, fetchFollowRequestsTo, fetchGrant, fetchGrantsTo, fetchLatestKeyGeneration,
  fetchMembers, fetchRekeys, forgetFeeds, type FollowRequestDocument, type GrantDocument, type PrivateFeedDocument,
} from './private-feed-reads'
import { moveInProgress } from './private-feed-move-job'
import { identityService } from './identity-service'
import { identifierToBytes } from './sdk-helpers'
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { contentLimits } from '@/lib/contract-topology'
import { findEncryptionKey } from '@/lib/crypto/encryption-key-lookup'
import { KeyPurpose, KeyType } from '@/lib/crypto/identity-keys'
import { getPublicKey } from '@/lib/crypto/keys'
import { bytesEqual, normalizeBytes } from '@/lib/bytes'
import { scopedKey } from '@/lib/storage-scope'
import {
  isDuplicateUniqueIndexError, isPropertyAgreementError, isReferenceNotFoundError, referencedPathFromError,
} from '@/lib/error-utils'
import {
  buildRekey, cekAt, CONTENT_OVERHEAD, DEFAULT_FEED_CAPS, encryptContent, generateSeed, grantPathKeys, historyKey, openSeed, sealCarry, sealGrant,
  sealSeed, type CarriedFeed, type ContentKind, type FeedCaps,
} from '@/lib/private-feed/crypto'

/** Why a private-feed write did not happen, where the caller acts on it. */
export type PrivateFeedErrorCode =
  /** The owner's keys for the current feed are not on this device: enter the encryption key. */
  | 'SYNC_REQUIRED'
  /** The follower withdrew their request (or left) before the grant landed. */
  | 'REQUEST_WITHDRAWN'
  /** The owner has no private feed. */
  | 'FEED_NOT_ENABLED'
  /** Every leaf of the current feed is taken: renew it with room for more. */
  | 'FEED_FULL'
  /** The current feed has used every key generation: renew it. */
  | 'GENERATIONS_USED'
  /** The current feed's seed is sealed to an encryption key this device does not hold (it was rotated): renew it. */
  | 'KEY_CHANGED'
  /** Followers are being moved to a new feed; the feed takes no other writes until that finishes (PF4). */
  | 'MOVE_IN_PROGRESS'

export interface PrivateFeedResult {
  success: boolean
  error?: string
  errorCode?: PrivateFeedErrorCode
}

const MESSAGES: Record<PrivateFeedErrorCode, string> = {
  SYNC_REQUIRED: 'SYNC_REQUIRED:Enter your encryption key to manage your private feed on this device.',
  REQUEST_WITHDRAWN: 'This person withdrew their request, so there is nothing to approve.',
  FEED_NOT_ENABLED: 'Turn on your private feed first.',
  FEED_FULL: 'Your private feed is full. Renew it to make room for more followers.',
  GENERATIONS_USED: 'Your private feed has used all its key changes. Renew it to keep removing followers.',
  KEY_CHANGED: 'Your messaging key changed since this private feed was set up. Renew your private feed to keep posting privately.',
  MOVE_IN_PROGRESS: 'Your followers are being moved to your renewed private feed. Try again when the move finishes.',
}

const failure = (errorCode: PrivateFeedErrorCode): PrivateFeedResult & { success: false } => ({ success: false, error: MESSAGES[errorCode], errorCode })

/** Kept for callers that show the withdrawn-request case by its text. */
export const REQUEST_WITHDRAWN_MESSAGE = MESSAGES.REQUEST_WITHDRAWN

/**
 * A grant write's refusal, by what consensus names: 40120 on `recipientId`
 * (no follow request: withdrawn), on `$ownerId` (no such feed of the writer),
 * and 40127 (the leaf or generation is past the feed's stored caps).
 */
function grantRefusal(error: unknown): PrivateFeedResult | null {
  if (isReferenceNotFoundError(error)) {
    const path = referencedPathFromError(error)
    if (path === 'recipientId') return failure('REQUEST_WITHDRAWN')
    if (path === '$ownerId') return failure('FEED_NOT_ENABLED')
  }
  if (isPropertyAgreementError(error)) return failure('FEED_FULL')
  return null
}

const toBytes = identifierToBytes

const toFollower = (grant: GrantDocument): PrivateFollower => ({ recipientId: grant.recipientId, leafIndex: grant.leafIndex, grantedAt: grant.createdAt })

/** The current feed and this device's keys for it, synced with the chain. */
export interface OwnerFeedState {
  feed: PrivateFeedDocument
  keys: OwnerFeedKeys
}

type StateResult = { success: true; state: OwnerFeedState } | (PrivateFeedResult & { success: false })

// ---- requests the owner already answered by revoking (this device only) ----

const answeredKey = (ownerId: string) => scopedKey(`yappr_pf_answered:${ownerId}`)

function answeredRequests(ownerId: string): Set<string> {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(answeredKey(ownerId))
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function markAnswered(ownerId: string, requestId: string): void {
  try {
    const answered = answeredRequests(ownerId)
    answered.add(requestId)
    window.localStorage.setItem(answeredKey(ownerId), JSON.stringify([...answered]))
  } catch (error) {
    logger.warn('PrivateFeed: could not remember a revoked request', error)
  }
}

/** A follow request waiting on the owner: new, or (`renewal`) a member asking for a fresh grant. */
export interface PendingRequest extends FollowRequestDocument {
  renewal: boolean
}

export interface PrivateFollower {
  recipientId: string
  leafIndex: number
  grantedAt: number
}

/** What the owner's settings show. */
export interface OwnerOverview {
  feed: PrivateFeedDocument
  /** All of the owner's feeds, newest first. */
  feeds: PrivateFeedDocument[]
  followers: PrivateFollower[]
  keyGeneration: number
  /** The feed's seed is sealed to an encryption key the identity no longer uses. */
  keyRotated: boolean
  /** This device holds the current feed's seed, so a renewal can bring older posts along. */
  hasSeed: boolean
}

class PrivateFeedService {
  private readonly contractId = YAPPR_CONTRACT_ID

  // ============================================================
  // Reads
  // ============================================================

  /** Whether `ownerId` has a private feed. A failed read answers false (logged): use it to decorate, not to decide. */
  async hasPrivateFeed(ownerId: string): Promise<boolean> {
    try {
      return (await fetchCurrentFeed(ownerId)) !== null
    } catch (error) {
      logger.error('Error checking private feed status:', error)
      return false
    }
  }

  /** The owner's current feed, or null. Throws on a failed read. */
  async getCurrentFeed(ownerId: string, options: { fresh?: boolean } = {}): Promise<PrivateFeedDocument | null> {
    return fetchCurrentFeed(ownerId, options)
  }

  /** The current feed's members, by leaf. */
  async getPrivateFollowers(ownerId: string): Promise<PrivateFollower[]> {
    const feed = await fetchCurrentFeed(ownerId)
    if (!feed) return []
    return (await fetchMembers(ownerId, feed.feed)).map(toFollower)
  }

  async getPrivateFollowerCount(ownerId: string): Promise<number> {
    return (await this.getPrivateFollowers(ownerId)).length
  }

  /**
   * Follow requests waiting on the owner: requests with no grant in the
   * current feed (requests persist while the requester follows, PF8), less the
   * ones this device answered by revoking, plus `renewal` requests a member
   * re-made after their grant (their encryption key changed).
   */
  async getPendingRequests(ownerId: string): Promise<PendingRequest[]> {
    const feed = await fetchCurrentFeed(ownerId)
    if (!feed) return []
    const [requests, members] = await Promise.all([fetchFollowRequestsTo(ownerId), fetchMembers(ownerId, feed.feed)])
    const grantedAt = new Map(members.map((grant) => [grant.recipientId, grant.createdAt]))
    const answered = answeredRequests(ownerId)
    return requests.flatMap((request): PendingRequest[] => {
      const granted = grantedAt.get(request.$ownerId)
      if (granted !== undefined) return request.$createdAt > granted ? [{ ...request, renewal: true }] : []
      return answered.has(request.$id) ? [] : [{ ...request, renewal: false }]
    })
  }

  /** The owner's feed, followers and key state for Settings. Null when there is no feed. */
  async getOverview(ownerId: string): Promise<OwnerOverview | null> {
    const feeds = await fetchFeeds(ownerId, { fresh: true })
    const feed = feeds.find((doc) => doc.audience === undefined)
    if (!feed) return null
    const [members, keyGeneration, current] = await Promise.all([
      fetchMembers(ownerId, feed.feed),
      fetchLatestKeyGeneration(ownerId, feed.feed),
      this.currentEncryptionKeyId(ownerId),
    ])
    return {
      feed,
      feeds,
      followers: members.map(toFollower),
      keyGeneration,
      keyRotated: current !== null && current !== feed.keyId,
      hasSeed: privateFeedKeyStore.ownerKeys(ownerId, feed.feed) !== null,
    }
  }

  /** The id of the encryption key a new feed of `ownerId` would be sealed to, or null when it has none. */
  private async currentEncryptionKeyId(ownerId: string): Promise<number | null> {
    const identity = await identityService.getIdentity(ownerId, { fresh: isAppConnectBuild() })
    return identity ? findEncryptionKey(identity.publicKeys)?.id ?? null : null
  }

  // ============================================================
  // Opening a feed
  // ============================================================

  /** Turn the private feed on: open feed 1 (PF2 defaults). */
  async enablePrivateFeed(ownerId: string, encryptionPrivateKey: Uint8Array): Promise<PrivateFeedResult> {
    try {
      if (await fetchCurrentFeed(ownerId, { fresh: true })) return { success: false, error: 'Your private feed is already on.' }
    } catch (error) {
      logger.error('Error reading private feeds:', error)
      return { success: false, error: 'Could not check your private feed. Try again.' }
    }
    const opened = await this.openFeed(ownerId, encryptionPrivateKey)
    return opened.success ? { success: true } : opened
  }

  /**
   * Open the owner's next feed (`max(feed) + 1`; the unique `[$ownerId, feed]`
   * index refuses a second device opening the same number). `carryFrom` links
   * the predecessor's history; without it the new feed starts fresh.
   */
  async openFeed(
    ownerId: string,
    encryptionPrivateKey: Uint8Array,
    options: { carryFrom?: CarriedFeed; caps?: FeedCaps } = {},
  ): Promise<PrivateFeedResult & { feed?: PrivateFeedDocument }> {
    const caps = options.caps ?? DEFAULT_FEED_CAPS
    try {
      // Seal to the identity's current encryption key: on App Connect builds
      // the anchor's, which is what peers and this owner's other devices use.
      const identity = await identityService.getIdentity(ownerId, { fresh: isAppConnectBuild() })
      if (!identity) return { success: false, error: 'Could not read your identity. Try again.' }
      const publicKey = getPublicKey(encryptionPrivateKey)
      const matches = (data: unknown) => {
        const onChain = normalizeBytes(data)
        return onChain !== null && bytesEqual(onChain, publicKey)
      }
      const preferred = findEncryptionKey(identity.publicKeys)
      const key = preferred?.data && matches(preferred.data)
        ? preferred
        : isAppConnectBuild()
          ? undefined
          : identity.publicKeys.find((candidate) => candidate.purpose === KeyPurpose.ENCRYPTION
            && candidate.type === KeyType.ECDSA_SECP256K1 && !candidate.disabledAt && matches(candidate.data))
      if (!key) return { success: false, error: 'That encryption key is not the one on your identity.' }

      const feeds = await fetchFeeds(ownerId, { fresh: true })
      const feed = (feeds[0]?.feed ?? 0) + 1
      const seed = generateSeed()
      const ownerBytes = toBytes(ownerId)
      const data: Record<string, unknown> = {
        feed,
        treeCapacity: caps.treeCapacity,
        maxKeyGeneration: caps.maxKeyGeneration,
        keyId: key.id,
        encryptedSeed: await sealSeed(publicKey, seed, ownerBytes, feed, key.id),
      }
      if (options.carryFrom) data.carry = sealCarry(historyKey(seed), ownerBytes, feed, options.carryFrom)

      const result = await stateTransitionService.createDocument(this.contractId, DOCUMENT_TYPES.PRIVATE_FEED, ownerId, data)
      forgetFeeds(ownerId)
      if (!result.success) {
        if (isDuplicateUniqueIndexError(result.error)) {
          return { success: false, error: 'Your private feed changed on another device. Reload and try again.' }
        }
        return { success: false, error: result.error || 'Could not open your private feed.' }
      }
      privateFeedKeyStore.storeOwnerKeys(ownerId, feed, { seed, keyGeneration: 1, revokedLeaves: [], ...caps })
      const document: PrivateFeedDocument = {
        $id: String(result.document?.$id ?? ''), ownerId, createdAt: Date.now(), feed, ...caps, keyId: key.id,
        encryptedSeed: data.encryptedSeed as Uint8Array, ...(data.carry ? { carry: data.carry as Uint8Array } : {}),
      }
      return { success: true, feed: document }
    } catch (error) {
      logger.error('Error opening a private feed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Could not open your private feed.' }
    }
  }

  // ============================================================
  // Sync before write (design §6.1)
  // ============================================================

  /**
   * The current feed and this device's keys for it, recovered from the chain
   * when they are missing or behind. Fails closed: a failed read is an error,
   * never "no revocations".
   */
  async ownerFeedState(ownerId: string, encryptionPrivateKey?: Uint8Array): Promise<StateResult> {
    const feed = await fetchCurrentFeed(ownerId, { fresh: true })
    if (!feed) return failure('FEED_NOT_ENABLED')
    const local = privateFeedKeyStore.ownerKeys(ownerId, feed.feed)
    const chainGeneration = await fetchLatestKeyGeneration(ownerId, feed.feed)
    if (local && local.keyGeneration >= chainGeneration) return { success: true, state: { feed, keys: local } }
    if (!encryptionPrivateKey) return failure('SYNC_REQUIRED')
    return this.recoverOwnerFeed(ownerId, feed, encryptionPrivateKey, local?.seed)
  }

  /**
   * Rebuild this device's keys for `feed` from the chain: the seed (from this
   * device, or opened with the encryption key it was sealed to) and the
   * revocations in order.
   */
  async recoverOwnerFeed(ownerId: string, feed: PrivateFeedDocument, encryptionPrivateKey: Uint8Array, knownSeed?: Uint8Array): Promise<StateResult> {
    let seed = knownSeed
    if (!seed) {
      try {
        seed = await openSeed(encryptionPrivateKey, feed.encryptedSeed, toBytes(ownerId), feed.feed, feed.keyId)
      } catch {
        return failure('KEY_CHANGED')
      }
    }
    const rekeys = await fetchRekeys(ownerId, feed.feed, 1)
    rekeys.forEach((rekey, index) => {
      if (rekey.keyGeneration !== index + 2) throw new Error(`Missing key change ${index + 2} of your private feed`)
    })
    const keys: OwnerFeedKeys = {
      seed,
      keyGeneration: rekeys.length + 1,
      revokedLeaves: rekeys.map((rekey) => rekey.revokedLeaf),
      treeCapacity: feed.treeCapacity,
      maxKeyGeneration: feed.maxKeyGeneration,
    }
    privateFeedKeyStore.storeOwnerKeys(ownerId, feed.feed, keys)
    return { success: true, state: { feed, keys } }
  }

  /** Sync before write, as a plain success/failure for callers that only need the keys in place. */
  async syncAndRecover(ownerId: string, encryptionPrivateKey: Uint8Array): Promise<PrivateFeedResult> {
    try {
      const synced = await this.ownerFeedState(ownerId, encryptionPrivateKey)
      return synced.success ? { success: true } : synced
    } catch (error) {
      logger.error('Error syncing private feed keys:', error)
      return { success: false, error: 'Could not sync your private feed. Check your connection and try again.' }
    }
  }

  // ============================================================
  // Members
  // ============================================================

  /**
   * Write `recipientId`'s grant at `leafIndex` of the current feed: its path
   * keys at the current versions, the current CEK and the feed's history key,
   * sealed to `recipientPublicKey`.
   */
  async writeGrant(ownerId: string, state: OwnerFeedState, recipientId: string, recipientPublicKey: Uint8Array, leafIndex: number): Promise<PrivateFeedResult> {
    const { feed, keys } = state
    const encryptedPayload = await sealGrant(recipientPublicKey, toBytes(ownerId), toBytes(recipientId), {
      feed: feed.feed,
      keyGeneration: keys.keyGeneration,
      leafIndex,
      pathKeys: grantPathKeys(keys.seed, keys.treeCapacity, leafIndex, keys.revokedLeaves),
      cek: cekAt(keys.seed, keys.maxKeyGeneration, keys.keyGeneration),
      history: historyKey(keys.seed),
    })
    const result = await stateTransitionService.createDocument(this.contractId, DOCUMENT_TYPES.PRIVATE_FEED_GRANT, ownerId, {
      feed: feed.feed,
      recipientId: toBytes(recipientId),
      leafIndex,
      keyGeneration: keys.keyGeneration,
      encryptedPayload,
    })
    if (result.success) return { success: true }
    return grantRefusal(result.error) ?? { success: false, error: result.error || 'Could not approve this follower.' }
  }

  /**
   * Approve `requesterId`: a grant on the lowest free leaf of the current feed.
   * A member who asked again after their grant (their encryption key changed)
   * is re-granted on the same leaf.
   */
  async approveFollower(ownerId: string, requesterId: string, requesterPublicKey: Uint8Array, encryptionPrivateKey?: Uint8Array): Promise<PrivateFeedResult> {
    try {
      if (moveInProgress(ownerId)) return failure('MOVE_IN_PROGRESS')
      const request = await fetchFollowRequest(ownerId, requesterId)
      if (!request) return failure('REQUEST_WITHDRAWN')
      const synced = await this.ownerFeedState(ownerId, encryptionPrivateKey)
      if (!synced.success) return synced
      const { state } = synced
      const members = await fetchMembers(ownerId, state.feed.feed)
      const existing = members.find((grant) => grant.recipientId === requesterId)
      if (existing && request.$createdAt <= existing.createdAt) return { success: true }
      if (existing) {
        const removed = await stateTransitionService.deleteDocument(this.contractId, DOCUMENT_TYPES.PRIVATE_FEED_GRANT, existing.$id, ownerId)
        if (!removed.success) return { success: false, error: removed.error || 'Could not renew this follower\'s access.' }
      }
      const taken = new Set(members.filter((grant) => grant !== existing).map((grant) => grant.leafIndex))
      let leafIndex = existing?.leafIndex ?? -1
      for (let leaf = 0; leafIndex < 0 && leaf < state.feed.treeCapacity; leaf++) if (!taken.has(leaf)) leafIndex = leaf
      if (leafIndex < 0) return failure('FEED_FULL')
      return await this.writeGrant(ownerId, state, requesterId, requesterPublicKey, leafIndex)
    } catch (error) {
      logger.error('Error approving follower:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Could not approve this follower.' }
    }
  }

  /**
   * Revoke `followerId` (design §7.3): a rekey to the next generation that
   * their keys cannot follow, then their grant's deletion, which frees the
   * leaf. Grants they still hold in older feeds go too.
   */
  async revokeFollower(ownerId: string, followerId: string, encryptionPrivateKey?: Uint8Array): Promise<PrivateFeedResult> {
    try {
      if (moveInProgress(ownerId)) return failure('MOVE_IN_PROGRESS')
      const synced = await this.ownerFeedState(ownerId, encryptionPrivateKey)
      if (!synced.success) return synced
      const { feed, keys } = synced.state
      const [grant, request] = await Promise.all([fetchGrant(ownerId, feed.feed, followerId), fetchFollowRequest(ownerId, followerId)])
      if (grant) {
        const keyGeneration = keys.keyGeneration + 1
        if (keyGeneration > feed.maxKeyGeneration) return failure('GENERATIONS_USED')
        const rekey = buildRekey(keys.seed, keys, { ownerId: toBytes(ownerId), feed: feed.feed, keyGeneration }, keys.revokedLeaves, grant.leafIndex)
        const written = await stateTransitionService.createDocument(this.contractId, DOCUMENT_TYPES.PRIVATE_FEED_REKEY, ownerId, {
          feed: feed.feed, keyGeneration, revokedLeaf: grant.leafIndex, packets: rekey.packets, encryptedCEK: rekey.encryptedCEK,
        })
        if (!written.success) {
          // Another device revoked at this generation first: these keys are behind.
          if (isDuplicateUniqueIndexError(written.error)) return failure('SYNC_REQUIRED')
          return { success: false, error: written.error || 'Could not remove this follower.' }
        }
        privateFeedKeyStore.storeOwnerKeys(ownerId, feed.feed, { ...keys, keyGeneration, revokedLeaves: [...keys.revokedLeaves, grant.leafIndex] })
      }
      // The rekey is the revocation; deleting grants frees the leaf and the
      // follower's older-feed keys. A failed delete leaves them revoked.
      const grants = grant ? [grant, ...(await fetchGrantsTo(ownerId, followerId)).filter((g) => g.$id !== grant.$id)] : await fetchGrantsTo(ownerId, followerId)
      if (!grant && grants.length === 0) return { success: false, error: 'This person is not a private follower.' }
      await this.deleteGrants(ownerId, grants)
      if (request) markAnswered(ownerId, request.$id)
      return { success: true }
    } catch (error) {
      logger.error('Error revoking follower:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Could not remove this follower.' }
    }
  }

  /** Delete `grants`, best effort: each failure is logged and the rest go on. Returns how many were deleted. */
  async deleteGrants(ownerId: string, grants: readonly GrantDocument[]): Promise<number> {
    let deleted = 0
    for (const grant of grants) {
      const result = await stateTransitionService.deleteDocument(this.contractId, DOCUMENT_TYPES.PRIVATE_FEED_GRANT, grant.$id, ownerId)
      if (result.success) deleted++
      else logger.warn(`PrivateFeed: could not delete grant ${grant.$id}:`, result.error)
    }
    return deleted
  }
}

export const privateFeedService = new PrivateFeedService()
export type { PrivateFeedService }

// ============================================================
// Encryption for posts and replies
// ============================================================

export interface EncryptedPostData {
  encryptedContent: Uint8Array
  keyGeneration: number
  nonce: Uint8Array
  feed: number
  teaser?: string
}

export type PrepareEncryptionResult = { success: true; data: EncryptedPostData } | { success: false; error: string }

/** The largest plaintext, in UTF-8 bytes: `encryptedContent`'s maximum less the version byte and the tag. */
function plaintextTooLong(content: string): { success: false; error: string } | null {
  const size = new TextEncoder().encode(content).length
  const max = contentLimits().encryptedMaxBytes - CONTENT_OVERHEAD
  return size > max ? { success: false, error: `Content too long: ${size} bytes (max ${max})` } : null
}

const UNVERIFIED_ERROR = 'Could not confirm your private feed\'s current keys, so nothing was posted. Check your connection and try again.'

/**
 * Encrypt the owner's own private post or reply into their current feed at
 * its current generation, after syncing with the chain. Refused while
 * followers are being moved (PF4).
 */
export async function prepareOwnerEncryption(
  ownerId: string, content: string, kind: ContentKind, teaser?: string, encryptionPrivateKey?: Uint8Array,
): Promise<PrepareEncryptionResult> {
  const tooLong = plaintextTooLong(content)
  if (tooLong) return tooLong
  if (moveInProgress(ownerId)) return { success: false, error: MESSAGES.MOVE_IN_PROGRESS }
  let synced: StateResult
  try {
    synced = await privateFeedService.ownerFeedState(ownerId, encryptionPrivateKey)
  } catch (error) {
    logger.error('Error syncing private feed before posting:', error)
    return { success: false, error: UNVERIFIED_ERROR }
  }
  if (!synced.success) return { success: false, error: synced.error ?? UNVERIFIED_ERROR }
  const { feed, keys } = synced.state
  const owner = toBytes(ownerId)
  const encrypted = encryptContent(cekAt(keys.seed, keys.maxKeyGeneration, keys.keyGeneration), content, {
    feedOwnerId: owner, feed: feed.feed, keyGeneration: keys.keyGeneration, authorId: owner, kind,
  })
  return { success: true, data: { encryptedContent: encrypted.ciphertext, nonce: encrypted.nonce, keyGeneration: keys.keyGeneration, feed: feed.feed, teaser } }
}

/**
 * Encrypt a reply in someone's private thread (design §7.2): into the root
 * owner's CURRENT feed (not the root's own, which a renewal may have closed)
 * at its newest generation, so a follower revoked or not carried since the
 * root cannot read it. The replier must be a member of that feed.
 */
export async function prepareInheritedEncryption(
  content: string, source: { ownerId: string }, authorId: string, encryptionPrivateKey?: Uint8Array,
): Promise<PrepareEncryptionResult> {
  if (authorId === source.ownerId) return prepareOwnerEncryption(source.ownerId, content, 'reply', undefined, encryptionPrivateKey)
  const tooLong = plaintextTooLong(content)
  if (tooLong) return tooLong
  try {
    const { privateFeedFollowerService } = await import('./private-feed-follower-service')
    const ready = await privateFeedFollowerService.currentFeedKeys(source.ownerId, authorId)
    if (!ready.success) return { success: false, error: ready.error.startsWith('SYNC_REQUIRED:') ? ready.error : `Cannot encrypt reply: ${ready.error}` }
    const { feed, keys } = ready
    const encrypted = encryptContent(keys.cek, content, {
      feedOwnerId: toBytes(source.ownerId), feed, keyGeneration: keys.keyGeneration, authorId: toBytes(authorId), kind: 'reply',
    })
    return { success: true, data: { encryptedContent: encrypted.ciphertext, nonce: encrypted.nonce, keyGeneration: keys.keyGeneration, feed } }
  } catch (error) {
    logger.error('Error preparing inherited encryption:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Could not encrypt this reply.' }
  }
}
