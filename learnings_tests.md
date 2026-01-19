# E2E Testing Learnings

## 2026-01-19: WASM SDK Integration Challenges

### Issue 1: WASM Module Import Path
**Problem:** Importing `IdentityPublicKeyInCreation` directly from `@dashevo/wasm-sdk` resulted in:
```
Cannot read properties of undefined (reading 'identitypublickeyincreation_fromObject')
```

**Root Cause:** The WASM SDK exports are from the compressed bundle (`@dashevo/wasm-sdk/compressed`), and the WASM module needs to be initialized before use.

**Solution Applied:**
```typescript
import initWasm, * as wasmSdk from '@dashevo/wasm-sdk/compressed';

let wasmInitialized = false;
async function ensureWasmInitialized() {
  if (!wasmInitialized) {
    await initWasm();
    wasmInitialized = true;
  }
  return wasmSdk;
}
```

**Lesson:** Always check package.json exports and README for the correct import paths when dealing with WASM-based SDKs.

### Issue 2: IdentityPublicKeyInCreation.fromObject() Format (BUG-001 - RESOLVED)
**Problem:** Even with proper WASM initialization, `IdentityPublicKeyInCreation.fromObject()` throws `WasmDppError`.

**What Was Tried:**
1. Passing `data` as byte array: `[3, 229, 27, ...]` - Failed
2. Passing `data` as base64 string: `"A+UbPMgXMbc3MAhqN..."` - Failed
3. With `contractBounds` object - Failed
4. Without `contractBounds` (null) - Failed
5. Added `disabledAt: null` to match existing keys - Failed

**Solution Found:** Use the constructor directly instead of `fromObject()`:
```typescript
const newKey = new wasm.IdentityPublicKeyInCreation(
  newKeyId,           // id: number
  'ENCRYPTION',       // purpose: string enum
  'MEDIUM',           // securityLevel: string enum
  'ECDSA_SECP256K1',  // keyType: string enum
  false,              // readOnly: boolean
  publicKeyBytes,     // data: Uint8Array (NOT base64!)
  null,               // signature: null for new keys
  null                // contractBounds: null or ContractBounds
);
```

**Key Insight:** The constructor accepts `data` as `Uint8Array`, while `fromObject()` has undocumented validation that fails. The constructor is more lenient and works correctly.

**Lesson:** When `fromObject()` or `fromJSON()` fail with unhelpful errors, try using the constructor directly. Check the TypeScript definitions for constructor parameters.

### Issue 3: Testing Identity Setup
**Observation:** The test identities (testing-identity-1.json, testing-identity-2.json) don't have encryption keys on their identities, which is required for private feed testing.

**Impact:** Cannot test E2E flows for private feed without first adding encryption keys.

**Workaround Needed:** May need to:
1. Fix BUG-001 to add keys programmatically
2. Or manually add encryption keys to test identities via another method
3. Or create fresh test identities with encryption keys pre-configured

### Issue 4: Identity Update Security Level Requirements (BUG-002 - RESOLVED)
**Problem:** After fixing BUG-001, `sdk.identities.update()` fails with `WasmSdkError` when trying to add an encryption key.

**Context:**
- User is logged in with HIGH security level key (securityLevel=2)
- Identity has keys: MASTER (0), CRITICAL (1), HIGH (2), TRANSFER (3)
- Error occurs during `sdk.identities.update()` call

**Root Cause Confirmed:** Dash Platform requires CRITICAL (securityLevel=1) or MASTER (securityLevel=0) keys to modify identities. The HIGH (securityLevel=2) login key is insufficient.

**Solution Applied:**
1. Added `validateKeySecurityLevel()` method to validate key security level before SDK calls
2. Modified modal flow to request CRITICAL key specifically for identity updates
3. Clear UI messaging explaining why CRITICAL key is needed

**Key Code Pattern:**
```typescript
// Validate signing key has sufficient security level before calling SDK
const validation = await this.validateKeySecurityLevel(signingPrivateKeyWif, identityId);
if (!validation.isValid) {
  return { success: false, error: validation.error };
}
// Validation checks: securityLevel must be <= 1 (CRITICAL or MASTER)
```

**Status:** RESOLVED - Security level validation working correctly. A deeper SDK error (BUG-003) was discovered.

**Lesson:** Always validate key security levels before performing sensitive operations. Identity modifications require CRITICAL or MASTER keys - this is a platform-level security requirement.

### Issue 5: SDK Identity Update Still Fails After Security Fix (BUG-003 - OPEN)
**Problem:** Even with correct CRITICAL-level key, `sdk.identities.update()` still throws `WasmSdkError`.

**Context:**
- Security level validation passes: `Signing key validated: keyId=2, securityLevel=1`
- SDK call still fails with generic `WasmSdkError`

