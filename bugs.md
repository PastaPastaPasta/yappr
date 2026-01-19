# Bug Reports

## BUG-002: sdk.identities.update() fails with WasmSdkError when adding encryption key

**Date Reported:** 2026-01-19
**Severity:** HIGH (Blocking)
**Status:** Open
**Affects:** E2E Test 1.1 - Enable Private Feed Happy Path

### Summary
After fixing BUG-001, the `IdentityPublicKeyInCreation` is now created successfully using the constructor. However, the subsequent call to `sdk.identities.update()` fails with `WasmSdkError`. This appears to be related to the security level of the signing key.

### Steps to Reproduce
1. Log in with an identity using the "High" security level key (securityLevel=2)
2. Navigate to Settings > Private Feed
3. Click "Add Encryption Key to Identity"
4. Generate and save encryption key
5. Click "Add Encryption Key"

### Expected Behavior
The encryption key should be added to the identity on Dash Platform.

### Actual Behavior
An error dialog appears showing "Unknown error" with console error: `Error adding encryption key: WasmSdkError`

### Technical Details

**Console Log:**
```
Creating IdentityPublicKeyInCreation: id=4, purpose=ENCRYPTION, securityLevel=MEDIUM, keyType=ECDSA_SECP256K1
Public key bytes length: 33
IdentityPublicKeyInCreation created successfully
Adding encryption key (id=4) to identity 9qRC7aPC3xTFwGJvMpwHfycU4SA49mx4Fc3Bh6jCT8v2...
Calling sdk.identities.update with privateKeyWif length: 52
Error adding encryption key: WasmSdkError
```

**Code Location:**
`lib/services/identity-service.ts:addEncryptionKey()` at line ~279

**Identity Keys Structure:**
```json
{
  "publicKeys": [
    { "id": 0, "purpose": 0, "securityLevel": 0 },  // MASTER
    { "id": 1, "purpose": 0, "securityLevel": 2 },  // HIGH (used for login)
    { "id": 2, "purpose": 0, "securityLevel": 1 },  // CRITICAL
    { "id": 3, "purpose": 3, "securityLevel": 1 }   // TRANSFER
  ]
}
```

### Root Cause Analysis
The user is logged in with the HIGH (securityLevel=2) authentication key, but identity updates (adding new keys) likely require CRITICAL (securityLevel=1) or MASTER (securityLevel=0) level keys according to Dash Platform protocol rules.

### Potential Fix
1. Update the login flow to require CRITICAL key for identity modifications
2. Or request the user to provide their CRITICAL key specifically for this operation
3. Or check available key security levels and use the appropriate one

### Impact
- Blocks all private feed functionality for users without encryption keys
- Users cannot enable private feeds unless they log in with CRITICAL level key
- E2E Test Suite 1 (Private Feed Enablement) is blocked

### Related Files
- `lib/services/identity-service.ts` - `addEncryptionKey()` method
- `components/auth/add-encryption-key-modal.tsx` - UI component
- `@dashevo/evo-sdk` - External SDK

### Screenshots
- `screenshots/e2e-bug001-fixed-new-bug002.png` - Current state after BUG-001 fix

### Notes
- BUG-001 has been fixed - IdentityPublicKeyInCreation is created successfully
- This is a security-level authorization issue at the SDK/platform level
- May need to investigate Dash Platform's identity update requirements
