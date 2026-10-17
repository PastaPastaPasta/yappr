/**
 * Building and opening the moderators' box on a v13 report of private
 * content (`lib/report-box.ts` holds the format and the cryptography).
 *
 * Filing: the box is sealed to the ENCRYPTION key of everyone who may
 * moderate when the report is filed (`moderatorIdsOf`: a seated elected
 * team's leader and members, or the interim's moderators and owner), and
 * carries the reporter's own CEK for the content's feed and key generation:
 * it opens that feed's posts up to that generation, never another feed (D12). Members
 * without an encryption key are left out; when none has one, nothing is
 * sealed and the reporter is pointed at the email channel instead.
 *
 * Reading: a moderator opens the box with their own encryption key (held on
 * this device) and decrypts the reported post or reply read-only.
 */
import { reportShape, targetKindOf } from '@/lib/contract-topology'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { logger } from '@/lib/logger'
import { maxReportBoxRecipients, openReportBox, sealReportBox, type ReportBoxPayload } from '@/lib/report-box'
import type { Post } from '@/lib/types'
import { identityService } from './identity-service'
import { moderationService, moderatorIdsOf } from './moderation-service'
import { identifierToBytes } from './sdk-helpers'

/** How a box for a report came out. */
export type ReportBoxOutcome =
  /** Sealed to `recipients` moderators; `missing` hold no usable encryption key. */
  | { kind: 'sealed'; box: Uint8Array; recipients: number; missing: number }
  /** Nobody moderating holds an encryption key: the content goes by email or not at all. */
  | { kind: 'no-recipients' }
  /** This device cannot read the content itself, so it has no key to hand over. */
  | { kind: 'no-key' }
  /** Nothing to seal: the content is public, or the contract takes no box. */
  | { kind: 'not-needed' }

/** True when a report of `target` should carry a box: private content on a contract that takes one. */
export function reportNeedsBox(target: Pick<Post, 'encryptedContent' | 'keyGeneration' | 'feed'>): boolean {
  return reportShape().boxMaxBytes !== null && !!target.encryptedContent?.length && target.keyGeneration !== undefined && target.feed !== undefined
}

/**
 * The compressed secp256k1 ENCRYPTION key `identityId` holds now, or null when
 * it holds none. Read fresh: a key disabled and replaced within the identity
 * cache's minute (a compromised key rotated) must not receive the feed key.
 * Throws when the read fails.
 */
async function encryptionKeyOf(identityId: string): Promise<Uint8Array | null> {
  return resolveEncryptionPublicKey(identityId, async () => (await identityService.getIdentity(identityId, { fresh: true }))?.publicKeys ?? null)
}

/**
 * The current moderators' encryption keys, and how many moderators have none.
 * Every input to this choice is read FRESH, in one pass: the team (a moderator
 * removed, or the interim owner replaced by a seated team, within the cache's
 * minute must not receive the key, and one just added must) and each member's
 * identity (a key disabled and replaced must not be used). Consensus never
 * checks who a box is sealed to, so this fails closed: when any read fails it
 * throws, and nothing is sealed (the report is refused, to try again).
 */
async function moderatorKeys(): Promise<{ keys: Uint8Array[]; missing: number }> {
  const team = await moderationService.getTeam({ fresh: true })
  const ids = team ? moderatorIdsOf(team) : []
  const keys = await Promise.all(ids.map((id) => encryptionKeyOf(id)))
  const found = keys.filter((key): key is Uint8Array => key !== null)
  return { keys: found, missing: ids.length - found.length }
}

/**
 * The identity whose private feed encrypted `target`, or null when that cannot
 * be told for certain: a post's author; for a reply in a private thread the
 * thread root's author (its replies inherit the root's encryption), and for a
 * private reply under a root read back public its own author (encrypted to
 * the replier's feed). A root that cannot be read, or a tombstone that no
 * longer says whether it was private, is uncertain: no key is chosen.
 */
async function feedOwnerOf(target: Post): Promise<string | null> {
  // The root may come from a cache, and so may the CEK below. Neither needs a
  // fresh read: the key is sealed only after it decrypts the target itself
  // ({@link opensTarget}), so a stale answer can only leave the box out.
  if (targetKindOf(target) !== 'reply') return target.author.id
  const rootId = target.rootPostId
  if (!rootId) return null
  const { postService } = await import('./post-service')
  const root = await postService.getPostById(rootId, { skipEnrichment: true })
  if (!root || root.deleted) return null
  return root.encryptedContent?.length ? root.author.id : target.author.id
}

