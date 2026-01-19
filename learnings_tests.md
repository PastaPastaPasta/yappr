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

### Issue 2: IdentityPublicKeyInCreation.fromObject() Format
**Problem:** Even with proper WASM initialization, `IdentityPublicKeyInCreation.fromObject()` throws `WasmDppError`.

**What Was Tried:**
1. Passing `data` as byte array: `[3, 229, 27, ...]` - Failed
2. Passing `data` as base64 string: `"A+UbPMgXMbc3MAhqN..."` - Failed
3. With `contractBounds` object - Failed
4. Without `contractBounds` (null) - Failed
5. Added `disabledAt: null` to match existing keys - Failed

**Current Status:** UNRESOLVED - Documented as BUG-001

**Lesson:** WASM SDK error messages are often not descriptive. Need to check SDK source code or reach out to SDK maintainers for correct object formats.

### Issue 3: Testing Identity Setup
**Observation:** The test identities (testing-identity-1.json, testing-identity-2.json) don't have encryption keys on their identities, which is required for private feed testing.

**Impact:** Cannot test E2E flows for private feed without first adding encryption keys.

**Workaround Needed:** May need to:
1. Fix BUG-001 to add keys programmatically
2. Or manually add encryption keys to test identities via another method
3. Or create fresh test identities with encryption keys pre-configured

### Best Practices Identified

1. **Always restart dev server after code changes** - The dev server often enters a corrupted state after changes to service files.

2. **Use browser console logs extensively** - Add detailed logging before/after SDK calls to pinpoint exactly where failures occur.

3. **Compare with working examples** - Look at how existing keys are formatted in `identity.toJSON()` to understand expected formats.

4. **Document SDK integration patterns** - The Dash Platform SDK has specific patterns that aren't always obvious from TypeScript types alone.
