/**
 * Reading private posts and replies for any viewer (design §5.4, §6.4).
 *
 * A private post names its feed owner, feed and key generation. Its content
 * key comes, in order, from:
 *
 *   1. this device's keys for that very feed: the owner's seed, a member's
 *      grant keys (caught up on rekeys when the post is newer), or a closed
 *      feed's history entry;
 *   2. a walk back from the newest feed this viewer can open (the owner's
 *      seed, or a member's grant) through each successor's `carry`, which
 *      seals the predecessor's final CEK and history key. Every step is kept
 *      as a history entry, so a walk is done once per device.
 *
 * A feed opened without a history link (a fresh start, or a renewal after the
 * owner's key changed without the old secret, PF5/PF9) ends the walk: what
 * came before it stays readable only to whoever already held its keys.
 */

import { logger } from '@/lib/logger'
import { privateFeedKeyStore } from './private-feed-key-store'
import { fetchFeeds, fetchGrant, fetchNewestGrant, type PrivateFeedDocument } from './private-feed-reads'
import { identifierToBytes } from './sdk-helpers'
import { targetKindOf } from '@/lib/contract-topology'
import { cekAt, decryptContent, hashBack, historyKey, openCarry, type ContentKind } from '@/lib/private-feed/crypto'

/** A private post or reply, as the reader needs it. */
export interface PrivateContent {
  /** Whose feed encrypted it: the author of a post; for a reply in a private thread, the root's author. */
  feedOwnerId: string
  feed: number
  keyGeneration: number
  nonce: Uint8Array
  encryptedContent: Uint8Array
  authorId: string
  kind: ContentKind
}

/**
 * Why content could not be read:
 * - `needs-key`: this viewer can read it, but this device needs their encryption key first;
 * - `no-access`: nothing this viewer holds reaches that feed;
 * - `revoked`: this viewer was removed before that key generation;
 * - `history-unavailable`: the feed is from before a renewal without a history link;
 * - `failed`: a read failed, or the ciphertext does not open.
 */
export type LockReason = 'needs-key' | 'no-access' | 'revoked' | 'history-unavailable' | 'failed'

export type ContentKeyResult = { cek: Uint8Array } | { reason: LockReason }
export type DecryptOutcome = { ok: true; text: string } | { ok: false; reason: LockReason }

/** The history key this viewer holds for `ownerId`'s feed `feed` without a network read, or null. */
function heldHistoryKey(viewerId: string, ownerId: string, feed: number): Uint8Array | null {
  if (viewerId === ownerId) {
    const owner = privateFeedKeyStore.ownerKeys(ownerId, feed)
    if (owner) return historyKey(owner.seed)
  }
  return privateFeedKeyStore.memberKeys(viewerId, ownerId, feed)?.history ?? privateFeedKeyStore.historyKeys(viewerId, ownerId, feed)?.history ?? null
}

/** The CEK for `keyGeneration` from keys this device holds for exactly this feed, catching a member up when needed. */
async function directKey(viewerId: string, ownerId: string, feed: number, keyGeneration: number): Promise<ContentKeyResult | null> {
  if (viewerId === ownerId) {
    const owner = privateFeedKeyStore.ownerKeys(ownerId, feed)
    if (owner && keyGeneration <= owner.maxKeyGeneration) return { cek: cekAt(owner.seed, owner.maxKeyGeneration, keyGeneration) }
  }
  let member = privateFeedKeyStore.memberKeys(viewerId, ownerId, feed)
  if (member && keyGeneration > member.keyGeneration) {
    const { privateFeedFollowerService } = await import('./private-feed-follower-service')
    const caught = await privateFeedFollowerService.catchUp(ownerId, feed, viewerId)
    if (!caught.success) {
      if (caught.error.startsWith('REVOKED:')) return { reason: 'revoked' }
      if (caught.error.startsWith('RECOVERY_NEEDED:')) return { reason: 'needs-key' }
      return { reason: 'failed' }
    }
    member = privateFeedKeyStore.memberKeys(viewerId, ownerId, feed)
  }
  if (member && keyGeneration <= member.keyGeneration) return { cek: hashBack(member.cek, member.keyGeneration, keyGeneration) }
  const history = privateFeedKeyStore.historyKeys(viewerId, ownerId, feed)
  if (history && keyGeneration <= history.finalKeyGeneration) return { cek: hashBack(history.cek, history.finalKeyGeneration, keyGeneration) }
  return null
}

/**
 * Walk from feed `from` (whose history key this viewer holds) back to
 * `target` through the carries, keeping every step. True when `target` was
 * reached.
 */
function walkBack(viewerId: string, ownerId: string, feeds: readonly PrivateFeedDocument[], from: number, target: number): boolean {
  const owner = identifierToBytes(ownerId)
  let feed = from
  let history = heldHistoryKey(viewerId, ownerId, from)
  while (history && feed > target) {
    const doc = feeds.find((candidate) => candidate.feed === feed)
    if (!doc?.carry) return false
    const previous = openCarry(history, owner, feed, doc.carry)
    privateFeedKeyStore.storeHistoryKeys(viewerId, ownerId, previous.feed, {
      finalKeyGeneration: previous.finalKeyGeneration, cek: previous.cek, history: previous.history,
    })
    feed = previous.feed
    history = previous.history
  }
  return feed === target
}