/** The text of `target` under `cek` of `feedOwnerId`'s feed, or null when the key does not open it. */
async function openTarget(cek: Uint8Array, feedOwnerId: string, target: Pick<Post, 'author' | 'encryptedContent' | 'nonce' | 'keyGeneration' | 'feed' | 'targetKind' | 'parentId'>): Promise<string | null> {
  const { privateContentOf } = await import('./private-feed-reader')
  const content = privateContentOf(target, feedOwnerId)
  if (!content) return null
  const { decryptContent } = await import('@/lib/private-feed/crypto')
  try {
    return decryptContent(cek, content.encryptedContent, content.nonce, {
      feedOwnerId: identifierToBytes(feedOwnerId), feed: content.feed, keyGeneration: content.keyGeneration,
      authorId: identifierToBytes(content.authorId), kind: content.kind,
    })
  } catch {
    return null
  }
}

/** This device's CEK of `feedOwnerId`'s feed `feed` for `keyGeneration`: the owner's own keys, or a member's. */
async function contentKeyOf(feedOwnerId: string, feed: number, keyGeneration: number, viewerId: string): Promise<Uint8Array | null> {
  const { contentKeyFor } = await import('./private-feed-reader')
  const key = await contentKeyFor(viewerId, feedOwnerId, feed, keyGeneration)
  return 'cek' in key ? key.cek : null
}

/**
 * The box for `reporterId`'s report of `target`, or why there is none.
 * Throws only when the moderation team cannot be read: filing then waits
 * rather than sending a private report nobody can open.
 */
export async function buildReportBox(reporterId: string, target: Post): Promise<ReportBoxOutcome> {
  const maxBytes = reportShape().boxMaxBytes
  if (maxBytes === null || !reportNeedsBox(target)) return { kind: 'not-needed' }
  const keyGeneration = target.keyGeneration as number
  const feed = target.feed as number
  const feedOwnerId = await feedOwnerOf(target)
  const cek = feedOwnerId ? await contentKeyOf(feedOwnerId, feed, keyGeneration, reporterId) : null
  // A key of the wrong feed would hand the moderators someone else's posts and still not open this one.
  if (!feedOwnerId || !cek || (await openTarget(cek, feedOwnerId, target)) === null) return { kind: 'no-key' }
  const { keys, missing } = await moderatorKeys()
  if (keys.length === 0) return { kind: 'no-recipients' }
  const room = maxReportBoxRecipients(maxBytes)
  if (keys.length > room) logger.warn(`reportBox: ${keys.length} moderators, room for ${room}; the rest cannot open this report`)
  const sealed = keys.slice(0, room)
  const box = sealReportBox({ feedOwnerId, feed, keyGeneration, cek }, sealed, target.id)
  return { kind: 'sealed', box, recipients: sealed.length, missing: missing + keys.length - sealed.length }
}

/** What a moderator reads out of a box: the reported content, or why it cannot be read. */
export type OpenedReport = { kind: 'opened'; text: string } | { kind: 'failed'; reason: string }

/**
 * Open `box` (on the report of `target`) with the moderator's encryption key
 * and decrypt the private content read-only. Version 2 boxes are sealed with
 * the content's own feed and key generation, and anyone can seal a box to a
 * moderator's public key, so a box naming any other feed or generation is
 * refused before any key derivation.
 */
export async function openReportedContent(
  box: Uint8Array,
  target: Pick<Post, 'id' | 'author' | 'encryptedContent' | 'nonce' | 'keyGeneration' | 'feed' | 'targetKind' | 'parentId'>,
  encryptionPrivateKey: Uint8Array
): Promise<OpenedReport> {
  if (!target.encryptedContent || !target.nonce || target.keyGeneration === undefined || target.feed === undefined) return { kind: 'failed', reason: 'The content is not encrypted' }
  let payload: ReportBoxPayload
  try {
    payload = openReportBox(box, target.id, encryptionPrivateKey)
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : 'The box could not be opened' }
  }
  if (payload.feed !== target.feed || payload.keyGeneration !== target.keyGeneration) {
    return { kind: 'failed', reason: 'The box holds a key for another feed or generation than the content' }
  }
  const text = await openTarget(payload.cek, payload.feedOwnerId, target)
  return text === null ? { kind: 'failed', reason: 'The key in this report does not open the content' } : { kind: 'opened', text }
}
