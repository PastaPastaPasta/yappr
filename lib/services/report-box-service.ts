/**
 * Building and opening the moderators' box on a v13 report of private
 * content (`lib/report-box.ts` holds the format and the cryptography).
 *
 * Filing: the box is sealed to the ENCRYPTION key of everyone who may
 * moderate when the report is filed (`moderatorIdsOf`: a seated elected
 * team's leader and members, or the interim's moderators and owner), and
 * carries the reporter's own CEK for the content's key generation. Members
 * without an encryption key are left out; when none has one, nothing is
 * sealed and the reporter is pointed at the email channel instead.
 *
 * Reading: a moderator opens the box with their own encryption key (held on
 * this device) and decrypts the reported post or reply read-only.
 */
import { reportShape, targetKindOf } from '@/lib/contract-topology'
import { normalizeBytes } from '@/lib/bytes'
import { findEncryptionKey } from '@/lib/crypto/encryption-key-lookup'
import { KeyType } from '@/lib/crypto/identity-keys'
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
export function reportNeedsBox(target: Pick<Post, 'encryptedContent' | 'keyGeneration'>): boolean {
  return reportShape().boxMaxBytes !== null && !!target.encryptedContent?.length && target.keyGeneration !== undefined
}

/** A compressed secp256k1 ENCRYPTION key of `identityId`, or null when it holds none. */
async function encryptionKeyOf(identityId: string): Promise<Uint8Array | null> {
  const identity = await identityService.getIdentity(identityId)
  const key = identity ? findEncryptionKey(identity.publicKeys) : undefined
  if (!key || key.type !== KeyType.ECDSA_SECP256K1) return null
  const bytes = normalizeBytes(key.data)
  return bytes?.length === 33 ? bytes : null
}

/** The current moderators' encryption keys, and how many moderators have none. Throws when the team cannot be read. */
async function moderatorKeys(): Promise<{ keys: Uint8Array[]; missing: number }> {
  const team = await moderationService.getTeam()
  const ids = team ? moderatorIdsOf(team) : []
  const keys = await Promise.all(ids.map((id) => encryptionKeyOf(id).catch((error: unknown) => {
    logger.warn(`reportBox: could not read moderator ${id}'s encryption key`, error)
    return null
  })))
  const found = keys.filter((key): key is Uint8Array => key !== null)
  return { keys: found, missing: ids.length - found.length }
}

/**
 * The identity whose private feed encrypted `target`: a post's author; for a
 * reply in a private thread the thread root's author (its replies inherit the
 * root's encryption), and for a private reply under a public post its own
 * author (encrypted to the replier's feed).
 */
async function feedOwnerOf(target: Post): Promise<string> {
  if (targetKindOf(target) !== 'reply') return target.author.id
  const { getEncryptionSource } = await import('./reply-service')
  return (await getEncryptionSource(target))?.ownerId ?? target.author.id
}

/** This device's CEK of `feedOwnerId`'s feed for `keyGeneration`: the owner's own chain, or a follower's granted keys. */
async function contentKeyOf(feedOwnerId: string, keyGeneration: number, viewerId: string): Promise<Uint8Array | null> {
  const { privateFeedFollowerService, privateFeedKeyStore, privateFeedCryptoService, MAX_KEY_GENERATION } = await import('./index')
  if (feedOwnerId === viewerId) {
    const seed = privateFeedKeyStore.getFeedSeed()
    return seed ? privateFeedCryptoService.generateCekChain(seed, MAX_KEY_GENERATION)[keyGeneration] ?? null : null
  }
  const key = await privateFeedFollowerService.contentKeyFor(feedOwnerId, keyGeneration, viewerId)
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
  const feedOwnerId = await feedOwnerOf(target)
  const cek = await contentKeyOf(feedOwnerId, keyGeneration, reporterId)
  if (!cek) return { kind: 'no-key' }
  const { keys, missing } = await moderatorKeys()
  if (keys.length === 0) return { kind: 'no-recipients' }
  const room = maxReportBoxRecipients(maxBytes)
  if (keys.length > room) logger.warn(`reportBox: ${keys.length} moderators, room for ${room}; the rest cannot open this report`)
  const sealed = keys.slice(0, room)
  const box = sealReportBox({ feedOwnerId, keyGeneration, cek }, sealed, target.id)
  return { kind: 'sealed', box, recipients: sealed.length, missing: missing + keys.length - sealed.length }
}

/** What a moderator reads out of a box: the reported content, or why it cannot be read. */
export type OpenedReport = { kind: 'opened'; text: string } | { kind: 'failed'; reason: string }

/**
 * Open `box` (on the report of `target`) with the moderator's encryption key
 * and decrypt the private content read-only. The box's CEK may be of a later
 * generation than the content (it opens every earlier one).
 */
export async function openReportedContent(
  box: Uint8Array,
  target: Pick<Post, 'id' | 'encryptedContent' | 'nonce' | 'keyGeneration'>,
  encryptionPrivateKey: Uint8Array
): Promise<OpenedReport> {
  if (!target.encryptedContent || !target.nonce || target.keyGeneration === undefined) return { kind: 'failed', reason: 'The content is not encrypted' }
  let payload: ReportBoxPayload
  try {
    payload = openReportBox(box, target.id, encryptionPrivateKey)
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : 'The box could not be opened' }
  }
  if (target.keyGeneration > payload.keyGeneration) return { kind: 'failed', reason: 'The box holds an older key than the content needs' }
  const { privateFeedCryptoService } = await import('./private-feed-crypto-service')
  try {
    const cek = privateFeedCryptoService.deriveCEK(payload.cek, payload.keyGeneration, target.keyGeneration)
    const text = privateFeedCryptoService.decryptPostContent(cek, {
      ciphertext: target.encryptedContent,
      nonce: target.nonce,
      keyGeneration: target.keyGeneration,
    }, identifierToBytes(payload.feedOwnerId))
    return { kind: 'opened', text }
  } catch {
    return { kind: 'failed', reason: 'The key in this report does not open the content' }
  }
}
