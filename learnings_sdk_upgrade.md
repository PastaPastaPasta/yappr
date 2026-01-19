# SDK Upgrade Learnings

## Purpose
Document issues encountered and lessons learned during the SDK upgrade from dev.9 to dev.11.

---

## Key Breaking Changes (from PRD)

1. **Typed Parameters for State Transitions** (PR #2932)
   - Old: `sdk.documents.create({ contractId, type, ownerId, data, entropyHex, privateKeyWif })`
   - New: `sdk.documents.create({ document: Document, identityKey: IdentityPublicKey, signer: IdentitySigner })`

2. **Return Type Changes**
   - Old: Returns result object with document and transaction info
   - New: Returns `Promise<void>` (fire-and-forget with built-in wait)

3. **New Required Types**
   - `Document` - WASM object for document data
   - `IdentityPublicKey` - Public key for signing
   - `IdentitySigner` - Manages private keys for signing

---

<!-- Add entries below as issues are encountered -->

## 2026-01-19: Phase 1 Learnings

### Document Constructor ID Parameter

**Issue**: The WASM `Document` constructor TypeScript types specify `js_document_id: Identifier | Uint8Array | string` but the actual WASM code accepts `undefined` to auto-generate the document ID from entropy.

**Solution**: Use type assertion `undefined as unknown as string` to pass undefined.

**Example**:
```typescript
const document = new wasm.Document(
  data,
  documentTypeName,
  BigInt(1),
  contractId,
  ownerId,
  undefined as unknown as string  // TS types don't allow undefined but WASM does
);
```

### IdentitySigner Creation

**Pattern discovered**: The `IdentitySigner` class:
1. Has a no-argument constructor: `new IdentitySigner()`
2. Keys are added via `addKey(privateKey)` or `addKeyFromWif(wif)`
3. `PrivateKey` can be created from WIF: `PrivateKey.fromWif(wif, network)`
4. Keys are stored by Hash160 of the public key for lookup

### IdentityPublicKey Constructor Parameters

The `IdentityPublicKey` constructor takes 8 parameters in order:
1. `keyId` (number)
2. `purpose` (number: 0=AUTH, 1=ENCRYPT, 2=DECRYPT, 3=TRANSFER)
3. `securityLevel` (number: 0=MASTER, 1=CRITICAL, 2=HIGH, 3=MEDIUM)
4. `keyType` (number: 0=ECDSA_SECP256K1, 2=ECDSA_HASH160)
5. `readOnly` (boolean)
6. `publicKeyData` (hex string, 66 chars for SECP256K1)
7. `disabledAt` (optional)
8. `contractBounds` (optional)

### DPNS API Changes

The DPNS registration API changed significantly:
- Old: `{ label, identityId, publicKeyId, privateKeyWif, onPreorder }`
- New: `{ label, identity, identityKey, signer, settings? }`

Now requires the full `Identity` object (not just ID) and uses the standard `identityKey`/`signer` pattern.

---

## 2026-01-19: Phase 2 Learnings

### PrivateKey.fromWIF vs fromWif

**Issue**: The WASM SDK exports `PrivateKey.fromWIF` (with capital "WIF"), not `fromWif`.

**Solution**: Use `signer.addKeyFromWif(wif)` instead, which handles the conversion internally.

### IdentityPublicKey.fromJSON Method

**Discovery**: The `IdentityPublicKey` class has a `fromJSON` method that can deserialize from a JSON object. This is simpler than using the 8-parameter constructor.

**Expected format**:
```typescript
{
  id: number,
  type: number,
  purpose: number,
  securityLevel: number,
  readOnly: boolean,
  data: string,  // base64 encoded
  disabledAt?: number,
  contractBounds?: object
}
```

### WASM Memory Access Errors

**Issue encountered**: "RuntimeError: memory access out of bounds" when calling `sdk.documents.create()`.

**Observations**:
- Document builds successfully (ID generated)
- Signer initializes without error
- Error occurs at WASM function boundary
- May be related to object lifetime or memory ownership

**Possible causes**:
1. IdentityPublicKey object may need to match internal SDK expectations
2. Data format mismatches (base64 vs hex)
3. Memory ownership issues with WASM objects

**Status**: Documented as BUG-SDK-001, needs deeper investigation.

### DashPlatformClient Delegation Pattern

**Issue**: The app had two code paths for document creation:
1. `DashPlatformClient.createPost()` - using old SDK API directly
2. `postService.createPost()` - using `stateTransitionService`

**Solution**: Updated `DashPlatformClient.createPost()` to delegate to `postService.createPost()`, ensuring all document creation goes through the new typed API path.

### Error Message Extraction from WasmSdkError

**Issue**: `WasmSdkError` objects have a complex structure where `error.message` may be an object instead of a string.

**Solution**: Created `extractErrorMessage()` helper that:
1. Handles standard `Error` instances
2. Extracts `message` property if string
3. JSON.stringify if message is object
4. Falls back to `toString()` or full JSON stringify
