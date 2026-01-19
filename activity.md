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
