/**
 * PrivateFeedCryptoService
 *
 * Core cryptographic operations for private feeds.
 * Implements the algorithms defined in YAPPR_PRIVATE_FEED_SPEC.md
 *
 * Dependencies:
 * - @noble/ciphers for XChaCha20-Poly1305
 * - @noble/hashes for SHA256, HKDF
 * - @noble/secp256k1 for ECDH
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { randomBytes } from '@noble/hashes/utils.js';
import * as secp256k1 from '@noble/secp256k1';

// Constants from SPEC
export const TREE_CAPACITY = 1024;
export const MAX_EPOCH = 2000;
export const LEAF_START_INDEX = 1024;
export const ROOT_NODE_ID = 1;

// Key sizes
const KEY_SIZE = 32; // 256 bits
const NONCE_SIZE = 24; // 192 bits for XChaCha20

// Empty Uint8Array for HKDF salt when no salt is needed
const EMPTY_SALT = new Uint8Array(0);

// HKDF info strings for key separation (SPEC §5.4)
const INFO_NODE = 'node';
const INFO_EPOCH_CHAIN = 'epoch-chain';
const INFO_CEK = 'cek';
const INFO_CEK_WRAP = 'cek-wrap';
const INFO_CEK_NONCE = 'cek-nonce';
const INFO_POST = 'post';
const INFO_WRAP = 'wrap';
const INFO_WRAPNONCE_SALT = 'wrapnonce-salt';
const INFO_ECIES = 'yappr/ecies/v1';

// AAD contexts (SPEC §5.5)
export const AAD_POST = 'yappr/post/v1';
export const AAD_CEK = 'yappr/cek/v1';
export const AAD_REKEY = 'yappr/rekey/v1';
export const AAD_GRANT = 'yappr/grant/v1';
export const AAD_FEED_STATE = 'yappr/feed-state/v1';

// Protocol version
export const PROTOCOL_VERSION = 0x01;

/**
 * Represents a node key in the LKH tree
 */
export interface NodeKey {
  nodeId: number;
  version: number;
  key: Uint8Array;
}

/**
 * Result of encrypting post content
 */
export interface EncryptedPost {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  epoch: number;
}

/**
 * A rekey packet for distributing updated node keys
 */
export interface RekeyPacket {
  targetNodeId: number;
  targetVersion: number;
  encryptedUnderNodeId: number;
  encryptedUnderVersion: number;
  wrappedKey: Uint8Array; // 48 bytes: 32 ciphertext + 16 tag
}

/**
 * Grant payload structure (before encryption)
 */
export interface GrantPayload {
  version: number;
  grantEpoch: number;
  leafIndex: number;
  pathKeys: NodeKey[];
  currentCEK: Uint8Array;
  wrapNonceSalt?: Uint8Array; // Added to allow followers to apply rekey documents
}

// Helper functions for integer encoding (big-endian as per SPEC §5.1.1)
function encodeUint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function encodeUint16BE(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (value >> 8) & 0xff;
  buf[1] = value & 0xff;
  return buf;
}

function encodeUint32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (value >> 24) & 0xff;
  buf[1] = (value >> 16) & 0xff;
  buf[2] = (value >> 8) & 0xff;
  buf[3] = value & 0xff;
  return buf;
}

function decodeUint16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function decodeUint32BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
}

/**
 * Concatenate multiple Uint8Arrays
 */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Convert string to UTF-8 bytes
 */
function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert UTF-8 bytes to string
 */
function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

class PrivateFeedCryptoService {
  // ============================================================
  // Key Generation (SPEC §5.2, §8.1)
  // ============================================================

  /**
   * Generate a random 256-bit feed seed
   */
  generateFeedSeed(): Uint8Array {
    return randomBytes(KEY_SIZE);
  }