/**
 * The content key of `ownerId`'s feed `feed` at `keyGeneration` for
 * `viewerId`. `encryptionPrivateKey`, when given, lets this device recover
 * keys it does not hold yet (the owner's current seed, or the viewer's newest
 * grant).
 */
export async function contentKeyFor(
  viewerId: string, ownerId: string, feed: number, keyGeneration: number, encryptionPrivateKey?: Uint8Array,
): Promise<ContentKeyResult> {
  try {
    const direct = await directKey(viewerId, ownerId, feed, keyGeneration)
    if (direct) return direct

    // A grant of exactly this feed (current, or kept after a renewal without a history link, PF6b).
    if (viewerId !== ownerId) {
      const grant = await fetchGrant(ownerId, feed, viewerId)
      if (grant) {
        if (!encryptionPrivateKey) return { reason: 'needs-key' }
        const { privateFeedFollowerService } = await import('./private-feed-follower-service')
        const recovered = await privateFeedFollowerService.recoverFromGrant(grant, viewerId, encryptionPrivateKey)
        if (!recovered.success) return { reason: 'needs-key' }
        return (await directKey(viewerId, ownerId, feed, keyGeneration)) ?? { reason: 'revoked' }
      }
    }

    const feeds = await fetchFeeds(ownerId)
    const later = feeds.filter((doc) => doc.audience === undefined && doc.feed > feed).map((doc) => doc.feed)
    let start = later.find((candidate) => heldHistoryKey(viewerId, ownerId, candidate) !== null)
    if (start === undefined) {
      const recovered = await recoverNewest(viewerId, ownerId, encryptionPrivateKey)
      if (recovered !== 'recovered') return { reason: recovered }
      const again = await directKey(viewerId, ownerId, feed, keyGeneration)
      if (again) return again
      start = later.find((candidate) => heldHistoryKey(viewerId, ownerId, candidate) !== null)
      // Nothing held at or after this feed: it is newer than this viewer's access, not lost history.
      if (start === undefined) return { reason: viewerId !== ownerId && (privateFeedKeyStore.newestMemberFeed(viewerId, ownerId) ?? 0) < feed ? 'no-access' : 'history-unavailable' }
    }
    if (!walkBack(viewerId, ownerId, feeds, start, feed)) return { reason: 'history-unavailable' }
    return (await directKey(viewerId, ownerId, feed, keyGeneration)) ?? { reason: 'revoked' }
  } catch (error) {
    logger.error('Private content key could not be derived:', error)
    return { reason: 'failed' }
  }
}

/** Bring the viewer's newest openable feed onto this device: the owner's current seed, or their newest grant. */
async function recoverNewest(viewerId: string, ownerId: string, encryptionPrivateKey?: Uint8Array): Promise<'recovered' | LockReason> {
  if (viewerId === ownerId) {
    if (!encryptionPrivateKey) return 'needs-key'
    const { privateFeedService } = await import('./private-feed-service')
    const synced = await privateFeedService.ownerFeedState(ownerId, encryptionPrivateKey)
    if (synced.success) return 'recovered'
    return synced.errorCode === 'KEY_CHANGED' ? 'history-unavailable' : 'needs-key'
  }
  const grant = await fetchNewestGrant(ownerId, viewerId)
  if (!grant) return privateFeedKeyStore.newestMemberFeed(viewerId, ownerId) !== null ? 'revoked' : 'no-access'
  if (privateFeedKeyStore.memberKeys(viewerId, ownerId, grant.feed)) return 'recovered'
  if (!encryptionPrivateKey) return 'needs-key'
  const { privateFeedFollowerService } = await import('./private-feed-follower-service')
  const recovered = await privateFeedFollowerService.recoverFromGrant(grant, viewerId, encryptionPrivateKey)
  return recovered.success ? 'recovered' : 'needs-key'
}

/**
 * A post or reply as private content, or null when it is not private.
 * `feedOwnerId` is whose feed encrypted it: the author by default; for a reply
 * in a private thread, the thread root's author.
 */
export function privateContentOf(
  post: { author: { id: string }; encryptedContent?: Uint8Array; nonce?: Uint8Array; keyGeneration?: number; feed?: number; targetKind?: ContentKind; parentId?: string },
  feedOwnerId: string = post.author.id,
): PrivateContent | null {
  const { encryptedContent, nonce, keyGeneration, feed } = post
  if (!encryptedContent || !nonce || keyGeneration === undefined || feed === undefined) return null
  return { feedOwnerId, feed, keyGeneration, nonce, encryptedContent, authorId: post.author.id, kind: targetKindOf(post) }
}

/** Decrypt `content` for `viewerId` (see {@link contentKeyFor}). */
export async function decryptPrivateContent(content: PrivateContent, viewerId: string, encryptionPrivateKey?: Uint8Array): Promise<DecryptOutcome> {
  const key = await contentKeyFor(viewerId, content.feedOwnerId, content.feed, content.keyGeneration, encryptionPrivateKey)
  if ('reason' in key) return { ok: false, reason: key.reason }
  try {
    const text = decryptContent(key.cek, content.encryptedContent, content.nonce, {
      feedOwnerId: identifierToBytes(content.feedOwnerId),
      feed: content.feed,
      keyGeneration: content.keyGeneration,
      authorId: identifierToBytes(content.authorId),
      kind: content.kind,
    })
    return { ok: true, text }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
