# E2E Testing Activity Log

## 2026-01-19: BUG-001 Fix - IdentityPublicKeyInCreation Constructor

### Task
Fix BUG-001: IdentityPublicKeyInCreation.fromObject() throws WasmDppError

### Status
**FIXED** - BUG-001 resolved; new BUG-002 discovered

### What Was Fixed
The original BUG-001 was caused by using `IdentityPublicKeyInCreation.fromObject()` which has undocumented format requirements. The fix was to use the constructor directly instead.

### Root Cause
The WASM SDK's `fromObject()` method has specific, undocumented format requirements that weren't being met. The constructor, however, has clear parameter types and works correctly.

### Solution Applied
Changed from:
```javascript
const newKey = wasm.IdentityPublicKeyInCreation.fromObject({
  $version: 0,
  id: newKeyId,
  purpose: 1,
  securityLevel: 2,
  type: 0,
  readOnly: false,
  data: publicKeyBase64,  // base64 string
  contractBounds: null,
  disabledAt: null,
});
```

To:
```javascript
const newKey = new wasm.IdentityPublicKeyInCreation(
  newKeyId,           // id
  'ENCRYPTION',       // purpose (string format)
  'MEDIUM',           // securityLevel (string format)
  'ECDSA_SECP256K1',  // keyType (string format)
  false,              // readOnly
  publicKeyBytes,     // data as Uint8Array (NOT base64)
  null,               // signature
  null                // contractBounds
);
```

### Key Learnings
1. The constructor takes `data` as `Uint8Array`, not base64 string
2. Purpose, securityLevel, and keyType can be passed as string enums ('ENCRYPTION', 'MEDIUM', 'ECDSA_SECP256K1')
3. The `fromObject()` method appears to have stricter/different validation than the constructor

### Verification
Console logs now show:
```
Creating IdentityPublicKeyInCreation: id=4, purpose=ENCRYPTION, securityLevel=MEDIUM, keyType=ECDSA_SECP256K1
Public key bytes length: 33
IdentityPublicKeyInCreation created successfully  ← BUG-001 FIXED
```

### New Bug Discovered (BUG-002)
After BUG-001 fix, a new error occurs in `sdk.identities.update()`:
- Error: `WasmSdkError`
- Likely cause: Identity updates require CRITICAL security level key, but user is logged in with HIGH security level key
- See `bugs.md` for detailed BUG-002 report

### Screenshots
- `screenshots/e2e-bug001-fix-verification.png` - Settings page after fix
- `screenshots/e2e-bug001-fixed-new-bug002.png` - Current state showing BUG-002

### Files Modified
- `lib/services/identity-service.ts` - Changed to use constructor instead of fromObject()

### Re-test Required
- [ ] E2E Test 1.1: Enable Private Feed - Happy Path (blocked by BUG-002)

---

## 2026-01-19: E2E Test 1.1 - Enable Private Feed (BLOCKED)

### Task
Test E2E 1.1: Enable Private Feed - Happy Path (PRD §4.1)

### Status
**BLOCKED** - Bug BUG-002 prevents completion (BUG-001 was fixed)

### What Was Tested
1. Navigated to Settings > Private Feed
2. Verified "Encryption key required" warning displays for identity without encryption key
3. Clicked "Add Encryption Key to Identity"
4. Verified key generation modal flow:
   - Initial warning about key importance
   - Key generation
   - Copy to clipboard functionality
   - Confirmation checkbox
   - Continue to confirmation step
5. Attempted to add encryption key to identity

### Bug Found
~~BUG-001: WasmDppError at IdentityPublicKeyInCreation.fromObject()~~ **FIXED**
BUG-002: WasmSdkError at sdk.identities.update() - likely security level issue

See `bugs.md` for detailed bug reports.

### Changes Made
1. Fixed WASM SDK import in `lib/services/identity-service.ts`:
   - Changed from direct `@dashevo/wasm-sdk` import to dynamic import from `@dashevo/wasm-sdk/compressed`
   - Added proper WASM initialization with `initWasm()`
   - This fixed the original error: `Cannot read properties of undefined (reading 'identitypublickeyincreation_fromObject')`

2. Fixed BUG-001 by using constructor instead of fromObject():
   - Use `new wasm.IdentityPublicKeyInCreation(...)` instead of `fromObject()`
   - Pass data as Uint8Array, not base64 string
   - Use string enum values for purpose, securityLevel, keyType

3. Added debug logging to track the issue:
   - Logs key object being created
   - Logs success/failure of each step
   - Better error details in catch block

### Screenshots
- `screenshots/e2e-private-feed-settings-initial.png` - Initial private feed settings page
- `screenshots/e2e-add-encryption-key-modal.png` - Key generation modal
- `screenshots/e2e-encryption-key-generated.png` - Generated key display
- `screenshots/e2e-confirm-key-addition.png` - Confirmation step
- `screenshots/e2e-add-encryption-key-error.png` - Error dialog
- `screenshots/e2e-private-feed-settings-blocked.png` - Current blocked state
- `screenshots/e2e-bug001-fix-verification.png` - BUG-001 fix verification
- `screenshots/e2e-bug001-fixed-new-bug002.png` - Current state with BUG-002

### Next Steps
1. BUG-002 needs to be fixed before this test can be completed
2. Once fixed, re-run E2E Test 1.1 to verify:
   - Private feed enables successfully
   - Dashboard shows correct initial stats (0 followers, 0 pending, 0 posts)
   - PrivateFeedState document exists on-chain

### Re-test Required
- [ ] E2E Test 1.1: Enable Private Feed - Happy Path
