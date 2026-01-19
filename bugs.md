# Bug Reports

## BUG-001: IdentityPublicKeyInCreation.fromObject() throws WasmDppError

**Date Reported:** 2026-01-19
**Severity:** HIGH (Blocking)
**Status:** Open
**Affects:** E2E Test 1.1 - Enable Private Feed Happy Path

### Summary
When attempting to add an encryption key to an identity via the "Add Encryption Key to Identity" flow in Settings > Private Feed, the operation fails with a `WasmDppError` when calling `IdentityPublicKeyInCreation.fromObject()`.

### Steps to Reproduce
1. Log in with an identity that does NOT have an encryption key
2. Navigate to Settings > Private Feed
3. Click "Add Encryption Key to Identity"
4. Click "Generate Encryption Key"
5. Check "I have securely saved my private key..."
6. Click "Continue"
7. Click "Add Encryption Key"

### Expected Behavior
The encryption key should be added to the identity on Dash Platform, and the user should see a success message allowing them to enable their private feed.

### Actual Behavior
An error dialog appears showing "Unknown error" with console error: `Error adding encryption key: WasmDppError`

### Technical Details

**Console Log:**
```
Creating IdentityPublicKeyInCreation with object: {"$version":0,"id":4,"purpose":1,"securityLevel":2,"type":0,"readOnly":false,"data":"<base64-public-key>","contractBounds":null,"disabledAt":null}
Error adding encryption key: WasmDppError
```

**Code Location:**
`lib/services/identity-service.ts:addEncryptionKey()` at line ~268

**What was tried:**
1. Originally imported `IdentityPublicKeyInCreation` directly from `@dashevo/wasm-sdk` - resulted in `Cannot read properties of undefined (reading 'identitypublickeyincreation_fromObject')`
2. Changed to dynamic import from `@dashevo/wasm-sdk/compressed` with `initWasm()` - WASM now loads but `fromObject()` throws `WasmDppError`
3. Tried passing `data` as byte array instead of base64 string - same error
4. Tried with/without `contractBounds` - same error
5. Tried adding `disabledAt: null` to match existing key format - same error

**Existing Identity Keys Format (from identity.toJSON()):**
```json
{
  "$version": "0",
  "id": 0,
  "purpose": 0,
  "securityLevel": 0,
  "contractBounds": null,
  "type": 0,
  "readOnly": false,
  "data": "A9t7xFWBYGXjviYDSZm1jhlw6vwGdz28ITuda4gZEQTa",
  "disabledAt": null
}
```

**New Key Object Attempted:**
```json
{
  "$version": 0,
  "id": 4,
  "purpose": 1,
  "securityLevel": 2,
  "type": 0,
  "readOnly": false,
  "data": "<base64-33-byte-compressed-pubkey>",
  "contractBounds": null,
  "disabledAt": null
}
```

### Root Cause Analysis
The WASM SDK's `IdentityPublicKeyInCreation.fromObject()` method is throwing an error when creating an encryption key (purpose=1). This could be:
1. WASM module initialization timing issue
2. Data format mismatch between what WASM expects and what we're providing
3. Validation error inside the WASM code that isn't being properly surfaced

### Impact
- Blocks all private feed functionality for users without encryption keys
- Users cannot enable private feeds
- E2E Test Suite 1 (Private Feed Enablement) is blocked

### Workaround
None currently. Users would need to manually add encryption keys to their identities outside of Yappr.

### Related Files
- `lib/services/identity-service.ts` - `addEncryptionKey()` method
- `components/auth/add-encryption-key-modal.tsx` - UI component
- `@dashevo/wasm-sdk` / `@dashevo/evo-sdk` - External SDK

### Screenshots
- `screenshots/e2e-add-encryption-key-error.png` - Error dialog
- `screenshots/e2e-private-feed-settings-blocked.png` - Current blocked state

### Notes
- The UI flow itself works correctly (key generation, copy to clipboard, confirmation)
- The error occurs specifically when interacting with the WASM SDK
- This may require upstream investigation with the Dash Platform SDK team
