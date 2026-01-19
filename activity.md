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

## 2026-01-19: Manage Follow Requests UI (Phase 2 Follower Management)

**Task:** Create UI for feed owners to manage pending follow requests (PRD §4.5)

**Changes made:**
1. Extended `lib/services/private-feed-follower-service.ts` with owner-side query:
   - `getFollowRequestsForOwner(ownerId)` - Query all FollowRequest documents targeting the owner
   - Filters out stale requests where a grant already exists
   - Returns requests sorted by creation date (newest first)

2. Extended `lib/services/private-feed-service.ts` with follower approval:
   - `approveFollower(ownerId, requesterId, requesterPublicKey)` - Full grant creation flow:
     - Sync check: compares chain epoch vs local epoch
     - Allocates next available leaf index
     - Computes path keys from leaf to root with correct versions
     - Retrieves current CEK for the epoch
     - Builds and encodes grant payload (version, epoch, leafIndex, pathKeys, CEK)
     - Encrypts payload using ECIES to requester's public key
     - Creates PrivateFeedGrant document on platform
     - Updates local state (removes leaf from available, adds to recipient map)
   - `getPrivateFollowers(ownerId)` - Query all grant documents for the owner

3. Created `components/settings/private-feed-follow-requests.tsx`:
   - Card-based UI with header showing request count badge
   - Loading skeleton state matching existing patterns
   - "Not enabled" state with lock icon prompting user to enable private feed
   - Empty state when no pending requests
   - Request list with:
     - User avatar via `UserAvatar` component
     - Display name and DPNS username (if available)
     - "Requested X ago" timestamp using relative time formatting
     - "Approve" button (green) with loading spinner during processing
     - "Ignore" button (outline) to dismiss request from UI
   - Resolves user details via `dpnsService` and `unifiedProfileService`
   - Fetches requester's encryption public key from identity for grant creation
   - Toast notifications for success/error states

4. Updated `app/settings/page.tsx`:
   - Imported `PrivateFeedFollowRequests` component
   - Added component below `PrivateFeedSettings` in the privateFeed section

**Key features per PRD §4.5:**
- Shows pending requests targeting the feed owner
- Approve action creates PrivateFeedGrant with all cryptographic keys
- Ignore action hides request from UI (request remains on-chain, can approve later)
- Request count badge in header for quick visibility
- Proper handling of encryption key lookup from identity

**Screenshot:** `screenshots/private-feed-follow-requests-ui.png`

## 2026-01-19: Private Post Rendering UI (Phase 3 Feed Integration)

**Task:** Implement private post rendering in feed for both followers and non-followers (PRD §4.3 & §4.4)

**Changes made:**
1. Updated `lib/types.ts` to include private feed fields on Post interface:
   - `encryptedContent?: Uint8Array` - XChaCha20-Poly1305 ciphertext
   - `epoch?: number` - Revocation epoch at post creation
   - `nonce?: Uint8Array` - Random nonce for encryption

2. Updated `lib/services/post-service.ts`:
   - Extended `PostDocument` interface with private feed fields
   - Updated `transformDocument()` to extract and normalize private feed fields from SDK responses
   - Added `normalizeBytes()` helper to handle SDK byte array formats (base64, Uint8Array, regular array)

3. Created `components/post/private-post-content.tsx` with comprehensive rendering:
   - `PrivatePostContent` component handles all decryption states:
     - **Loading state**: Shows teaser (if available) + "Decrypting..." skeleton
     - **Decrypted state**: Shows full content with teaser (muted) above
     - **Locked state (no-keys)**: Shows teaser + locked box + "Request Access" button
     - **Locked state (revoked)**: Shows teaser + locked box + "Access revoked" message
     - **Locked state (no-auth)**: Shows teaser + locked box + "Log in to request access"
     - **Error state**: Shows teaser + error message
   - `PrivatePostBadge` helper component for showing private indicator
   - `isPrivatePost()` type guard function
   - Owner decryption path uses local feed seed and CEK cache
   - Follower decryption path uses `privateFeedFollowerService.decryptPost()`
   - Automatic catch-up on rekeys when post epoch > cached epoch

4. Updated `components/post/post-card.tsx`:
   - Imported `PrivatePostContent`, `PrivatePostBadge`, and `isPrivatePost`
   - Added `LockClosedIcon` import for private post indicator
   - Added lock icon next to timestamp for private posts
   - Integrated `PrivatePostContent` component for rendering private posts
   - Added `onRequestAccess` handler that navigates to the author's profile

**Key features per PRD §4.3 & §4.4:**
- Private posts show lock icon in header next to timestamp
- Non-followers see locked state with teaser (if available) and "Request Access" button
- Approved followers see decrypted content with loading state during decryption
- Revoked users see locked state with "Access revoked" message
- Post owner always sees full decrypted content
- Graceful error handling with user-friendly messages

**Screenshot:** `screenshots/private-post-view-ui.png`

## 2026-01-19: Request Access UI on Profile Page (Phase 2 Follower Management)

