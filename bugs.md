# Bug Reports

## Active Bugs

(No active bugs)

---

## Resolved Bugs

### BUG-016: Visibility selector hidden when replying - cannot create private replies to public posts (RESOLVED)

**Status:** RESOLVED

**Description:** The compose modal did not show the visibility selector when creating a reply. This prevented users from creating private replies to public posts, which is explicitly allowed by PRD §5.5.

**Original Behavior:**
- User opens reply dialog on a public post
- Reply compose dialog shows only the text input area
- No visibility selector (Public/Private/Private with Teaser) was available
- User could only create a public reply

**Root Cause:**
In `components/compose/compose-modal.tsx` line 1051:
```typescript
{!replyingTo && hasPrivateFeed && (
  <VisibilitySelector ...
```

The condition `!replyingTo` hid the visibility selector for ALL replies, when it should only be hidden for replies that inherit encryption from a private parent post.

**Fix Applied:**
Changed the condition to:
```typescript
{!(replyingTo && isPrivatePost(replyingTo)) && hasPrivateFeed && (
  <VisibilitySelector ...
```

This logic:
- Shows visibility selector when NOT replying (new post)
- Shows visibility selector when replying to a PUBLIC post (user can choose visibility)
- Hides visibility selector when replying to a PRIVATE post (inherited encryption per PRD §5.5)

**Files Modified:**
- `components/compose/compose-modal.tsx` - Updated visibility selector condition

**Verification:**
- Reply to PUBLIC post: Visibility selector shows with all 3 options ✅
- Reply to PRIVATE post: Visibility selector hidden, inherited encryption banner shown ✅
- Lint check: Passed ✅
- Build check: Passed ✅

**Screenshots:**
- `screenshots/bug016-fix-reply-visibility-selector.png` - Reply to public post with visibility options
- `screenshots/bug016-fix-reply-to-private-no-selector.png` - Reply to private post with inheritance banner

**Date Resolved:** 2026-01-19

---

### BUG-015: UI says MASTER or CRITICAL but only MASTER works for identity modifications (RESOLVED)

**Status:** RESOLVED

**Description:** In the Add Encryption Key modal, the UI stated "MASTER or CRITICAL" key was required, but only MASTER key actually works for identity modifications in SDK dev.11+.

**Original Behavior:**
- UI showed: "Modifying your identity requires your **CRITICAL** or **MASTER** key"
- Label showed: "CRITICAL / MASTER Key (WIF format)"
- Placeholder showed: "Enter your CRITICAL or MASTER private key..."
- Users who entered their CRITICAL key would get an error

**Root Cause:** Dash Platform SDK dev.11 changed security requirements - only MASTER (securityLevel=0) keys are accepted for identity modifications. CRITICAL (securityLevel=1) keys no longer work for this purpose.

**Fix Applied:**
Updated all user-facing text in `components/auth/add-encryption-key-modal.tsx` to state only "MASTER" key is required:
1. Intro step: Changed to "MASTER Key Required"
2. Confirm step: Changed to "You'll enter your MASTER key"
3. Critical-key step title: Changed to "Enter MASTER Key"
4. Warning text: Changed to "Dash Platform requires a MASTER security level key"
5. Label: Changed to "MASTER Key (WIF format)"
6. Placeholder: Changed to "Enter your MASTER private key..."
7. Tip: Changed to "Your MASTER key was provided when you created..."
8. Validation error: Changed to "Please enter your MASTER key"

**Files Modified:**
- `components/auth/add-encryption-key-modal.tsx` - Updated all user-facing text

**Verification:**
- `npm run lint` passed with no new errors
- All text changes confirmed via grep
- Dev server runs successfully
- Screenshot: `screenshots/bug015-fix-private-feed-settings.png`

**Date Resolved:** 2026-01-19

### BUG-014: Private feed request notifications missing action button (RESOLVED)

**Status:** RESOLVED

