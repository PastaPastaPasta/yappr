# Activity

## 2026-01-18: Data Contract Update for Private Feeds

**Task:** Update data contract with private feed document types and post modifications

**Changes made:**
1. Updated `contracts/yappr-social-contract-actual.json` with 4 new document types:
   - `followRequest` - For requesting access to a private feed (with unique index on targetId + $ownerId)
   - `privateFeedGrant` - For approved private followers (with unique indices on owner+recipient and owner+leafIndex)
   - `privateFeedRekey` - For revocation operations, marked as `canBeDeleted: false` and `mutable: false` (CRITICAL for security)
   - `privateFeedState` - For feed initialization state, marked as `canBeDeleted: false` and `mutable: false`

2. Modified `post` document type with new optional fields for private posts:
   - `encryptedContent` (bytes, max 1024) - AEAD ciphertext for private content
   - `epoch` (uint32) - Epoch number for key derivation
   - `nonce` (bytes[24]) - XChaCha20-Poly1305 nonce

3. Extended `notification` type enum with three new values:
   - `privateFeedRequest`
   - `privateFeedApproved`
   - `privateFeedRevoked`

4. Updated `lib/constants.ts`:
   - Changed `YAPPR_CONTRACT_ID` to new contract: `FNDUsTkqMQ1Wv4qhvg25VqHRnLLfCwwvw1YFMUL9iQ7e`
   - Added new document type constants: `FOLLOW_REQUEST`, `PRIVATE_FEED_GRANT`, `PRIVATE_FEED_REKEY`, `PRIVATE_FEED_STATE`

**Screenshot:** `screenshots/contract-update-private-feeds.png`

## 2026-01-18: PrivateFeedCryptoService Implementation

**Task:** Create core cryptographic service for private feeds (Phase 1 Foundation)

**Changes made:**
1. Created `lib/services/private-feed-crypto-service.ts` with comprehensive cryptographic operations:

   **Key Generation:**
   - `generateFeedSeed()` - Generate 256-bit random feed seed
   - `generateEpochChain()` - Pre-generate full CEK hash chain (2000 epochs)
   - `deriveCEK()` - Derive CEK for older epochs via hash chain
   - `deriveNodeKey()` - Derive LKH tree node keys using HKDF
   - `deriveWrapNonceSalt()` - Derive salt for deterministic nonce generation

   **Tree Operations (LKH binary tree with 1024 leaves):**
   - `parent()`, `leftChild()`, `rightChild()`, `sibling()` - Tree navigation
   - `leafToNodeId()`, `nodeIdToLeaf()` - Leaf/node index conversion
   - `isOnPath()`, `computePath()` - Path operations
   - `computeNodeVersion()` - Derive node version from revoked leaves history
   - `computeCover()` - Compute minimal cover set for non-revoked users

   **ECIES Encryption (secp256k1 + XChaCha20-Poly1305):**
   - `eciesEncrypt()` - Ephemeral ECDH-based encryption
   - `eciesDecrypt()` - ECIES decryption

   **Content Encryption:**
   - `encryptPostContent()` - Encrypt private post content with versioning
   - `decryptPostContent()` - Decrypt and validate private post content

   **Key Wrapping:**
   - `deriveRekeyNonce()` - Deterministic nonce for rekey packets
   - `wrapKey()`, `unwrapKey()` - XChaCha20-Poly1305 key wrapping
   - `deriveWrapKey()` - Derive wrap key from node key
   - `encryptCEK()`, `decryptCEK()` - CEK encryption for rekey documents

   **Binary Encoding:**
   - `encodeGrantPayload()`, `decodeGrantPayload()` - Grant payload serialization
   - `encodeRekeyPackets()`, `decodeRekeyPackets()` - Rekey packet serialization
   - `buildGrantAAD()`, `buildFeedStateAAD()`, `buildRekeyAAD()` - AAD construction

   **Validation (per SPEC §12):**
   - `validateGrantPayload()` - Validate grant payload structure and path integrity
   - `validateRekeyPacket()` - Validate rekey packet bounds

2. Exported service and types from `lib/services/index.ts`:
   - `privateFeedCryptoService` singleton
   - Types: `NodeKey`, `EncryptedPost`, `RekeyPacket`, `GrantPayload`
   - Constants: `TREE_CAPACITY`, `MAX_EPOCH`, `LEAF_START_INDEX`, `ROOT_NODE_ID`, `PROTOCOL_VERSION`, AAD constants

**Dependencies:** Uses already-installed `@noble/ciphers`, `@noble/hashes`, `@noble/secp256k1`

**Screenshot:** `screenshots/private-feed-crypto-service.png`
