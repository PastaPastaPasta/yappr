'use client';

import { logger } from '@/lib/logger';
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
  MAX_KEY_GENERATION,
  PROTOCOL_VERSION,
} from './private-feed-crypto-service';
import { privateFeedKeyStore } from './private-feed-key-store';
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import { contentLimits, isV10, privateFeedKeyFields, privateFeedWritesAreGated } from '@/lib/contract-topology';
import { isReferenceNotFoundError, referencedPathFromError } from '@/lib/error-utils';
import { findEncryptionKey } from '@/lib/crypto/encryption-key-lookup';
import { KeyPurpose, KeyType } from '@/lib/crypto/identity-keys';
import { getPublicKey } from '@/lib/crypto/keys';
import { RequestDeduplicator, queryDocuments, identifierToBase58, identifierToBytes } from './sdk-helpers';
import { paginateFetchAll } from './pagination-utils';
import { bytesEqual, normalizeBytes, requireBytes } from '@/lib/bytes';
import { identityService } from './identity-service';

/**
 * PrivateFeedState document from platform
 */
export interface PrivateFeedStateDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  treeCapacity: number;
  maxKeyGeneration: number;
  encryptedSeed: Uint8Array;
}

/**
 * PrivateFeedRekey document from platform
 */
export interface PrivateFeedRekeyDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  keyGeneration: number;
  revokedLeaf: number;
  packets: Uint8Array;
  encryptedCEK: Uint8Array;
}

/**
 * Convert string to UTF-8 bytes
 */
function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Why an approval failed, where the caller should act on it (v9 private-feed gates). */
export type ApproveErrorCode = 'REQUEST_WITHDRAWN' | 'FEED_NOT_ENABLED';

export const REQUEST_WITHDRAWN_MESSAGE = 'This follower withdrew their request, so there is nothing to approve.';
const FEED_NOT_ENABLED_MESSAGE = 'Enable your private feed before approving followers.';

/**
 * A grant refused by a v9 gate (40120), by the path Drive names:
 * `recipientId` — the follower's request is gone (cancelled between the
 * owner's read and the grant); `$ownerId` — the owner has no privateFeedState.
 */