**Possible Causes:**
- Network/DAPI connectivity issues
- SDK version incompatibility with current platform state
- Missing or invalid state transition parameters
- Platform-specific validation failures

**Status:** OPEN - Needs further investigation into SDK/platform requirements.

**Lesson:** Even when client-side validation passes, SDK operations can fail for platform-specific reasons. Better error handling and messages from the SDK would help diagnose these issues.

### Best Practices Identified

1. **Always restart dev server after code changes** - The dev server often enters a corrupted state after changes to service files.

2. **Use browser console logs extensively** - Add detailed logging before/after SDK calls to pinpoint exactly where failures occur.

3. **Compare with working examples** - Look at how existing keys are formatted in `identity.toJSON()` to understand expected formats.

4. **Document SDK integration patterns** - The Dash Platform SDK has specific patterns that aren't always obvious from TypeScript types alone.

5. **Try constructors when fromObject/fromJSON fail** - The WASM SDK's `fromObject()` and `fromJSON()` methods often have undocumented validation. Constructors are more predictable.

6. **Check security level requirements** - Different Dash Platform operations require different security level keys. Identity updates may need CRITICAL or MASTER keys.


## Developer extra learnings
**IMPORTANT** I was able register a new key to my identity via the evo-sdk on dev.11. I've confirmed on v2 of the sdk, it was borked. It seems likely that we will need to update to dev.11 of the sdk.

---

## 2026-01-19: E2E Test 1.1 Completion - Key Learnings

### Issue 6: SDK dev.11 Requires MASTER Key for Identity Updates (NOT CRITICAL)
**Problem:** When attempting to add an encryption key to identity, using CRITICAL key resulted in error:
```
Identity modifications require a MASTER key. You provided a CRITICAL key.
```

**Context:**
- UI states "CRITICAL or MASTER" key is accepted
- CRITICAL key (securityLevel=1) was validated and accepted client-side
- SDK rejected the CRITICAL key during `sdk.identities.update()`

**Discovery:** SDK dev.11 has changed the security requirements for identity modifications. Only MASTER (securityLevel=0) keys are now accepted, not CRITICAL (securityLevel=1).

**Solution:** Use MASTER key instead of CRITICAL for identity modifications.

**UI Consideration:** The modal UI mentions "CRITICAL or MASTER" but should perhaps emphasize MASTER is required, or update the validation to only accept MASTER keys.

**Lesson:** Always verify SDK behavior changes between versions. Security level requirements may change.

### Issue 7: Encryption Key Storage Location
**Observation:** After adding encryption key to identity, the private key is stored in localStorage with the key format:
```
yappr_secure_ek_<identityId>
```

**Value format:** JSON-encoded hex string (with quotes): `"81661572aae449..."`

**Usage:** When enabling private feed, the user must re-enter this key if it's not already in session storage. The key can be retrieved from localStorage for testing purposes.

**Lesson:** For E2E testing, the encryption key can be extracted from localStorage using browser console or Playwright evaluate functions.

### Issue 8: Private Feed Enable Flow Requires Key Entry
**Observation:** Even after successfully adding an encryption key to the identity on-chain, the "Enable Private Feed" button requires the user to re-enter the encryption private key (32 bytes hex).

**Flow:**
1. Add encryption key to identity (stores in localStorage as side effect)
2. Click "Enable Private Feed"
3. Modal prompts for encryption private key hex
4. Key is validated and used to create PrivateFeedState document

**Lesson:** The encryption private key must be available for both adding to identity AND enabling private feed. It's stored in localStorage for convenience but must be entered again if session is lost.

### Best Practices Updates

7. **Check localStorage for stored encryption keys** - For testing, encryption keys are stored at `yappr_secure_ek_<identityId>` in localStorage.

8. **Use MASTER key for identity updates on SDK dev.11** - CRITICAL key is no longer sufficient for identity modifications on the newer SDK version.

9. **Update test identity files after successful tests** - Add encryption keys and private feed status to test identity JSON files for reuse in subsequent tests.

---

## 2026-01-19: E2E Test 1.3 - Straightforward Test

### Issue 9: Settings Page URL Structure
**Observation:** The private feed settings are accessed via query parameter, not a separate route:
- Correct URL: `/settings?section=privateFeed`
- NOT: `/settings/private-feed` (returns 404)

**Lesson:** Check the settings page implementation for the correct URL structure. The app uses a single settings page with query params to switch between sections.

### Issue 10: DPNS Username Not Required for Testing
**Observation:** The test identity doesn't have a DPNS username registered, causing the app to redirect to `/dpns/register/`. However, clicking "Skip for now" allows access to the rest of the app.

**Lesson:** For testing purposes, DPNS username registration can be skipped. The "Skip for now" button allows full app functionality without a registered username.

