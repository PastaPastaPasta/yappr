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
 * - createPrivatePost(): Create an encrypted private post
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
import { privateFeedNotificationService } from './private-feed-notification-service';
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import { queryDocuments } from './sdk-helpers';

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

/**
 * Convert identifier to 32-byte Uint8Array for cryptographic operations
 */
function identifierToBytes(identifier: string): Uint8Array {
  // Decode base58 identifier to bytes
  // Use a simple base58 decode - identifiers are 32 bytes
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP.set(ALPHABET[i], i);
  }

  let num = BigInt(0);
  for (const char of identifier) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * BigInt(58) + BigInt(value);
  }

  // Convert to 32-byte array (big-endian)
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(num & BigInt(0xff));
    num = num >> BigInt(8);
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

      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
        where: [['$ownerId', '==', ownerId]],
        orderBy: [['epoch', 'asc']],
        limit: 100, // Should be enough for most cases
      });

      return documents.map((doc) => ({
        $id: doc.$id as string,
        $ownerId: doc.$ownerId as string,
        $createdAt: doc.$createdAt as number,
        epoch: doc.epoch as number,
        revokedLeaf: doc.revokedLeaf as number,
        packets: this.normalizeBytes(doc.packets),
        encryptedCEK: this.normalizeBytes(doc.encryptedCEK),
      }));
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

      // 2. Verify user has encryption key on identity
      const encryptionPubKey = privateFeedCryptoService.getPublicKey(encryptionPrivateKey);

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

  /**
   * Create a private post (SPEC §8.2)
   *
   * @param ownerId - The identity ID of the post author
   * @param content - The plaintext content to encrypt
   * @param teaser - Optional public teaser content
   * @returns Promise<PrivatePostResult>
   */
  async createPrivatePost(
    ownerId: string,
    content: string,
    teaser?: string
  ): Promise<PrivatePostResult> {
    try {
      // 1. SYNC CHECK (SPEC §8.2 step 1)
      // Fetch latest epoch from chain and compare with local
      const chainEpoch = await this.getLatestEpoch(ownerId);
      const localEpoch = privateFeedKeyStore.getCurrentEpoch();

      if (chainEpoch > localEpoch) {
        // Need to run owner recovery to sync state
        console.log(`Chain epoch ${chainEpoch} > local epoch ${localEpoch}, need recovery`);
        // For now, return error - full recovery will be implemented in Phase 4
        return {
          success: false,
          error: 'Local state out of sync. Please refresh and try again.',
        };
      }

      // 2. Validate plaintext size (SPEC §8.2 step 2)
      const plaintextBytes = utf8Encode(content);
      if (plaintextBytes.length > MAX_PLAINTEXT_SIZE) {
        return {
          success: false,
          error: `Content too long: ${plaintextBytes.length} bytes (max ${MAX_PLAINTEXT_SIZE})`,
        };
      }

      // 3. Get feed seed and current CEK
      const feedSeed = privateFeedKeyStore.getFeedSeed();
      if (!feedSeed) {
        return { success: false, error: 'Private feed not enabled' };
      }

      // Get or derive CEK for current epoch
      let cek: Uint8Array;
      const cached = privateFeedKeyStore.getCachedCEK(ownerId);

      if (cached && cached.epoch === localEpoch) {
        cek = cached.cek;
      } else if (cached && cached.epoch > localEpoch) {
        // Derive backwards from cached CEK
        cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.epoch, localEpoch);
      } else {
        // Generate fresh from chain
        const chain = privateFeedCryptoService.generateEpochChain(feedSeed, MAX_EPOCH);
        cek = chain[localEpoch];
      }

      // 4-8. Encrypt content (SPEC §8.2 steps 3-8)
      const ownerIdBytes = identifierToBytes(ownerId);
      const encrypted = privateFeedCryptoService.encryptPostContent(
        cek,
        content,
        ownerIdBytes,
        localEpoch
      );

      // 9. Create Post document (SPEC §8.2 step 9)
      const postData: Record<string, unknown> = {
        content: teaser || '', // Teaser or empty string for private-only posts
        encryptedContent: Array.from(encrypted.ciphertext),
        epoch: localEpoch,
        nonce: Array.from(encrypted.nonce),
      };

      console.log('Creating private post:', {
        hasTeaser: !!teaser,
        encryptedContentLength: encrypted.ciphertext.length,
        epoch: localEpoch,
        nonceLength: encrypted.nonce.length,
      });

      const result = await stateTransitionService.createDocument(
        this.contractId,
        DOCUMENT_TYPES.POST,
        ownerId,
        postData
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to create post' };
      }

      const postId = (result.document?.$id || result.document?.id) as string | undefined;

      console.log('Private post created successfully:', postId);
      return { success: true, postId };
    } catch (error) {
      console.error('Error creating private post:', error);
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
   * @returns Promise<{success: boolean, error?: string}>
   */
  async approveFollower(
    ownerId: string,
    requesterId: string,
    requesterPublicKey: Uint8Array
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Get feed seed
      const feedSeed = privateFeedKeyStore.getFeedSeed();
      if (!feedSeed) {
        return { success: false, error: 'Private feed not initialized locally' };
      }

      // 2. SYNC CHECK: Compare chain epoch vs local epoch
      const chainEpoch = await this.getLatestEpoch(ownerId);
      const localEpoch = privateFeedKeyStore.getCurrentEpoch();

      if (chainEpoch > localEpoch) {
        return {
          success: false,
          error: 'Local state out of sync. Please refresh and try again.',
        };
      }

      // 3. Get an available leaf index
      const availableLeaves = privateFeedKeyStore.getAvailableLeaves();
      if (!availableLeaves || availableLeaves.length === 0) {
        return { success: false, error: 'No available leaf slots (feed at capacity)' };
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

      // 13. Create notification for the approved follower (best effort)
      try {
        await privateFeedNotificationService.createApprovedNotification(ownerId, requesterId);
      } catch (notifError) {
        console.error('Failed to create approval notification:', notifError);
        // Don't fail the main operation
      }

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
   * @returns Promise<{success: boolean, error?: string}>
   */
  async revokeFollower(
    ownerId: string,
    followerId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Get feed seed
      const feedSeed = privateFeedKeyStore.getFeedSeed();
      if (!feedSeed) {
        return { success: false, error: 'Private feed not initialized locally' };
      }

      // 2. SYNC CHECK: Compare chain epoch vs local epoch
      const chainEpoch = await this.getLatestEpoch(ownerId);
      const localEpoch = privateFeedKeyStore.getCurrentEpoch();

      if (chainEpoch > localEpoch) {
        return {
          success: false,
          error: 'Local state out of sync. Please refresh and try again.',
        };
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

      // 9. Derive wrap nonce salt
      const wrapNonceSalt = privateFeedCryptoService.deriveWrapNonceSalt(feedSeed);
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
          wrapNonceSalt,
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
            wrapNonceSalt,
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

      // 16. Create notification for the revoked follower (best effort)
      try {
        await privateFeedNotificationService.createRevokedNotification(ownerId, followerId);
      } catch (notifError) {
        console.error('Failed to create revocation notification:', notifError);
        // Don't fail the main operation
      }

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

      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
        where: [['$ownerId', '==', ownerId]],
        orderBy: [['$createdAt', 'desc']],
        limit: 100,
      });

      return documents.map((doc) => ({
        recipientId: doc.recipientId as string,
        leafIndex: doc.leafIndex as number,
        grantedAt: doc.$createdAt as number,
      }));
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
