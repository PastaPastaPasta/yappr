/**
 * Private feeds, follower side (social v17, crypto v2).
 *
 * A follower asks once: their `followRequest` stays as standing consent while
 * they follow privately (PF8), so the owner can carry them into a renewed feed
 * without asking again; "Leave private feed" deletes it. The owner's grant
 * (one per feed) hands over the follower's path keys, the feed's current CEK
 * and its history key; rekeys move the keys on after each revocation.
 * "Feeds I can read" is the recipient-first grant index, so it holds on any
 * device (D32).
 */

import { logger } from '@/lib/logger'
import { stateTransitionService } from './state-transition-service'
import { privateFeedKeyStore, type MemberFeedKeys } from './private-feed-key-store'
import {
  fetchCurrentFeed, fetchFeed, fetchFollowRequest, fetchGrant, fetchGrantsHeldBy, fetchNewestGrant, fetchRekeys, grantIsRevoked,
  type GrantDocument,
} from './private-feed-reads'
import { identifierToBytes } from './sdk-helpers'
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants'
import { applyRekey, decodeRekeyPackets, openGrant } from '@/lib/private-feed/crypto'

/**
 * Where a viewer stands with someone's private feed:
 * - `approved`: a grant in force in the current feed and the keys on this device;
 * - `approved-no-keys`: that grant, but not yet the keys here (enter the encryption key);
 * - `renewing`: a grant in force only in an older feed and the request still stands: the owner renewed and is moving followers;
 * - `pending`: asked, and not answered since;
 * - `revoked`: the owner removed them (their grant's leaf was rekeyed), and they have not asked again;
 * - `none`: nothing, or they left (withdrew their request).
 */
export type AccessStatus = 'none' | 'pending' | 'approved' | 'approved-no-keys' | 'renewing' | 'revoked'

type Outcome = { success: true } | { success: false; error: string }

/** A follower's keys for an owner's current feed, ready to encrypt a reply. */
type CurrentKeys = { success: true; feed: number; keys: MemberFeedKeys } | { success: false; error: string }

class PrivateFeedFollowerService {
  private readonly contractId = YAPPR_CONTRACT_ID

  // ============================================================
  // Requests
  // ============================================================

  /**
   * Ask `ownerId` for access. A request that already stands is replaced by a
   * new one: that is how a revoked follower asks again, and how a member whose
   * encryption key changed asks for a fresh grant (the owner sees a request
   * newer than their grant).
   */
  async requestAccess(ownerId: string, myId: string, publicKey?: Uint8Array): Promise<Outcome> {
    if (ownerId === myId) return { success: false, error: 'You cannot request access to your own private feed' }
    try {
      const feed = await fetchCurrentFeed(ownerId)
      if (!feed) return { success: false, error: 'This person has no private feed' }
      const existing = await fetchFollowRequest(ownerId, myId)
      if (existing) {
        const removed = await stateTransitionService.deleteDocument(this.contractId, DOCUMENT_TYPES.FOLLOW_REQUEST, existing.$id, myId)
        if (!removed.success) return { success: false, error: removed.error || 'Could not send your request' }
      }
      const data: Record<string, unknown> = { targetId: identifierToBytes(ownerId) }
      if (publicKey) data.publicKey = publicKey
      const result = await stateTransitionService.createDocument(this.contractId, DOCUMENT_TYPES.FOLLOW_REQUEST, myId, data)
      return result.success ? { success: true } : { success: false, error: result.error || 'Could not send your request' }
    } catch (error) {
      logger.error('Error requesting access:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Could not send your request' }
    }
  }

  /**
   * Withdraw a request, or leave a private feed (PF8): delete the standing
   * request, so the owner no longer carries this follower into a renewed feed.
   * Keys already on this device keep reading what they could.
   */
  async leave(ownerId: string, myId: string): Promise<Outcome> {
    try {
      const request = await fetchFollowRequest(ownerId, myId)
      if (!request) return { success: false, error: 'No pending request found' }
      const result = await stateTransitionService.deleteDocument(this.contractId, DOCUMENT_TYPES.FOLLOW_REQUEST, request.$id, myId)
      return result.success ? { success: true } : { success: false, error: result.error || 'Could not withdraw your request' }
    } catch (error) {
      logger.error('Error leaving a private feed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Could not withdraw your request' }
    }
  }