  /**
   * Generate the full epoch chain from seed (SPEC §5.2)
   *
   * CEK[maxEpoch] = HKDF(epochChainRoot, "cek" || maxEpoch)
   * CEK[n-1] = SHA256(CEK[n])  (hash chain, computed backwards)
   *
   * Returns array indexed by epoch (1 to maxEpoch)
   */
  generateEpochChain(seed: Uint8Array, maxEpoch: number = MAX_EPOCH): Uint8Array[] {
    const epochChainRoot = hkdf(sha256, seed, EMPTY_SALT, utf8Encode(INFO_EPOCH_CHAIN), KEY_SIZE);

    // Generate CEK[maxEpoch]
    const cekMaxInfo = concat(utf8Encode(INFO_CEK), encodeUint32BE(maxEpoch));
    const cekMax = hkdf(sha256, epochChainRoot, EMPTY_SALT, cekMaxInfo, KEY_SIZE);

    // Pre-allocate array (index 0 unused, epochs 1 to maxEpoch)
    const chain: Uint8Array[] = new Array(maxEpoch + 1);
    chain[maxEpoch] = cekMax;

    // Compute backwards: CEK[n-1] = SHA256(CEK[n])
    for (let i = maxEpoch - 1; i >= 1; i--) {
      chain[i] = sha256(chain[i + 1]);
    }

    return chain;
  }

  /**
   * Derive CEK for a specific epoch from a known CEK at higher epoch
   * Uses hash chain: CEK[n-1] = SHA256(CEK[n])
   */
  deriveCEK(cek: Uint8Array, fromEpoch: number, toEpoch: number): Uint8Array {
    if (toEpoch > fromEpoch) {
      throw new Error('Cannot derive forward in epoch chain');
    }
    if (toEpoch < 1) {
      throw new Error('Epoch must be >= 1');
    }

    let result = cek;
    for (let i = fromEpoch; i > toEpoch; i--) {
      result = sha256(result);
    }
    return result;
  }

  /**
   * Derive a node key (SPEC §5.2)
   * nodeKey[nodeId, version] = HKDF(feedSeed, "node" || nodeId || version)
   */
  deriveNodeKey(seed: Uint8Array, nodeId: number, version: number): Uint8Array {
    const info = concat(utf8Encode(INFO_NODE), encodeUint16BE(nodeId), encodeUint16BE(version));
    return hkdf(sha256, seed, EMPTY_SALT, info, KEY_SIZE);
  }

  /**
   * Derive the wrap nonce salt from feed seed (SPEC §10)
   */
  deriveWrapNonceSalt(seed: Uint8Array): Uint8Array {
    return hkdf(sha256, seed, EMPTY_SALT, utf8Encode(INFO_WRAPNONCE_SALT), KEY_SIZE);
  }

  // ============================================================
  // Tree Operations (SPEC §6.1, §6.2)
  // ============================================================

  /**
   * Get parent node ID: parent(n) = floor(n / 2)
   */
  parent(nodeId: number): number {
    return Math.floor(nodeId / 2);
  }

  /**
   * Get left child: leftChild(n) = 2n
   */
  leftChild(nodeId: number): number {
    return 2 * nodeId;
  }

  /**
   * Get right child: rightChild(n) = 2n + 1
   */
  rightChild(nodeId: number): number {
    return 2 * nodeId + 1;
  }

  /**
   * Get sibling node ID
   * sibling(n) = n + 1 if n is even (left child), n - 1 if n is odd (right child)
   */
  sibling(nodeId: number): number {
    return nodeId % 2 === 0 ? nodeId + 1 : nodeId - 1;
  }

  /**
   * Check if node is a left child
   */
  isLeftChild(nodeId: number): boolean {
    return nodeId % 2 === 0;
  }

  /**
   * Get depth of a node: depth(n) = floor(log2(n))
   */
  depth(nodeId: number): number {
    return Math.floor(Math.log2(nodeId));
  }

  /**
   * Convert leaf index (0-1023) to node ID (1024-2047)
   */
  leafToNodeId(leafIndex: number): number {
    return LEAF_START_INDEX + leafIndex;
  }

  /**
   * Convert node ID to leaf index
   */
  nodeIdToLeaf(nodeId: number): number {
    return nodeId - LEAF_START_INDEX;
  }

  /**
   * Check if a node is on the path from a leaf to root (SPEC §6.2)
   */
  isOnPath(nodeId: number, leafNodeId: number): boolean {
    let current = leafNodeId;
    while (current >= 1) {
      if (current === nodeId) return true;
      current = this.parent(current);
    }
    return false;
  }

