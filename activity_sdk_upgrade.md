# SDK Upgrade Activity Log

## Purpose
Track progress on upgrading @dashevo/evo-sdk from dev.9 to dev.11.

---

<!-- Add entries below as work progresses -->

## 2026-01-19: Phase 1 Complete - Core Infrastructure

### Changes Made

1. **Updated package.json**: Changed `@dashevo/evo-sdk` from `^3.0.0-dev.9` to `^3.0.0-dev.11`

2. **Created `lib/services/signer-service.ts`**: New service for managing IdentitySigner objects
   - `createSigner(privateKeyWif, network)`: Creates IdentitySigner from WIF
   - `createSignerFromHex(privateKeyHex, network)`: Creates IdentitySigner from hex
   - `createIdentityPublicKey(keyData)`: Creates WASM IdentityPublicKey object
   - `getSigningKeyData(publicKeys, securityLevel, keyId)`: Finds appropriate signing key
   - `createSignerAndKey(privateKeyWif, keyData, network)`: Convenience method for both
   - Exports `KeyPurpose`, `SecurityLevel`, `KeyType` constants

3. **Created `lib/services/document-builder-service.ts`**: New service for building WASM Document objects
   - `buildDocumentForCreate(...)`: Builds Document for creation (auto-generates ID)
   - `buildDocumentForReplace(...)`: Builds Document for updates (requires revision)
   - `buildDocumentForDelete(...)`: Builds identifier object for deletion
   - `normalizeDocumentResponse(document)`: Normalizes SDK responses
   - `getDocumentId(document)`: Extracts document ID from WASM object

4. **Updated `lib/services/index.ts`**: Exported new services

### Build Status

- **New services compile successfully** - no lint errors
- **Build fails** due to old API usage in:
  - `state-transition-service.ts` (Phase 2)
  - `dpns-service.ts` (Phase 4)
  - `identity-service.ts` (Phase 3)

This is expected - the old API (`privateKeyWif`, `entropyHex`, etc.) no longer exists in dev.11.

### Testing

Cannot run dev server until Phases 2-4 update the consuming code. Infrastructure services are ready for use.

### Next Steps

Phase 2: Refactor `state-transition-service.ts` to use new typed APIs with:
- `signerService` for creating signers
- `documentBuilderService` for building documents

---

## 2026-01-19: Phase 2 In Progress - State Transition Service Refactored

### Changes Made

1. **Refactored `lib/services/state-transition-service.ts`**:
   - `createDocument()`: Now uses `documentBuilderService.buildDocumentForCreate()`, `signerService.createSignerAndKey()`, and `sdk.documents.create({ document, identityKey, signer })`
   - `updateDocument()`: Now uses `documentBuilderService.buildDocumentForReplace()` and `sdk.documents.replace({ document, identityKey, signer })`
   - `deleteDocument()`: Now uses `documentBuilderService.buildDocumentForDelete()` and `sdk.documents.delete({ document, identityKey, signer })`
   - Added `extractErrorMessage()` helper for better WasmSdkError handling
   - All methods now fetch identity, find signing key, create signer/key, build document, then call SDK

2. **Updated `lib/services/signer-service.ts`**:
   - Changed `createSigner()` to use `signer.addKeyFromWif(privateKeyWif)` directly
   - Changed `createIdentityPublicKey()` to use `wasm.IdentityPublicKey.fromJSON(normalizedKeyData)`

3. **Updated `lib/services/identity-service.ts`**:
   - Added missing fields to `IdentityPublicKey` interface: `readOnly`, `read_only`, `disabled_at`, `contractBounds`, `contract_bounds`

4. **Updated `lib/dash-platform-client.ts`**:
   - Changed `createPost()` to delegate to `postService.createPost()` instead of using old SDK API directly

### Build Status

- **Lint passes** with only pre-existing warnings (no new errors)
- **Build fails** only on `dpns-service.ts` (Phase 4) - expected

### Testing

- Dev server starts successfully
- Document creation flow reaches the SDK call
- **BUG-SDK-001 discovered**: WASM "memory access out of bounds" error during `sdk.documents.create()`

### Screenshot

`screenshots/sdk-upgrade-phase2-wasm-error.png` - Shows compose modal with error indicator

### Bug Filed

See `bugs_sdk_upgrade.md` for BUG-SDK-001 details. Investigation needed into IdentityPublicKey construction.

### Next Steps

1. **Fix BUG-SDK-001** before proceeding (blocking)
2. Phase 3: Identity Service updates
3. Phase 4: DPNS Service updates
