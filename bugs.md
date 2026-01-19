# Bug Reports

## Active Bugs

(No active bugs)

## Resolved Bugs

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