**Task:** Add Request Access button to user profile page for private feed access (PRD §4.7)

**Changes made:**
1. Created `components/profile/private-feed-access-button.tsx`:
   - `PrivateFeedAccessButton` component for profile page integration
   - Checks if profile owner has private feed enabled
   - Shows different states based on access status:
     - **Not shown**: When not following OR owner has no private feed
     - **Request Access**: Button with lock icon to request access
     - **Pending...**: Amber badge showing request is awaiting approval (click to cancel)
     - **Private ✓**: Green badge showing approved access
     - **Revoked**: Gray badge showing access was revoked
   - Handles request submission via `privateFeedFollowerService.requestAccess()`
   - Handles request cancellation via `privateFeedFollowerService.cancelRequest()`
   - Loading states and toast notifications for all actions

2. Updated `app/user/page.tsx`:
   - Added `LockClosedIcon` import from Heroicons
   - Added `PrivateFeedAccessButton` import
   - Added `hasPrivateFeed` state variable
   - Added private feed status check in profile loading effect
   - Added Private Feed badge next to username when owner has private feed enabled:
     - Shows "Private Feed" badge with lock icon
     - Tooltip explaining: "This user has a private feed. Follow them to request access."
   - Integrated `PrivateFeedAccessButton` in action buttons section (after Follow button)

**Key features per PRD §4.7:**
- Button only appears after following the user
- Button only appears if the user has a private feed
- Shows appropriate state: Request Access, Pending, Approved, or Revoked
- Pending state allows canceling the request
- Profile shows "Private Feed" badge indicator for users with private feeds

**Screenshot:** `screenshots/profile-following-no-private-feed.png`

## 2026-01-19: Manage Private Followers UI (Phase 2 Follower Management)

**Task:** Create UI for feed owners to view and manage their private followers with revocation capability (PRD §4.6)

**Changes made:**
1. Extended `lib/services/private-feed-service.ts` with revocation functionality:
   - `revokeFollower(ownerId, followerId)` - Full LKH revocation implementation per SPEC §8.5:
     - Sync check: compares chain epoch vs local epoch
     - Finds follower's leaf index from their grant
     - Advances epoch (newEpoch = currentEpoch + 1)
     - Computes revoked path from leaf to root
     - Computes new node versions and keys for all nodes on the path
     - Creates rekey packets (bottom-up per SPEC §8.5 step 7):
       - Packet A: encrypts new key under sibling's current version key
       - Packet B: encrypts new key under updated child's new key (for chain decryption)
     - Encrypts new CEK using the new root key
     - Creates PrivateFeedRekey document on platform
     - Updates local state (epoch, revoked leaves, recipient map)
     - Deletes PrivateFeedGrant document
     - Adds leaf back to available leaves
   - Fixed non-null assertion lint warnings with explicit checks

2. Created `components/settings/private-feed-followers.tsx`:
   - Card-based UI with header showing follower count (X/1024)
   - Loading skeleton state matching existing patterns
   - "Not enabled" state with lock icon prompting user to enable private feed
   - Empty state when no private followers ("No private followers yet")
   - Search input for filtering followers by name/username
   - Follower list with:
     - User avatar via `UserAvatar` component
     - Display name and DPNS username (if available)
     - "Following since [date]" timestamp
     - "Revoke" button (red outline) with warning icon
   - Two-step revoke confirmation:
     - First click shows "Confirm" and "Cancel" buttons
     - Second click executes revocation
   - Resolves user details via `dpnsService` and `unifiedProfileService`
   - Toast notifications for success/error states
   - Footer explaining revocation behavior

3. Updated `app/settings/page.tsx`:
   - Imported `PrivateFeedFollowers` component
   - Added component to `renderPrivateFeedSettings()` after PrivateFeedFollowRequests

**Key features per PRD §4.6:**
- Shows all private followers with follower count badge (X/1024)
- Search functionality to find specific followers
- Two-step revoke confirmation to prevent accidental revocations
- Clear explanation of revocation behavior in footer
- Proper handling of all states (loading, not enabled, empty, with followers)

**Screenshot:** `screenshots/manage-private-followers-ui.png`

## 2026-01-19: Private Feed Notifications Integration (PRD §7)

**Task:** Integrate private feed events with the notifications system

**Changes made:**
1. Updated `lib/types.ts`:
   - Extended `Notification` type to include private feed notification types: `privateFeedRequest`, `privateFeedApproved`, `privateFeedRevoked`

2. Created `lib/services/private-feed-notification-service.ts`:
   - `createRequestNotification(requesterId, feedOwnerId)` - Creates notification when someone requests access
   - `createApprovedNotification(feedOwnerId, requesterId)` - Creates notification when request is approved
   - `createRevokedNotification(feedOwnerId, revokeeId)` - Creates notification when access is revoked
   - All methods create notification documents owned by the recipient with `fromUserId` set to the actor