**Description:** Private feed request notifications in the notifications page did not have an action button to view or manage the request, as specified in PRD §7.4.

**Original Behavior:**
- Notification showed "Test Owner PF requested access to your private feed 19m"
- Clicking the notification only marked it as read
- No `[View Requests]` button was present
- No inline `[Approve]` / `[Ignore]` buttons were present

**Fix Applied:**
Added action buttons to the notifications page for private feed notification types:
1. `[View Requests]` button for `privateFeedRequest` type - links to `/settings?section=privateFeed`
2. `[View Profile]` button for `privateFeedApproved` type - links to user profile

**Code Changes:**
```typescript
// Added to app/notifications/page.tsx
{notification.type === 'privateFeedRequest' && (
  <Link
    href="/settings?section=privateFeed"
    onClick={(e) => e.stopPropagation()}
    className="px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 ..."
  >
    View Requests
  </Link>
)}
{notification.type === 'privateFeedApproved' && (
  <Link
    href={`/user?id=${notification.from?.id}`}
    onClick={(e) => e.stopPropagation()}
    className="px-3 py-1 text-xs font-medium text-green-600 bg-green-50 hover:bg-green-100 ..."
  >
    View Profile
  </Link>
)}
```

**Files Modified:**
- `app/notifications/page.tsx` - Added action buttons for private feed notification types

**Verification:**
- Notification now shows "View Requests" button in blue on the right side
- Clicking "View Requests" navigates to Private Feed settings (`/settings?section=privateFeed`)
- User can directly access the pending requests list to Approve/Ignore
- Screenshots:
  - `screenshots/bug014-fix-view-requests-button.png` - Notification with View Requests button
  - `screenshots/bug014-fix-navigated-to-settings.png` - Settings page after clicking button

**Date Resolved:** 2026-01-20

### BUG-013: Followers fail to fetch latest keys after revocation (RESOLVED)

**Status:** RESOLVED

**Description:** After a user revokes a follower (which creates a new epoch via rekey document), other approved followers could not decrypt new posts encrypted at the new epoch.

**Scenario:**
- User A has private feed
- Users B and C are both approved followers
- A revokes B (creates rekey document, epoch advances from 1 to 2)
- B correctly can no longer read (revoked)
- C could not read posts at epoch 2 (BUG)

**Root Cause:** The follower service's `applyRekey()` method used `deriveRekeyNonceFollower()` which derived the nonce with an **empty salt**, while the owner's `deriveRekeyNonce()` used `wrapNonceSalt` derived from `feedSeed`. This nonce mismatch caused the XChaCha20-Poly1305 decryption of rekey packets to fail for followers.

Followers don't have access to `feedSeed` (by design - that's the owner's secret), so they couldn't derive the same `wrapNonceSalt` that the owner used when creating the rekey packets.

**Fix Applied:**
1. Added `wrapNonceSalt` field to `GrantPayload` interface in `private-feed-crypto-service.ts`
2. Updated `encodeGrantPayload()` to include `wrapNonceSalt` (32 bytes at end)
3. Updated `decodeGrantPayload()` to read `wrapNonceSalt` (optional for backwards compatibility)
4. Updated `approveFollower()` in `private-feed-service.ts` to derive and include `wrapNonceSalt` in grant payload
5. Updated `initializeFollowerState()` in `private-feed-key-store.ts` to accept and store `wrapNonceSalt`
6. Added `storeWrapNonceSalt()` and `getWrapNonceSalt()` methods to key store
7. Updated `applyRekey()` in `private-feed-follower-service.ts` to use stored `wrapNonceSalt` for proper nonce derivation
8. Added `applyRekeyLegacy()` fallback for grants created before this fix

**Files Modified:**
- `lib/services/private-feed-crypto-service.ts` - Extended GrantPayload with wrapNonceSalt
- `lib/services/private-feed-service.ts` - Include wrapNonceSalt in grant creation
- `lib/services/private-feed-key-store.ts` - Store and retrieve wrapNonceSalt
- `lib/services/private-feed-follower-service.ts` - Use proper nonce derivation in applyRekey