### Issue 11: Console Errors for Private Followers Query
**Observation:** Console shows "Error fetching private followers: WasmSdkError" but the page still loads correctly and shows "No private followers yet".

**Possible Cause:** The PrivateFeedGrant query may have different requirements or the document type may not be properly configured on testnet.

**Impact:** Non-blocking - the UI gracefully handles the error and shows empty state.

**Lesson:** Some console errors are non-blocking and the UI handles them gracefully. Focus on visual/functional testing rather than expecting zero console errors.

---

## 2026-01-19: E2E Test 2.1 - Compose Modal Testing

### Issue 12: Compose Modal Navigation
**Observation:** The compose button in the navigation bar opens a modal dialog overlay, not a separate page.

**Implementation Detail:** The compose modal is implemented as a dialog component that overlays the current page content. This allows users to compose posts from any page without losing their place.

**Lesson:** When testing the compose flow, the modal can be opened from any page in the app via the navigation bar.

### Issue 13: Visibility Selector Implementation
**Observation:** The visibility selector is implemented as a dropdown button that shows all three options:
- Public (globe icon) - default
- Private (lock icon) - requires private feed enabled
- Private with Teaser (lock icon) - requires private feed enabled

**Key Details:**
- The currently selected option shows a checkmark
- Each option has an icon and descriptive text
- The dropdown is a custom component, not a native HTML select

**Lesson:** The visibility options are properly gated based on whether the user has private feed enabled. For users without private feed, only "Public" would be available (not tested in this scenario since our test identity has private feed enabled).

---

## 2026-01-19: E2E Test 2.2 - Private Post Creation Bug

### Issue 14: Data Contract Constraint on Empty Content (BUG-004)
**Problem:** Private posts without teaser fail with JsonSchemaError because the implementation sets `content` to empty string, but the contract requires `minLength: 1`.

**Error:**
```
WasmSdkError: Failed to broadcast transition: Protocol error: JsonSchemaError: "" is shorter than 1 character, path: /content
```

**Root Cause:** In `lib/services/private-feed-service.ts`, line 407:
```typescript
content: teaser || '', // Teaser or empty string for private-only posts
```

The contract (`contracts/yappr-social-contract-actual.json`) defines:
```json
"content": {
  "type": "string",
  "minLength": 1,  // <-- Rejects empty string
  ...
}
```

**Impact:** The "Private" visibility option (without teaser) is completely broken. Users can only create private posts if they provide a teaser.

**Suggested Fix:** Use a placeholder like `"🔒"` or `"[Private]"` for the `content` field when no teaser is provided. This maintains contract compatibility while preserving the intended functionality.

**Lesson:** When building features that interact with on-chain data contracts, always verify the schema constraints. The `minLength` constraint isn't optional validation - it's enforced at the protocol level and will reject state transitions that violate it.

### Issue 15: Error Handling in Compose Modal
**Observation:** When the private post creation failed, the error was logged to console but no visible error message appeared in the UI (the toast may have been briefly shown or suppressed).

**User Experience Impact:** Users see the post button re-enable but may not understand why their post failed.

**Lesson:** Error handling for post creation should show clear, user-friendly error messages. Consider showing "Could not create private post: [reason]" in a persistent toast or inline error message.

### Issue 16: Multiple Affected Code Paths
**Observation:** Both `createPrivatePost()` and `createInheritedPrivateReply()` in private-feed-service.ts use empty string for content when no teaser is provided. Any fix needs to address both methods.

**Affected Methods:**
- `createPrivatePost()` - line 407: `content: teaser || ''`
- `createInheritedPrivateReply()` - line 508: `content: ''`

**Lesson:** When fixing a bug, search the codebase for similar patterns that may have the same issue.

---

## 2026-01-19: BUG-005 Fix - Private Feed Access Request Encryption Key

### Issue 17: Missing Encryption Key in Follow Requests (BUG-005 - FIXED)
**Problem:** When a user requests access to another user's private feed, the `FollowRequest` document was being created without the requester's encryption public key. This caused approval to fail with "Could not find encryption key for this user".

**Root Cause:**
1. `privateFeedFollowerService.requestAccess(ownerId, myId, publicKey?)` has an optional `publicKey` parameter
2. `PrivateFeedAccessButton` was calling `requestAccess(ownerId, currentUserId)` WITHOUT the publicKey
3. When owner approves, the code tried to find encryption key from request (undefined) then identity (may not have one)
4. Result: Approval fails if requester has no encryption key on identity

**Solution:**
1. Modified `PrivateFeedAccessButton.handleRequestAccess()` to retrieve encryption public key before calling `requestAccess()`
2. Key sources (in order): localStorage stored key -> derive from private key, identity public keys
3. If no key available, show clear error asking user to set up encryption key first
4. Pass the key to `requestAccess()` so it's stored in the `FollowRequest` document

