# Bug Reports

## Active Bugs

### BUG-012: followers listed in Private Feed page is incorrect

**Status:** OPEN

**Description:** The Private Feed settings page correctly detects 2 followers but displays incorrect user IDs when linking to their profiles.

**Observed Behavior:**
- Links point to: `fqo6OUtPAVlsnOP0YYxOfhgZNxUZHJ5VsG6yUUrUCZo=` and `QjTG2D1fnUuJt1Fxe5jWtrfPzpZsd2Hw8kW7WKE3UPY=`

**Expected Behavior:**
- Links should point to: `5TSasoJ1gF1ZKcpBC8zgEyvWCj4duVvdYRM4vTufhpn9` and `9XSvMdaxxpBNb5EmPDZjRn86j5xgcqgEoqnq3x4q3QLZ`

**Impact:** Users cannot navigate to the correct profile pages for their private followers.

**Possible Root Cause:** The `recipientId` field in `PrivateFeedGrant` documents may be stored/displayed incorrectly, or there's a data encoding issue (base64 vs base58).

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

## Resolved Bugs

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