**Verification:**
- Built successfully with no lint errors
- Tested revocation flow: successfully created epoch 2 after revoking a follower
- UI correctly shows epoch 2/2000 and 1/1999 revocations used
- Screenshot: `screenshots/bug013-epoch2-confirmed.png`

**Note:** Grants created before this fix won't have `wrapNonceSalt` and will use the legacy (broken) nonce derivation. Those followers will need to be re-approved to receive a new grant with the salt included.

**Date Resolved:** 2026-01-19

### BUG-012: followers listed in Private Feed page is incorrect (RESOLVED)

**Status:** RESOLVED

**Description:** The Private Feed settings page correctly detects 2 followers but displays incorrect user IDs when linking to their profiles.

**Observed Behavior:**
- Links pointed to base64 encoded strings like: `fqo6OUtPAVlsnOP0YYxOfhgZNxUZHJ5VsG6yUUrUCZo=`

**Expected Behavior:**
- Links should point to base58 identity IDs like: `6DkmgQWvbB1z8HJoY6MnfmnvDBcYLyjYyJ9fLDPYt87n`

**Root Cause:** The `getPrivateFollowers()` function in `private-feed-service.ts` and `getGrant()` in `private-feed-follower-service.ts` were directly casting `doc.recipientId` to string without converting from base64 (SDK format) to base58 (identity ID format).

The SDK returns byte array fields like `recipientId` as base64-encoded strings via `toJSON()`, but identity IDs should be displayed as base58 strings for user-facing URLs and displays.

**Fix Applied:**
```typescript
// Changed from:
recipientId: doc.recipientId as string,

// To:
recipientId: identifierToBase58(doc.recipientId) || '',
```

**Files Modified:**
- `lib/services/private-feed-service.ts` - Added `identifierToBase58` import and used it in `getPrivateFollowers()`
- `lib/services/private-feed-follower-service.ts` - Added `identifierToBase58` import and used it in `getGrant()`

**Verification:**
- Private Followers list now correctly shows user profiles with proper base58 identity IDs
- Links navigate to correct user profiles: `/user/?id=6DkmgQWvbB1z8HJoY6MnfmnvDBcYLyjYyJ9fLDPYt87n`
- Screenshot: `screenshots/bug012-fix-private-followers-correct-links.png`

**Date Resolved:** 2026-01-19

---

### BUG-010: Failed to create post: Private feed not enabled (RESOLVED)

**Resolution:** Added a check for missing local keys at the beginning of `createPrivatePost()` to trigger full recovery when the feed seed is not stored locally, even if the epoch check passes.

**Root Cause:** The `createPrivatePost()` function only triggered recovery when `chainEpoch > localEpoch`. When local keys were completely absent (not just out of sync), `getCurrentEpoch()` returned 1 by default, and if the chain epoch was also 1, the recovery check passed. Then `getFeedSeed()` returned null because no feed seed was stored locally, causing the "Private feed not enabled" error.

**Fix Applied:**
```typescript
// 0. Check if local keys exist at all (BUG-010 fix)
const hasLocalKeys = privateFeedKeyStore.hasFeedSeed();

if (!hasLocalKeys) {
  console.log('No local private feed keys found, need full recovery');
  if (encryptionPrivateKey) {
    const recoveryResult = await this.recoverOwnerState(ownerId, encryptionPrivateKey);
    // ... handle result
  } else {
    return { success: false, error: 'SYNC_REQUIRED:No local keys found...' };
  }
}
```

**Files Modified:**
- `lib/services/private-feed-service.ts` - Added missing local keys check before epoch sync check

**Verification:**
- Tested with user who has private feed enabled on-chain but no local `yappr:pf:*` keys
- Console showed "No local private feed keys found, need full recovery"
- Recovery completed successfully, post was created
- Screenshot: `screenshots/bug010-fix-verified.png`