  /**
   * Compute the path from a leaf to root (inclusive)
   * Returns array of node IDs from leaf to root
   */
  computePath(leafIndex: number): number[] {
    const path: number[] = [];
    let nodeId = this.leafToNodeId(leafIndex);
    while (nodeId >= ROOT_NODE_ID) {
      path.push(nodeId);
      nodeId = this.parent(nodeId);
    }
    return path;
  }

  /**
   * Compute node version based on revoked leaves (SPEC §6.2)
   *
   * A node's version equals the number of times it has appeared on a revoked
   * leaf's path to root.
   */
  computeNodeVersion(nodeId: number, revokedLeaves: number[]): number {
    let version = 0;
    for (const leafIndex of revokedLeaves) {
      const leafNodeId = this.leafToNodeId(leafIndex);
      if (this.isOnPath(nodeId, leafNodeId)) {
        version++;
      }
    }
    return version;
  }

  /**
   * Compute the minimal cover set of nodes for remaining (non-revoked) users
   * This is used during revocation to determine which nodes need new keys.
   *
   * Note: This is a simplified implementation. For a proper LKH cover algorithm,
   * we would need to find the minimal set of nodes that covers all non-revoked
   * leaves without covering any revoked leaves.
   */
  computeCover(revokedLeaves: number[], treeCapacity: number = TREE_CAPACITY): number[] {
    // Mark all leaves as active or revoked
    const revokedSet = new Set(revokedLeaves);
    const cover: number[] = [];

    // Find minimal covering nodes for non-revoked leaves
    // Start from each non-revoked leaf and find highest ancestor not covering revoked
    const covered = new Set<number>();

    for (let leafIndex = 0; leafIndex < treeCapacity; leafIndex++) {
      if (revokedSet.has(leafIndex)) continue;
      if (covered.has(leafIndex)) continue;

      // Find highest ancestor that doesn't cover any revoked leaf
      let nodeId = this.leafToNodeId(leafIndex);
      let bestNode = nodeId;

      while (nodeId > ROOT_NODE_ID) {
        const parentId = this.parent(nodeId);
        let parentCoversRevoked = false;

        // Check if parent would cover any revoked leaf
        for (const revokedLeaf of revokedLeaves) {
          const revokedNodeId = this.leafToNodeId(revokedLeaf);
          if (this.isOnPath(parentId, revokedNodeId)) {
            parentCoversRevoked = true;
            break;
          }
        }

        if (parentCoversRevoked) break;
        bestNode = parentId;
        nodeId = parentId;
      }

      cover.push(bestNode);

      // Mark all leaves under bestNode as covered
      const stack = [bestNode];
      let current: number | undefined;
      while ((current = stack.pop()) !== undefined) {
        if (current >= LEAF_START_INDEX) {
          covered.add(this.nodeIdToLeaf(current));
        } else {
          stack.push(this.leftChild(current), this.rightChild(current));
        }
      }
    }

    return cover;
  }

  // ============================================================
  // ECIES Encryption (SPEC §11.5)
  // ============================================================

  /**
   * ECIES Encrypt (SPEC §11.5.1)
   *
   * Uses ephemeral ECDH + XChaCha20-Poly1305
   */
  async eciesEncrypt(
    recipientPubKey: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    // 1. Generate ephemeral keypair
    const ephemeralPrivKey = randomBytes(KEY_SIZE);
    const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true); // compressed

    // 2. Compute shared secret via ECDH
    const sharedPoint = secp256k1.getSharedSecret(ephemeralPrivKey, recipientPubKey, true);
    // Extract x-coordinate (skip first byte which is the prefix)
    const sharedX = sharedPoint.slice(1, 33);
    const sharedSecret = sha256(sharedX);

    // 3. Derive encryption key and nonce via HKDF
    const derived = hkdf(sha256, sharedSecret, ephemeralPubKey, utf8Encode(INFO_ECIES), 56);
    const encKey = derived.slice(0, 32);
    const nonce = derived.slice(32, 56);

