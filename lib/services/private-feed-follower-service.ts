'use client';

/**
 * PrivateFeedFollowerService
 *
 * Follower-side operations for private feeds.
 * Implements PRD §3.3 interface.
 *
 * Operations:
 * - requestAccess(): Request access to a user's private feed
 * - cancelRequest(): Cancel a pending follow request
 * - canDecrypt(): Check if user can decrypt a feed owner's posts
 * - decryptPost(): Decrypt a private post
 * - catchUp(): Apply rekey documents to catch up on key state
 * - recoverFollowerKeys(): Recover keys from grant document
 *
 * See YAPPR_PRIVATE_FEED_SPEC.md for cryptographic details.
 * See YAPPR_PRIVATE_FEED_PRD.md for implementation guidance.
 */

import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import { privateFeedCryptoService } from './private-feed-crypto-service';
import { privateFeedKeyStore } from './private-feed-key-store';
import { privateFeedService } from './private-feed-service';
import type { PrivateFeedRekeyDocument } from './private-feed-service';
import type { NodeKey } from './private-feed-crypto-service';
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import { queryDocuments, identifierToBase58, identifierToBytes } from './sdk-helpers';
import { paginateFetchAll } from './pagination-utils';

/**
 * FollowRequest document from platform
 */
export interface FollowRequestDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  targetId: string;
  publicKey?: Uint8Array;
}

/**
 * PrivateFeedGrant document from platform
 */
export interface PrivateFeedGrantDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  recipientId: string;
  leafIndex: number;
  epoch: number;
  encryptedPayload: Uint8Array;
}

/**
 * Result of decrypting a private post
 */
export interface DecryptResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Encrypted post fields from a post document
 */
export interface EncryptedPostFields {
  encryptedContent: Uint8Array;
  epoch: number;
  nonce: Uint8Array;
  $ownerId: string;
}

