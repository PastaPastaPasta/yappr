'use client';

/**
 * PrivateFeedService
 *
 * High-level operations for private feed management (owner side).
 * Implements PRD §3.2 interface.
 *
 * Operations:
 * - enablePrivateFeed(): Initialize a new private feed
 * - hasPrivateFeed(): Check if a user has a private feed
 * - approveFollower(): Grant access to a follower
 * - revokeFollower(): Revoke access from a follower
 *
 * For creating private posts, use postService.createPost() with encryption options.
 * Helper functions prepareOwnerEncryption() and prepareInheritedEncryption() are
 * exported for use by postService.
 *
 * See YAPPR_PRIVATE_FEED_SPEC.md for cryptographic details.
 * See YAPPR_PRIVATE_FEED_PRD.md for implementation guidance.
 */

import { getEvoSdk } from './evo-sdk-service';
import { stateTransitionService } from './state-transition-service';
import {
  privateFeedCryptoService,
  TREE_CAPACITY,
  MAX_EPOCH,
  PROTOCOL_VERSION,
} from './private-feed-crypto-service';
import { privateFeedKeyStore } from './private-feed-key-store';
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import { queryDocuments, identifierToBase58, identifierToBytes } from './sdk-helpers';
import { paginateFetchAll } from './pagination-utils';
import { identityService } from './identity-service';

// Max plaintext size per SPEC §7.5.1 (999 bytes to leave room for version prefix)
const MAX_PLAINTEXT_SIZE = 999;

/**
 * PrivateFeedState document from platform
 */
export interface PrivateFeedStateDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  treeCapacity: number;
  maxEpoch: number;
  encryptedSeed: Uint8Array;
}

/**
 * PrivateFeedRekey document from platform
 */
export interface PrivateFeedRekeyDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  epoch: number;
  revokedLeaf: number;
  packets: Uint8Array;
  encryptedCEK: Uint8Array;
}

/**
 * Result of creating a private post
 */
export interface PrivatePostResult {
  success: boolean;
  postId?: string;
  error?: string;
}

/**
 * Convert string to UTF-8 bytes
 */
function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
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

class PrivateFeedService {
  private readonly contractId = YAPPR_CONTRACT_ID;

  // ============================================================
  // Query Operations
  // ============================================================

  /**
   * Check if a user has a private feed enabled
   */
  async hasPrivateFeed(ownerId: string): Promise<boolean> {
    try {
      const state = await this.getPrivateFeedState(ownerId);
      return state !== null;
    } catch (error) {
      console.error('Error checking private feed status:', error);
      return false;
    }
  }

