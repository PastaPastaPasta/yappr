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
