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
import { fetchFeed, fetchFeeds, fetchGrant, mainFeeds, readGrantsTo, type GrantDocument, type PrivateFeedDocument } from './private-feed-reads'
import { identifierToBytes, RequestDeduplicator } from './sdk-helpers'
import { targetKindOf } from '@/lib/contract-topology'
import { cekAt, decryptContent, hashBack, historyKey, openCarry, type ContentKind } from '@/lib/private-feed/crypto'
import { bytesEqual } from '@/lib/bytes'

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

/** Which reason wins when several paths fail: the one that tells the viewer most about what would open it. */
const REASON_RANK: Record<LockReason, number> = { 'needs-key': 4, failed: 3, revoked: 2, 'history-unavailable': 1, 'no-access': 0 }

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

/** The owner's CEK of one feed at its current generation, per seed: deriving it walks the chain down from the cap. */
const ownerTops = new Map<string, { seed: Uint8Array; keyGeneration: number; cek: Uint8Array }>()

function ownerCek(ownerId: string, feed: number, keyGeneration: number): Uint8Array | null {
  const owner = privateFeedKeyStore.ownerKeys(ownerId, feed)
  if (!owner || keyGeneration > owner.keyGeneration) return null
  const name = `${ownerId}:${feed}`
  let top = ownerTops.get(name)
  if (!top || top.keyGeneration !== owner.keyGeneration || !bytesEqual(top.seed, owner.seed)) {
    top = { seed: owner.seed, keyGeneration: owner.keyGeneration, cek: cekAt(owner.seed, owner.maxKeyGeneration, owner.keyGeneration) }
    ownerTops.set(name, top)
  }
  return hashBack(top.cek, top.keyGeneration, keyGeneration)
}

/** The CEK from a closed feed's history entry (reached through a carry), or null. */
function historyCek(viewerId: string, ownerId: string, feed: number, keyGeneration: number): ContentKeyResult | null {
  const history = privateFeedKeyStore.historyKeys(viewerId, ownerId, feed)
  if (!history) return null
  return keyGeneration <= history.finalKeyGeneration ? { cek: hashBack(history.cek, history.finalKeyGeneration, keyGeneration) } : { reason: 'failed' }
}

/**
 * The CEK for `keyGeneration` from keys this device holds for exactly this
 * feed, catching a member up when the content is newer. A member re-approved
 * since their keys were kept recovers the new grant when the encryption key
 * is at hand. Content naming a generation the feed never reached does not
 * open (anyone can post a reply claiming one). A history entry for the feed
 * (a later grant's carry) counts even where the member's own keys stop.
 */
async function directKey(viewerId: string, ownerId: string, feed: number, keyGeneration: number, encryptionPrivateKey?: Uint8Array): Promise<ContentKeyResult | null> {
  if (viewerId === ownerId) {
    const cek = ownerCek(ownerId, feed, keyGeneration)
    if (cek) return { cek }
  }
  let member = privateFeedKeyStore.memberKeys(viewerId, ownerId, feed)
  if (member && keyGeneration > member.keyGeneration) {
    const { privateFeedFollowerService } = await import('./private-feed-follower-service')
    let caught = await privateFeedFollowerService.catchUp(ownerId, feed, viewerId)
    let reason: LockReason = 'failed'
    if (!caught.success && caught.error.startsWith('RECOVERY_NEEDED:')) {
      const grant = encryptionPrivateKey ? await fetchGrant(ownerId, feed, viewerId) : null
      if (grant && encryptionPrivateKey) caught = await privateFeedFollowerService.recoverFromGrant(grant, viewerId, encryptionPrivateKey)
      if (!caught.success) reason = 'needs-key'
    } else if (!caught.success && caught.error.startsWith('REVOKED:')) {
      reason = 'revoked'
    }
    // Catch-up keeps every generation it reached before it stopped (at a later removal, say): that may be enough.
    member = privateFeedKeyStore.memberKeys(viewerId, ownerId, feed)
    if (member && keyGeneration > member.keyGeneration) return historyCek(viewerId, ownerId, feed, keyGeneration) ?? { reason }
  }
  if (member && keyGeneration <= member.keyGeneration) return { cek: hashBack(member.cek, member.keyGeneration, keyGeneration) }
  return historyCek(viewerId, ownerId, feed, keyGeneration)
}

/** One of `ownerId`'s feeds, from the discovery list or, past its window, by a point read. */
async function feedDoc(feeds: readonly PrivateFeedDocument[], ownerId: string, feed: number): Promise<PrivateFeedDocument | null> {
  return feeds.find((candidate) => candidate.feed === feed) ?? fetchFeed(ownerId, feed)
}

