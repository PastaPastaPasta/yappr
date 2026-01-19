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

## 2026-01-18: PrivateFeedKeyStore Implementation

**Task:** Create local key storage service for private feeds (Phase 1 Foundation)

**Changes made:**
1. Created `lib/services/private-feed-key-store.ts` implementing the PRD §3.4 interface:

   **Owner Key Storage:**
   - `storeFeedSeed()` / `getFeedSeed()` - Store/retrieve feed seed
   - `storeCurrentEpoch()` / `getCurrentEpoch()` - Track current epoch
   - `storeRevokedLeaves()` / `getRevokedLeaves()` - Maintain ordered revocation history
   - `storeAvailableLeaves()` / `getAvailableLeaves()` - Cache available leaves (derived from grants)
   - `storeRecipientMap()` / `getRecipientMap()` - Track recipientId → leafIndex mapping
   - `initializeOwnerState()` - Initialize all owner state for new feed

   **Follower Key Storage (per feed owner):**
   - `storePathKeys()` / `getPathKeys()` - Store LKH path keys for followed feeds
   - `updatePathKeys()` - Update specific path keys after rekey application
   - `storeCachedCEK()` / `getCachedCEK()` - Cache current epoch CEK
   - `initializeFollowerState()` - Initialize follower keys from grant payload

   **Cleanup:**
   - `clearFeedKeys()` - Clear keys for a specific followed feed
   - `clearOwnerKeys()` - Clear all owner keys (when disabling private feed)
   - `clearAllKeys()` - Clear all private feed keys
   - `getFollowedFeedOwners()` - List all feeds we have keys for

   **Utilities:**
   - Base64 encoding/decoding for Uint8Array storage
   - Storage availability detection for SSR safety
   - Storage key prefix: `yappr:pf:` as specified in PRD

2. Exported service and types from `lib/services/index.ts`:
   - `privateFeedKeyStore` singleton
   - Types: `StoredPathKey`, `CachedCEK`, `RecipientLeafMap`

**Screenshot:** `screenshots/private-feed-key-store.png`

## 2026-01-18: PrivateFeedService Implementation

**Task:** Create high-level service for private feed owner operations (Phase 1 Foundation)

**Changes made:**
1. Created `lib/services/private-feed-service.ts` implementing PRD §3.2 interface:

   **Query Operations:**
   - `hasPrivateFeed(ownerId)` - Check if user has private feed enabled
   - `getPrivateFeedState(ownerId)` - Fetch PrivateFeedState document
   - `getLatestEpoch(ownerId)` - Get current epoch from rekey documents
   - `getRekeyDocuments(ownerId)` - Fetch all rekey documents for recovery

   **Owner Operations (SPEC §8.1, §8.2):**
   - `enablePrivateFeed(ownerId, encryptionPrivateKey)` - Initialize private feed:
     - Generate 256-bit feed seed
     - Pre-compute epoch chain (CEK[1] cached for immediate use)
     - Encrypt seed to owner's public key using ECIES
     - Create PrivateFeedState document on platform
     - Initialize local state (all 1024 leaves available)
   - `createPrivatePost(ownerId, content, teaser?)` - Create encrypted post:
     - Sync check: compare chain epoch vs local epoch
     - Validate content size (max 999 bytes)
     - Derive/retrieve CEK for current epoch
     - Encrypt content using XChaCha20-Poly1305
     - Create post document with encryptedContent, epoch, nonce

   **State Accessors:**
   - `getCurrentEpoch()` - Get local epoch
   - `getAvailableLeafCount()` - Count available follower slots
   - `getRevokedLeaves()` - Get revocation history
   - `isLocallyInitialized()` - Check if local keys exist

   **Utilities:**
   - `identifierToBytes()` - Convert base58 identity to 32-byte array for crypto
   - `normalizeBytes()` - Handle SDK byte array response formats

2. Updated `lib/services/index.ts` exports:
   - `privateFeedService` singleton
   - Types: `PrivateFeedStateDocument`, `PrivateFeedRekeyDocument`, `PrivatePostResult`

**Screenshot:** `screenshots/private-feed-service.png`

## 2026-01-18: PrivateFeedFollowerService Implementation

**Task:** Create follower-side service for private feed operations (Phase 2 Follower Management)