/**
 * Convert base64 to Uint8Array
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

class PrivateFeedFollowerService {
  private readonly contractId = YAPPR_CONTRACT_ID;

  // ============================================================
  // Access Request Operations (SPEC §8.3)
  // ============================================================

  /**
   * Request access to a user's private feed
   *
   * @param ownerId - The feed owner's identity ID
   * @param myId - The requester's identity ID
   * @param publicKey - Optional: requester's encryption public key (if not on-chain)
   */
  async requestAccess(
    ownerId: string,
    myId: string,
    publicKey?: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Check if the owner has a private feed
      const hasPrivateFeed = await privateFeedService.hasPrivateFeed(ownerId);
      if (!hasPrivateFeed) {
        return { success: false, error: 'User does not have a private feed' };
      }

      // 2. Check if already approved
      const existingGrant = await this.getGrant(ownerId, myId);
      if (existingGrant) {
        return { success: false, error: 'Already approved for this private feed' };
      }

      // 3. Check if request already pending
      const existingRequest = await this.getFollowRequest(ownerId, myId);
      if (existingRequest) {
        return { success: false, error: 'Request already pending' };
      }

      // 4. Create FollowRequest document
      // targetId must be a byte array (Identifier type in contract)
      const documentData: Record<string, unknown> = {
        targetId: Array.from(identifierToBytes(ownerId)),
      };

      // Include public key if provided (for hash160-only keys on identity)
      if (publicKey) {
        documentData.publicKey = Array.from(publicKey);
      }

      console.log('Creating FollowRequest:', { targetId: ownerId });

      const result = await stateTransitionService.createDocument(
        this.contractId,
        DOCUMENT_TYPES.FOLLOW_REQUEST,
        myId,
        documentData
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to create follow request' };
      }

      // Note: Notifications are now discovered by querying followRequest documents directly
      // (see notification-service.ts getPrivateFeedNotifications). No need to create
      // separate notification documents, which would fail anyway due to ownership constraints.
      // The feed owner's client will find this request when polling for notifications.

      console.log('Follow request created successfully');
      return { success: true };
    } catch (error) {
      console.error('Error requesting access:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Cancel a pending follow request
   *
   * @param ownerId - The feed owner's identity ID
   * @param myId - The requester's identity ID
   */
  async cancelRequest(
    ownerId: string,
    myId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Find the existing request
      const request = await this.getFollowRequest(ownerId, myId);
      if (!request) {
        return { success: false, error: 'No pending request found' };
      }

      // 2. Delete the request (requester owns their own follow request)
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        DOCUMENT_TYPES.FOLLOW_REQUEST,
        request.$id,
        myId
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to delete follow request' };
      }

      console.log('Follow request cancelled successfully');
      return { success: true };
    } catch (error) {
      console.error('Error cancelling request:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get all follow requests targeting a feed owner (for owner to review)
   *
   * @param ownerId - The feed owner's identity ID
   */
  async getFollowRequestsForOwner(ownerId: string): Promise<FollowRequestDocument[]> {
    try {
      const sdk = await getEvoSdk();

      const { documents: allDocs } = await paginateFetchAll<FollowRequestDocument>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.FOLLOW_REQUEST,
          where: [['targetId', '==', ownerId]],
          // Use target index: [targetId, $createdAt] - must include all index fields in orderBy
          orderBy: [['targetId', 'asc'], ['$createdAt', 'desc']],
          limit: 100,
          ...(startAfter && { startAfter }),
        }),
        (doc) => ({
          $id: doc.$id as string,
          $ownerId: doc.$ownerId as string,
          $createdAt: doc.$createdAt as number,
          targetId: doc.targetId as string,
          publicKey: doc.publicKey ? this.normalizeBytes(doc.publicKey) : undefined,
        }),
        { maxResults: 1024 } // SPEC allows up to 1024 followers
      );

      // Filter out requests where a grant already exists (stale requests)
      const requests: FollowRequestDocument[] = [];
      for (const doc of allDocs) {
        const existingGrant = await this.getGrant(ownerId, doc.$ownerId);
        if (!existingGrant) {
          requests.push(doc);
        }
      }

      return requests;
    } catch (error) {
      console.error('Error fetching follow requests for owner:', error);
      return [];
    }
  }

  // ============================================================
  // Grant Query Operations
  // ============================================================

  /**
   * Get a specific follow request
   */
  async getFollowRequest(ownerId: string, requesterId: string): Promise<FollowRequestDocument | null> {
    try {
      const sdk = await getEvoSdk();

      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.FOLLOW_REQUEST,
        where: [
          ['targetId', '==', ownerId],
          ['$ownerId', '==', requesterId],
        ],
        limit: 1,
      });

      if (documents.length === 0) {
        return null;
      }

      const doc = documents[0];
      return {
        $id: doc.$id as string,
        $ownerId: doc.$ownerId as string,
        $createdAt: doc.$createdAt as number,
        targetId: doc.targetId as string,
        publicKey: doc.publicKey ? this.normalizeBytes(doc.publicKey) : undefined,
      };
    } catch (error) {
      console.error('Error fetching follow request:', error);
      return null;
    }
  }

  /**
   * Get a grant for a specific user
   */
  async getGrant(ownerId: string, recipientId: string): Promise<PrivateFeedGrantDocument | null> {
    try {
      const sdk = await getEvoSdk();

      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
        where: [
          ['$ownerId', '==', ownerId],
          ['recipientId', '==', recipientId],
        ],
        limit: 1,
      });

      if (documents.length === 0) {
        return null;
      }

      const doc = documents[0];
      return {
        $id: doc.$id as string,
        $ownerId: doc.$ownerId as string,
        $createdAt: doc.$createdAt as number,
        // Convert recipientId from base64 bytes (SDK format) to base58 string (identity ID format)
        recipientId: identifierToBase58(doc.recipientId) || '',
        leafIndex: doc.leafIndex as number,
        epoch: doc.epoch as number,
        encryptedPayload: this.normalizeBytes(doc.encryptedPayload),
      };
    } catch (error) {
      console.error('Error fetching grant:', error);
      return null;
    }
  }

  // ============================================================
  // Decryption Capability (SPEC §8.6)
  // ============================================================

  /**
   * Check if we can decrypt posts from a specific owner
   *
   * @param ownerId - The feed owner's identity ID
   */
  async canDecrypt(ownerId: string): Promise<boolean> {
    // Check if we have cached keys for this owner
    return privateFeedKeyStore.hasPathKeys(ownerId);
  }

  /**
   * Get the cached epoch for a feed owner
   *
   * @param ownerId - The feed owner's identity ID
   */
  getCachedEpoch(ownerId: string): number | null {
    return privateFeedKeyStore.getCachedEpoch(ownerId);
  }

  // ============================================================
  // Post Decryption (SPEC §8.6)
  // ============================================================

  /**
   * Decrypt a private post
   *
   * @param post - The encrypted post fields
   * @param myId - The current user's identity ID (optional, enables revocation detection)
   */
  async decryptPost(post: EncryptedPostFields, myId?: string): Promise<DecryptResult> {
    try {
      const ownerId = post.$ownerId;
      const postEpoch = post.epoch;

      // 1. Check if we have keys for this owner
      if (!privateFeedKeyStore.hasPathKeys(ownerId)) {
        return { success: false, error: 'No keys for this feed' };
      }

      // 2. Check if we need to catch up on rekeys
      const cachedEpoch = privateFeedKeyStore.getCachedEpoch(ownerId);
      if (cachedEpoch === null) {
        return { success: false, error: 'No cached CEK for this feed' };
      }

      // 3. If post epoch is newer than our cached epoch, catch up
      if (postEpoch > cachedEpoch) {
        const catchUpResult = await this.catchUp(ownerId, myId);
        if (!catchUpResult.success) {
          // BUG-017 fix: If recovery is needed (missing wrapNonceSalt), propagate special error
          // The UI layer can detect this and prompt the user to enter their encryption key
          // to re-recover from the grant document
          if (catchUpResult.error?.startsWith('RECOVERY_NEEDED:')) {
            return {
              success: false,
              error: 'REKEY_RECOVERY_NEEDED:Your access keys need to be refreshed. Please enter your encryption key to sync.'
            };
          }
          return { success: false, error: catchUpResult.error || 'Failed to catch up on rekeys' };
        }
      }

      // 4. Derive CEK for the post's epoch
      const cached = privateFeedKeyStore.getCachedCEK(ownerId);
      if (!cached) {
        return { success: false, error: 'No cached CEK after catch-up' };
      }

      let cek: Uint8Array;
      if (postEpoch === cached.epoch) {
        cek = cached.cek;
      } else if (postEpoch < cached.epoch) {
        // Derive backwards via hash chain
        cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, postEpoch);
      } else {
        return { success: false, error: 'Post epoch still newer than cached epoch after catch-up' };
      }

      // 5. Decrypt the content
      const ownerIdBytes = identifierToBytes(ownerId);
      try {
        const content = privateFeedCryptoService.decryptPostContent(
          cek,
          {
            ciphertext: post.encryptedContent,
            nonce: post.nonce,
            epoch: postEpoch,
          },
          ownerIdBytes
        );
        return { success: true, content };
      } catch (decryptError) {
        // Check if this is an "invalid tag" error (AES-GCM authentication failure)
        const errorMsg = decryptError instanceof Error ? decryptError.message : '';
        if (errorMsg.includes('invalid tag') || errorMsg.includes('tag doesn\'t match')) {
          // Decryption failed - keys don't work for this post.
          // This could be because:
          // 1. User was revoked (no grant)
          // 2. Post is from before a feed reset (encrypted with old seed)
          // 3. Post is from after user was revoked (they can't derive new epoch keys)
          //
          // NOTE: We do NOT clear local keys here because the user might still
          // be able to decrypt other posts (e.g., new posts after re-requesting access,
          // or old posts from before they were revoked).
          if (myId) {
            const grant = await this.getGrant(ownerId, myId);
            if (!grant) {
              // No grant - user was revoked or feed was reset and grants deleted
              return {
                success: false,
                error: 'REVOKED:Your access has been revoked.',
              };
            }
            // Has grant but keys don't work for this specific post
            // This is likely an old post from before a feed reset
            return {
              success: false,
              error: 'OLD_POST:This post was encrypted before your current access was granted and cannot be decrypted.',
            };
          }
          // No myId provided, generic error
          return {
            success: false,
            error: 'DECRYPT_FAILED:Decryption failed - keys may be invalid for this post.',
          };
        }
        throw decryptError;
      }
    } catch (error) {
      console.error('Error decrypting post:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Decryption failed',
      };
    }
  }

  // ============================================================
  // Key Catch-up (SPEC §8.7)
  // ============================================================

  /**
   * Catch up on rekey documents for a feed owner
   *
   * @param ownerId - The feed owner's identity ID
   */
  async catchUp(ownerId: string, myId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const cachedEpoch = privateFeedKeyStore.getCachedEpoch(ownerId);
      if (cachedEpoch === null) {
        return { success: false, error: 'No cached epoch - need to recover from grant first' };
      }

      // Fetch rekey documents newer than our cached epoch
      const rekeyDocs = await this.getRekeyDocumentsAfter(ownerId, cachedEpoch);
      if (rekeyDocs.length === 0) {
        // Already up to date
        return { success: true };
      }

      // Sort by epoch ascending to apply in order
      rekeyDocs.sort((a, b) => a.epoch - b.epoch);

      // Verify epoch continuity
      let expectedEpoch = cachedEpoch + 1;
      for (const rekey of rekeyDocs) {
        if (rekey.epoch !== expectedEpoch) {
          return { success: false, error: `Missing rekey for epoch ${expectedEpoch}` };
        }
        expectedEpoch++;
      }

      // Apply each rekey in order
      for (const rekey of rekeyDocs) {
        const result = await this.applyRekey(ownerId, rekey);
        if (!result.success) {
          // If we failed to derive root key, check if we've actually been revoked
          if (result.error?.includes('Failed to derive new root key') && myId) {
            const grant = await this.getGrant(ownerId, myId);
            if (!grant) {
              // Grant is gone - definitively revoked
              // Clear local keys since they're no longer valid
              privateFeedKeyStore.clearFeedKeys(ownerId);
              return { success: false, error: 'Access has been revoked' };
            }
          }
          return result;
        }
      }

      console.log(`Caught up on ${rekeyDocs.length} rekey(s) for owner ${ownerId}`);
      return { success: true };
    } catch (error) {
      console.error('Error catching up:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Catch-up failed',
      };
    }
  }

  /**
   * Apply a single rekey document (SPEC §8.7)
   * Uses public feedOwnerId for nonce derivation (SPEC §10)
   */
  private async applyRekey(
    ownerId: string,
    rekey: PrivateFeedRekeyDocument
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const ownerIdBytes = identifierToBytes(ownerId);

      // 1. Get current path keys
      const pathKeys = privateFeedKeyStore.getPathKeys(ownerId);
      if (!pathKeys) {
        return { success: false, error: 'No path keys found' };
      }

      // 2. Build key lookup from current path keys
      const keyLookup = new Map<string, NodeKey>();
      for (const pk of pathKeys) {
        keyLookup.set(`${pk.nodeId}:${pk.version}`, pk);
      }

      // 3. Parse rekey packets
      const packets = privateFeedCryptoService.decodeRekeyPackets(rekey.packets);

      // 4. Validate packets
      for (const packet of packets) {
        privateFeedCryptoService.validateRekeyPacket(packet);
      }

      // 5. Process packets iteratively (SPEC §8.7 step 4)
      const newKeys = new Map<number, NodeKey>();
      const decryptedPackets = new Set<number>();
      let progress = true;

      while (progress) {
        progress = false;

        for (let i = 0; i < packets.length; i++) {
          if (decryptedPackets.has(i)) continue;

          const packet = packets[i];
          const lookupKey = `${packet.encryptedUnderNodeId}:${packet.encryptedUnderVersion}`;

          // Check if we have the key to decrypt this packet
          let unwrapSourceKey: NodeKey | undefined;

          // First check newly decrypted keys from this rekey
          const newKey = newKeys.get(packet.encryptedUnderNodeId);
          if (newKey && newKey.version === packet.encryptedUnderVersion) {
            unwrapSourceKey = newKey;
          } else {
            // Check existing path keys
            unwrapSourceKey = keyLookup.get(lookupKey);
          }

          if (!unwrapSourceKey) continue;

          // Decrypt the packet
          const wrapKey = privateFeedCryptoService.deriveWrapKey(unwrapSourceKey.key);

          // Derive nonce using public feedOwnerId (SPEC §10)
          const nonce = privateFeedCryptoService.deriveRekeyNonce(
            ownerIdBytes,
            rekey.epoch,
            packet.targetNodeId,
            packet.targetVersion,
            packet.encryptedUnderNodeId,
            packet.encryptedUnderVersion
          );

          const aad = privateFeedCryptoService.buildRekeyAAD(
            ownerIdBytes,
            rekey.epoch,
            packet.targetNodeId,
            packet.targetVersion,
            packet.encryptedUnderNodeId,
            packet.encryptedUnderVersion
          );

          try {
            const unwrappedKey = privateFeedCryptoService.unwrapKey(
              wrapKey,
              packet.wrappedKey,
              nonce,
              aad
            );

            newKeys.set(packet.targetNodeId, {
              nodeId: packet.targetNodeId,
              version: packet.targetVersion,
              key: unwrappedKey,
            });
            decryptedPackets.add(i);
            progress = true;
          } catch {
            // Can't decrypt this packet yet, will retry on next iteration
          }
        }
      }

      // 6. Verify we got the new root key
      const newRootKey = newKeys.get(1);
      if (!newRootKey) {
        return { success: false, error: 'Failed to derive new root key - may be revoked' };
      }

      // 7. Decrypt CEK from encryptedCEK field
      const newCEK = privateFeedCryptoService.decryptCEK(
        newRootKey.key,
        rekey.encryptedCEK,
        ownerIdBytes,
        rekey.epoch
      );

      // 8. Update path keys with new versions
      const updatedPathKeys = pathKeys.map((pk) => {
        const newKey = newKeys.get(pk.nodeId);
        return newKey || pk;
      });

      // 9. Store updated state
      privateFeedKeyStore.storePathKeys(ownerId, updatedPathKeys);
      privateFeedKeyStore.storeCachedCEK(ownerId, rekey.epoch, newCEK);

      return { success: true };
    } catch (error) {
      console.error('Error applying rekey:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Rekey application failed',
      };
    }
  }

  /**
   * Get rekey documents with epoch greater than a given value
   */
  private async getRekeyDocumentsAfter(
    ownerId: string,
    afterEpoch: number
  ): Promise<PrivateFeedRekeyDocument[]> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll<PrivateFeedRekeyDocument>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
          where: [
            ['$ownerId', '==', ownerId],
            ['epoch', '>', afterEpoch],
          ],
          orderBy: [['epoch', 'asc']],
          limit: 100,
          ...(startAfter && { startAfter }),
        }),
        (doc) => ({
          $id: doc.$id as string,
          $ownerId: doc.$ownerId as string,
          $createdAt: doc.$createdAt as number,
          epoch: doc.epoch as number,
          revokedLeaf: doc.revokedLeaf as number,
          packets: this.normalizeBytes(doc.packets),
          encryptedCEK: this.normalizeBytes(doc.encryptedCEK),
        }),
        { maxResults: 2000 } // SPEC allows up to 2000 epochs
      );

      return documents;
    } catch (error) {
      console.error('Error fetching rekey documents:', error);
      return [];
    }
  }

  // ============================================================
  // Follower Recovery (SPEC §8.9)
  // ============================================================

  /**
   * Recover follower keys from grant document
   *
   * @param ownerId - The feed owner's identity ID
   * @param myId - The follower's identity ID
   * @param encryptionPrivateKey - The follower's encryption private key
   */
  async recoverFollowerKeys(
    ownerId: string,
    myId: string,
    encryptionPrivateKey: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Fetch grant
      const grant = await this.getGrant(ownerId, myId);
      if (!grant) {
        return { success: false, error: 'No grant found for this feed' };
      }

      // 2. Build AAD for grant decryption
      const ownerIdBytes = identifierToBytes(ownerId);
      const myIdBytes = identifierToBytes(myId);
      const aad = privateFeedCryptoService.buildGrantAAD(
        ownerIdBytes,
        myIdBytes,
        grant.leafIndex,
        grant.epoch
      );

      // 3. Decrypt grant payload using ECIES
      const payloadBytes = await privateFeedCryptoService.eciesDecrypt(
        encryptionPrivateKey,
        grant.encryptedPayload,
        aad
      );

      // 4. Decode and validate payload
      const payload = privateFeedCryptoService.decodeGrantPayload(payloadBytes);
      privateFeedCryptoService.validateGrantPayload(payload, grant.leafIndex);

      // 5. Store path keys and CEK
      privateFeedKeyStore.initializeFollowerState(
        ownerId,
        payload.pathKeys,
        payload.grantEpoch,
        payload.currentCEK
      );

      // 6. Catch up on any rekeys since grant epoch
      const catchUpResult = await this.catchUp(ownerId, myId);
      if (!catchUpResult.success) {
        // Log but don't fail - we have initial keys at least
        console.warn('Failed to catch up after recovery:', catchUpResult.error);
      }

      // 7. Clean up stale FollowRequest if it exists (PRD §4.5)
      this.cleanupStaleFollowRequest(ownerId, myId).catch(err => {
        console.warn('Failed to cleanup stale follow request after recovery:', err);
      });

      console.log(`Recovered follower keys for owner ${ownerId} at epoch ${payload.grantEpoch}`);
      return { success: true };
    } catch (error) {
      console.error('Error recovering follower keys:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Recovery failed',
      };
    }
  }

  // ============================================================
  // Access Status Query
  // ============================================================

  /**
   * Get the access status for a user's private feed
   *
   * @param ownerId - The feed owner's identity ID
   * @param myId - The requester's identity ID
   * @param autoCleanup - If true, automatically clean up stale FollowRequest when approved (default: true)
   */
  async getAccessStatus(
    ownerId: string,
    myId: string,
    autoCleanup: boolean = true
  ): Promise<'none' | 'pending' | 'approved' | 'approved-no-keys' | 'revoked'> {
    try {
      // Check if we have an active grant
      const grant = await this.getGrant(ownerId, myId);

      if (grant) {
        // We have a grant - check if we can still decrypt
        // If we have keys and can decrypt current epoch, we're approved
        const canDecrypt = await this.canDecrypt(ownerId);
        if (canDecrypt) {
          // Auto-cleanup: Delete stale FollowRequest if it exists (PRD §4.5)
          if (autoCleanup) {
            this.cleanupStaleFollowRequest(ownerId, myId).catch(err => {
              console.warn('Failed to cleanup stale follow request:', err);
            });
          }
          return 'approved';
        }

        // Grant exists but no local keys - distinguish from revoked
        // 'approved-no-keys' means user needs to enter encryption key to recover
        // This happens on new device or after clearing storage
        // True 'revoked' would mean the grant is orphaned from a previous epoch
        // We can't easily distinguish here, so we return 'approved-no-keys'
        // and let the recovery attempt determine if it's actually revoked
        return 'approved-no-keys';
      }

      // No grant - check for pending request
      const request = await this.getFollowRequest(ownerId, myId);
      if (request) {
        // Check if this user was previously approved and then revoked (PRD §4.7)
        // A revoked user has a FollowRequest but no grant, and the request was created
        // before any revocation occurred (meaning they were approved then revoked)
        const rekeyDocs = await this.getRekeyDocumentsAfter(ownerId, 0);
        if (rekeyDocs.length > 0) {
          // Revocations have occurred - check if request predates first revocation
          const requestCreatedAt = request.$createdAt as number;
          const firstRevocationAt = rekeyDocs[0].$createdAt;

          if (requestCreatedAt < firstRevocationAt) {
            // Request was created before any revocation, meaning this user
            // was approved (which would have happened after the request)
            // and then later revoked. Return 'revoked' state.
            console.log(`User ${myId} appears to be revoked: request created at ${requestCreatedAt}, first revocation at ${firstRevocationAt}`);
            return 'revoked';
          }
        }

        // Either no revocations have occurred, or request is newer than revocations
        // This is a genuinely pending request
        return 'pending';
      }

      return 'none';
    } catch (error) {
      console.error('Error getting access status:', error);
      return 'none';
    }
  }

  /**
   * Clean up stale FollowRequest after approval (PRD §4.5)
   *
   * After a user is approved for private feed access, their FollowRequest document
   * should be deleted since it's no longer needed. This is a best-effort cleanup
   * that doesn't affect the user's access (the grant is what matters).
   *
   * @param ownerId - The feed owner's identity ID
   * @param myId - The requester's identity ID
   */
  async cleanupStaleFollowRequest(
    ownerId: string,
    myId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if a follow request still exists
      const request = await this.getFollowRequest(ownerId, myId);
      if (!request) {
        // No stale request - nothing to clean up
        return { success: true };
      }

      // Delete the stale request
      console.log('Cleaning up stale FollowRequest for approved user:', myId);
      const result = await stateTransitionService.deleteDocument(
        this.contractId,
        DOCUMENT_TYPES.FOLLOW_REQUEST,
        request.$id,
        myId
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to delete stale follow request' };
      }

      console.log('Successfully cleaned up stale FollowRequest');
      return { success: true };
    } catch (error) {
      console.error('Error cleaning up stale follow request:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Cleanup failed',
      };
    }
  }

  /**
   * Clean up local keys for a feed (e.g., after being revoked)
   */
  clearFeedKeys(ownerId: string): void {
    privateFeedKeyStore.clearFeedKeys(ownerId);
  }

  // ============================================================
  // Background Key Sync (PRD §5.4)
  // ============================================================

  /**
   * Sync keys for all followed private feeds in background
   *
   * Per PRD §5.4 Key Caching:
   * "On app load:
   *  1. For each feed owner we follow privately:
   *     - Check if cachedEpoch < latest post epoch from that author
   *     - If stale, trigger background catch-up
   *  2. Decrypt posts using cached keys"
   *
   * This method should be called on app load/login to proactively
   * sync keys before the user tries to view private posts.
   *
   * @returns Summary of sync results
   */
  async syncFollowedFeeds(): Promise<{
    synced: string[];
    failed: string[];
    upToDate: string[];
  }> {
    const synced: string[] = [];
    const failed: string[] = [];
    const upToDate: string[] = [];

    try {
      // Get all feeds we have keys for
      const followedOwners = privateFeedKeyStore.getFollowedFeedOwners();

      if (followedOwners.length === 0) {
        console.log('PrivateFeedSync: No followed private feeds to sync');
        return { synced, failed, upToDate };
      }

      console.log(`PrivateFeedSync: Syncing ${followedOwners.length} followed private feed(s)`);

      // Process each feed owner in parallel (with limited concurrency)
      const CONCURRENCY_LIMIT = 3;
      const chunks: string[][] = [];
      for (let i = 0; i < followedOwners.length; i += CONCURRENCY_LIMIT) {
        chunks.push(followedOwners.slice(i, i + CONCURRENCY_LIMIT));
      }

      for (const chunk of chunks) {
        const results = await Promise.allSettled(
          chunk.map(async (ownerId) => {
            const result = await this.syncFeedKeys(ownerId);
            return { ownerId, result };
          })
        );

        for (const settledResult of results) {
          if (settledResult.status === 'fulfilled') {
            const { ownerId, result } = settledResult.value;
            if (result.status === 'synced') {
              synced.push(ownerId);
            } else if (result.status === 'up_to_date') {
              upToDate.push(ownerId);
            } else {
              failed.push(ownerId);
            }
          } else {
            // Promise rejected - shouldn't happen but handle gracefully
            console.error('PrivateFeedSync: Promise rejected:', settledResult.reason);
          }
        }
      }

      console.log(`PrivateFeedSync: Complete - synced: ${synced.length}, up-to-date: ${upToDate.length}, failed: ${failed.length}`);
      return { synced, failed, upToDate };
    } catch (error) {
      console.error('PrivateFeedSync: Error syncing feeds:', error);
      return { synced, failed, upToDate };
    }
  }

  /**
   * Sync keys for a single feed owner
   *
   * Checks if the cached epoch is behind the chain epoch and
   * triggers catch-up if needed.
   *
   * @param ownerId - The feed owner's identity ID
   * @param myId - The current user's identity ID (optional, enables revocation detection)
   */
  async syncFeedKeys(ownerId: string, myId?: string): Promise<{
    status: 'synced' | 'up_to_date' | 'failed';
    error?: string;
  }> {
    try {
      // Get cached epoch from local storage
      const cachedEpoch = privateFeedKeyStore.getCachedEpoch(ownerId);
      if (cachedEpoch === null) {
        // No cached epoch means we don't have keys properly initialized
        return { status: 'failed', error: 'No cached epoch' };
      }

      // Get latest epoch from chain
      const chainEpoch = await privateFeedService.getLatestEpoch(ownerId);

      if (chainEpoch <= cachedEpoch) {
        // Already up to date
        return { status: 'up_to_date' };
      }

      // Need to catch up
      console.log(`PrivateFeedSync: Catching up feed ${ownerId} from epoch ${cachedEpoch} to ${chainEpoch}`);
      const catchUpResult = await this.catchUp(ownerId, myId);

      if (catchUpResult.success) {
        return { status: 'synced' };
      } else {
        return { status: 'failed', error: catchUpResult.error };
      }
    } catch (error) {
      console.error(`PrivateFeedSync: Error syncing feed ${ownerId}:`, error);
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================================
  // Utility Methods
  // ============================================================

  /**
   * Normalize bytes from SDK response (may be base64 string or array)
   */
  private normalizeBytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (Array.isArray(value)) {
      return new Uint8Array(value);
    }
    if (typeof value === 'string') {
      try {
        return fromBase64(value);
      } catch {
        if (/^[0-9a-fA-F]+$/.test(value)) {
          const bytes = new Uint8Array(value.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(value.substr(i * 2, 2), 16);
          }
          return bytes;
        }
      }
    }
    console.warn('Unable to normalize bytes:', value);
    return new Uint8Array(0);
  }
}

// Export singleton instance
export const privateFeedFollowerService = new PrivateFeedFollowerService();

// Export class for testing
export { PrivateFeedFollowerService };