  /** Withdraw a pending request (the same write as {@link leave}). */
  cancelRequest(ownerId: string, myId: string): Promise<Outcome> {
    return this.leave(ownerId, myId)
  }

  // ============================================================
  // Status
  // ============================================================

  /** Where `myId` stands with `ownerId`'s private feed (see {@link AccessStatus}). Throws on a failed read. */
  async getAccessStatus(ownerId: string, myId: string): Promise<AccessStatus> {
    const [feed, grant, request] = await Promise.all([fetchCurrentFeed(ownerId), fetchNewestGrant(ownerId, myId), fetchFollowRequest(ownerId, myId)])
    if (!feed) return 'none'
    if (!grant) return request ? 'pending' : 'none'
    const askedSince = !!request && request.$createdAt > grant.createdAt
    if (await grantIsRevoked(grant)) return askedSince ? 'pending' : 'revoked'
    if (!request) return 'none'
    if (grant.feed !== feed.feed) return 'renewing'
    const keys = privateFeedKeyStore.memberKeys(myId, ownerId, feed.feed)
    return keys && keys.leafIndex === grant.leafIndex && keys.keyGeneration >= grant.keyGeneration ? 'approved' : 'approved-no-keys'
  }

  // ============================================================
  // Keys
  // ============================================================

  /** Open `grant` with the follower's encryption key and keep its keys, then catch up on the feed's rekeys. */
  async recoverFromGrant(grant: GrantDocument, myId: string, encryptionPrivateKey: Uint8Array): Promise<Outcome> {
    const feed = await fetchFeed(grant.ownerId, grant.feed)
    if (!feed) return { success: false, error: 'This private feed could not be read' }
    let payload
    try {
      payload = await openGrant(encryptionPrivateKey, grant.encryptedPayload, identifierToBytes(grant.ownerId), identifierToBytes(myId), {
        feed: grant.feed, leafIndex: grant.leafIndex, keyGeneration: grant.keyGeneration, treeCapacity: feed.treeCapacity, maxKeyGeneration: feed.maxKeyGeneration,
      })
    } catch (error) {
      logger.warn('Private feed grant did not open:', error)
      return { success: false, error: 'KEY_MISMATCH:Your access was granted to a different encryption key. Ask for access again.' }
    }
    privateFeedKeyStore.storeMemberKeys(myId, grant.ownerId, grant.feed, {
      grantedAt: grant.createdAt, leafIndex: payload.leafIndex, keyGeneration: payload.keyGeneration, cek: payload.cek, history: payload.history,
      pathKeys: payload.pathKeys, treeCapacity: feed.treeCapacity, maxKeyGeneration: feed.maxKeyGeneration,
    })
    const caught = await this.catchUp(grant.ownerId, grant.feed, myId)
    if (!caught.success) logger.warn('Private feed keys recovered but not caught up:', caught.error)
    return { success: true }
  }

  /**
   * Apply `ownerId`'s rekeys of `feed` above the generation this device holds.
   * Fails with `REVOKED:` when the follower was removed, and `RECOVERY_NEEDED:`
   * when they were re-approved since (the keys here belong to the old grant).
   * Throws nothing; a failed read is a failure, never "up to date".
   */
  async catchUp(ownerId: string, feed: number, myId: string): Promise<Outcome> {
    try {
      let keys = privateFeedKeyStore.memberKeys(myId, ownerId, feed)
      if (!keys) return { success: false, error: 'No keys for this feed' }
      const rekeys = await fetchRekeys(ownerId, feed, keys.keyGeneration)
      for (const rekey of rekeys) {
        if (rekey.keyGeneration !== keys.keyGeneration + 1) return { success: false, error: `Missing key change ${keys.keyGeneration + 1}` }
        const ctx = { ownerId: identifierToBytes(ownerId), feed, keyGeneration: rekey.keyGeneration }
        const applied = applyRekey(keys.pathKeys, decodeRekeyPackets(rekey.packets, keys.treeCapacity), rekey.encryptedCEK, ctx)
        if (!applied) {
          // A grant newer than these keys (re-approved after a removal) takes over; else this leaf was revoked.
          const grant = await fetchGrant(ownerId, feed, myId)
          if (grant && grant.createdAt > keys.grantedAt) {
            return { success: false, error: 'RECOVERY_NEEDED:Your access was renewed. Enter your encryption key to sync.' }
          }
          if (!grant || rekey.revokedLeaf === keys.leafIndex) return { success: false, error: 'REVOKED:Your access has been revoked.' }
          return { success: false, error: 'This private feed\'s keys could not be updated' }
        }
        keys = { ...keys, keyGeneration: rekey.keyGeneration, cek: applied.cek, pathKeys: applied.pathKeys }
        privateFeedKeyStore.storeMemberKeys(myId, ownerId, feed, keys)
      }
      return { success: true }
    } catch (error) {
      logger.error('Error catching up on private feed keys:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Catch-up failed' }
    }
  }