/**
 * Walk from feed `from` (whose history key this viewer holds) back to
 * `target` through the carries, keeping every step. True when `target` was
 * reached.
 */
async function walkBack(viewerId: string, ownerId: string, feeds: readonly PrivateFeedDocument[], from: number, target: number): Promise<boolean> {
  const owner = identifierToBytes(ownerId)
  let feed = from
  let history = heldHistoryKey(viewerId, ownerId, from)
  while (history && feed > target) {
    const doc = await feedDoc(feeds, ownerId, feed)
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
 * Bring this viewer's keys for `doc` onto this device: the owner's seed (here
 * already, or opened with the encryption key it was sealed to), or the
 * member's grant of that feed (opened with their encryption key).
 */
async function openFeedKeys(viewerId: string, ownerId: string, doc: PrivateFeedDocument, grant: GrantDocument | null, encryptionPrivateKey?: Uint8Array): Promise<'recovered' | 'needs-key' | 'none'> {
  if (viewerId === ownerId) {
    const { privateFeedService } = await import('./private-feed-service')
    // Without the seed here or the key it is sealed to, a read would not change the answer.
    if (!encryptionPrivateKey && !privateFeedKeyStore.ownerKeys(ownerId, doc.feed)) return 'needs-key'
    const synced = await privateFeedService.feedState(ownerId, doc, encryptionPrivateKey)
    if (synced.success) return 'recovered'
    return synced.errorCode === 'SYNC_REQUIRED' ? 'needs-key' : 'none'
  }
  if (privateFeedKeyStore.memberKeys(viewerId, ownerId, doc.feed)) return 'recovered'
  if (!grant) return 'none'
  if (!encryptionPrivateKey) return 'needs-key'
  const { privateFeedFollowerService } = await import('./private-feed-follower-service')
  return (await privateFeedFollowerService.recoverFromGrant(grant, viewerId, encryptionPrivateKey)).success ? 'recovered' : 'needs-key'
}

/**
 * The content key of `ownerId`'s feed `feed` at `keyGeneration` for
 * `viewerId`. `encryptionPrivateKey`, when given, lets this device recover
 * keys it does not hold yet (the owner's seeds, or the viewer's grants).
 *
 * Every authorised path is tried before giving up: the viewer's keys for this
 * very feed (a member revoked here may still be granted its history through a
 * later feed's carry), then each later feed this viewer can open, newest
 * first, walking back through the carries (a fresh start breaks one walk, not
 * the ones from older retained grants).
 */
export async function contentKeyFor(
  viewerId: string, ownerId: string, feed: number, keyGeneration: number, encryptionPrivateKey?: Uint8Array,
): Promise<ContentKeyResult> {
  try {
    // Keys already on this device answer without a read.
    const direct = await directKey(viewerId, ownerId, feed, keyGeneration, encryptionPrivateKey)
    if (direct && 'cek' in direct) return direct
    const isOwner = viewerId === ownerId
    const feeds = await fetchFeeds(ownerId)
    const grants = isOwner ? [] : await readGrantsTo(ownerId, viewerId)
    const grantIn = (number: number) => grants.find((grant) => grant.feed === number) ?? null
    let fallback: LockReason | null = null
    const note = (reason: LockReason) => {
      if (fallback === null || REASON_RANK[reason] > REASON_RANK[fallback]) fallback = reason
    }

    if (direct) note(direct.reason)
    // This feed's own keys, unless this device holds a member's already (directKey caught those up):
    // a history entry reached through a later carry may stop short of the generation asked for.
    if (isOwner || !privateFeedKeyStore.memberKeys(viewerId, ownerId, feed)) {
      const doc = await feedDoc(feeds, ownerId, feed)
      const opened = doc ? await openFeedKeys(viewerId, ownerId, doc, grantIn(feed), encryptionPrivateKey) : 'none'
      if (opened === 'recovered') {
        const again = await directKey(viewerId, ownerId, feed, keyGeneration, encryptionPrivateKey)
        if (again && 'cek' in again) return again
        note(again?.reason ?? 'failed')
      } else if (opened === 'needs-key') note('needs-key')
    }

    // Walk starts: the newest main feeds, plus any feed the viewer holds a grant, keys or (the owner) a seed in, past the discovery window too.
    const starts = new Set(mainFeeds(feeds).map((doc) => doc.feed))
    for (const grant of grants) starts.add(grant.feed)
    if (isOwner) for (const held of privateFeedKeyStore.ownerFeeds(ownerId)) starts.add(held)
    else for (const entry of privateFeedKeyStore.memberFeeds(viewerId)) if (entry.ownerId === ownerId) starts.add(entry.feed)
    for (const number of [...starts].filter((candidate) => candidate > feed).sort((a, b) => b - a)) {
      if (!isOwner && !grantIn(number) && !privateFeedKeyStore.memberKeys(viewerId, ownerId, number) && !privateFeedKeyStore.historyKeys(viewerId, ownerId, number)) continue
      const later = await feedDoc(feeds, ownerId, number)
      if (!later || later.audience !== undefined) continue
      if (heldHistoryKey(viewerId, ownerId, later.feed) === null) {
        const opened = await openFeedKeys(viewerId, ownerId, later, grantIn(later.feed), encryptionPrivateKey)
        if (opened === 'needs-key') note('needs-key')
        if (opened !== 'recovered') continue
      }
      if (await walkBack(viewerId, ownerId, feeds, later.feed, feed)) {
        const found = historyCek(viewerId, ownerId, feed, keyGeneration)
        if (found && 'cek' in found) return found
      }
      note('history-unavailable')
    }
    if (fallback) return { reason: fallback }
    if (isOwner) return { reason: encryptionPrivateKey ? 'history-unavailable' : 'needs-key' }
    if (grants.length === 0) return { reason: privateFeedKeyStore.newestMemberFeed(viewerId, ownerId) !== null ? 'revoked' : 'no-access' }
    return { reason: Math.max(...grants.map((grant) => grant.feed)) < feed ? 'no-access' : 'history-unavailable' }
  } catch (error) {
    logger.error('Private content key could not be derived:', error)
    return { reason: 'failed' }
  }
}

type ThreadedContent = Parameters<typeof privateContentOf>[0] & { rootOwnerId?: string; rootPostId?: string }

// Thread roots, shared by every card of a thread and kept briefly (a failed read too, so cards do not retry it each render).
const rootReads = new RequestDeduplicator<string, Awaited<ReturnType<typeof readRoot>>>(30_000)

async function readRoot(rootPostId: string) {
  const { postService } = await import('./post-service')
  return postService.getPostById(rootPostId, { skipEnrichment: true })
}

/**
 * Whose feed encrypted a private post or reply: a post's author; for a reply
 * the thread root's author when the root is private (replies inherit its
 * encryption), the replier's own under a public root. Both are `certain`.
 * Otherwise it is a guess: a deleted root's author (the tombstone no longer
 * says whether it was private), else the reply's own `rootOwnerId`, or
 * `rootOwnerHint` (who started the thread).
 */
export async function privateFeedOwnerOf(reply: ThreadedContent, rootOwnerHint?: string): Promise<{ owner: string; certain: boolean }> {
  if (targetKindOf(reply) !== 'reply') return { owner: reply.author.id, certain: true }
  const rootPostId = reply.rootPostId
  const root = rootPostId ? await rootReads.dedupe(rootPostId, () => readRoot(rootPostId)) : null
  if (root && !root.deleted) return { owner: root.encryptedContent?.length ? root.author.id : reply.author.id, certain: true }
  return { owner: root?.author.id ?? reply.rootOwnerId ?? rootOwnerHint ?? reply.author.id, certain: false }
}

/** The other feed a guessed `owner` could be: the replier's own, or (when `owner` is the replier) the thread's root owner. */
export function otherFeedOwner(post: { author: { id: string }; rootOwnerId?: string }, owner: string, rootOwnerHint?: string): string | undefined {
  return owner !== post.author.id ? post.author.id : post.rootOwnerId ?? rootOwnerHint
}

/**
 * Decrypt a post or reply, working out whose feed encrypted it (see
 * {@link privateFeedOwnerOf}). When that owner is a guess and does not open it,
 * a reply's other candidate is tried ({@link otherFeedOwner}). The content
 * binding rejects a wrong owner. Returns the outcome and the owner it is
 * about (the one that opened it, else the likelier one); null when the
 * content is not private.
 */
export async function decryptPostOrReply(
  post: ThreadedContent, viewerId: string, encryptionPrivateKey?: Uint8Array, rootOwnerHint?: string,
): Promise<{ outcome: DecryptOutcome; feedOwnerId: string } | null> {
  const content = privateContentOf(post)
  if (!content) return null
  const { owner, certain } = await privateFeedOwnerOf(post, rootOwnerHint)
  const outcome = await decryptPrivateContent({ ...content, feedOwnerId: owner }, viewerId, encryptionPrivateKey)
  const other = otherFeedOwner(post, owner, rootOwnerHint)
  if (outcome.ok || certain || !other || other === owner) return { outcome, feedOwnerId: owner }
  const second = await decryptPrivateContent({ ...content, feedOwnerId: other }, viewerId, encryptionPrivateKey)
  return second.ok ? { outcome: second, feedOwnerId: other } : { outcome, feedOwnerId: owner }
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