  /**
   * Get PrivateFeedState document for an owner
   */
  async getPrivateFeedState(ownerId: string): Promise<PrivateFeedStateDocument | null> {
    try {
      const sdk = await getEvoSdk();

      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_STATE,
        where: [['$ownerId', '==', ownerId]],
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
        treeCapacity: doc.treeCapacity as number,
        maxEpoch: doc.maxEpoch as number,
        encryptedSeed: this.normalizeBytes(doc.encryptedSeed),
      };
    } catch (error) {
      console.error('Error fetching private feed state:', error);
      return null;
    }
  }

  /**
   * Get the latest epoch for an owner by checking rekey documents
   * Returns 1 if no rekey documents exist
   */
  async getLatestEpoch(ownerId: string): Promise<number> {
    try {
      const sdk = await getEvoSdk();

      // Query rekey documents ordered by epoch descending to get the latest
      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
        where: [['$ownerId', '==', ownerId]],
        orderBy: [['epoch', 'desc']],
        limit: 1,
      });

      if (documents.length === 0) {
        return 1; // No revocations yet, epoch is 1
      }

      return documents[0].epoch as number;
    } catch (error) {
      console.error('Error fetching latest epoch:', error);
      return 1;
    }
  }

  /**
   * Get all rekey documents for an owner, ordered by epoch
   */
  async getRekeyDocuments(ownerId: string): Promise<PrivateFeedRekeyDocument[]> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll<PrivateFeedRekeyDocument>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
          where: [['$ownerId', '==', ownerId]],
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
  // Owner Operations
  // ============================================================

  /**
   * Enable private feed for the current user (SPEC §8.1)
   *
   * Prerequisites:
   * - User must have a contract-bound encryption key on their identity
   *
   * @param ownerId - The identity ID of the feed owner
   * @param encryptionPrivateKey - The private key for encryption (32 bytes)
   * @returns Promise<{success: boolean, error?: string}>
   */
  async enablePrivateFeed(
    ownerId: string,
    encryptionPrivateKey: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Check if feed already exists
      const existingState = await this.getPrivateFeedState(ownerId);
      if (existingState) {
        return { success: false, error: 'Private feed already enabled' };
      }

      // 2. Derive public key and verify it matches the identity's registered encryption key
      const encryptionPubKey = privateFeedCryptoService.getPublicKey(encryptionPrivateKey);

      // Verify the derived public key is registered on the identity
      const identity = await identityService.getIdentity(ownerId);
      if (!identity) {
        return { success: false, error: 'Could not fetch identity' };
      }

      const derivedPubKeyHex = Buffer.from(encryptionPubKey).toString('hex');
      const matchingKey = identity.publicKeys.find(
        key => key.purpose === 1 && key.type === 0 && !key.disabledAt &&
          Buffer.from(key.data).toString('hex') === derivedPubKeyHex
      );

      if (!matchingKey) {
        return {
          success: false,
          error: 'The provided encryption key does not match the encryption key registered on your identity',
        };
      }

      // 3. Generate feed seed (SPEC §8.1 step 1)
      const feedSeed = privateFeedCryptoService.generateFeedSeed();

      // 4. Pre-compute epoch chain (SPEC §8.1 steps 2-3)
      // Note: We don't store the full chain, just compute CEK[1] for immediate use
      const epochChain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH);
      const cek1 = epochChain[1];

      // 5. Encrypt feedSeed to owner's public key using ECIES (SPEC §8.1 step 4)
      // versionedPayload = 0x01 || feedSeed
      const versionedPayload = new Uint8Array(1 + feedSeed.length);
      versionedPayload[0] = PROTOCOL_VERSION;
      versionedPayload.set(feedSeed, 1);

      // AAD = "yappr/feed-state/v1" || ownerId
      const ownerIdBytes = identifierToBytes(ownerId);
      const aad = privateFeedCryptoService.buildFeedStateAAD(ownerIdBytes);

      const encryptedSeed = await privateFeedCryptoService.eciesEncrypt(
        encryptionPubKey,
        versionedPayload,
        aad
      );

      // 6. Create PrivateFeedState document (SPEC §8.1 step 5)
      const documentData = {
        treeCapacity: TREE_CAPACITY,
        maxEpoch: MAX_EPOCH,
        encryptedSeed: Array.from(encryptedSeed), // Convert to array for platform
      };

      console.log('Creating PrivateFeedState document:', {
        treeCapacity: TREE_CAPACITY,
        maxEpoch: MAX_EPOCH,
        encryptedSeedLength: encryptedSeed.length,
      });

      const result = await stateTransitionService.createDocument(
        this.contractId,
        DOCUMENT_TYPES.PRIVATE_FEED_STATE,
        ownerId,
        documentData
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to create PrivateFeedState' };
      }

      // 7. Initialize local state (SPEC §8.1 step 6)
      privateFeedKeyStore.initializeOwnerState(feedSeed, TREE_CAPACITY);

      // Store CEK[1] for immediate use
      privateFeedKeyStore.storeCachedCEK(ownerId, 1, cek1);

      console.log('Private feed enabled successfully');
      return { success: true };
    } catch (error) {
      console.error('Error enabling private feed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================================
  // Follower Management (SPEC §8.4 - Approve Follow Request)
  // ============================================================

  /**
   * Approve a follower and grant them access to the private feed
   *
   * @param ownerId - The identity ID of the feed owner
   * @param requesterId - The identity ID of the requester
   * @param requesterPublicKey - The requester's encryption public key
   * @param encryptionPrivateKey - Optional: owner's encryption key for automatic sync/recovery
   * @returns Promise<{success: boolean, error?: string}>
   */
  async approveFollower(
    ownerId: string,
    requesterId: string,
    requesterPublicKey: Uint8Array,
    encryptionPrivateKey?: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Get feed seed
      let feedSeed = privateFeedKeyStore.getFeedSeed();
      if (!feedSeed) {
        // Try to recover if we have the encryption key
        if (encryptionPrivateKey) {
          const recoveryResult = await this.recoverOwnerState(ownerId, encryptionPrivateKey);
          if (!recoveryResult.success) {
            return { success: false, error: `Recovery failed: ${recoveryResult.error}` };
          }
          feedSeed = privateFeedKeyStore.getFeedSeed();
          if (!feedSeed) {
            return { success: false, error: 'Private feed not initialized after recovery' };
          }
        } else {
          return { success: false, error: 'SYNC_REQUIRED:Private feed not initialized locally. Please enter your encryption key to sync.' };
        }
      }

      // 2. SYNC CHECK: Compare chain epoch vs local epoch
      const chainEpoch = await this.getLatestEpoch(ownerId);
      let localEpoch = privateFeedKeyStore.getCurrentEpoch();

      if (chainEpoch > localEpoch) {
        if (encryptionPrivateKey) {
          // Automatic recovery with provided key
          const recoveryResult = await this.recoverOwnerState(ownerId, encryptionPrivateKey);
          if (!recoveryResult.success) {
            return { success: false, error: `Sync failed: ${recoveryResult.error}` };
          }
          // Refresh feedSeed and localEpoch after recovery
          feedSeed = privateFeedKeyStore.getFeedSeed();
          localEpoch = privateFeedKeyStore.getCurrentEpoch();
          if (!feedSeed) {
            return { success: false, error: 'Feed seed not available after recovery' };
          }
          console.log('Automatic recovery completed, continuing with approval');
        } else {
          return {
            success: false,
            error: 'SYNC_REQUIRED:Local state out of sync. Please enter your encryption key to sync.',
          };
        }
      }

      // 3. Get an available leaf index (with chain verification to handle race conditions)
      // Fetch existing grants from chain to get authoritative used leaf indices
      const existingGrants = await this.getPrivateFollowers(ownerId);
      const usedLeafIndices = new Set(existingGrants.map(g => g.leafIndex));

      // Get local available leaves and filter out any that are already used on chain
      let availableLeaves = privateFeedKeyStore.getAvailableLeaves();
      if (!availableLeaves || availableLeaves.length === 0) {
        return { success: false, error: 'No available leaf slots (feed at capacity)' };
      }

      // Filter to only truly available leaves (not used on chain)
      availableLeaves = availableLeaves.filter(leaf => !usedLeafIndices.has(leaf));
      if (availableLeaves.length === 0) {
        // Local state was stale, rebuild from chain
        availableLeaves = [];
        for (let i = 0; i < TREE_CAPACITY; i++) {
          if (!usedLeafIndices.has(i)) {
            availableLeaves.push(i);
          }
        }
        // Update local state with corrected available leaves
        privateFeedKeyStore.storeAvailableLeaves(availableLeaves);

        if (availableLeaves.length === 0) {
          return { success: false, error: 'No available leaf slots (feed at capacity)' };
        }
      }

      const leafIndex = availableLeaves[0];

      // 4. Get revoked leaves to compute node versions
      const revokedLeaves = privateFeedKeyStore.getRevokedLeaves();

      // 5. Compute path from leaf to root and derive keys
      const path = privateFeedCryptoService.computePath(leafIndex);
      const pathKeys: Array<{ nodeId: number; version: number; key: Uint8Array }> = [];

      for (const nodeId of path) {
        const version = privateFeedCryptoService.computeNodeVersion(nodeId, revokedLeaves);
        const key = privateFeedCryptoService.deriveNodeKey(feedSeed, nodeId, version);
        pathKeys.push({ nodeId, version, key });
      }

      // 6. Get current CEK
      let cek: Uint8Array;
      const cached = privateFeedKeyStore.getCachedCEK(ownerId);

      if (cached && cached.epoch === localEpoch) {
        cek = cached.cek;
      } else if (cached && cached.epoch > localEpoch) {
        cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, localEpoch);
      } else {
        const chain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH);
        cek = chain[localEpoch];
      }

      // 7. Build grant payload
      const grantPayload = {
        version: PROTOCOL_VERSION,
        grantEpoch: localEpoch,
        leafIndex,
        pathKeys,
        currentCEK: cek,
      };

      // 8. Encode grant payload
      const encodedPayload = privateFeedCryptoService.encodeGrantPayload(grantPayload);

      // 9. Build AAD for ECIES encryption
      const ownerIdBytes = identifierToBytes(ownerId);
      const requesterIdBytes = identifierToBytes(requesterId);
      const aad = privateFeedCryptoService.buildGrantAAD(
        ownerIdBytes,
        requesterIdBytes,
        leafIndex,
        localEpoch
      );

      // 10. Encrypt payload using ECIES to requester's public key
      const encryptedPayload = await privateFeedCryptoService.eciesEncrypt(
        requesterPublicKey,
        encodedPayload,
        aad
      );

      // 11. Create PrivateFeedGrant document
      const documentData = {
        recipientId: requesterId,
        leafIndex,
        epoch: localEpoch,
        encryptedPayload: Array.from(encryptedPayload),
      };

      console.log('Creating PrivateFeedGrant document:', {
        recipientId: requesterId,
        leafIndex,
        epoch: localEpoch,
        encryptedPayloadLength: encryptedPayload.length,
      });

      const result = await stateTransitionService.createDocument(
        this.contractId,
        DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
        ownerId,
        documentData
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to create grant' };
      }

      // 12. Update local state - remove leaf from available and add to recipient map
      const newAvailable = availableLeaves.filter((l) => l !== leafIndex);
      privateFeedKeyStore.storeAvailableLeaves(newAvailable);

      const recipientMap = privateFeedKeyStore.getRecipientMap() || {};
      recipientMap[requesterId] = leafIndex;
      privateFeedKeyStore.storeRecipientMap(recipientMap);

      // Note: Notification documents cannot be created here due to ownership constraints
      // (we can't sign documents owned by the recipient). Followers discover approvals
      // by polling their grants via getMyGrants() or checking followRequest status.

      console.log(`Approved follower ${requesterId} with leaf index ${leafIndex}`);
      return { success: true };
    } catch (error) {
      console.error('Error approving follower:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Revoke a follower's access to the private feed (SPEC §8.5)
   *
   * @param ownerId - The identity ID of the feed owner
   * @param followerId - The identity ID of the follower to revoke
   * @param encryptionPrivateKey - Optional: owner's encryption key for automatic sync/recovery
   * @returns Promise<{success: boolean, error?: string}>
   */
  async revokeFollower(
    ownerId: string,
    followerId: string,
    encryptionPrivateKey?: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Get feed seed
      let feedSeed = privateFeedKeyStore.getFeedSeed();
      if (!feedSeed) {
        // Try to recover if we have the encryption key
        if (encryptionPrivateKey) {
          const recoveryResult = await this.recoverOwnerState(ownerId, encryptionPrivateKey);
          if (!recoveryResult.success) {
            return { success: false, error: `Recovery failed: ${recoveryResult.error}` };
          }
          feedSeed = privateFeedKeyStore.getFeedSeed();
          if (!feedSeed) {
            return { success: false, error: 'Private feed not initialized after recovery' };
          }
        } else {
          return { success: false, error: 'SYNC_REQUIRED:Private feed not initialized locally. Please enter your encryption key to sync.' };
        }
      }

      // 2. SYNC CHECK: Compare chain epoch vs local epoch
      const chainEpoch = await this.getLatestEpoch(ownerId);
      let localEpoch = privateFeedKeyStore.getCurrentEpoch();

      if (chainEpoch > localEpoch) {
        if (encryptionPrivateKey) {
          // Automatic recovery with provided key
          const recoveryResult = await this.recoverOwnerState(ownerId, encryptionPrivateKey);
          if (!recoveryResult.success) {
            return { success: false, error: `Sync failed: ${recoveryResult.error}` };
          }
          // Refresh feedSeed and localEpoch after recovery
          feedSeed = privateFeedKeyStore.getFeedSeed();
          localEpoch = privateFeedKeyStore.getCurrentEpoch();
          if (!feedSeed) {
            return { success: false, error: 'Feed seed not available after recovery' };
          }
          console.log('Automatic recovery completed, continuing with revocation');
        } else {
          return {
            success: false,
            error: 'SYNC_REQUIRED:Local state out of sync. Please enter your encryption key to sync.',
          };
        }
      }

      // 3. Get follower's grant to find their leaf index
      const sdk = await getEvoSdk();
      const grants = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
        where: [
          ['$ownerId', '==', ownerId],
          ['recipientId', '==', followerId],
        ],
        limit: 1,
      });

      if (grants.length === 0) {
        return { success: false, error: 'Follower not found' };
      }

      const grant = grants[0];
      const leafIndex = grant.leafIndex as number;
      const grantId = grant.$id as string;

      // 4. Advance epoch
      const newEpoch = localEpoch + 1;

      if (newEpoch > MAX_EPOCH) {
        return {
          success: false,
          error: 'Maximum revocations reached. Migration required.',
        };
      }

      // 5. Compute new CEK for the new epoch
      const epochChain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH);
      const newCEK = epochChain[newEpoch];

      // 6. Compute revoked path from leaf to root
      const revokedPath = privateFeedCryptoService.computePath(leafIndex);

      // 7. Get current revoked leaves and add the new one
      const revokedLeaves = privateFeedKeyStore.getRevokedLeaves();
      const newRevokedLeaves = [...revokedLeaves, leafIndex];

      // 8. Compute new versions and keys for nodes on revoked path
      const newVersions: Map<number, number> = new Map();
      const newKeys: Map<number, Uint8Array> = new Map();

      // Skip the leaf itself (index 0), compute for all other nodes on path
      for (let i = 1; i < revokedPath.length; i++) {
        const nodeId = revokedPath[i];
        const newVersion = privateFeedCryptoService.computeNodeVersion(nodeId, newRevokedLeaves);
        newVersions.set(nodeId, newVersion);
        newKeys.set(nodeId, privateFeedCryptoService.deriveNodeKey(feedSeed, nodeId, newVersion));
      }

      // 9. Get owner ID bytes for nonce derivation (SPEC §10)
      const ownerIdBytes = identifierToBytes(ownerId);

      // 10. Create rekey packets (bottom-up per SPEC §8.5 step 7)
      const packets: Array<{
        targetNodeId: number;
        targetVersion: number;
        encryptedUnderNodeId: number;
        encryptedUnderVersion: number;
        wrappedKey: Uint8Array;
      }> = [];

      for (let i = 1; i < revokedPath.length; i++) {
        const nodeId = revokedPath[i];
        const childOnPath = revokedPath[i - 1];
        const siblingOfChild = privateFeedCryptoService.sibling(childOnPath);

        const targetVersion = newVersions.get(nodeId);
        const newNodeKey = newKeys.get(nodeId);
        if (targetVersion === undefined || !newNodeKey) {
          throw new Error(`Missing version or key for node ${nodeId}`);
        }

        // Packet A: encrypt new key under sibling's CURRENT version key
        const siblingVersion = privateFeedCryptoService.computeNodeVersion(
          siblingOfChild,
          revokedLeaves
        );
        const siblingKey = privateFeedCryptoService.deriveNodeKey(
          feedSeed,
          siblingOfChild,
          siblingVersion
        );
        const wrapKeyA = privateFeedCryptoService.deriveWrapKey(siblingKey);
        const nonceA = privateFeedCryptoService.deriveRekeyNonce(
          ownerIdBytes,
          newEpoch,
          nodeId,
          targetVersion,
          siblingOfChild,
          siblingVersion
        );
        const aadA = privateFeedCryptoService.buildRekeyAAD(
          ownerIdBytes,
          newEpoch,
          nodeId,
          targetVersion,
          siblingOfChild,
          siblingVersion
        );

        packets.push({
          targetNodeId: nodeId,
          targetVersion,
          encryptedUnderNodeId: siblingOfChild,
          encryptedUnderVersion: siblingVersion,
          wrappedKey: privateFeedCryptoService.wrapKey(wrapKeyA, newNodeKey, nonceA, aadA),
        });

        // Packet B: encrypt new key under the UPDATED child's NEW key
        // Skip for the first updated node (its child is the revoked leaf)
        if (i > 1) {
          const updatedChild = revokedPath[i - 1];
          const childNewVersion = newVersions.get(updatedChild);
          const childNewKey = newKeys.get(updatedChild);
          if (childNewVersion === undefined || !childNewKey) {
            throw new Error(`Missing version or key for updated child node ${updatedChild}`);
          }
          const wrapKeyB = privateFeedCryptoService.deriveWrapKey(childNewKey);
          const nonceB = privateFeedCryptoService.deriveRekeyNonce(
            ownerIdBytes,
            newEpoch,
            nodeId,
            targetVersion,
            updatedChild,
            childNewVersion
          );
          const aadB = privateFeedCryptoService.buildRekeyAAD(
            ownerIdBytes,
            newEpoch,
            nodeId,
            targetVersion,
            updatedChild,
            childNewVersion
          );

          packets.push({
            targetNodeId: nodeId,
            targetVersion,
            encryptedUnderNodeId: updatedChild,
            encryptedUnderVersion: childNewVersion,
            wrappedKey: privateFeedCryptoService.wrapKey(wrapKeyB, newNodeKey, nonceB, aadB),
          });
        }
      }

      // 11. Get new root key and encrypt CEK
      const newRootKey = newKeys.get(1); // Root is node 1
      if (!newRootKey) {
        throw new Error('Missing root key');
      }
      const encryptedCEK = privateFeedCryptoService.encryptCEK(
        newRootKey,
        newCEK,
        ownerIdBytes,
        newEpoch
      );

      // 12. Encode packets
      const encodedPackets = privateFeedCryptoService.encodeRekeyPackets(packets);

      // 13. Create PrivateFeedRekey document
      const rekeyData = {
        epoch: newEpoch,
        revokedLeaf: leafIndex,
        packets: Array.from(encodedPackets),
        encryptedCEK: Array.from(encryptedCEK),
      };

      console.log('Creating PrivateFeedRekey document:', {
        epoch: newEpoch,
        revokedLeaf: leafIndex,
        packetsCount: packets.length,
        packetsLength: encodedPackets.length,
        encryptedCEKLength: encryptedCEK.length,
      });

      const rekeyResult = await stateTransitionService.createDocument(
        this.contractId,
        DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
        ownerId,
        rekeyData
      );

      if (!rekeyResult.success) {
        return { success: false, error: rekeyResult.error || 'Failed to create rekey document' };
      }

      // 14. Update local state
      privateFeedKeyStore.storeCurrentEpoch(newEpoch);
      privateFeedKeyStore.storeRevokedLeaves(newRevokedLeaves);

      // Update recipient map
      const recipientMap = privateFeedKeyStore.getRecipientMap() || {};
      delete recipientMap[followerId];
      privateFeedKeyStore.storeRecipientMap(recipientMap);

      // Add leaf back to available (after grant deletion)
      // Note: We'll do this after grant deletion for consistency

      // 15. Delete PrivateFeedGrant document
      console.log(`Deleting grant document: ${grantId}`);

      const deleteResult = await stateTransitionService.deleteDocument(
        this.contractId,
        DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
        grantId,
        ownerId
      );

      if (!deleteResult.success) {
        // Grant deletion failed but rekey exists - user is cryptographically revoked
        // This is acceptable per SPEC §8.5, log error and schedule retry
        console.error('Failed to delete grant:', deleteResult.error);
        // Still return success since the cryptographic revocation is complete
      }

      // Update available leaves
      const availableLeaves = privateFeedKeyStore.getAvailableLeaves() || [];
      if (!availableLeaves.includes(leafIndex)) {
        availableLeaves.push(leafIndex);
        privateFeedKeyStore.storeAvailableLeaves(availableLeaves);
      }

      // Update cached CEK
      privateFeedKeyStore.storeCachedCEK(ownerId, newEpoch, newCEK);

      // Note: Notification documents cannot be created here due to ownership constraints
      // (we can't sign documents owned by the recipient). Revoked followers discover
      // revocation when their grant stops working or via grant expiry checks.

      console.log(`Revoked follower ${followerId} (leaf ${leafIndex}), new epoch: ${newEpoch}`);
      return { success: true };
    } catch (error) {
      console.error('Error revoking follower:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get all private followers (from grants)
   *
   * @param ownerId - The identity ID of the feed owner
   */
  async getPrivateFollowers(ownerId: string): Promise<Array<{ recipientId: string; leafIndex: number; grantedAt: number }>> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll<{ recipientId: string; leafIndex: number; grantedAt: number }>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
          where: [['$ownerId', '==', ownerId]],
          orderBy: [['leafIndex', 'asc']],
          limit: 100,
          ...(startAfter && { startAfter }),
        }),
        (doc) => ({
          // Convert recipientId from base64 bytes (SDK format) to base58 string (identity ID format)
          recipientId: identifierToBase58(doc.recipientId) || '',
          leafIndex: doc.leafIndex as number,
          grantedAt: doc.$createdAt as number,
        }),
        { maxResults: 1024 } // SPEC allows up to 1024 followers
      );

      return documents;
    } catch (error) {
      console.error('Error fetching private followers:', error);
      return [];
    }
  }

  // ============================================================
  // Owner State Accessors
  // ============================================================

  /**
   * Get current epoch from local storage
   */
  getCurrentEpoch(): number {
    return privateFeedKeyStore.getCurrentEpoch();
  }

  /**
   * Get available leaf count from local storage
   */
  getAvailableLeafCount(): number {
    const leaves = privateFeedKeyStore.getAvailableLeaves();
    return leaves ? leaves.length : 0;
  }

  /**
   * Get revoked leaves from local storage
   */
  getRevokedLeaves(): number[] {
    return privateFeedKeyStore.getRevokedLeaves();
  }

  /**
   * Check if local keys are initialized (owner has enabled private feed locally)
   */
  isLocallyInitialized(): boolean {
    return privateFeedKeyStore.hasFeedSeed();
  }

  // ============================================================
  // Reset Operations (PRD §9)
  // ============================================================

  /**
   * Reset private feed - creates new seed, invalidating all existing followers
   *
   * This operation:
   * - Generates a new feed seed and encrypts it to the owner's encryption key
   * - Updates the existing PrivateFeedState document with the new encrypted seed
   * - Clears all local state (epoch, revoked leaves, recipient map)
   * - Orphans all existing PrivateFeedGrant and PrivateFeedRekey documents
   *
   * Consequences (per PRD §9.2):
   * - All existing followers lose access (their grants are encrypted to old keys)
   * - All existing private posts become unreadable (encrypted with old CEKs)
   * - Followers must re-request access and be re-approved
   *
   * @param ownerId - The identity ID of the feed owner
   * @param encryptionPrivateKey - The owner's encryption private key (32 bytes)
   * @returns Promise<{success: boolean, error?: string}>
   */
  async resetPrivateFeed(
    ownerId: string,
    encryptionPrivateKey: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Get existing PrivateFeedState document
      const existingState = await this.getPrivateFeedState(ownerId);
      if (!existingState) {
        return { success: false, error: 'Private feed not enabled' };
      }

      // 2. Verify user has the encryption key by deriving public key
      const encryptionPubKey = privateFeedCryptoService.getPublicKey(encryptionPrivateKey);

      // 3. Delete all existing PrivateFeedGrant documents
      // These are now useless since they're encrypted to old seed's epoch keys
      console.log('Deleting existing grants...');
      const sdk = await getEvoSdk();
      const { documents: grantDocs } = await paginateFetchAll<{ $id: string }>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
          where: [['$ownerId', '==', ownerId]],
          orderBy: [['leafIndex', 'asc']],
          limit: 100,
          ...(startAfter && { startAfter }),
        }),
        (doc) => ({ $id: doc.$id as string }),
        { maxResults: 1024 }
      );

      console.log(`Found ${grantDocs.length} grants to delete`);

      // Delete grants one by one (unfortunately no batch delete in SDK)
      let deletedCount = 0;
      for (const grant of grantDocs) {
        try {
          const deleteResult = await stateTransitionService.deleteDocument(
            this.contractId,
            DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
            grant.$id,
            ownerId
          );
          if (deleteResult.success) {
            deletedCount++;
          } else {
            console.warn(`Failed to delete grant ${grant.$id}:`, deleteResult.error);
          }
        } catch (deleteError) {
          console.warn(`Error deleting grant ${grant.$id}:`, deleteError);
          // Continue with other grants even if one fails
        }
      }
      console.log(`Deleted ${deletedCount}/${grantDocs.length} grants`);

      // 4. Delete all existing PrivateFeedRekey documents
      // These reference the old epoch chain and would cause conflicts/confusion
      console.log('Deleting existing rekey documents...');
      const { documents: rekeyDocs } = await paginateFetchAll<{ $id: string }>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
          where: [['$ownerId', '==', ownerId]],
          orderBy: [['epoch', 'asc']],
          limit: 100,
          ...(startAfter && { startAfter }),
        }),
        (doc) => ({ $id: doc.$id as string }),
        { maxResults: 2000 } // maxEpoch is typically 2000
      );

      console.log(`Found ${rekeyDocs.length} rekey documents to delete`);

      let deletedRekeyCount = 0;
      for (const rekey of rekeyDocs) {
        try {
          const deleteResult = await stateTransitionService.deleteDocument(
            this.contractId,
            DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
            rekey.$id,
            ownerId
          );
          if (deleteResult.success) {
            deletedRekeyCount++;
          } else {
            console.warn(`Failed to delete rekey ${rekey.$id}:`, deleteResult.error);
          }
        } catch (deleteError) {
          console.warn(`Error deleting rekey ${rekey.$id}:`, deleteError);
          // Continue with other rekeys even if one fails
        }
      }
      console.log(`Deleted ${deletedRekeyCount}/${rekeyDocs.length} rekey documents`);

      // 5. Generate new feed seed (SPEC §8.1 step 1)
      const newFeedSeed = privateFeedCryptoService.generateFeedSeed();

      // 6. Pre-compute epoch chain and get CEK[1] for immediate use
      const epochChain = privateFeedCryptoService.generateEpochChain(newFeedSeed, MAX_EPOCH);
      const cek1 = epochChain[1];

      // 7. Encrypt new feedSeed to owner's public key using ECIES
      // versionedPayload = 0x01 || feedSeed
      const versionedPayload = new Uint8Array(1 + newFeedSeed.length);
      versionedPayload[0] = PROTOCOL_VERSION;
      versionedPayload.set(newFeedSeed, 1);

      // AAD = "yappr/feed-state/v1" || ownerId
      const ownerIdBytes = identifierToBytes(ownerId);
      const aad = privateFeedCryptoService.buildFeedStateAAD(ownerIdBytes);

      const newEncryptedSeed = await privateFeedCryptoService.eciesEncrypt(
        encryptionPubKey,
        versionedPayload,
        aad
      );

      // 8. Fetch the existing PrivateFeedState document to get its revision number
      const stateDocs = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_STATE,
        where: [['$ownerId', '==', ownerId]],
        limit: 1,
      });

      if (stateDocs.length === 0) {
        return { success: false, error: 'PrivateFeedState document not found' };
      }

      const existingDoc = stateDocs[0];
      const documentId = existingDoc.$id as string;
      const revision = (existingDoc.$revision as number) || (existingDoc.revision as number) || 1;

      // 9. Update the PrivateFeedState document with new encrypted seed
      // The treeCapacity and maxEpoch remain the same
      const updateData = {
        treeCapacity: TREE_CAPACITY,
        maxEpoch: MAX_EPOCH,
        encryptedSeed: Array.from(newEncryptedSeed),
      };

      console.log('Resetting PrivateFeedState document:', {
        documentId,
        revision,
        encryptedSeedLength: newEncryptedSeed.length,
      });

      const result = await stateTransitionService.updateDocument(
        this.contractId,
        DOCUMENT_TYPES.PRIVATE_FEED_STATE,
        documentId,
        ownerId,
        updateData,
        revision
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to update PrivateFeedState' };
      }

      // 10. Clear all local owner state and reinitialize
      privateFeedKeyStore.clearOwnerKeys();
      privateFeedKeyStore.initializeOwnerState(newFeedSeed, TREE_CAPACITY);

      // Store CEK[1] for immediate use
      privateFeedKeyStore.storeCachedCEK(ownerId, 1, cek1);

      console.log('Private feed reset successfully');
      return { success: true };
    } catch (error) {
      console.error('Error resetting private feed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get count of private followers (for reset confirmation UI)
   */
  async getPrivateFollowerCount(ownerId: string): Promise<number> {
    const followers = await this.getPrivateFollowers(ownerId);
    return followers.length;
  }

  // ============================================================
  // Owner Recovery (SPEC §8.8)
  // ============================================================

  /**
   * Recover owner state from chain documents
   *
   * This is used when:
   * - Logging in on a new device
   * - Local state is behind chain state (another device made changes)
   * - After a session where local state was corrupted
   *
   * Per SPEC §8.8, this:
   * 1. Decrypts feedSeed from PrivateFeedState using owner's encryption key
   * 2. Fetches ALL PrivateFeedRekey documents to rebuild revokedLeaves list
   * 3. Determines currentEpoch from rekey documents
   * 4. Fetches ALL PrivateFeedGrant documents to rebuild recipientId → leafIndex mapping
   * 5. Derives availableLeaves from grants (authoritative source)
   * 6. Stores all state in local storage
   *
   * @param ownerId - The identity ID of the feed owner
   * @param encryptionPrivateKey - The owner's encryption private key (32 bytes)
   * @returns Promise<{success: boolean, error?: string}>
   */
  async recoverOwnerState(
    ownerId: string,
    encryptionPrivateKey: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('Starting owner recovery for:', ownerId);

      // 1. Fetch PrivateFeedState document
      const feedState = await this.getPrivateFeedState(ownerId);
      if (!feedState) {
        return { success: false, error: 'No PrivateFeedState found - private feed not enabled' };
      }

      // 2. Decrypt feedSeed using ECIES
      const ownerIdBytes = identifierToBytes(ownerId);
      const aad = privateFeedCryptoService.buildFeedStateAAD(ownerIdBytes);

      let versionedPayload: Uint8Array;
      try {
        versionedPayload = await privateFeedCryptoService.eciesDecrypt(
          encryptionPrivateKey,
          feedState.encryptedSeed,
          aad
        );
      } catch (decryptError) {
        console.error('Failed to decrypt feed seed:', decryptError);
        return { success: false, error: 'Failed to decrypt feed seed - invalid encryption key' };
      }

      // 3. Validate and extract feedSeed
      if (versionedPayload[0] !== PROTOCOL_VERSION) {
        return { success: false, error: `Unknown protocol version: ${versionedPayload[0]}` };
      }
      const feedSeed = versionedPayload.slice(1);
      if (feedSeed.length !== 32) {
        return { success: false, error: `Invalid feed seed length: ${feedSeed.length}` };
      }

      // 4. Fetch ALL PrivateFeedRekey documents (ordered by epoch)
      const rekeyDocs = await this.getRekeyDocuments(ownerId);
      console.log(`Found ${rekeyDocs.length} rekey documents`);

      // 5. Build revokedLeaves list from rekey docs (in epoch order)
      const revokedLeaves: number[] = [];
      for (const rekey of rekeyDocs) {
        revokedLeaves.push(rekey.revokedLeaf);
      }

      // 6. Determine currentEpoch
      const currentEpoch = rekeyDocs.length > 0
        ? rekeyDocs[rekeyDocs.length - 1].epoch
        : 1;
      console.log(`Current epoch: ${currentEpoch}, revoked leaves: ${revokedLeaves.length}`);

      // 7. Fetch ALL PrivateFeedGrant documents
      const grants = await this.getPrivateFollowers(ownerId);
      console.log(`Found ${grants.length} active grants`);

      // 8. Build recipientId → leafIndex mapping
      const recipientMap: Record<string, number> = {};
      for (const grant of grants) {
        recipientMap[grant.recipientId] = grant.leafIndex;
      }

      // 9. Derive availableLeaves from grants (authoritative source per SPEC §6.3)
      // Start with all leaves available, then mark assigned ones as unavailable
      const availableLeaves: number[] = [];
      const assignedLeaves = new Set(grants.map(g => g.leafIndex));
      for (let i = 0; i < TREE_CAPACITY; i++) {
        if (!assignedLeaves.has(i)) {
          availableLeaves.push(i);
        }
      }
      console.log(`Available leaves: ${availableLeaves.length}`);

      // 10. Clear existing owner state and initialize with recovered data
      privateFeedKeyStore.clearOwnerKeys();

      // Store feedSeed
      privateFeedKeyStore.storeFeedSeed(feedSeed);

      // Store currentEpoch
      privateFeedKeyStore.storeCurrentEpoch(currentEpoch);

      // Store revokedLeaves
      privateFeedKeyStore.storeRevokedLeaves(revokedLeaves);

      // Store availableLeaves
      privateFeedKeyStore.storeAvailableLeaves(availableLeaves);

      // Store recipientMap
      privateFeedKeyStore.storeRecipientMap(recipientMap);

      // 11. Compute and cache current CEK for immediate use
      const epochChain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH);
      const currentCEK = epochChain[currentEpoch];
      privateFeedKeyStore.storeCachedCEK(ownerId, currentEpoch, currentCEK);

      console.log('Owner recovery completed successfully');
      return { success: true };
    } catch (error) {
      console.error('Error during owner recovery:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during recovery',
      };
    }
  }

  /**
   * Run sync check and recovery if needed before write operations
   *
   * This is the critical sync-before-write check per SPEC §7.6.
   * Must be called before: createPrivatePost, approveFollower, revokeFollower
   *
   * @param ownerId - The identity ID of the feed owner
   * @param encryptionPrivateKey - The owner's encryption private key (for recovery if needed)
   * @returns Promise<{success: boolean, error?: string}>
   */
  async syncAndRecover(
    ownerId: string,
    encryptionPrivateKey: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if local keys exist
      const hasLocalKeys = privateFeedKeyStore.hasFeedSeed();

      if (!hasLocalKeys) {
        // No local keys - need full recovery
        console.log('No local keys found, running full owner recovery');
        return await this.recoverOwnerState(ownerId, encryptionPrivateKey);
      }

      // Compare chain epoch vs local epoch
      const chainEpoch = await this.getLatestEpoch(ownerId);
      const localEpoch = privateFeedKeyStore.getCurrentEpoch();

      if (chainEpoch > localEpoch) {
        // Local state is behind - need recovery
        console.log(`Local epoch ${localEpoch} < chain epoch ${chainEpoch}, running recovery`);
        return await this.recoverOwnerState(ownerId, encryptionPrivateKey);
      }

      // Already synced
      return { success: true };
    } catch (error) {
      console.error('Error during sync check:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Sync check failed',
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
      // Try base64 decode
      try {
        return fromBase64(value);
      } catch {
        // Might be hex
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
export const privateFeedService = new PrivateFeedService();

// Export types
export type { PrivateFeedService };

// ============================================================
// Exported Encryption Helpers for use by postService
// ============================================================

/**
 * Encrypted post data ready for document creation
 */
export interface EncryptedPostData {
  encryptedContent: number[];  // Array for platform serialization
  epoch: number;
  nonce: number[];             // Array for platform serialization
  teaser?: string;             // Optional public teaser
}

/**
 * Result of preparing encryption - either data or error
 */
export type PrepareEncryptionResult =
  | { success: true; data: EncryptedPostData }
  | { success: false; error: string };

// Max plaintext size per SPEC §7.5.1 (999 bytes to leave room for version prefix)
const EXPORTED_MAX_PLAINTEXT_SIZE = 999;

/**
 * Prepare owner encryption for a private post (SPEC §8.2)
 *
 * This extracts the encryption logic from createPrivatePost for use by
 * the consolidated postService.createPost method.
 *
 * @param ownerId - The identity ID of the post author
 * @param content - The plaintext content to encrypt
 * @param teaser - Optional public teaser content
 * @param encryptionPrivateKey - Optional: encryption key for automatic sync/recovery
 * @returns PrepareEncryptionResult with encrypted data or error
 */
export async function prepareOwnerEncryption(
  ownerId: string,
  content: string,
  teaser?: string,
  encryptionPrivateKey?: Uint8Array
): Promise<PrepareEncryptionResult> {
  try {
    // 0. Check if local keys exist at all (BUG-010 fix)
    const hasLocalKeys = privateFeedKeyStore.hasFeedSeed();

    if (!hasLocalKeys) {
      console.log('No local private feed keys found, need full recovery');

      if (encryptionPrivateKey) {
        const recoveryResult = await privateFeedService.recoverOwnerState(ownerId, encryptionPrivateKey);
        if (!recoveryResult.success) {
          return { success: false, error: `Recovery failed: ${recoveryResult.error}` };
        }
        console.log('Full recovery completed, continuing with encryption');
      } else {
        return {
          success: false,
          error: 'SYNC_REQUIRED:No local keys found. Please enter your encryption key to sync.',
        };
      }
    }

    // 1. SYNC CHECK (SPEC §8.2 step 1)
    const chainEpoch = await privateFeedService.getLatestEpoch(ownerId);
    const localEpoch = privateFeedKeyStore.getCurrentEpoch();

    if (chainEpoch > localEpoch) {
      console.log(`Chain epoch ${chainEpoch} > local epoch ${localEpoch}, need recovery`);

      if (encryptionPrivateKey) {
        const recoveryResult = await privateFeedService.recoverOwnerState(ownerId, encryptionPrivateKey);
        if (!recoveryResult.success) {
          return { success: false, error: `Sync failed: ${recoveryResult.error}` };
        }
        console.log('Automatic recovery completed, continuing with encryption');
      } else {
        return {
          success: false,
          error: 'SYNC_REQUIRED:Local state out of sync. Please enter your encryption key to sync.',
        };
      }
    }

    // 2. Validate plaintext size (SPEC §8.2 step 2)
    const plaintextBytes = utf8Encode(content);
    if (plaintextBytes.length > EXPORTED_MAX_PLAINTEXT_SIZE) {
      return {
        success: false,
        error: `Content too long: ${plaintextBytes.length} bytes (max ${EXPORTED_MAX_PLAINTEXT_SIZE})`,
      };
    }

    // 3. Get feed seed and current CEK
    const feedSeed = privateFeedKeyStore.getFeedSeed();
    if (!feedSeed) {
      return { success: false, error: 'Private feed not enabled' };
    }

    // Get current epoch after potential recovery
    const currentEpoch = privateFeedKeyStore.getCurrentEpoch();

    // Get or derive CEK for current epoch
    let cek: Uint8Array;
    const cached = privateFeedKeyStore.getCachedCEK(ownerId);

    if (cached && cached.epoch === currentEpoch) {
      cek = cached.cek;
    } else if (cached && cached.epoch > currentEpoch) {
      cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, currentEpoch);
    } else {
      const chain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH);
      cek = chain[currentEpoch];
    }

    // 4-8. Encrypt content (SPEC §8.2 steps 3-8)
    const ownerIdBytes = identifierToBytes(ownerId);
    const encrypted = privateFeedCryptoService.encryptPostContent(
      cek,
      content,
      ownerIdBytes,
      currentEpoch
    );

    console.log('Prepared owner encryption:', {
      hasTeaser: !!teaser,
      encryptedContentLength: encrypted.ciphertext.length,
      epoch: currentEpoch,
      nonceLength: encrypted.nonce.length,
    });

    return {
      success: true,
      data: {
        encryptedContent: Array.from(encrypted.ciphertext),
        epoch: currentEpoch,
        nonce: Array.from(encrypted.nonce),
        teaser,
      },
    };
  } catch (error) {
    console.error('Error preparing owner encryption:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Prepare inherited encryption for a reply to a private post (PRD §5.5)
 *
 * When replying to a private post, the reply inherits encryption from the
 * root private post in the thread. This ensures anyone who can read the
 * parent can also read the reply.
 *
 * @param content - The plaintext content to encrypt
 * @param source - The encryption source (feed owner ID and epoch)
 * @returns PrepareEncryptionResult with encrypted data or error
 */
export async function prepareInheritedEncryption(
  content: string,
  source: { ownerId: string; epoch: number }
): Promise<PrepareEncryptionResult> {
  try {
    // 1. Validate plaintext size
    const plaintextBytes = utf8Encode(content);
    if (plaintextBytes.length > EXPORTED_MAX_PLAINTEXT_SIZE) {
      return {
        success: false,
        error: `Content too long: ${plaintextBytes.length} bytes (max ${EXPORTED_MAX_PLAINTEXT_SIZE})`,
      };
    }

    // 2. Get the CEK from the cached follower keys for this feed owner
    const cached = privateFeedKeyStore.getCachedCEK(source.ownerId);
    if (!cached) {
      return {
        success: false,
        error: 'Cannot encrypt reply: no access to private feed encryption keys',
      };
    }

    // 3. Derive CEK for the specified epoch
    let cek: Uint8Array;
    if (cached.epoch === source.epoch) {
      cek = cached.cek;
    } else if (cached.epoch > source.epoch) {
      cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, source.epoch);
    } else {
      return {
        success: false,
        error: 'Cannot encrypt reply: encryption key state is out of date',
      };
    }

    // 4. Encrypt content using the feed owner's ID as AAD
    const ownerIdBytes = identifierToBytes(source.ownerId);
    const encrypted = privateFeedCryptoService.encryptPostContent(
      cek,
      content,
      ownerIdBytes,
      source.epoch
    );

    console.log('Prepared inherited encryption:', {
      feedOwnerId: source.ownerId,
      epoch: source.epoch,
      encryptedContentLength: encrypted.ciphertext.length,
    });

    return {
      success: true,
      data: {
        encryptedContent: Array.from(encrypted.ciphertext),
        epoch: source.epoch,
        nonce: Array.from(encrypted.nonce),
      },
    };
  } catch (error) {
    console.error('Error preparing inherited encryption:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