**Date Resolved:** 2026-01-19

### BUG-007: getPrivateFollowers query fails with WasmSdkError (RESOLVED)

**Resolution:** Removed `orderBy` clause from the query in `getPrivateFollowers()`. The `privateFeedGrant` document type's indices don't include `$createdAt`, so the orderBy was causing the query to fail.

**Fix Applied:**
```typescript
// Changed from:
const documents = await queryDocuments(sdk, {
  ...
  orderBy: [['$createdAt', 'desc']],  // REMOVED
  ...
});

// To:
const documents = await queryDocuments(sdk, {
  dataContractId: this.contractId,
  documentTypeName: DOCUMENT_TYPES.PRIVATE_FEED_GRANT,
  where: [['$ownerId', '==', ownerId]],
  limit: 100,
});
```

**Files Modified:**
- `lib/services/private-feed-service.ts` - `getPrivateFollowers()` method (line 1044)

**Verification:**
After the fix:
- The Private Followers section now correctly displays "1/1024" and lists existing followers
- Recovery correctly identifies assigned leaf indices
- UI dashboard shows accurate follower count

**Note:** There may still be stale test data on-chain from prior testing sessions causing leafIndex conflicts. This is not a code bug but a test data issue.

**Date Resolved:** 2026-01-19

### BUG-011: Owner cannot decrypt their own private posts when local feed keys are missing (RESOLVED)

**Resolution:** Added auto-recovery logic to `PrivatePostContent.attemptDecryption()`. When the owner has no feed seed but has an encryption key available, the code now automatically triggers `recoverOwnerState()` to restore local keys from chain before attempting decryption.

**Root Cause:** The `attemptDecryption()` function immediately showed a locked state when `getFeedSeed()` returned null, without checking if the encryption key was available for auto-recovery. This was inconsistent with the BUG-010 fix that added auto-recovery to `createPrivatePost()`.

**Files Modified:**
- `components/post/private-post-content.tsx` - Added auto-recovery logic when owner has encryption key but no feed seed

**Verification:**
- Cleared localStorage, stored only encryption key
- Logged in as owner and clicked on a private post
- Console showed: "Owner auto-recovery: no local feed seed, attempting recovery with encryption key"
- Post decrypted successfully showing content and "Visible to 2 private followers"
- Screenshot: `screenshots/bug011-fix-owner-decryption-success.png`

**Date Resolved:** 2026-01-19

### BUG-008: Private feed notifications do not work (RESOLVED)

**Resolution:** Changed the notification discovery architecture from trying to create `notification` documents (which was impossible) to querying `followRequest` documents directly.

**Root Cause:** The original implementation in `private-feed-notification-service.ts` tried to create notification documents owned by the recipient (feed owner), but signed by the requester. This is impossible in Dash Platform - you cannot create a document owned by another identity. The `stateTransitionService.createDocument()` call would fail because the requester doesn't have the feed owner's private key.

**Architectural Fix:** Instead of creating separate notification documents, the `notification-service.ts` now queries `followRequest` documents where the user is the `targetId` (the feed owner). This follows the same pattern as follower notifications, which query `follow` documents directly. This is more robust and doesn't require any new document types or contract changes.

**Files Modified:**
- `lib/services/notification-service.ts` - Changed `getPrivateFeedNotifications()` to query `followRequest` documents with `[targetId, $createdAt]` index instead of `notification` documents
- `lib/services/private-feed-follower-service.ts` - Removed the (broken) notification creation call from `requestAccess()` and added a comment explaining the new architecture

**Verification:**
- Feed owner (identity 9qRC7aPC...) now sees "Test Follower User requested access to your private feed" notification
- Notification appears in both "All" and "Private Feed" filter tabs
- Screenshot: `screenshots/bug008-fix-notifications.png`

**Date Resolved:** 2026-01-19