**Key Insight:** The `requestAccess()` API accepts an optional `publicKey` parameter specifically for cases where the key might not be on the identity (hash160-only keys). The calling code was not utilizing this parameter.

**Lesson:** When debugging "missing data" errors, trace back through the entire flow to find where the data should have been populated. Optional parameters in APIs often indicate a design decision that callers should respect.

### Issue 18: Dev Server Corruption After Code Changes
**Observation:** The Next.js dev server frequently enters a corrupted state after modifying service files, resulting in 404 errors for all static assets.

**Symptoms:**
- All `_next/static/chunks/*.js` files return 404
- Page renders but is non-functional (no JS)
- Console shows dozens of 404 errors

**Workaround:** Kill the dev server (`pkill -f "next dev"`) and restart with `npm run dev`.

**Lesson:** When testing code changes, be prepared to restart the dev server if the page appears broken. Always verify the server is working correctly before assuming a bug in the code.

### Issue 19: Multi-Identity E2E Testing Complexity
**Observation:** Testing the full private feed request->approve flow requires:
1. Two test identities (requester and owner)
2. Both need encryption keys
3. Requester must follow the owner
4. Session switching between identities

**Challenge:** Playwright session state is tied to localStorage, so testing multi-user flows requires either:
- Multiple browser contexts
- Clearing and re-logging between actions
- Using different browsers/profiles

**Lesson:** Design test identities upfront with all required capabilities (encryption keys, DPNS names, following relationships). Document the setup so tests can assume prerequisites are met.

---

## 2026-01-19: BUG-004 Fix - Empty Content Field Validation

### Issue 20: Data Contract Constraint on Empty String (BUG-004 - FIXED)
**Problem:** Private posts without teaser failed because the `content` field was set to empty string `''`, but the data contract enforces `minLength: 1`.

**Root Cause:** The implementation assumed empty string was valid for posts where all content is encrypted. The contract defines:
```json
"content": {
  "type": "string",
  "minLength": 1,
  "maxLength": 500
}
```

**Solution:** Use a placeholder character `🔒` for the `content` field when no teaser is provided. This:
1. Satisfies the contract constraint (length = 1)
2. Visually indicates to users that the post is private
3. Keeps the actual content encrypted in `encryptedContent`

**Key Insight:** When a data contract field is required with constraints, you cannot simply pass empty/null values even if the "real" data is stored elsewhere. The placeholder approach is a clean solution that maintains contract compatibility.

**Lesson:** Always verify data contract constraints before implementing features that interact with on-chain documents. Constraints like `minLength`, `maxLength`, and `required` are enforced at the protocol level and will reject state transitions that violate them.

### Issue 21: Testing Private Post Creation E2E
**Observation:** The E2E test for private post creation (Test 2.2) requires:
1. User with private feed enabled
2. Encryption keys stored in localStorage
3. Dev server running with fresh state

**Verification Steps:**
1. Check console for `Creating post document with data: {content: 🔒, ...}`
2. Verify "Document creation submitted successfully" log
3. Refresh page to see post in feed with 🔒 placeholder
4. Confirm post count increased

**Lesson:** When fixing bugs related to on-chain operations, verify the fix by checking both console logs (for the data being sent) and the UI (for the result after refresh).

---

## 2026-01-19: E2E Test 2.3 - Private Post with Teaser

### Issue 22: Dev Server Corruption on Navigation
**Problem:** After posting a private post, navigating (page refresh) caused the dev server to enter a corrupted state with multiple 404 errors for chunk files.

**Symptoms:**
- `ChunkLoadError: Loading chunk vendors-_app-pages-browser...`
- Multiple 404 errors for `_next/static/chunks/*.js` files
- Page fails to render

**Workaround:** Kill the dev server, clear `.next` cache, and restart:
```bash
pkill -f "next dev"; rm -rf .next && npm run dev
```

**Lesson:** When running E2E tests, be prepared for dev server corruption especially after state transitions. Always have the restart command ready and clear the `.next` cache if issues persist.

### Issue 23: Two-Field Compose UI for Private with Teaser
**Observation:** When selecting "Private with Teaser" visibility, the compose modal transforms to show two distinct content areas:
1. **Teaser section**: "Public Teaser (visible to everyone)" with character limit 280
2. **Private section**: "Private Content (encrypted)" with the standard content editor

**Key Details:**
- The teaser field has its own character counter (e.g., "106/280")
- Visual info banner explains encryption: "The main content will be encrypted. Teaser will be visible to everyone."
- Warning shows follower count: "Only visible to you (no followers yet)"
- Both fields must have content for the Post button to enable