**Changes made:**
1. Created `lib/services/private-feed-follower-service.ts` implementing PRD §3.3 interface:

   **Access Request Operations (SPEC §8.3):**
   - `requestAccess(ownerId, myId, publicKey?)` - Create FollowRequest document:
     - Validates owner has private feed enabled
     - Checks for existing grant or pending request
     - Creates FollowRequest document with targetId
     - Optionally includes public key if not available on-chain
   - `cancelRequest(ownerId, myId)` - Delete pending FollowRequest
   - `getPendingRequests(myId)` - Get all pending requests for current user

   **Grant Query Operations:**
   - `getFollowRequest(ownerId, requesterId)` - Get specific follow request
   - `getGrant(ownerId, recipientId)` - Get grant document for a recipient
   - `getAccessStatus(ownerId, myId)` - Get access status: 'none' | 'pending' | 'approved' | 'revoked'

   **Decryption Capability (SPEC §8.6):**
   - `canDecrypt(ownerId)` - Check if we have cached keys for a feed
   - `getCachedEpoch(ownerId)` - Get cached epoch for a feed owner
   - `decryptPost(post)` - Decrypt private post:
     - Verify we have keys for the feed owner
     - Auto catch-up if post epoch > cached epoch
     - Derive CEK for post's epoch (backwards via hash chain if needed)
     - Decrypt using XChaCha20-Poly1305

   **Key Catch-up (SPEC §8.7):**
   - `catchUp(ownerId)` - Apply rekey documents to update keys:
     - Fetch rekey documents after cached epoch
     - Verify epoch continuity
     - Apply each rekey iteratively
   - `applyRekey()` - Process single rekey document:
     - Parse and validate rekey packets
     - Iteratively decrypt packets using current keys
     - Derive new root key and CEK
     - Update stored path keys

   **Follower Recovery (SPEC §8.9):**
   - `recoverFollowerKeys(ownerId, myId, encryptionPrivateKey)` - Recover from grant:
     - Fetch grant document
     - Decrypt payload using ECIES
     - Validate and store path keys and CEK
     - Auto catch-up on any pending rekeys

   **Cleanup:**
   - `clearFeedKeys(ownerId)` - Clear local keys for a feed (e.g., after revocation)

2. Updated `lib/services/index.ts` exports:
   - `privateFeedFollowerService` singleton
   - Types: `FollowRequestDocument`, `PrivateFeedGrantDocument`, `DecryptResult`, `EncryptedPostFields`

**Screenshot:** `screenshots/private-feed-follower-service.png`

## 2026-01-19: Enable Private Feed UI (Phase 3 Feed Integration - UI)

**Task:** Create settings UI for enabling private feeds (PRD §4.1)

**Changes made:**
1. Created `components/settings/private-feed-settings.tsx` implementing the Enable Private Feed UI:

   **Not Enabled State:**
   - Explanation card with feature benefits:
     - "You control who can see your private posts"
     - "Up to 1,024 private followers"
     - "Revoke access at any time"
   - "Enable Private Feed" button
   - "How it works" section explaining encryption

   **Key Input State (after clicking Enable):**
   - Warning banner explaining encryption key requirement
   - Hex input field for 32-byte encryption private key
   - Input validation (64 hex characters, valid secp256k1 key)
   - Cancel and Enable buttons with loading state

   **Enabled State:**
   - Success indicator with enabled date
   - Stats dashboard: Followers count, Current epoch, Available slots
   - Epoch usage warning when > 90% (approaching revocation limit)
   - Capacity information display

2. Updated `app/settings/page.tsx`:
   - Added 'privateFeed' to SettingsSection type and valid sections array
   - Imported LockClosedIcon from Heroicons
   - Added Private Feed to settingsSections navigation array
   - Created renderPrivateFeedSettings() function
   - Added case for 'privateFeed' in renderSection switch

3. Imported PrivateFeedSettings component and integrated with settings page

**Key features:**
- Responsive design following existing settings patterns
- Loading states with skeleton placeholders
- Proper error handling with user-friendly messages
- Toast notifications for success/failure
- Validates encryption key format before attempting enable

**Screenshots:**
- `screenshots/private-feed-enable-ui.png` (not enabled state)
- `screenshots/private-feed-key-input.png` (key input state)
- `screenshots/settings-private-feed-nav.png` (settings navigation with Private Feed)

## 2026-01-19: Compose Private Post UI (Phase 3 Feed Integration)

**Task:** Add visibility selector to compose modal for private posts (PRD §4.2)

**Changes made:**
1. Updated `lib/store.ts` with new types and actions:
   - Added `PostVisibility` type: `'public' | 'private' | 'private-with-teaser'`
   - Extended `ThreadPost` interface with `visibility` and `teaser` fields
   - Added `updateThreadPostVisibility()` and `updateThreadPostTeaser()` actions

2. Created `components/compose/visibility-selector.tsx`:
   - Dropdown selector with three options: Public, Private, Private with Teaser
   - Visual indicators: globe icon for public, lock icon for private options
   - Shows warning when no private followers exist
   - Displays follower count in footer when private is selected
   - Handles loading state while checking private feed status

3. Updated `components/compose/compose-modal.tsx`:
   - Integrated VisibilitySelector component
   - Added private feed state checking (uses local keys as fast path)
   - Added private post banner explaining encryption behavior
   - Added teaser input field for "Private with Teaser" mode
   - Added "Private Content (encrypted)" label above main content
   - Updated footer to show private follower visibility info
   - Modified post creation to use `privateFeedService.createPrivatePost()` for private posts
   - Disabled thread composition for private posts (single post only)

**Key features per PRD §4.2:**
- Visibility selector below content input (default: Public)
- Visual indicator with lock icon when private selected
- Two text areas for Private with Teaser mode:
  - Teaser: 280 character limit
  - Full content: 500 character limit (encrypted)
- Validation: Requires private feed to be enabled
- Warning when no private followers

**Screenshots:**
- `screenshots/compose-with-visibility-selector.png` (public mode with selector)
- `screenshots/compose-visibility-dropdown.png` (expanded dropdown)
- `screenshots/compose-private-mode.png` (private mode with banner)
- `screenshots/compose-private-with-teaser.png` (teaser input visible)