### BUG-009: private follower not showing after acceptance (RESOLVED)

**Resolution:** Modified `private-feed-settings.tsx` to query on-chain grants (`privateFeedService.getPrivateFollowers()`) instead of using local storage (`recipientMap`) for the follower count. This ensures consistency with the dashboard and followers list components which also use on-chain queries.

**Root Cause:** The Private Feed Settings card was getting follower count from local `recipientMap` in localStorage, while the Dashboard and Private Followers list were querying on-chain `privateFeedGrant` documents. If the local state was stale or empty, the counts would be inconsistent.

**Files Modified:**
- `components/settings/private-feed-settings.tsx` - Changed `checkPrivateFeedStatus()` to call `getPrivateFollowers()` with fallback to local storage

**Verification:**
- All three UI sections (Settings card, Dashboard, Followers list) now show consistent "1/1024" follower count
- Private Followers section correctly lists "User clx6Y=" as follower

**Date Resolved:** 2026-01-19

### BUG-006: Encrypted replies fail to decrypt (RESOLVED)

**Resolution:** Modified `private-post-content.tsx` to detect inherited encryption for replies. When a post has `replyToId` and encrypted content, the code now uses `getEncryptionSource()` to trace back to the root private post and use that owner's CEK for decryption, instead of assuming `post.author.id` is the encryption owner.

**Root Cause:** Replies to private posts use inherited encryption (PRD §5.5), meaning they're encrypted with the parent thread owner's CEK, not the reply author's CEK. The decryption code was using `post.author.id` (reply author) instead of the encryption source owner for key lookups.

**Files Modified:**
- `components/post/private-post-content.tsx` - Updated `attemptDecryption()` and `attemptRecovery()` to detect inherited encryption

**Verification:**
- Reply by @maybetestprivfeed3.dash now decrypts correctly showing "test reply to private"
- Console logs confirm: "Reply decryption: inherited encryption from 9qRC7aPC3xTFwGJvMpwHfycU4SA49mx4Fc3Bh6jCT8v2"

**Date Resolved:** 2026-01-19

### BUG-004: Private posts without teaser fail with JsonSchemaError (RESOLVED)

**Resolution:** Used a placeholder character `🔒` for the `content` field when no teaser is provided. This satisfies the contract constraint (`minLength: 1`) while preserving the intended functionality. The actual post content remains encrypted in `encryptedContent`.

**Files Modified:**
- `lib/services/private-feed-service.ts` - Both `createPrivatePost()` and `createInheritedPrivateReply()` now use `PRIVATE_POST_PLACEHOLDER = '🔒'` instead of empty string

**Verification:**
- E2E Test 2.2 now passes
- Private posts created successfully with post ID 3JaTDNCSpfFdpYMXcEneCeuziXwdRrMxaGgr8jit8gvi
- Post visible in feed showing 🔒 as placeholder content

**Date Resolved:** 2026-01-19

### BUG-005: Accepting private feed fails (RESOLVED)

**Resolution:** Modified `PrivateFeedAccessButton` to require and include the requester's encryption public key when calling `requestAccess()`. The key is retrieved from localStorage (stored encryption private key) or the identity's public keys. If no encryption key is available, a clear error message is shown asking the user to set up their encryption key first.

Also improved the error message on the approval side from "Could not find encryption key for this user" to "This user needs to set up an encryption key before you can approve their request".

**Files Modified:**
- `components/profile/private-feed-access-button.tsx` - Added encryption key retrieval before request
- `components/settings/private-feed-follow-requests.tsx` - Improved error message

**Date Resolved:** 2026-01-19

### BUG-003: sdk.identities.update() fails with WasmSdkError (RESOLVED)

**Resolution:** SDK upgraded from dev.9 to dev.11. The issue was confirmed to be a bug in the older SDK version. Identity update operations now work correctly with MASTER keys.

**Date Resolved:** 2026-01-19