3. Updated `lib/services/notification-service.ts`:
   - Added `PrivateFeedNotificationType` type alias
   - Added `getPrivateFeedNotifications(userId, sinceTimestamp)` method to query notification documents for private feed events
   - Updated `fetchNotifications()` to include private feed notifications alongside follows and mentions

4. Updated `lib/services/private-feed-follower-service.ts`:
   - Integrated notification creation in `requestAccess()` - sends notification to feed owner

5. Updated `lib/services/private-feed-service.ts`:
   - Integrated notification creation in `approveFollower()` - sends notification to approved user
   - Integrated notification creation in `revokeFollower()` - sends notification to revoked user
   - All notification calls are best-effort (don't fail main operation if notification fails)

6. Updated `lib/stores/notification-store.ts`:
   - Extended `NotificationFilter` type to include `privateFeed` filter
   - Updated `getFilteredNotifications()` to handle the `privateFeed` filter (matches all three private feed notification types)

7. Updated `app/notifications/page.tsx`:
   - Added imports for new Heroicons: `LockClosedIcon`, `LockOpenIcon`, `ShieldExclamationIcon`
   - Added "Private Feed" tab to `FILTER_TABS`
   - Extended `NOTIFICATION_ICONS` with icons for each private feed notification type:
     - `privateFeedRequest`: Blue lock icon
     - `privateFeedApproved`: Green unlock icon
     - `privateFeedRevoked`: Red shield icon
   - Extended `NOTIFICATION_MESSAGES` with messages for each type:
     - "requested access to your private feed"
     - "approved your private feed request"
     - "revoked your private feed access"

8. Exported new service and types from `lib/services/index.ts`:
   - `privateFeedNotificationService` singleton
   - `PrivateFeedNotificationType` type

**Key features per PRD §7:**
- Notification document creation for all three private feed events
- Notifications are queried from the `notification` document type using the `ownerNotifications` index
- UI displays appropriate icons and messages for each notification type
- New "Private Feed" filter tab on notifications page
- Best-effort notification creation (main operations succeed even if notification fails)

**Screenshots:**
- `screenshots/notifications-private-feed-tab.png` (notifications page with Private Feed tab)
- `screenshots/notifications-private-feed-selected.png` (Private Feed tab selected)

## 2026-01-19: Auto-Revoke Private Feed Access on Block (PRD §8.1)

**Task:** Implement automatic revocation of private feed access when blocking a user who is a private follower

**Changes made:**
1. Updated `lib/services/block-service.ts`:
   - Modified `blockUser()` method to check if the blocked user is a private follower
   - Added `autoRevoked?: boolean` to the return type to indicate when auto-revocation occurred
   - Added new private method `autoRevokePrivateFeedAccess()` that:
     - Checks if the blocker has a private feed enabled (via `privateFeedKeyStore.hasFeedSeed()`)
     - Queries private followers to check if the blocked user has a grant
     - Calls `privateFeedService.revokeFollower()` if the user is a private follower
     - Uses dynamic import to avoid circular dependencies
     - Fails gracefully - block succeeds even if revocation fails
   - Auto-revocation is best-effort: the block operation always succeeds, and revocation errors are logged but don't cause failure

2. Updated `hooks/use-block.ts`:
   - Modified `toggleBlock()` to handle the new `autoRevoked` response field
   - Shows appropriate toast message when auto-revocation occurs:
     - "User blocked" (normal block)
     - "User blocked and private feed access revoked" (block + auto-revoke)

**Key features per PRD §8.1:**
- Blocking a private follower automatically revokes their private feed access
- Creates proper rekey document on-chain to cryptographically revoke access
- Deletes the user's grant document
- Best-effort approach: revocation failure doesn't block the block operation
- Clear user feedback via toast notification

**Screenshot:** `screenshots/auto-revoke-block-settings.png`

## 2026-01-19: Encryption Key Entry on Login (PRD §6.3)

**Task:** Add encryption key entry modal and session storage for private feed operations after login

**Changes made:**
1. Updated `lib/secure-storage.ts` with encryption key storage functions:
   - `storeEncryptionKey(identityId, encryptionKey)` - Store key in session
   - `getEncryptionKey(identityId)` - Retrieve key from session
   - `hasEncryptionKey(identityId)` - Check if key exists in session
   - `clearEncryptionKey(identityId)` - Remove key from session

2. Created `hooks/use-encryption-key-modal.ts`:
   - Zustand store for modal state management
   - `EncryptionKeyAction` type for context-specific prompts: `view_private_posts`, `create_private_post`, `manage_private_feed`, `decrypt_grant`, `generic`
   - `getEncryptionKeyActionDescription()` for human-readable action descriptions
   - `open(action, onSuccess)` and `close()` methods

3. Created `hooks/use-require-encryption-key.ts`:
   - `useRequireEncryptionKey()` hook for components needing encryption key
   - `hasEncryptionKey()` - Check if key is stored
   - `getEncryptionKeyBytes()` - Get key as Uint8Array
   - `requireEncryptionKey(action, onSuccess)` - Show modal if key missing, else proceed
   - `requireEncryptionKeyAsync(action)` - Promise-based version

4. Created `components/auth/encryption-key-modal.tsx`:
   - Modal UI for entering encryption private key (64 hex chars)
   - Validates key format and length
   - Verifies key matches identity's on-chain encryption public key
   - Shows context-aware message based on action type
   - Info box explaining session storage behavior
   - "Skip for now" option for deferring key entry
   - Link to key recovery documentation

5. Updated `components/providers.tsx`:
   - Added `EncryptionKeyModal` import and component to providers tree

6. Updated `components/settings/private-feed-settings.tsx`:
   - Added encryption key status section when private feed is enabled
   - Shows green "Key stored for this session" when key is present
   - Shows amber warning "Key not entered for this session" when missing
   - "Enter Encryption Key" button opens modal with callback to refresh status
   - Uses `useEncryptionKeyModal` hook for modal control

**Key features per PRD §6.3:**
- Users can enter encryption key after logging in to enable private feed operations
- Key is stored in session storage (cleared on logout/tab close if not "remember me")
- Modal validates key against identity's on-chain encryption public key
- Settings page shows clear status of whether key is stored for current session
- Contextual prompts explain why key is needed based on the action

**Screenshot:** `screenshots/encryption-key-entry-enable.png`

## 2026-01-19: Private Feed Owner Dashboard (PRD §4.10)

**Task:** Create dashboard UI for private feed owners showing stats, epoch usage, and recent activity

**Changes made:**
1. Created `components/settings/private-feed-dashboard.tsx`:
   - New component implementing the PRD §4.10 dashboard layout
   - Only renders when private feed is enabled (returns null otherwise)
   - Includes loading skeleton state while fetching data

   **Stats Grid (3 columns):**
   - **Followers**: Count with gradient blue styling, shows X/1024 capacity
   - **Pending Requests**: Count with gradient amber styling
   - **Private Posts**: Count with gradient purple styling

   **Epoch Usage Section:**
   - Progress bar showing revocation usage (currentEpoch-1 / MAX_EPOCH-1)
   - Color-coded: green (<50%), amber (50-90%), red (>90%)
   - Warning message when usage exceeds 90%
   - Shows remaining capacity percentage when 50-90%

   **Quick Actions:**
   - "View Requests" button with pending count badge
   - "Manage Followers" button
   - Buttons scroll to respective sections using element IDs

   **Recent Activity Section:**
   - Shows last 5 activities combining approvals and revocations
   - Approvals show user avatar/name with green checkmark
   - Revocations show leaf number with red X (user info unavailable after revocation)
   - Relative timestamps (e.g., "2h ago", "3d ago")

2. Updated `app/settings/page.tsx`:
   - Imported `PrivateFeedDashboard` component
   - Added dashboard between `PrivateFeedSettings` and `PrivateFeedFollowRequests`
   - Added `id="private-feed-requests"` and `id="private-feed-followers"` wrapper divs for scroll targeting

**Key features per PRD §4.10:**
- Dashboard only visible when private feed is enabled
- Stats show followers, pending requests, and private post counts
- Epoch usage progress bar with color-coded visual feedback
- Warning banner when approaching revocation limit (>90%)
- Quick action buttons for common tasks
- Recent activity feed showing approvals and revocations

**Screenshot:** `screenshots/private-feed-owner-dashboard.png`

## 2026-01-19: Reset Private Feed Functionality (PRD §9)

**Task:** Implement Reset Private Feed functionality for lost key recovery and starting fresh

**Changes made:**
1. Extended `lib/services/private-feed-service.ts` with reset functionality:
   - `resetPrivateFeed(ownerId, encryptionPrivateKey)` - Full reset implementation per PRD §9:
     - Generates new feed seed
     - Pre-computes epoch chain and CEK[1]
     - Encrypts new seed using ECIES to owner's public key
     - Updates existing PrivateFeedState document with new encrypted seed
     - Clears all local owner state (epoch, revoked leaves, recipient map)
     - Reinitializes local state with fresh seed and all leaves available
   - `getPrivateFollowerCount(ownerId)` - Helper for reset confirmation UI

2. Created `components/settings/reset-private-feed-dialog.tsx`:
   - Modal dialog using Radix UI Dialog + Framer Motion (matching existing patterns)
   - Warning section explaining consequences:
     - Remove all current private followers (shows count)
     - Make all existing private posts unreadable (shows count)
     - Generate a new encryption key
   - Two-factor confirmation:
     - Encryption key input (64 hex characters, masked)
     - Type "RESET" confirmation text
   - Reset button only enabled when both fields are valid
   - Loading state during reset operation
   - Error handling with user-friendly messages
   - Loads follower and private post counts when dialog opens

3. Updated `components/settings/private-feed-settings.tsx`:
   - Added "Danger Zone" section when private feed is enabled
   - Red styling to indicate destructive action
   - "Reset Private Feed" button opens the reset dialog
   - Integrated ResetPrivateFeedDialog component
   - Added ArrowPathIcon import for reset button icon

**Key features per PRD §9:**
- Reset mechanism updates existing PrivateFeedState document (canBeDeleted: false)
- Requires user to type "RESET" to confirm (prevents accidental resets)
- Shows follower count and private post count in confirmation dialog
- Clear explanation of consequences before proceeding
- Error handling if reset fails
- Local state properly cleared and reinitialized after successful reset

**Screenshots:**
- `screenshots/reset-private-feed-enabled.png` (settings page with Danger Zone section)
- `screenshots/reset-private-feed-dialog-full.png` (reset dialog)
- `screenshots/reset-private-feed-form-filled.png` (form with encryption key and RESET typed)
- `screenshots/reset-private-feed-error.png` (error handling display)

## 2026-01-19: Owner Viewing Own Private Posts - Visibility Indicator (PRD §4.8)

**Task:** Add "Visible to X private followers" indicator when feed owner views their own private posts

**Changes made:**
1. Updated `components/post/private-post-content.tsx`:
   - Extended `DecryptionState` type to include optional `followerCount` field in the decrypted state
   - Added follower count fetching in the owner decryption path using `privateFeedService.getPrivateFollowerCount()`
   - Added visibility indicator below decrypted content for owner's posts showing "Visible to X private follower(s)"
   - Indicator includes lock icon and proper pluralization (1 follower vs N followers)
   - Follower count fetch is best-effort (doesn't fail decryption if count lookup fails)

**Key features per PRD §4.8:**
- Owner viewing own private posts sees "Visible to X private followers" text
- Subtle indicator with lock icon, matching the existing private post styling
- Only shown for the post owner (not for followers viewing the post)
- Graceful handling if follower count fetch fails (indicator simply not shown)

**Screenshot:** `screenshots/owner-visibility-settings.png` (private feed settings showing follower count integration)

## 2026-01-19: Add Encryption Key to Identity (PRD §6.2)

**Task:** Implement Key Addition Flow for users who don't have an encryption key on their identity

**Changes made:**
1. Extended `lib/services/identity-service.ts` with key management methods:
   - `hasEncryptionKey(identityId)` - Check if identity has encryption key (purpose=1, type=0)
   - `addEncryptionKey(identityId, encryptionPrivateKey, authPrivateKeyWif, contractId?)` - Full identity update flow:
     - Fetches current identity from platform
     - Verifies no existing encryption key
     - Derives public key from provided private key bytes
     - Creates `IdentityPublicKeyInCreation` with proper WASM SDK classes
     - Creates `IdentitySigner` and adds auth key for signing
     - Broadcasts identity update state transition
     - Clears identity cache to reflect update
   - Imported `IdentityPublicKeyInCreation` and `IdentitySigner` from `@dashevo/wasm-sdk`

2. Created `components/auth/add-encryption-key-modal.tsx`:
   - Multi-step modal implementing PRD §6.2 Key Addition Flow
   - **Intro step**: Explains what encryption keys are used for and why they're needed
   - **Generate step**:
     - Generates cryptographically secure 32-byte private key
     - Displays private key (masked by default, with show/hide toggle)
     - Displays public key for verification
     - Copy to clipboard functionality
     - Requires checkbox confirmation that key was saved
   - **Confirm step**: Shows what will happen (transaction broadcast, local storage, enables private feed)
   - **Adding step**: Loading spinner during identity update transaction
   - **Success step**: Confirmation with next steps (enable private feed, etc.)
   - **Error step**: Error message with retry option, note about saved key being usable later

3. Updated `components/auth/encryption-key-modal.tsx`:
   - Added "Add one to your identity" link at bottom of modal
   - Integrated `AddEncryptionKeyModal` component
   - Added `noKeyOnIdentity` state tracking
   - When user enters invalid key because no encryption key exists on identity, shows inline prompt to add one
   - Success callback properly closes both modals and triggers success action

4. Updated `components/settings/private-feed-settings.tsx`:
   - Added check for encryption key on identity during status load
   - New state `hasEncryptionKeyOnIdentity` to track whether user can enable private feed
   - When user lacks encryption key on identity, shows warning and "Add Encryption Key to Identity" button
   - Button opens `AddEncryptionKeyModal` directly
   - Success callback refreshes status to show Enable Private Feed button

**Key features per PRD §6.2:**
- Generates new secp256k1 keypair with cryptographically secure random bytes
- Displays private key (hex) for user to save securely
- Requires explicit confirmation that key was saved before proceeding
- Creates identity update state transition to add key on-chain
- Stores private key in session storage after successful addition
- Clear step-by-step flow with appropriate warnings and explanations
- Error handling with retry capability

**Screenshots:**
- `screenshots/add-encryption-key-modal.png` (key generation step with save warning)
- `screenshots/encryption-key-modal-with-add-option.png` (enter key modal with add link)

## 2026-01-19: Lost Encryption Key UI Flow (PRD §6.4)

**Task:** Implement the Lost Encryption Key recovery UI flow for users who have lost their encryption key

**Changes made:**
1. Created `components/auth/lost-encryption-key-modal.tsx`:
   - Modal dialog for users who have lost their encryption key
   - Warning section explaining that without the key, private feed features cannot be used
   - **Check Your Secure Storage** option:
     - Explains that the key was shown when first set up
     - Suggests checking password manager, secure notes, etc.
     - "I Found My Key" button returns user to the encryption key entry modal
   - **Reset Your Private Feed** option (shown only for feed owners):
     - Explains the destructive nature of the reset
     - Lists consequences: all followers lose access, existing posts unreadable, followers must re-request
     - "Reset Private Feed" button navigates to settings with action=reset parameter
   - **Request New Access** option (shown for followers of private feeds):
     - Explains that without the key, grants cannot be decrypted
     - Instructions to add new encryption key and ask feed owners to revoke and re-approve
   - Automatically checks if user has a private feed and what feeds they follow locally
   - Loading state while checking status

2. Updated `components/auth/encryption-key-modal.tsx`:
   - Imported `LostEncryptionKeyModal` component
   - Added "Lost your key? See recovery options" link at bottom of modal
   - Added `showLostKeyModal` state for controlling the lost key modal
   - Added `handleLostKeyFoundKey` callback to close lost key modal and return to key entry
   - Added `handleLostKeyResetFeed` callback to navigate to settings with action=reset parameter
   - Integrated `LostEncryptionKeyModal` in the component render

3. Updated `components/settings/private-feed-settings.tsx`:
   - Added `openReset` prop (boolean) to trigger auto-opening of reset dialog
   - Added useEffect to open reset dialog when `openReset` prop is true and feed is enabled

4. Updated `app/settings/page.tsx`:
   - Modified `renderPrivateFeedSettings()` to check for `action=reset` URL parameter
   - Passes `openReset={shouldOpenReset}` prop to `PrivateFeedSettings` component

5. Fixed `lib/services/identity-service.ts`:
   - Fixed SDK API call for `sdk.identities.update()` - uses `identityId` and `privateKeyWif` instead of `identity` and `signer`
   - Removed unused `IdentitySigner` import

**Key features per PRD §6.4:**
- Accessible from "Lost your key?" link in encryption key modal
- Clear explanation of consequences of not having the key
- Multiple recovery options based on user's role (owner vs follower)
- Feed owners can easily navigate to reset their private feed
- Followers are guided to add new encryption key and request re-approval
- Checking secure storage is the first recommended option
- Deep-link support: navigating to `/settings?section=privateFeed&action=reset` auto-opens reset dialog

**Screenshots:**
- `screenshots/lost-encryption-key-ui.png` (lost key modal showing recovery options)
- `screenshots/lost-encryption-key-ui-full.png` (full page view with modal)
- `screenshots/lost-key-reset-dialog.png` (reset dialog auto-opened from lost key flow)

## 2026-01-19: Private Follower Badge on Profile Page (PRD §4.9)

**Task:** Add "Private Follower ✓" badge to profile page when viewing another user whose private feed you have been approved to access

**Changes made:**
1. Updated `app/user/page.tsx`:
   - Added `CheckIcon` import from Heroicons
   - Added `isPrivateFollower` state variable to track if current user is an approved private follower
   - Extended the private feed status check to also query access status via `privateFeedFollowerService.getAccessStatus()`
   - Sets `isPrivateFollower` to true when access status is `'approved'`
   - Added reset of `isPrivateFollower` state when navigating between profiles
   - Added "Private Follower ✓" badge with green styling next to the existing "Private Feed" badge
   - Badge includes tooltip: "You have access to this user's private feed"

**Key features per PRD §4.9:**
- Badge only appears when viewing another user's profile (not your own)
- Badge only appears when you're an approved private follower
- Green styling with checkmark icon distinguishes it from the gray "Private Feed" badge
- Tooltip provides context about what the badge means
- State properly resets when navigating between different profiles

**Screenshot:** `screenshots/private-follower-badge-profile.png` (profile page showing "Private Feed" badge area where "Private Follower ✓" badge would appear when conditions are met)

## 2026-01-19: Automatic FollowRequest Cleanup After Approval (PRD §4.5)

**Task:** Implement automatic cleanup of stale FollowRequest documents after a user has been approved for private feed access

**Changes made:**
1. Updated `lib/services/private-feed-follower-service.ts`:
   - Extended `getAccessStatus()` method with optional `autoCleanup` parameter (default: true)
   - When access status is 'approved' and autoCleanup is enabled, automatically triggers cleanup in background
   - Added new `cleanupStaleFollowRequest(ownerId, myId)` method that:
     - Checks if a FollowRequest document still exists for the approved user
     - Deletes the stale request document if found
     - Returns success even if no request exists (no cleanup needed)
     - Best-effort operation that doesn't fail the main flow if cleanup fails
   - Extended `recoverFollowerKeys()` to call cleanup after successful key recovery (step 7)
   - All cleanup operations are fire-and-forget with error catching to avoid disrupting main operations

**Key features per PRD §4.5:**
- "After approval, the requester's client should detect the grant and delete their FollowRequest"
- Cleanup happens automatically when:
  - User checks their access status and is 'approved'
  - User recovers their follower keys from a grant document
- Best-effort cleanup: failure doesn't affect access (grant is what matters)
- Stale requests are harmless but cleaned up for tidiness

**Screenshot:** `screenshots/follow-request-cleanup-settings.png` (Private Feed settings page showing the private follower management UI where approved users would have their FollowRequests cleaned up)

## 2026-01-19: Owner Recovery (SPEC §8.8) for Multi-Device Sync

**Task:** Implement Owner Recovery functionality for private feed multi-device synchronization

**Changes made:**
1. Extended `lib/services/private-feed-service.ts` with recovery functionality:
   - `recoverOwnerState(ownerId, encryptionPrivateKey)` - Full owner recovery implementation per SPEC §8.8:
     - Fetches PrivateFeedState document from chain
     - Decrypts feedSeed using ECIES with owner's encryption private key
     - Validates protocol version prefix
     - Fetches ALL PrivateFeedRekey documents to rebuild revokedLeaves list
     - Determines currentEpoch from rekey documents (or 1 if none exist)
     - Fetches ALL PrivateFeedGrant documents to rebuild recipientId → leafIndex mapping
     - Derives availableLeaves from grants (authoritative source per SPEC §6.3)
     - Clears existing owner state and reinitializes with recovered data
     - Computes and caches current CEK for immediate use
   - `syncAndRecover(ownerId, encryptionPrivateKey)` - Sync check helper:
     - Checks if local keys exist (triggers full recovery if not)
     - Compares chain epoch vs local epoch
     - Triggers recovery automatically when local state is behind

2. Updated `createPrivatePost()`, `approveFollower()`, and `revokeFollower()` methods:
   - Added optional `encryptionPrivateKey` parameter to all three methods
   - Modified sync check to automatically trigger recovery when local state is behind and key is provided
   - Returns `SYNC_REQUIRED:` error prefix when sync needed but no key provided (for UI detection)
   - Properly refreshes `feedSeed` and `localEpoch` variables after recovery

3. Updated `hooks/use-encryption-key-modal.ts`:
   - Added `sync_state` to `EncryptionKeyAction` type
   - Added description: "sync your private feed state"

4. Updated `components/compose/compose-modal.tsx`:
   - Retrieves encryption key from secure storage before creating private posts
   - Passes encryption key to `createPrivatePost()` for automatic sync/recovery
   - Handles `SYNC_REQUIRED:` error by opening encryption key modal with `sync_state` action
   - Shows user-friendly toast notification about needing to sync

5. Updated `components/settings/private-feed-follow-requests.tsx`:
   - Retrieves encryption key from secure storage before approving followers
   - Passes encryption key to `approveFollower()` for automatic sync/recovery
   - Handles `SYNC_REQUIRED:` error appropriately

6. Updated `components/settings/private-feed-followers.tsx`:
   - Retrieves encryption key from secure storage before revoking followers
   - Passes encryption key to `revokeFollower()` for automatic sync/recovery
   - Handles `SYNC_REQUIRED:` error appropriately

**Key features per SPEC §8.8 and PRD §10.3:**
- Owner can recover feed state from chain data using only their encryption private key
- Automatic sync/recovery when creating posts, approving, or revoking from a different device
- Falls back to prompting for encryption key when key not in session storage
- Graceful error handling with user-friendly messages
- Local state properly rebuilt from authoritative chain documents

**Screenshot:** `screenshots/owner-recovery-private-feed-settings.png`

## 2026-01-19: Private Replies with Inherited Encryption (PRD §5.5)

**Task:** Implement inherited encryption for replies to private posts

**Changes made:**
1. Updated `lib/services/post-service.ts`:
   - Added `EncryptionSource` interface for tracking encryption inheritance
   - Added `getEncryptionSource(replyToPostId)` function that walks up the reply chain to find the root private post
   - Returns the feed owner ID and epoch to use for encrypting the reply

2. Extended `lib/services/private-feed-service.ts`:
   - Added `createInheritedPrivateReply(authorId, content, encryptionSource, replyToPostId)` method:
     - Encrypts reply content using the parent thread's CEK (not the replier's own CEK)
     - Validates access to the required encryption keys
     - Derives CEK for the specified epoch from cached path keys
     - Creates post document with proper encryption fields and replyToPostId

3. Updated `components/compose/compose-modal.tsx`:
   - Added `inheritedEncryption` state to track when replying to private posts
   - Added `inheritedEncryptionLoading` state for async encryption source detection
   - Added useEffect to check for inherited encryption when `replyingTo` is set
   - Updated handlePost to use `createInheritedPrivateReply()` when inheritance is detected
   - Added purple "inherited encryption" banner for replies to private posts
   - Added loading state while checking encryption inheritance
   - Disabled thread composition for inherited encryption replies
   - Updated footer to show "Reply inherits parent's encryption" indicator

4. Created `hooks/use-can-reply-to-private.ts`:
   - Hook to check if current user can reply to a private post
   - Returns `canReply`, `isPrivate`, `isLoading`, and `reason` for disabled state
   - Checks: user is owner OR user has cached decryption keys for the feed

5. Updated `components/post/post-card.tsx`:
   - Integrated `useCanReplyToPrivate` hook
   - Reply button disabled when user can't decrypt parent private post
   - Tooltip shows reason when reply is disabled (e.g., "Can't reply - no access to this private feed")
   - Toast notification when user attempts to reply without access

**Key features per PRD §5.5:**
- Replies to private posts inherit encryption from the root private post
- `getEncryptionSource()` walks up the reply chain to find the original private post
- Reply is encrypted using the thread owner's CEK, not the replier's own CEK
- This allows anyone with access to the parent thread to also read replies
- Reply button is disabled for users who can't decrypt the parent post
- Clear visual indicators when composing an inherited-encryption reply

**Screenshot:** `screenshots/private-reply-inherited-encryption.png`

## 2026-01-19: Quoting Private Posts (PRD §5.3)

**Task:** Implement private post quoting with separate decryption (no encryption inheritance)

**Changes made:**
1. Created `components/post/private-quoted-post-content.tsx`:
   - `PrivateQuotedPostContent` component for rendering quoted private posts
   - Handles all decryption states: loading, decrypted, locked, error
   - Shows teaser content when available
   - Non-followers see "[Private post from @user]" locked state per PRD §5.3
   - Owner path uses local feed seed and CEK cache
   - Follower path uses `privateFeedFollowerService.decryptPost()`
   - Lock icon in header indicates private post
   - `isQuotedPostPrivate()` helper function exported

2. Updated `components/post/post-card.tsx`:
   - Imported `PrivateQuotedPostContent` and `isQuotedPostPrivate`
   - Modified quoted post rendering to check if quoted post is private
   - Uses `PrivateQuotedPostContent` for private quoted posts
   - Falls back to standard quoted post rendering for public posts

3. Updated `components/compose/compose-sub-components.tsx`:
   - Extended `QuotedPostPreview` to handle private posts
   - Added `isPrivatePost()` helper function
   - Added `DecryptionState` type for state management
   - Added `identifierToBytes()` for AAD construction
   - Shows lock icon in header for private posts
   - Loading state shows "Decrypting..." with teaser
   - Decrypted state shows full content with teaser
   - Locked state shows "[Private post from @user]" indicator
   - Imports `LockClosedIcon`, `LockOpenIcon`, `useAuth`, React hooks

**Key features per PRD §5.3:**
- Quotes do NOT inherit encryption - quoted content is decrypted separately
- Quoter chooses their own encryption for the quote (public or using their own CEK)
- Non-followers see locked state with "[Private post from @user]" message
- Teaser content (if available) shown in all states
- Lock icon in header distinguishes private quoted posts

**Screenshots:**
- `screenshots/quote-private-posts-compose-modal.png` (compose modal with visibility selector)
- `screenshots/quote-private-posts-settings.png` (private feed settings page)

## 2026-01-19: Background Key Sync for Private Feeds (PRD §5.4)

**Task:** Implement background key sync on app load to proactively sync private feed keys

**Changes made:**
1. Extended `lib/services/private-feed-follower-service.ts` with background sync methods:
   - `syncFollowedFeeds()` - Main sync method that processes all followed private feeds:
     - Gets all feed owners from local key storage
     - Processes feeds in parallel with concurrency limit (3 at a time)
     - For each feed, checks if cached epoch < chain epoch
     - Triggers catch-up for stale feeds
     - Returns summary: synced, failed, up-to-date counts
   - `syncFeedKeys(ownerId)` - Single feed sync helper:
     - Gets cached epoch from local storage
     - Fetches latest epoch from chain via `privateFeedService.getLatestEpoch()`
     - Triggers `catchUp()` if local is behind
     - Returns status: 'synced', 'up_to_date', or 'failed'

2. Updated `contexts/auth-context.tsx`:
   - Modified `initializePostLoginTasks()` to include private feed sync
   - Sync runs immediately on session restoration (same as block data)
   - Non-blocking background execution
   - Console logging for sync results

**Key features per PRD §5.4:**
- "On app load:
   1. For each feed owner we follow privately:
      - Check if cachedEpoch < latest post epoch from that author
      - If stale, trigger background catch-up
   2. Decrypt posts using cached keys"
- Sync runs in background, doesn't block UI
- Limited concurrency (3 feeds at a time) to avoid overwhelming network
- Graceful error handling - individual feed failures don't affect others
- Logging for debugging and monitoring

**Screenshot:** `screenshots/background-key-sync-settings.png` (Private Feed settings page showing sync working - console shows "PrivateFeedSync: No followed private feeds to sync")