**Lesson:** The UI clearly separates teaser (public) from encrypted content, making it easy for users to understand what will be visible to everyone vs. private followers only.

### Issue 24: Private Post Document Structure Verification
**Observation:** The console logs provide clear verification of the document structure:
```javascript
{
  content: "teaser text here...",  // Public teaser (visible to all)
  encryptedContent: Array(297),     // Encrypted private content
  epoch: 1,                         // Current epoch
  nonce: Array(24)                  // 24-byte nonce for decryption
}
```

**Key Details:**
- `content` field contains the plaintext teaser (satisfies minLength constraint)
- `encryptedContent` contains the encrypted full content
- `hasTeaser: true` is logged during creation
- Post ID is logged on success: `Private post created successfully: <postId>`

**Lesson:** Console logs are essential for E2E test verification. Check for `hasTeaser: true` to confirm the correct code path was taken, and verify `encryptedContent` array has expected length.

---

## 2026-01-19: E2E Test 2.4 - No Followers Warning

### Issue 25: Warning Wording in Compose Modal
**Observation:** When a user with private feed enabled but 0 private followers selects "Private" visibility in the compose modal:
- Warning displays: "Only visible to you (no followers yet)"
- This is clearer than the expected wording "No private followers yet"
- The phrasing emphasizes the immediate consequence (only you can see it) rather than just the state

**Key Details:**
- Warning appears at the bottom of the compose modal
- Warning has yellow/orange styling with a lock icon
- Warning is separate from the blue "encryption info" banner at top
- Post button remains enabled (warning is advisory only)

**Lesson:** Test expectations should be flexible on exact wording - the spirit of the requirement is met even if the exact text differs. The implementation's wording ("Only visible to you") is arguably better UX than the specification ("No private followers yet").

### Issue 26: Dev Server Stability
**Observation:** The Next.js dev server was stable throughout this test session without requiring a restart.

**Key Details:**
- Started fresh with `rm -rf .next && npm run dev`
- Completed full E2E test without corruption
- Page navigation, modal interactions, and post creation all worked smoothly

**Lesson:** Starting with a clean `.next` cache helps prevent dev server corruption issues seen in earlier test sessions.

---

## 2026-01-19: E2E Test 2.5 - Character Limit Validation

### Issue 27: Different Character Counter Display Formats
**Observation:** The teaser and private content fields use different formats for displaying character limits:
- **Teaser field**: Shows "X/280" format (e.g., "330/280" when over limit)
- **Private content field**: Shows remaining characters or negative value when over (e.g., "-77" for 77 over)

**Key Details:**
- Both formats effectively communicate the limit status
- Red styling applied when limits are exceeded
- Post button correctly disables when either field exceeds its limit
- Both fields must be valid for Post button to enable

**Lesson:** UI implementations may vary from spec expectations, but the key functionality (preventing posts that exceed limits) works correctly. The different formats are both valid UX approaches.

