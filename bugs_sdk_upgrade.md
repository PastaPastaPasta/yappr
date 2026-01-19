# SDK Upgrade Bug Reports

## Purpose
Track bugs discovered during the SDK upgrade from dev.9 to dev.11.

---

## BUG-SDK-001: WASM Memory Access Out of Bounds During Document Creation

**Status**: OPEN
**Severity**: CRITICAL
**Phase**: Phase 2 (State Transition Service)

### Description
When calling `sdk.documents.create()` with the new typed API, a WASM runtime error occurs:
```
RuntimeError: memory access out of bounds
    at wasm://wasm/03a2373e:wasm-function[14753]:0xa5efc6
```

### Steps to Reproduce
1. Build a Document using `new wasm.Document(data, typeName, revision, contractId, ownerId, undefined)`
2. Create an IdentitySigner using `signer.addKeyFromWif(privateKeyWif)`
3. Create an IdentityPublicKey using `wasm.IdentityPublicKey.fromJSON(keyData)`
4. Call `sdk.documents.create({ document, identityKey, signer })`

### Observations
- Document builds successfully (ID is generated)
- Signer initialization succeeds
- Error occurs during `sdk.documents.create()` call
- The error is at the WASM level, not JavaScript

### Suspected Cause
The `IdentityPublicKey.fromJSON()` method may not be producing a correctly structured object that the `documents.create()` method expects. Alternatively, there may be an issue with how the signer's private key hash is being matched to the identity public key.

### Workaround
None currently. The old API still works but requires updating to use the new typed APIs per PRD.

### Investigation Needed
1. Check if `IdentityPublicKey` constructor vs `fromJSON` produces different internal structures
2. Verify the identity public key data format (should be base64 encoded)
3. Check if the signer's key hash matches the identity public key hash
4. Consider using the SDK's internal identity fetching rather than manual key construction

### Files Affected
- `lib/services/state-transition-service.ts`
- `lib/services/signer-service.ts`
- `lib/services/document-builder-service.ts`

---

<!-- Add bug reports below as they are discovered -->
