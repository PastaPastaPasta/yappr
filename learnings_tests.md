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

### Issue 4: Identity Update Security Level Requirements (BUG-002 - OPEN)
**Problem:** After fixing BUG-001, `sdk.identities.update()` fails with `WasmSdkError` when trying to add an encryption key.

**Context:**
- User is logged in with HIGH security level key (securityLevel=2)
- Identity has keys: MASTER (0), CRITICAL (1), HIGH (2), TRANSFER (3)
- Error occurs during `sdk.identities.update()` call

**Suspected Cause:** Dash Platform likely requires a higher security level key (CRITICAL or MASTER) to perform identity modifications like adding new public keys.

**Status:** OPEN - Needs investigation into:
1. Dash Platform security level requirements for identity updates
2. Whether the SDK provides better error messages for this case
3. Possible solutions (request CRITICAL key for this operation, or change login requirements)

**Lesson:** Dash Platform operations have security level requirements. Identity modifications likely require higher privilege keys than routine operations.

### Best Practices Identified

1. **Always restart dev server after code changes** - The dev server often enters a corrupted state after changes to service files.

2. **Use browser console logs extensively** - Add detailed logging before/after SDK calls to pinpoint exactly where failures occur.

3. **Compare with working examples** - Look at how existing keys are formatted in `identity.toJSON()` to understand expected formats.

4. **Document SDK integration patterns** - The Dash Platform SDK has specific patterns that aren't always obvious from TypeScript types alone.

5. **Try constructors when fromObject/fromJSON fail** - The WASM SDK's `fromObject()` and `fromJSON()` methods often have undocumented validation. Constructors are more predictable.

6. **Check security level requirements** - Different Dash Platform operations require different security level keys. Identity updates may need CRITICAL or MASTER keys.