    // 4. Encrypt with XChaCha20-Poly1305
    const cipher = xchacha20poly1305(encKey, nonce, aad);
    const ciphertext = cipher.encrypt(plaintext);

    // 5. Return: ephemeralPubKey || ciphertext
    return concat(ephemeralPubKey, ciphertext);
  }

  /**
   * ECIES Decrypt (SPEC §11.5.2)
   */
  async eciesDecrypt(
    recipientPrivKey: Uint8Array,
    eciesCiphertext: Uint8Array,
    aad: Uint8Array
  ): Promise<Uint8Array> {
    // 1. Parse eciesCiphertext
    const ephemeralPubKey = eciesCiphertext.slice(0, 33);
    const ciphertext = eciesCiphertext.slice(33);

    // 2. Compute shared secret via ECDH
    const sharedPoint = secp256k1.getSharedSecret(recipientPrivKey, ephemeralPubKey, true);
    const sharedX = sharedPoint.slice(1, 33);
    const sharedSecret = sha256(sharedX);

    // 3. Derive encryption key and nonce via HKDF
    const derived = hkdf(sha256, sharedSecret, ephemeralPubKey, utf8Encode(INFO_ECIES), 56);
    const encKey = derived.slice(0, 32);
    const nonce = derived.slice(32, 56);

    // 4. Decrypt with XChaCha20-Poly1305
    const cipher = xchacha20poly1305(encKey, nonce, aad);
    return cipher.decrypt(ciphertext);
  }

  // ============================================================
  // Content Encryption (SPEC §8.2, §8.6)
  // ============================================================

  /**
   * Encrypt post content (SPEC §8.2)
   *
   * postKey = HKDF(CEK[epoch], "post" || nonce || ownerId)
   * AAD = "yappr/post/v1" || ownerId || epoch || nonce
   * versionedContent = 0x01 || plaintext
   * ciphertext = XChaCha20-Poly1305-Encrypt(postKey, nonce, versionedContent, AAD)
   */
  encryptPostContent(
    cek: Uint8Array,
    plaintext: string,
    ownerId: Uint8Array,
    epoch: number
  ): EncryptedPost {
    // Generate random nonce
    const nonce = randomBytes(NONCE_SIZE);

    // Derive post key
    const postKeyInfo = concat(utf8Encode(INFO_POST), nonce, ownerId);
    const postKey = hkdf(sha256, cek, EMPTY_SALT, postKeyInfo, KEY_SIZE);

    // Build AAD
    const aad = concat(utf8Encode(AAD_POST), ownerId, encodeUint32BE(epoch), nonce);

    // Version prefix + plaintext
    const versionedContent = concat(encodeUint8(PROTOCOL_VERSION), utf8Encode(plaintext));

    // Encrypt
    const cipher = xchacha20poly1305(postKey, nonce, aad);
    const ciphertext = cipher.encrypt(versionedContent);

    return { ciphertext, nonce, epoch };
  }

  /**
   * Decrypt post content (SPEC §8.6)
   */
  decryptPostContent(
    cek: Uint8Array,
    encrypted: EncryptedPost,
    ownerId: Uint8Array
  ): string {
    const { ciphertext, nonce, epoch } = encrypted;

    // Derive post key
    const postKeyInfo = concat(utf8Encode(INFO_POST), nonce, ownerId);
    const postKey = hkdf(sha256, cek, EMPTY_SALT, postKeyInfo, KEY_SIZE);

    // Build AAD
    const aad = concat(utf8Encode(AAD_POST), ownerId, encodeUint32BE(epoch), nonce);

    // Decrypt
    const cipher = xchacha20poly1305(postKey, nonce, aad);
    const versionedContent = cipher.decrypt(ciphertext);

    // Validate and strip version prefix
    if (versionedContent[0] !== PROTOCOL_VERSION) {
      throw new Error(`Unknown protocol version: ${versionedContent[0]}`);
    }

    return utf8Decode(versionedContent.slice(1));
  }

  // ============================================================
  // Key Wrapping (SPEC §8.5, §8.7)
  // ============================================================

  /**
   * Derive deterministic nonce for rekey packets (SPEC §10)
   */
  deriveRekeyNonce(
    wrapNonceSalt: Uint8Array,
    epoch: number,
    targetNodeId: number,
    targetVersion: number,
    encryptedUnderNodeId: number,
    encryptedUnderVersion: number
  ): Uint8Array {
    const info = concat(
      encodeUint32BE(epoch),
      encodeUint16BE(targetNodeId),
      encodeUint16BE(targetVersion),
      encodeUint16BE(encryptedUnderNodeId),
      encodeUint16BE(encryptedUnderVersion)
    );
    return hkdf(sha256, utf8Encode('yappr/wrapnonce'), wrapNonceSalt, info, NONCE_SIZE);
  }

  /**
   * Wrap a key using XChaCha20-Poly1305
   */
  wrapKey(
    wrapKey: Uint8Array,
    keyToWrap: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array
  ): Uint8Array {
    const cipher = xchacha20poly1305(wrapKey, nonce, aad);
    return cipher.encrypt(keyToWrap);
  }

  /**
   * Unwrap a key using XChaCha20-Poly1305
   */
  unwrapKey(
    wrapKey: Uint8Array,
    wrappedKey: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array
  ): Uint8Array {
    const cipher = xchacha20poly1305(wrapKey, nonce, aad);
    return cipher.decrypt(wrappedKey);
  }

  /**
   * Derive wrap key from a node key (SPEC §8.5)
   */
  deriveWrapKey(nodeKey: Uint8Array): Uint8Array {
    return hkdf(sha256, nodeKey, EMPTY_SALT, utf8Encode(INFO_WRAP), KEY_SIZE);
  }

  /**
   * Build AAD for rekey packet (SPEC §9.1)
   */
  buildRekeyAAD(
    ownerId: Uint8Array,
    epoch: number,
    targetNodeId: number,
    targetVersion: number,
    encryptedUnderNodeId: number,
    encryptedUnderVersion: number
  ): Uint8Array {
    return concat(
      utf8Encode(AAD_REKEY),
      ownerId,
      encodeUint32BE(epoch),
      encodeUint16BE(targetNodeId),
      encodeUint16BE(targetVersion),
      encodeUint16BE(encryptedUnderNodeId),
      encodeUint16BE(encryptedUnderVersion)
    );
  }

  /**
   * Encrypt CEK for distribution (SPEC §8.5 step 9)
   */
  encryptCEK(
    rootKey: Uint8Array,
    cek: Uint8Array,
    ownerId: Uint8Array,
    epoch: number
  ): Uint8Array {
    const cekWrapKey = hkdf(sha256, rootKey, EMPTY_SALT, utf8Encode(INFO_CEK_WRAP), KEY_SIZE);
    const cekNonceInfo = concat(utf8Encode(INFO_CEK_NONCE), encodeUint32BE(epoch));
    const cekNonce = hkdf(sha256, rootKey, EMPTY_SALT, cekNonceInfo, NONCE_SIZE);
    const cekAAD = concat(utf8Encode(AAD_CEK), ownerId, encodeUint32BE(epoch));

    const cipher = xchacha20poly1305(cekWrapKey, cekNonce, cekAAD);
    return cipher.encrypt(cek);
  }

  /**
   * Decrypt CEK from rekey document (SPEC §8.7 step 7)
   */
  decryptCEK(
    rootKey: Uint8Array,
    encryptedCEK: Uint8Array,
    ownerId: Uint8Array,
    epoch: number
  ): Uint8Array {
    const cekWrapKey = hkdf(sha256, rootKey, EMPTY_SALT, utf8Encode(INFO_CEK_WRAP), KEY_SIZE);
    const cekNonceInfo = concat(utf8Encode(INFO_CEK_NONCE), encodeUint32BE(epoch));
    const cekNonce = hkdf(sha256, rootKey, EMPTY_SALT, cekNonceInfo, NONCE_SIZE);
    const cekAAD = concat(utf8Encode(AAD_CEK), ownerId, encodeUint32BE(epoch));

    const cipher = xchacha20poly1305(cekWrapKey, cekNonce, cekAAD);
    return cipher.decrypt(encryptedCEK);
  }

  // ============================================================
  // Grant Payload Encoding/Decoding (SPEC §9.3)
  // ============================================================

  /**
   * Encode grant payload to bytes (SPEC §9.3.1)
   * Extended with wrapNonceSalt for follower rekey support
   */
  encodeGrantPayload(payload: GrantPayload): Uint8Array {
    const parts: Uint8Array[] = [
      encodeUint8(payload.version),
      encodeUint32BE(payload.grantEpoch),
      encodeUint16BE(payload.leafIndex),
      encodeUint8(payload.pathKeys.length)
    ];

    for (const pk of payload.pathKeys) {
      parts.push(encodeUint16BE(pk.nodeId));
      parts.push(encodeUint16BE(pk.version));
      parts.push(pk.key);
    }

    parts.push(payload.currentCEK);

    // Include wrapNonceSalt if provided (32 bytes)
    // This allows followers to apply rekey documents
    if (payload.wrapNonceSalt) {
      parts.push(payload.wrapNonceSalt);
    }

    return concat(...parts);
  }

  /**
   * Decode grant payload from bytes (SPEC §9.3.1)
   * Extended to read wrapNonceSalt if present
   */
  decodeGrantPayload(data: Uint8Array): GrantPayload {
    let offset = 0;

    const version = data[offset++];
    const grantEpoch = decodeUint32BE(data, offset);
    offset += 4;
    const leafIndex = decodeUint16BE(data, offset);
    offset += 2;
    const pathKeyCount = data[offset++];

    const pathKeys: NodeKey[] = [];
    for (let i = 0; i < pathKeyCount; i++) {
      const nodeId = decodeUint16BE(data, offset);
      offset += 2;
      const keyVersion = decodeUint16BE(data, offset);
      offset += 2;
      const key = data.slice(offset, offset + KEY_SIZE);
      offset += KEY_SIZE;
      pathKeys.push({ nodeId, version: keyVersion, key });
    }

    const currentCEK = data.slice(offset, offset + KEY_SIZE);
    offset += KEY_SIZE;

    // Check if wrapNonceSalt is present (optional, 32 bytes at end)
    let wrapNonceSalt: Uint8Array | undefined;
    if (offset + KEY_SIZE <= data.length) {
      wrapNonceSalt = data.slice(offset, offset + KEY_SIZE);
    }

    return { version, grantEpoch, leafIndex, pathKeys, currentCEK, wrapNonceSalt };
  }

  /**
   * Build AAD for grant encryption (SPEC §11.5.4)
   */
  buildGrantAAD(
    ownerId: Uint8Array,
    recipientId: Uint8Array,
    leafIndex: number,
    epoch: number
  ): Uint8Array {
    return concat(
      utf8Encode(AAD_GRANT),
      ownerId,
      recipientId,
      encodeUint16BE(leafIndex),
      encodeUint32BE(epoch)
    );
  }

  /**
   * Build AAD for feed state encryption (SPEC §11.5.4)
   */
  buildFeedStateAAD(ownerId: Uint8Array): Uint8Array {
    return concat(utf8Encode(AAD_FEED_STATE), ownerId);
  }

  // ============================================================
  // Rekey Packet Encoding/Decoding (SPEC §9.1)
  // ============================================================

  /**
   * Encode rekey packets to bytes (SPEC §9.1)
   */
  encodeRekeyPackets(packets: RekeyPacket[]): Uint8Array {
    const parts: Uint8Array[] = [encodeUint8(packets.length)];

    for (const packet of packets) {
      parts.push(encodeUint16BE(packet.targetNodeId));
      parts.push(encodeUint16BE(packet.targetVersion));
      parts.push(encodeUint16BE(packet.encryptedUnderNodeId));
      parts.push(encodeUint16BE(packet.encryptedUnderVersion));
      parts.push(packet.wrappedKey); // 48 bytes
    }

    return concat(...parts);
  }

  /**
   * Decode rekey packets from bytes (SPEC §9.1)
   */
  decodeRekeyPackets(data: Uint8Array): RekeyPacket[] {
    const packetCount = data[0];
    const packets: RekeyPacket[] = [];
    // Each packet is 56 bytes: 2 + 2 + 2 + 2 + 48

    let offset = 1;
    for (let i = 0; i < packetCount; i++) {
      const targetNodeId = decodeUint16BE(data, offset);
      offset += 2;
      const targetVersion = decodeUint16BE(data, offset);
      offset += 2;
      const encryptedUnderNodeId = decodeUint16BE(data, offset);
      offset += 2;
      const encryptedUnderVersion = decodeUint16BE(data, offset);
      offset += 2;
      const wrappedKey = data.slice(offset, offset + 48);
      offset += 48;

      packets.push({
        targetNodeId,
        targetVersion,
        encryptedUnderNodeId,
        encryptedUnderVersion,
        wrappedKey
      });
    }

    return packets;
  }

  // ============================================================
  // Validation (SPEC §12.0)
  // ============================================================

  /**
   * Validate grant payload (SPEC §12.0.2)
   */
  validateGrantPayload(payload: GrantPayload, expectedLeafIndex: number): void {
    if (payload.version !== PROTOCOL_VERSION) {
      throw new Error(`Unknown protocol version: ${payload.version}`);
    }

    if (payload.leafIndex !== expectedLeafIndex) {
      throw new Error(
        `Leaf index mismatch: expected ${expectedLeafIndex}, got ${payload.leafIndex}`
      );
    }

    if (payload.pathKeys.length === 0) {
      throw new Error('Path keys cannot be empty');
    }

    if (payload.pathKeys.length > 11) {
      throw new Error(`Too many path keys: ${payload.pathKeys.length} > 11`);
    }

    // Verify path starts at correct leaf
    const expectedLeafNodeId = this.leafToNodeId(expectedLeafIndex);
    if (payload.pathKeys[0].nodeId !== expectedLeafNodeId) {
      throw new Error(
        `Path must start at leaf node ${expectedLeafNodeId}, got ${payload.pathKeys[0].nodeId}`
      );
    }

    // Verify path continuity: each subsequent node is parent of previous
    for (let i = 1; i < payload.pathKeys.length; i++) {
      const expectedParent = this.parent(payload.pathKeys[i - 1].nodeId);
      if (payload.pathKeys[i].nodeId !== expectedParent) {
        throw new Error(
          `Path discontinuity at index ${i}: expected ${expectedParent}, got ${payload.pathKeys[i].nodeId}`
        );
      }
    }

    // Verify path ends at root
    const lastNodeId = payload.pathKeys[payload.pathKeys.length - 1].nodeId;
    if (lastNodeId !== ROOT_NODE_ID) {
      throw new Error(`Path must end at root (1), got ${lastNodeId}`);
    }
  }

  /**
   * Validate rekey packet bounds (SPEC §12.0.1)
   */
  validateRekeyPacket(packet: RekeyPacket): void {
    if (packet.targetNodeId < 1 || packet.targetNodeId > 2047) {
      throw new Error(`Invalid targetNodeId: ${packet.targetNodeId}`);
    }

    if (packet.encryptedUnderNodeId < 1 || packet.encryptedUnderNodeId > 2047) {
      throw new Error(`Invalid encryptedUnderNodeId: ${packet.encryptedUnderNodeId}`);
    }

    if (packet.targetVersion >= 65535) {
      throw new Error(`Version overflow: ${packet.targetVersion}`);
    }

    if (packet.wrappedKey.length !== 48) {
      throw new Error(`Invalid wrapped key length: ${packet.wrappedKey.length}`);
    }
  }

  // ============================================================
  // Utility Functions
  // ============================================================

  /**
   * Generate random bytes
   */
  randomBytes(length: number): Uint8Array {
    return randomBytes(length);
  }

  /**
   * Get a public key from private key (compressed format)
   */
  getPublicKey(privateKey: Uint8Array): Uint8Array {
    return secp256k1.getPublicKey(privateKey, true);
  }
}

// Export singleton instance
export const privateFeedCryptoService = new PrivateFeedCryptoService();

// Export types for use by other modules
export type { PrivateFeedCryptoService };