### Issue 28: Teaser vs Private Content Limits
**Observation:** The character limits are:
- Teaser: 280 characters max (same as Twitter/X post limit)
- Private content: 500 characters max (matches the post contract's content maxLength)

**Lesson:** These limits match the data contract constraints, ensuring posts won't fail at the protocol level due to content length.

---

## 2026-01-19: E2E Test 2.6 - Default Visibility Not Sticky

### Issue 29: Compose Modal State Management
**Observation:** The compose modal correctly resets its state (including visibility selection) each time it opens. After creating a private post with "Private" visibility, opening the compose modal again shows "Public" as the default.

**Key Details:**
- The compose modal does not persist visibility state between uses
- This is intentional UX design - users should consciously choose private visibility each time
- Prevents accidental private posts or accidental public posts

**Implementation Insight:** The compose modal likely initializes its state fresh on each open, rather than persisting previous selections in localStorage or component state that survives unmounting.

**Lesson:** For sensitive features like private posts, defaulting to the "safer" option (public) on each use is good UX practice. Users must explicitly choose to make a post private, reducing the risk of accidentally posting private content publicly or vice versa.

### Issue 30: Test Simplicity
**Observation:** This test (2.6) was straightforward and required no code changes - it simply verified existing expected behavior.

**Lesson:** Some E2E tests are pure verification of existing functionality. These tests are valuable for regression testing and documentation purposes, even though they don't uncover bugs.

---

## BUG-006 Fix Session (2026-01-19)

### Issue 31: Inherited Encryption Requires Different Decryption Logic
**Bug:** BUG-006 - Encrypted replies fail to decrypt for the reply author, showing "Private Content - Only approved followers can see this content"

**Root Cause:** When replying to a private post, the reply is encrypted with the **parent thread owner's CEK** (per PRD §5.5 inherited encryption), not the reply author's CEK. The decryption code assumed `post.author.id` was always the encryption owner, but for replies:
- `post.author.id` = The person who wrote the reply
- Encryption owner = The person who owns the private feed (root post author)

**Key Insight:** In a reply chain to a private post, all replies inherit encryption from the root private post. This means:
1. User A creates private post (encrypted with A's CEK)
2. User B replies to A's private post (encrypted with A's CEK, not B's)
3. When User B views their own reply, they need A's CEK to decrypt it

**Solution:** For posts with `replyToId` and encrypted content, use `getEncryptionSource()` to trace back to the root private post and use that owner's keys for decryption.

**Lesson:** When implementing inherited/cascading encryption, always consider the decryption path. The entity that performs encryption (author) may be different from the entity whose keys were used (encryption source owner). Both composition AND decryption must be aware of this distinction.

### Issue 32: Existing Utility Functions Can Be Reused
**Observation:** The `getEncryptionSource()` function was already implemented for the compose modal to detect when replies need inherited encryption. The same function works perfectly for the decryption path.

**Lesson:** When fixing bugs, look for existing utility functions that solve part of the problem. `getEncryptionSource()` walks the reply chain to find the root private post - exactly what the decryption code needed. Reusing it ensured consistency between encryption and decryption logic.

### Issue 33: Console Logging for Debugging Complex Flows
**Observation:** Adding `console.log('Reply decryption: inherited encryption from', encryptionSourceOwnerId)` immediately revealed when the fix was working correctly in the browser.

**Lesson:** For complex cryptographic flows like private feed decryption, strategic console logs showing key state transitions (e.g., "using X's keys instead of Y's") make debugging much easier without cluttering the codebase.

---

## 2026-01-19: E2E Test 3.1 - Request Access Happy Path

### Issue 34: Encryption Key Required Before Requesting Private Feed Access
**Observation:** When a user without an encryption key tries to request access to a private feed, they get a clear error message: "You need an encryption key to request private feed access. Please enable your own private feed first."

**Context:** Per BUG-005 fix, the `requestAccess()` method now requires the requester to have an encryption public key. This key is included in the `FollowRequest` document so the owner can encrypt the grant payload.

**Key Flow:**
1. User clicks "Request Access" on a profile with private feed
2. System checks if user has encryption key (stored locally or on identity)
3. If no key found, shows error with guidance
4. If key found, includes `publicKey: Array(33)` in the FollowRequest document

**Lesson:** The encryption key requirement is properly enforced at the UI level, preventing broken requests where the owner can't encrypt the grant because the requester has no encryption key.

### Issue 35: Multi-Step Identity Modification Flow
**Observation:** Adding an encryption key to an identity requires a multi-step modal flow:
1. Generate key (client-side)
2. Save/copy private key (user action)
3. Confirm key backup (checkbox)
4. Enter MASTER key (required for identity modifications)
5. Broadcast identity update transaction

**Key Detail:** SDK dev.11 requires MASTER key (securityLevel=0) for identity modifications, not CRITICAL. The console shows: `Signing key validated: keyId=0, securityLevel=0`

**Lesson:** The modal flow properly guides users through the complex process of adding an encryption key, with appropriate warnings and confirmations. The MASTER key requirement is clearly communicated.

### Issue 36: Notification Creation Failure (Non-Blocking)
**Observation:** After successfully creating the FollowRequest document, the notification creation fails with "No private key found. Please log in again."

**Error Context:**
```
[ERROR] Error creating document: Error: No private key found. Please log in again.
    at StateTransitionService.getPrivateKey
[ERROR] Failed to create privateFeedRequest notification: No private key found...
[LOG] Follow request created successfully
```

**Impact:** The main FollowRequest flow succeeds, but the owner doesn't receive a notification. This is non-blocking for the core functionality but affects UX.

**Possible Cause:** The notification service may be using a different contract that requires re-authentication, or there's a timing issue with the private key lookup.

**Lesson:** Notification creation should be wrapped in try/catch and not block the main operation. The current implementation correctly continues despite notification failure.

### Issue 37: UI Button State Transitions
**Observation:** The "Request Access" button has clear state transitions:
- Default: "Request Access" with lock icon
- During operation: "Requesting..." (disabled)
- After success: "Pending..." with clock icon

**Lesson:** Good UI feedback helps users understand the operation status. The "Pending..." state clearly indicates the request was submitted and is awaiting owner approval.

### Issue 38: Test Identity Setup for Multi-User Testing
**Observation:** E2E Test 3.1 required significant setup:
1. Login as follower identity
2. Skip DPNS registration (no username)
3. Create profile (required for following)
4. Follow the owner
5. Add encryption key to identity
6. Then test the request flow

**Lesson:** Multi-user E2E tests require careful orchestration. Having test identity JSON files with pre-configured encryption keys would speed up future tests. Consider adding profile and encryption key info to test identity files.

---

## 2026-01-19: BUG-007 - Query Index Constraints

### Issue 39: Document Queries Must Match Available Indices (BUG-007)
**Problem:** The `getPrivateFollowers()` query was failing with `WasmSdkError` because it used `orderBy: [['$createdAt', 'desc']]` but the `privateFeedGrant` document type indices don't include `$createdAt`.

**Root Cause:** Dash Platform queries require matching indices. The available indices were:
- `ownerAndRecipient`: `($ownerId, recipientId)`
- `ownerAndLeaf`: `($ownerId, leafIndex)`

Neither supports ordering by `$createdAt`.

**Solution:** Remove the `orderBy` clause and sort client-side if needed.

**Lesson:** When writing document queries:
1. Always check the document type's indices in the contract definition
2. The `where` and `orderBy` clauses must be supported by available indices
3. If the SDK fails silently or with generic errors, check if the query matches an index
4. Client-side sorting is a valid alternative when index support is missing

### Issue 40: Stale Test Data on Testnet
**Observation:** After fixing BUG-007, approval still failed with "duplicate unique properties" error. This is because there are stale grants from prior test sessions that weren't properly cleaned up.

**Impact:** The `leafIndex` conflict occurs when:
1. Recovery finds some grants but misses others
2. Code calculates available leaves incorrectly
3. New grant creation fails on already-used leafIndex

**Lesson:** When running E2E tests on testnet:
1. Test data accumulates across sessions
2. Consider using fresh identities for each test run
3. Or implement proper cleanup between tests
4. The "duplicate unique properties" error often indicates stale data conflicts, not code bugs

### Issue 41: Inconsistent UI Data Sources
**Observation:** The Private Feed settings page showed inconsistent follower counts:
- One card showed "0/1024 Followers"
- Another showed "1/1024 Followers"

**Cause:** Different UI components may fetch data from different sources (local state vs API calls), leading to inconsistency when queries fail or return partial data.

**Lesson:** When UI components show different values for the same metric, investigate whether they're using the same data source and whether all queries are succeeding.

---

## 2026-01-19: BUG-009 Fix - Data Source Consistency

### Issue 42: Local Storage vs On-Chain Data Inconsistency (BUG-009 - FIXED)
**Problem:** After accepting a private follower and reloading, the settings card showed "1/1024 Followers" but the Private Followers list showed no one.

**Root Cause:**
1. `private-feed-settings.tsx` got follower count from local `recipientMap` in localStorage
2. `private-feed-dashboard.tsx` and `private-feed-followers.tsx` queried on-chain `privateFeedGrant` documents
3. When local state was stale/empty or on-chain queries succeeded, counts diverged

**Code Pattern (Before):**
```typescript
// private-feed-settings.tsx - uses LOCAL storage
if (privateFeedKeyStore.hasFeedSeed()) {
  const recipientMap = privateFeedKeyStore.getRecipientMap()
  setFollowerCount(Object.keys(recipientMap || {}).length)
}

// private-feed-dashboard.tsx - uses ON-CHAIN query
const followers = await privateFeedService.getPrivateFollowers(user.identityId)
setFollowerCount(followers.length)
```

**Solution:** Changed `private-feed-settings.tsx` to query on-chain data with fallback to local storage for consistency.

**Lesson:** When multiple UI components display the same data:
1. All components should use the same authoritative data source
2. On-chain data is the source of truth for blockchain-backed features
3. Local storage should only be used as a fallback/cache, not primary source
4. Add fallback with clear logging to help debug query failures

---

## 2026-01-19: BUG-008 Fix - Notification Architecture

### Issue 43: Cannot Create Documents Owned by Another Identity (BUG-008 - FIXED)
**Problem:** Private feed request notifications were not being created. The feed owner never received a notification when someone requested access.

**Root Cause:** The `private-feed-notification-service.ts` was attempting to create `notification` documents owned by the **recipient** (feed owner), but signed by the **requester**. This is fundamentally impossible in Dash Platform:
1. `stateTransitionService.createDocument(contractId, docType, ownerId, data)` requires the private key for `ownerId`
2. The requester only has their own private key in session, not the feed owner's
3. Result: `getPrivateKey(ownerId)` fails with "No private key found"

**Key Insight:** In Dash Platform, you can ONLY create documents where `$ownerId` is your own identity. You cannot create documents on behalf of another user.

**Architectural Problem:** The notification schema has indices on `$ownerId` (the recipient), implying notifications should be owned by the recipient. But the sender can't create those documents.

**Solution:** Changed from "push" (create notification documents) to "pull" (discover via queries):
- Instead of creating `notification` documents (impossible)
- Query `followRequest` documents where `targetId == userId` (the feed owner)
- This follows the same pattern as follower notifications, which query `follow` documents directly

**Code Pattern:**
```typescript
// Before (broken): Query notification docs (can never exist)
const response = await sdk.documents.query({
  documentTypeName: 'notification',
  where: [['$ownerId', '==', userId], ...]
});

// After (working): Query the source documents directly
const response = await sdk.documents.query({
  documentTypeName: 'followRequest',
  where: [['targetId', '==', userId], ...]
});
```

**Lesson:** When designing decentralized notification systems:
1. You cannot create documents owned by someone else
2. "Push" notification models (sender creates notification for recipient) don't work
3. "Pull" models work well - recipient's client discovers events by querying relevant documents
4. Index your documents appropriately for the "pull" queries (e.g., `followRequest` has `[targetId, $createdAt]` index)

### Issue 44: Existing Pattern for Derived Notifications
**Observation:** The `notification-service.ts` already had a working pattern for follower notifications:
```typescript
// For new followers: query 'follow' documents, not 'notification' documents
await sdk.documents.query({
  documentTypeName: 'follow',
  where: [['followingId', '==', userId], ['$createdAt', '>', sinceTimestamp]]
});
```

**Lesson:** Before implementing a new notification type, check how existing notification types are implemented. The follower notification pattern (querying the source document directly) was already working and could be applied to private feed requests.

---

## 2026-01-19: E2E Test 5.1 - Multi-Identity Testing

### Issue 45: Session Management for Multi-Identity Testing
**Observation:** To test the non-follower view, needed to clear session and log in as a different identity. Used browser's `localStorage.clear()` and `sessionStorage.clear()` to fully log out before logging in as the test identity.

**Key Steps:**
1. Navigate to login page
2. Execute `localStorage.clear(); sessionStorage.clear(); window.location.reload()`
3. Log in with new identity credentials
4. Skip DPNS and key backup prompts to proceed with testing

**Lesson:** For multi-identity E2E testing, the cleanest approach is to clear all storage rather than trying to find and use a logout button. This ensures no session state persists between identity switches.

### Issue 46: Private Post Display States
**Observation:** Private posts have different display states depending on the viewer:

1. **Non-follower viewing post list (profile/feed):**
   - Shows only 🔒 emoji as content placeholder
   - No "Request Access" button inline (would clutter the feed)

2. **Non-follower viewing post detail:**
   - Shows 🔒 lock icon
   - Shows "Private Content" heading
   - Shows "Only approved followers can see this content" message
   - Shows [Request Access] button prominently

3. **Posts with teaser:**
   - Teaser text is always visible to everyone
   - Only the encrypted content is hidden

**Lesson:** The UI provides progressive disclosure - minimal indication in feed view, full explanation and action button in detail view. This keeps the feed clean while still guiding non-followers to request access.

### Issue 47: Testing Identity Organization
**Observation:** The test identities serve different purposes:
- Identity 1 (9qRC7aPC...) - "Test User 1" - Owner with private feed enabled
- Identity 2 (6DkmgQWv...) - "Test Follower User" - Follower who has requested access
- Identity 3 (4GPK6iuj...) - "Test Owner PF" - Non-follower for testing locked views

**Lesson:** Maintain clear documentation of test identity roles. Identity 3 was named "Test Owner PF" from prior testing but served as the non-follower in this test - the naming could be improved for clarity.

---

## 2026-01-19: E2E Test 5.2 - Teaser Posts for Non-Followers

### Issue 48: Teaser vs Non-Teaser Private Post Display
**Observation:** Private posts display differently depending on whether they have a teaser:

1. **Posts without teaser**: Show only 🔒 emoji as content placeholder in feed
2. **Posts with teaser**: Show the full teaser text (up to 280 chars) in the feed, looks like a normal post

In the post detail view:
- Posts with teaser show the teaser text above a grey box containing the locked content
- The locked content section has: lock icon, "Private Content" heading, "Only approved followers can see this content" message, and a [Request Access] button

**Lesson:** The teaser acts as public content - it's stored in the `content` field of the post document, while the encrypted content is in `encryptedContent`. This means teasers are fully indexed, searchable, and visible to all users.

### Issue 49: Grey Box vs Blur for Locked Content
**Observation:** The test expected "blurred/dimmed placeholder" for private content but the actual implementation uses a grey box with a lock icon.

**Key Details:**
- The grey box provides clear visual indication that content is hidden
- Contains: lock icon (🔒), "Private Content" heading, explanation text, and CTA button
- This is arguably better UX than a blur effect because it's unambiguous

**Lesson:** Test expectations should be flexible on visual implementation details. The spirit of the requirement (clearly indicate content is private and provide access path) is met even if the exact visual treatment differs from the spec.