function grantRefusal(error: unknown): { error: string; errorCode: ApproveErrorCode } | null {
  if (!isReferenceNotFoundError(error)) return null;
  const path = referencedPathFromError(error);
  if (path === 'recipientId') return { error: REQUEST_WITHDRAWN_MESSAGE, errorCode: 'REQUEST_WITHDRAWN' };
  if (path === '$ownerId') return { error: FEED_NOT_ENABLED_MESSAGE, errorCode: 'FEED_NOT_ENABLED' };
  return null;
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
      logger.error('Error checking private feed status:', error);
      return false;
    }
  }

  /**
   * Get PrivateFeedState document for an owner
   */
  private getPrivateFeedStateReads = new RequestDeduplicator<string, PrivateFeedStateDocument | null>(0);

  async getPrivateFeedState(ownerId: string): Promise<PrivateFeedStateDocument | null> {
    return this.getPrivateFeedStateReads.dedupe(ownerId, () => this.fetchPrivateFeedState(ownerId));
  }

  private async fetchPrivateFeedState(ownerId: string): Promise<PrivateFeedStateDocument | null> {
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
        maxKeyGeneration: doc[privateFeedKeyFields().latest] as number,
        encryptedSeed: requireBytes(doc.encryptedSeed, 'encryptedSeed'),
      };
    } catch (error) {
      logger.error('Error fetching private feed state:', error);
      return null;
    }
  }

  /**
   * Get the latest key generation for an owner by checking rekey documents
   * Returns 1 if no rekey documents exist, and also on a failed read unless
   * `throwOnError` is set: anything that encrypts must not mistake a failed
   * read for "no revocations yet".
   */
  async getLatestKeyGeneration(ownerId: string, options: { throwOnError?: boolean } = {}): Promise<number> {
    try {
      const sdk = await getEvoSdk();

      // Query rekey documents ordered by key generation descending to get the latest
      const documents = await queryDocuments(sdk, {
        dataContractId: this.contractId,
        documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
        where: [['$ownerId', '==', ownerId]],
        orderBy: [[privateFeedKeyFields().generation, 'desc']],
        limit: 1,
      });

      if (documents.length === 0) {
        return 1; // No revocations yet, key generation is 1
      }

      return documents[0][privateFeedKeyFields().generation] as number;
    } catch (error) {
      logger.error('Error fetching latest key generation:', error);
      if (options.throwOnError) throw error;
      return 1;
    }
  }

  /**
   * Get all rekey documents for an owner, ordered by key generation
   */
  async getRekeyDocuments(
    ownerId: string,
    options: { throwOnError?: boolean } = {}
  ): Promise<PrivateFeedRekeyDocument[]> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll<PrivateFeedRekeyDocument>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_REKEY,
          where: [['$ownerId', '==', ownerId]],
          orderBy: [[privateFeedKeyFields().generation, 'asc']],
          limit: 100,
          ...(startAfter && { startAfter }),
        }),
        (doc) => ({
          $id: doc.$id as string,
          $ownerId: doc.$ownerId as string,
          $createdAt: doc.$createdAt as number,
          keyGeneration: doc[privateFeedKeyFields().generation] as number,
          revokedLeaf: doc.revokedLeaf as number,
          packets: requireBytes(doc.packets, 'packets'),
          encryptedCEK: requireBytes(doc.encryptedCEK, 'encryptedCEK'),
        }),
        { maxResults: 2000 } // SPEC allows up to 2000 key generations
      );

      return documents;
    } catch (error) {
      logger.error('Error fetching rekey documents:', error);
      if (options.throwOnError) throw error;
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
   * - User must have an encryption key on their identity
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
      const encryptionPubKey = getPublicKey(encryptionPrivateKey);

      // Verify the derived public key is registered on the identity
      const identity = await identityService.getIdentity(ownerId);
      if (!identity) {
        return { success: false, error: 'Could not fetch identity' };
      }

      const matchesDerived = (data: unknown) => {
        const onChainPubKey = normalizeBytes(data);
        return onChainPubKey !== null && bytesEqual(onChainPubKey, encryptionPubKey);
      };
      // Find the identity's encryption key
      const preferredKey = findEncryptionKey(identity.publicKeys);
      const matchingKey = preferredKey?.data && matchesDerived(preferredKey.data)
        ? preferredKey
        : identity.publicKeys.find(key =>
            key.purpose === KeyPurpose.ENCRYPTION && key.type === KeyType.ECDSA_SECP256K1 && !key.disabledAt && matchesDerived(key.data)
          );

      if (!matchingKey) {
        return {
          success: false,
          error: 'The provided encryption key does not match the encryption key registered on your identity',
        };
      }

      // 3. Generate feed seed (SPEC §8.1 step 1)
      const feedSeed = privateFeedCryptoService.generateFeedSeed();

      // 4. Pre-compute the CEK chain (SPEC §8.1 steps 2-3)
      // Note: We don't store the full chain, just compute CEK[1] for immediate use
      const cekChain = privateFeedCryptoService.generateCekChain(feedSeed, MAX_KEY_GENERATION);
      const cek1 = cekChain[1];

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

      // 6. Create PrivateFeedState document (SPEC §8.1 step 5).
      // This is a typed write, so binary fields stay as Uint8Array.
      const documentData = {
        treeCapacity: TREE_CAPACITY,
        [privateFeedKeyFields().latest]: MAX_KEY_GENERATION,
        encryptedSeed,
      };

      logger.debug('Creating PrivateFeedState document:', {
        treeCapacity: TREE_CAPACITY,
        maxKeyGeneration: MAX_KEY_GENERATION,
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

      logger.debug('Private feed enabled successfully');
      return { success: true };
    } catch (error) {
      logger.error('Error enabling private feed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================================
  // Follower Management (SPEC §8.4 - Approve Follow Request)
  // ============================================================

  /** Whether `requesterId` has a live followRequest to `ownerId` (the v9 grant gate's lookup). */
  private async followRequestExists(ownerId: string, requesterId: string): Promise<boolean> {
    const sdk = await getEvoSdk();
    const documents = await queryDocuments(sdk, {
      dataContractId: this.contractId,
      documentTypeName: DOCUMENT_TYPES.FOLLOW_REQUEST,
      where: [['targetId', '==', ownerId], ['$ownerId', '==', requesterId]],
      limit: 1,
    });
    return documents.length > 0;
  }

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
  ): Promise<{ success: boolean; error?: string; errorCode?: ApproveErrorCode }> {
    try {
      // 0. v9 accepts a grant only while the recipient's followRequest to this
      // owner exists (refersTo through targetAndRequester). A follower may have
      // cancelled since the owner's list was read: check before any key work.
      if (privateFeedWritesAreGated() && !(await this.followRequestExists(ownerId, requesterId))) {
        return { success: false, error: REQUEST_WITHDRAWN_MESSAGE, errorCode: 'REQUEST_WITHDRAWN' };
      }

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

      // 2. SYNC CHECK: Compare chain key generation vs local key generation
      const chainKeyGeneration = await this.getLatestKeyGeneration(ownerId);
      let localKeyGeneration = privateFeedKeyStore.getCurrentKeyGeneration();

      if (chainKeyGeneration > localKeyGeneration) {
        if (encryptionPrivateKey) {
          // Automatic recovery with provided key
          const recoveryResult = await this.recoverOwnerState(ownerId, encryptionPrivateKey);
          if (!recoveryResult.success) {
            return { success: false, error: `Sync failed: ${recoveryResult.error}` };
          }
          // Refresh feedSeed and localKeyGeneration after recovery
          feedSeed = privateFeedKeyStore.getFeedSeed();
          localKeyGeneration = privateFeedKeyStore.getCurrentKeyGeneration();
          if (!feedSeed) {
            return { success: false, error: 'Feed seed not available after recovery' };
          }
          logger.debug('Automatic recovery completed, continuing with approval');
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

      if (cached && cached.keyGeneration === localKeyGeneration) {
        cek = cached.cek;
      } else if (cached && cached.keyGeneration > localKeyGeneration) {
        cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.keyGeneration, localKeyGeneration);
      } else {
        const chain = privateFeedCryptoService.generateCekChain(feedSeed, MAX_KEY_GENERATION);
        cek = chain[localKeyGeneration];
      }

      // 7. Build grant payload
      const grantPayload = {
        version: PROTOCOL_VERSION,
        grantKeyGeneration: localKeyGeneration,
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
        localKeyGeneration
      );

      // 10. Encrypt payload using ECIES to requester's public key
      const encryptedPayload = await privateFeedCryptoService.eciesEncrypt(
        requesterPublicKey,
        encodedPayload,
        aad
      );

      // 11. Create PrivateFeedGrant document.
      const documentData = {
        recipientId: identifierToBytes(requesterId),
        leafIndex,
        [privateFeedKeyFields().generation]: localKeyGeneration,
        encryptedPayload,
      };

      logger.debug('Creating PrivateFeedGrant document:', {
        recipientId: requesterId,
        leafIndex,
        keyGeneration: localKeyGeneration,
        encryptedPayloadLength: encryptedPayload.length,
      });

      const result = await stateTransitionService.createDocument(
        this.contractId,
        DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
        ownerId,
        documentData
      );

      if (!result.success) {
        return { success: false, ...(grantRefusal(result.error) ?? { error: result.error || 'Failed to create grant' }) };
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

      logger.debug(`Approved follower ${requesterId} with leaf index ${leafIndex}`);
      return { success: true };
    } catch (error) {
      logger.error('Error approving follower:', error);
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

      // 2. SYNC CHECK: Compare chain key generation vs local key generation
      const chainKeyGeneration = await this.getLatestKeyGeneration(ownerId);
      let localKeyGeneration = privateFeedKeyStore.getCurrentKeyGeneration();

      if (chainKeyGeneration > localKeyGeneration) {
        if (encryptionPrivateKey) {
          // Automatic recovery with provided key
          const recoveryResult = await this.recoverOwnerState(ownerId, encryptionPrivateKey);
          if (!recoveryResult.success) {
            return { success: false, error: `Sync failed: ${recoveryResult.error}` };
          }
          // Refresh feedSeed and localKeyGeneration after recovery
          feedSeed = privateFeedKeyStore.getFeedSeed();
          localKeyGeneration = privateFeedKeyStore.getCurrentKeyGeneration();
          if (!feedSeed) {
            return { success: false, error: 'Feed seed not available after recovery' };
          }
          logger.debug('Automatic recovery completed, continuing with revocation');
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

      // 4. Advance key generation
      const newKeyGeneration = localKeyGeneration + 1;

      if (newKeyGeneration > MAX_KEY_GENERATION) {
        return {
          success: false,
          error: 'Maximum revocations reached. Migration required.',
        };
      }

      // 5. Compute new CEK for the new key generation
      const cekChain = privateFeedCryptoService.generateCekChain(feedSeed, MAX_KEY_GENERATION);
      const newCEK = cekChain[newKeyGeneration];

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
          newKeyGeneration,
          nodeId,
          targetVersion,
          siblingOfChild,
          siblingVersion
        );
        const aadA = privateFeedCryptoService.buildRekeyAAD(
          ownerIdBytes,
          newKeyGeneration,
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
            newKeyGeneration,
            nodeId,
            targetVersion,
            updatedChild,
            childNewVersion
          );
          const aadB = privateFeedCryptoService.buildRekeyAAD(
            ownerIdBytes,
            newKeyGeneration,
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
        newKeyGeneration
      );

      // 12. Encode packets
      const encodedPackets = privateFeedCryptoService.encodeRekeyPackets(packets);

      // 13. Create PrivateFeedRekey document
      const rekeyData = {
        [privateFeedKeyFields().generation]: newKeyGeneration,
        revokedLeaf: leafIndex,
        packets: encodedPackets,
        encryptedCEK,
      };

      logger.debug('Creating PrivateFeedRekey document:', {
        keyGeneration: newKeyGeneration,
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
      privateFeedKeyStore.storeCurrentKeyGeneration(newKeyGeneration);
      privateFeedKeyStore.storeRevokedLeaves(newRevokedLeaves);

      // Update recipient map
      const recipientMap = privateFeedKeyStore.getRecipientMap() || {};
      delete recipientMap[followerId];
      privateFeedKeyStore.storeRecipientMap(recipientMap);

      // Add leaf back to available (after grant deletion)
      // Note: We'll do this after grant deletion for consistency

      // 15. Delete PrivateFeedGrant document
      logger.debug(`Deleting grant document: ${grantId}`);

      const deleteResult = await stateTransitionService.deleteDocument(
        this.contractId,
        DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
        grantId,
        ownerId
      );

      if (!deleteResult.success) {
        // Grant deletion failed but rekey exists - user is cryptographically revoked
        // This is acceptable per SPEC §8.5, log error and schedule retry
        logger.error('Failed to delete grant:', deleteResult.error);
        // Still return success since the cryptographic revocation is complete
      }

      // Update available leaves
      const availableLeaves = privateFeedKeyStore.getAvailableLeaves() || [];
      if (!availableLeaves.includes(leafIndex)) {
        availableLeaves.push(leafIndex);
        privateFeedKeyStore.storeAvailableLeaves(availableLeaves);
      }

      // Update cached CEK
      privateFeedKeyStore.storeCachedCEK(ownerId, newKeyGeneration, newCEK);

      // Note: Notification documents cannot be created here due to ownership constraints
      // (we can't sign documents owned by the recipient). Revoked followers discover
      // revocation when their grant stops working or via grant expiry checks.

      logger.debug(`Revoked follower ${followerId} (leaf ${leafIndex}), new key generation: ${newKeyGeneration}`);
      return { success: true };
    } catch (error) {
      logger.error('Error revoking follower:', error);
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
  private getPrivateFollowersReads = new RequestDeduplicator<string, Array<{ recipientId: string; leafIndex: number; grantedAt: number }>>(0);

  async getPrivateFollowers(ownerId: string): Promise<Array<{ recipientId: string; leafIndex: number; grantedAt: number }>> {
    return this.getPrivateFollowersReads.dedupe(ownerId, () => this.fetchPrivateFollowers(ownerId));
  }

  private async fetchPrivateFollowers(ownerId: string): Promise<Array<{ recipientId: string; leafIndex: number; grantedAt: number }>> {
    try {
      const sdk = await getEvoSdk();

      const { documents } = await paginateFetchAll<{ recipientId: string; leafIndex: number; grantedAt: number }>(
        sdk,
        (startAfter) => ({
          dataContractId: this.contractId,
          documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
          where: [['$ownerId', '==', ownerId]],
          // Use ownerAndLeaf index: [$ownerId, leafIndex] - must include all index fields in orderBy
          orderBy: [['$ownerId', 'asc'], ['leafIndex', 'asc']],
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
      logger.error('Error fetching private followers:', error);
      return [];
    }
  }

  // ============================================================
  // Owner State Accessors
  // ============================================================

  /**
   * Get current key generation from local storage
   */
  getCurrentKeyGeneration(): number {
    return privateFeedKeyStore.getCurrentKeyGeneration();
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
   * Reset is unavailable for the deployed private-feed contracts: the owner state
   * is immutable, undeletable and unique per owner. Refuse before touching grants,
   * rekeys or local keys. A future reset needs a supported atomic protocol.
   * Kept as a method (rather than deleted) so any caller gets the refusal
   * instead of a partial reset; it takes no arguments because it acts on none.
   */
  async resetPrivateFeed(): Promise<{ success: boolean; error?: string }> {
    return {
      success: false,
      error: 'Private feed reset is unavailable. Your existing feed and followers have not been changed. Use your original encryption key to recover access.',
    };
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
   * 3. Determines currentKeyGeneration from rekey documents
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
      logger.debug('Starting owner recovery for:', ownerId);

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
        logger.error('Failed to decrypt feed seed:', decryptError);
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

      // 4. Fetch ALL PrivateFeedRekey documents (ordered by key generation). A failed
      // read must fail recovery: an empty list would roll the key generation back to 1.
      const rekeyDocs = await this.getRekeyDocuments(ownerId, { throwOnError: true });
      logger.debug(`Found ${rekeyDocs.length} rekey documents`);

      // 5. Build revokedLeaves list from rekey docs (in key generation order)
      const revokedLeaves: number[] = [];
      for (const rekey of rekeyDocs) {
        revokedLeaves.push(rekey.revokedLeaf);
      }

      // 6. Determine currentKeyGeneration
      const currentKeyGeneration = rekeyDocs.length > 0
        ? rekeyDocs[rekeyDocs.length - 1].keyGeneration
        : 1;
      logger.debug(`Current key generation: ${currentKeyGeneration}, revoked leaves: ${revokedLeaves.length}`);

      // 7. Fetch ALL PrivateFeedGrant documents
      const grants = await this.getPrivateFollowers(ownerId);
      logger.debug(`Found ${grants.length} active grants`);

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
      logger.debug(`Available leaves: ${availableLeaves.length}`);

      // 10. Clear existing owner state and initialize with recovered data
      privateFeedKeyStore.clearOwnerKeys();

      // Store feedSeed
      privateFeedKeyStore.storeFeedSeed(feedSeed);

      // Store currentKeyGeneration
      privateFeedKeyStore.storeCurrentKeyGeneration(currentKeyGeneration);

      // Store revokedLeaves
      privateFeedKeyStore.storeRevokedLeaves(revokedLeaves);

      // Store availableLeaves
      privateFeedKeyStore.storeAvailableLeaves(availableLeaves);

      // Store recipientMap
      privateFeedKeyStore.storeRecipientMap(recipientMap);

      // 11. Compute and cache current CEK for immediate use
      const cekChain = privateFeedCryptoService.generateCekChain(feedSeed, MAX_KEY_GENERATION);
      const currentCEK = cekChain[currentKeyGeneration];
      privateFeedKeyStore.storeCachedCEK(ownerId, currentKeyGeneration, currentCEK);

      logger.debug('Owner recovery completed successfully');
      return { success: true };
    } catch (error) {
      logger.error('Error during owner recovery:', error);
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
        logger.debug('No local keys found, running full owner recovery');
        return await this.recoverOwnerState(ownerId, encryptionPrivateKey);
      }

      // Compare chain key generation vs local key generation
      const chainKeyGeneration = await this.getLatestKeyGeneration(ownerId);
      const localKeyGeneration = privateFeedKeyStore.getCurrentKeyGeneration();

      if (chainKeyGeneration > localKeyGeneration) {
        // Local state is behind - need recovery
        logger.debug(`Local key generation ${localKeyGeneration} < chain key generation ${chainKeyGeneration}, running recovery`);
        return await this.recoverOwnerState(ownerId, encryptionPrivateKey);
      }

      // Already synced
      return { success: true };
    } catch (error) {
      logger.error('Error during sync check:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Sync check failed',
      };
    }
  }

  // ============================================================
  // Utility Methods
  // ============================================================
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
  encryptedContent: Uint8Array;
  keyGeneration: number;
  nonce: Uint8Array;
  teaser?: string;
}

/**
 * Result of preparing encryption - either data or error
 */
export type PrepareEncryptionResult =
  | { success: true; data: EncryptedPostData }
  | { success: false; error: string };

// Max plaintext size per SPEC §7.5.1 (999 bytes to leave room for version prefix)
const LEGACY_MAX_PLAINTEXT_SIZE = 999;

// What encryptPostContent adds to the plaintext: the version byte and the 16-byte Poly1305 tag.
const CIPHERTEXT_OVERHEAD = 1 + 16;

/**
 * The largest plaintext, in UTF-8 bytes, a private post or reply may carry.
 * v2/v9 keep SPEC §7.5.1's 999 B; v10 fills `encryptedContent` (2048 B) less
 * the ciphertext overhead, 2031 B.
 */
function maxPlaintextBytes(): number {
  return isV10() ? contentLimits().encryptedMaxBytes - CIPHERTEXT_OVERHEAD : LEGACY_MAX_PLAINTEXT_SIZE;
}

/** Refuse `content` over the private plaintext cap, before anything is encrypted. */
function plaintextTooLong(content: string): { success: false; error: string } | null {
  const size = utf8Encode(content).length;
  const max = maxPlaintextBytes();
  return size > max ? { success: false, error: `Content too long: ${size} bytes (max ${max})` } : null;
}

const KEY_GENERATION_UNVERIFIED_ERROR =
  'Could not confirm your private feed\'s current encryption key generation, so nothing was posted. Check your connection and try again.';

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
      logger.debug('No local private feed keys found, need full recovery');

      if (encryptionPrivateKey) {
        const recoveryResult = await privateFeedService.recoverOwnerState(ownerId, encryptionPrivateKey);
        if (!recoveryResult.success) {
          return { success: false, error: `Recovery failed: ${recoveryResult.error}` };
        }
        logger.debug('Full recovery completed, continuing with encryption');
      } else {
        return {
          success: false,
          error: 'SYNC_REQUIRED:No local keys found. Please enter your encryption key to sync.',
        };
      }
    }

    // 1. SYNC CHECK (SPEC §8.2 step 1). Fail closed: if the chain key generation cannot
    // be read, a revocation made on another device may be missing locally, and
    // encrypting at the stale key generation would let the revoked follower read this.
    let chainKeyGeneration: number;
    try {
      chainKeyGeneration = await privateFeedService.getLatestKeyGeneration(ownerId, { throwOnError: true });
    } catch {
      return { success: false, error: KEY_GENERATION_UNVERIFIED_ERROR };
    }
    const localKeyGeneration = privateFeedKeyStore.getCurrentKeyGeneration();

    if (chainKeyGeneration > localKeyGeneration) {
      logger.debug(`Chain key generation ${chainKeyGeneration} > local key generation ${localKeyGeneration}, need recovery`);

      if (encryptionPrivateKey) {
        const recoveryResult = await privateFeedService.recoverOwnerState(ownerId, encryptionPrivateKey);
        if (!recoveryResult.success) {
          return { success: false, error: `Sync failed: ${recoveryResult.error}` };
        }
        if (privateFeedKeyStore.getCurrentKeyGeneration() < chainKeyGeneration) {
          return { success: false, error: KEY_GENERATION_UNVERIFIED_ERROR };
        }
        logger.debug('Automatic recovery completed, continuing with encryption');
      } else {
        return {
          success: false,
          error: 'SYNC_REQUIRED:Local state out of sync. Please enter your encryption key to sync.',
        };
      }
    }

    // 2. Validate plaintext size (SPEC §8.2 step 2)
    const tooLong = plaintextTooLong(content);
    if (tooLong) return tooLong;

    // 3. Get feed seed and current CEK
    const feedSeed = privateFeedKeyStore.getFeedSeed();
    if (!feedSeed) {
      return { success: false, error: 'Private feed not enabled' };
    }

    // Get current key generation after potential recovery
    const currentKeyGeneration = privateFeedKeyStore.getCurrentKeyGeneration();

    // Get or derive CEK for current key generation
    let cek: Uint8Array;
    const cached = privateFeedKeyStore.getCachedCEK(ownerId);

    if (cached && cached.keyGeneration === currentKeyGeneration) {
      cek = cached.cek;
    } else if (cached && cached.keyGeneration > currentKeyGeneration) {
      cek = privateFeedCryptoService.deriveCEK(cached.cek, cached.keyGeneration, currentKeyGeneration);
    } else {
      const chain = privateFeedCryptoService.generateCekChain(feedSeed, MAX_KEY_GENERATION);
      cek = chain[currentKeyGeneration];
    }

    // 4-8. Encrypt content (SPEC §8.2 steps 3-8)
    const ownerIdBytes = identifierToBytes(ownerId);
    const encrypted = privateFeedCryptoService.encryptPostContent(
      cek,
      content,
      ownerIdBytes,
      currentKeyGeneration
    );

    logger.debug('Prepared owner encryption:', {
      hasTeaser: !!teaser,
      encryptedContentLength: encrypted.ciphertext.length,
      keyGeneration: currentKeyGeneration,
      nonceLength: encrypted.nonce.length,
    });

    return {
      success: true,
      data: {
        encryptedContent: encrypted.ciphertext,
        keyGeneration: currentKeyGeneration,
        nonce: encrypted.nonce,
        teaser,
      },
    };
  } catch (error) {
    logger.error('Error preparing owner encryption:', error);
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
 * root private post in the thread: it is encrypted to the same FEED, so the
 * feed's followers can read it. It is encrypted at the feed's CURRENT key generation,
 * not the root's (SPEC §16.3): a follower revoked after the root was posted
 * holds the root's CEK, and must not be able to read replies written after
 * the revocation. Readers derive the CEK of each reply's own key generation.
 *
 * @param content - The plaintext content to encrypt
 * @param source - The encryption source (feed owner ID and the root post's key generation)
 * @param authorId - The identity writing the reply
 * @param encryptionPrivateKey - Optional: the feed owner's key for automatic sync
 * @returns PrepareEncryptionResult with encrypted data or error
 */
export async function prepareInheritedEncryption(
  content: string,
  source: { ownerId: string; keyGeneration: number },
  authorId: string,
  encryptionPrivateKey?: Uint8Array
): Promise<PrepareEncryptionResult> {
  // The feed owner replying in their own thread encrypts exactly like a new
  // private post, including the multi-device sync check (SPEC §8.2).
  if (authorId === source.ownerId) {
    return prepareOwnerEncryption(source.ownerId, content, undefined, encryptionPrivateKey);
  }

  try {
    // 1. Validate plaintext size
    const tooLong = plaintextTooLong(content);
    if (tooLong) return tooLong;

    // 2. A follower must hold keys for this feed at all
    if (!privateFeedKeyStore.getCachedCEK(source.ownerId)) {
      return {
        success: false,
        error: 'Cannot encrypt reply: no access to private feed encryption keys',
      };
    }

    // 3. Apply any rekeys since the last sync, so the reply uses the feed's
    // current key generation. A revoked follower cannot apply them and cannot reply.
    const { privateFeedFollowerService } = await import('./private-feed-follower-service');
    let catchUp = await privateFeedFollowerService.catchUp(source.ownerId, authorId);
    if (catchUp.error?.startsWith('RECOVERY_NEEDED:')) {
      // Re-approved since these keys were cached: recover from the new grant.
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage');
      const followerKey = getEncryptionKeyBytes(authorId);
      if (!followerKey) {
        return {
          success: false,
          error: 'SYNC_REQUIRED:Your private feed access was renewed. Please enter your encryption key to sync.',
        };
      }
      // Recovery tolerates a failed catch-up; encrypting must not, so check again.
      catchUp = await privateFeedFollowerService.recoverFollowerKeys(source.ownerId, authorId, followerKey);
      if (catchUp.success) catchUp = await privateFeedFollowerService.catchUp(source.ownerId, authorId);
    }
    if (!catchUp.success) {
      return {
        success: false,
        error: `Cannot encrypt reply: ${catchUp.error || 'could not sync private feed keys'}`,
      };
    }

    const cached = privateFeedKeyStore.getCachedCEK(source.ownerId);
    if (!cached || cached.keyGeneration < source.keyGeneration) {
      return {
        success: false,
        error: 'Cannot encrypt reply: encryption key state is out of date',
      };
    }

    // 4. Encrypt content at the current key generation, using the feed owner's ID as AAD
    const ownerIdBytes = identifierToBytes(source.ownerId);
    const encrypted = privateFeedCryptoService.encryptPostContent(
      cached.cek,
      content,
      ownerIdBytes,
      cached.keyGeneration
    );

    logger.debug('Prepared inherited encryption:', {
      feedOwnerId: source.ownerId,
      rootKeyGeneration: source.keyGeneration,
      keyGeneration: cached.keyGeneration,
      encryptedContentLength: encrypted.ciphertext.length,
    });

    return {
      success: true,
      data: {
        encryptedContent: encrypted.ciphertext,
        keyGeneration: cached.keyGeneration,
        nonce: encrypted.nonce,
      },
    };
  } catch (error) {
    logger.error('Error preparing inherited encryption:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