  /**
   * `myId`'s up-to-date keys for `ownerId`'s current feed (to encrypt a reply
   * in their thread): caught up on every rekey, recovered from the grant with
   * the session's encryption key when this device has none.
   */
  async currentFeedKeys(ownerId: string, myId: string): Promise<CurrentKeys> {
    const feed = await fetchCurrentFeed(ownerId, { fresh: true })
    if (!feed) return { success: false, error: 'this private feed is gone' }
    if (!privateFeedKeyStore.memberKeys(myId, ownerId, feed.feed)) {
      const grant = await fetchGrant(ownerId, feed.feed, myId)
      if (!grant) return { success: false, error: 'you can reply once your access to this private feed is renewed' }
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
      const key = getEncryptionKeyBytes(myId)
      if (!key) return { success: false, error: 'SYNC_REQUIRED:Enter your encryption key to reply to private posts.' }
      const recovered = await this.recoverFromGrant(grant, myId, key)
      if (!recovered.success) return recovered
    }
    let caught = await this.catchUp(ownerId, feed.feed, myId)
    if (!caught.success && caught.error.startsWith('RECOVERY_NEEDED:')) {
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
      const key = getEncryptionKeyBytes(myId)
      const grant = key ? await fetchGrant(ownerId, feed.feed, myId) : null
      if (!key || !grant) return { success: false, error: 'SYNC_REQUIRED:Your private feed access was renewed. Enter your encryption key to sync.' }
      caught = await this.recoverFromGrant(grant, myId, key)
      if (caught.success) caught = await this.catchUp(ownerId, feed.feed, myId)
    }
    if (!caught.success) return caught
    const keys = privateFeedKeyStore.memberKeys(myId, ownerId, feed.feed)
    return keys ? { success: true, feed: feed.feed, keys } : { success: false, error: 'could not sync private feed keys' }
  }

  /**
   * On sign-in: bring every feed `viewerId` can read up to date, from the
   * grant index (any device): catch up where this device holds the keys,
   * recover where it does not and the session holds the encryption key.
   */
  async syncFollowedFeeds(viewerId: string): Promise<{ synced: string[]; failed: string[]; upToDate: string[] }> {
    const synced: string[] = []
    const failed: string[] = []
    const upToDate: string[] = []
    try {
      const grants = await fetchGrantsHeldBy(viewerId)
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
      const key = getEncryptionKeyBytes(viewerId)
      for (const grant of grants) {
        const label = `${grant.ownerId}:${grant.feed}`
        const held = privateFeedKeyStore.memberKeys(viewerId, grant.ownerId, grant.feed)
        if (!held && !key) continue
        const before = held?.keyGeneration
        let result = held ? await this.catchUp(grant.ownerId, grant.feed, viewerId) : await this.recoverFromGrant(grant, viewerId, key as Uint8Array)
        // Re-approved since these keys were kept: the new grant replaces them.
        if (!result.success && key && result.error.startsWith('RECOVERY_NEEDED:')) result = await this.recoverFromGrant(grant, viewerId, key)
        // A grant the owner revoked is kept as their answer: nothing to sync, nothing failed.
        if (!result.success && result.error.startsWith('REVOKED:')) continue
        if (!result.success) failed.push(label)
        else if (before !== undefined && privateFeedKeyStore.memberKeys(viewerId, grant.ownerId, grant.feed)?.keyGeneration === before) upToDate.push(label)
        else synced.push(label)
      }
    } catch (error) {
      logger.error('PrivateFeedSync: could not read the feeds you follow:', error)
    }
    return { synced, failed, upToDate }
  }
}

export const privateFeedFollowerService = new PrivateFeedFollowerService()
export { PrivateFeedFollowerService }
