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

---

## 2026-01-19: BUG-SDK-001 Resolution Learnings

### WASM IdentityPublicKey.data Property

**Issue**: Tried to access `key.dataHex` which doesn't exist.

**Solution**: The property is simply `key.data` and returns a hex string (not base64).

### Identity Key Selection Must Match Stored Private Key

**Critical Learning**: In dev.11, you cannot arbitrarily select an identity key for signing based on security level. You MUST:

1. **Find the key that matches your private key**: The WASM signer stores private keys by their public key hash. If you select an identity key that doesn't match the hash of the private key you added to the signer, signing will fail.

2. **Security Level Restrictions for Documents**: Document operations (create, update, delete) only allow CRITICAL (1) or HIGH (2) security level keys. MASTER (0) keys are for identity operations only.

**Pattern for Document Signing**:
```typescript
// 1. Get the stored private key
const privateKeyWif = getPrivateKey(identityId);

// 2. Derive public key and find matching identity key
const publicKey = secp256k1.getPublicKey(privateKey);
const publicKeyHash = hash160(publicKey);

// 3. Find identity key with matching public key data
const matchingKey = identityPublicKeys.find(key => {
  // Compare hash or full public key depending on key type
  return matchesPublicKey(key.data, publicKey, publicKeyHash);
});

// 4. Verify security level is allowed for documents
if (matchingKey.securityLevel < 1 || matchingKey.securityLevel > 2) {
  throw new Error('Key not allowed for document operations');
}

// 5. Create signer with the same private key
const signer = new IdentitySigner();
signer.addKeyFromWif(privateKeyWif);

// 6. Use matched key and signer together
await sdk.documents.create({ document, identityKey: matchingKey, signer });
```

### Key Types and Data Formats

- **ECDSA_SECP256K1 (type 0)**: 33-byte compressed public key, hex string (66 chars)
- **ECDSA_HASH160 (type 2)**: 20-byte hash160, hex string (40 chars)

The `findMatchingKeyIndex()` function handles both types correctly.

---

## 2026-01-19: Phase 3 Learnings - Identity Service Updates

### Identity Updates Require MASTER Key (Not Just CRITICAL)

**Critical Discovery**: In dev.11, identity update operations (`sdk.identities.update()`) require a **MASTER** (security level 0) key for signing. This is more restrictive than previously documented.

**WASM SDK Implementation** (identity.rs lines 614-643):
```rust
// Find all valid master keys (AUTHENTICATION + MASTER + supported key type)
let master_keys: Vec<_> = identity
    .public_keys()
    .iter()
    .filter(|(_, key)| {
        key.purpose() == Purpose::AUTHENTICATION
            && key.security_level() == SecurityLevel::MASTER
            && (key.key_type() == KeyType::ECDSA_HASH160
                || key.key_type() == KeyType::ECDSA_SECP256K1)
    })
    .collect();

// Check if identity has any master keys
if master_keys.is_empty() {
    return Err(WasmSdkError::invalid_argument(
        "Identity does not have any master key with supported key type",
    ));
}
```

**Implications**:
- CRITICAL keys (security level 1) are **NOT** allowed for identity modifications
- Users must provide their MASTER key to add encryption keys or modify identity
- The UI/UX should be updated to clearly request MASTER keys, not "CRITICAL or MASTER"

### Security Level Hierarchy for Operations

| Operation Type | Allowed Security Levels |
|---------------|------------------------|
| Document operations (create/update/delete) | CRITICAL (1), HIGH (2) |
| Identity operations (add/disable keys) | MASTER (0) only |
| Transfer operations | Keys with TRANSFER purpose |

### IdentityUpdateOptions API Structure

The `sdk.identities.update()` function in dev.11 expects:
```typescript
interface IdentityUpdateOptions {
  identity: Identity;           // Full WASM Identity object (NOT just identityId)
  addPublicKeys?: IdentityPublicKeyInCreation[];
  disablePublicKeys?: number[]; // Key IDs to disable
  signer: IdentitySigner;       // Must contain MASTER key
  settings?: PutSettings;
}
```

**Key differences from document operations**:
- Takes full `Identity` object, not just `identityId`
- No `identityKey` parameter - the SDK finds the appropriate MASTER key automatically
- Signer must have a private key that matches one of the identity's MASTER keys

### IdentityPublicKeyInCreation Constructor

For adding new keys to an identity, use `IdentityPublicKeyInCreation`:
```typescript
const newKey = new wasm.IdentityPublicKeyInCreation(
  newKeyId,           // id (auto-assigned if 0)
  'ENCRYPTION',       // purpose (string or number)
  'MEDIUM',           // securityLevel (string or number)
  'ECDSA_SECP256K1',  // keyType (string or number)
  false,              // readOnly
  publicKeyBytes,     // data as Uint8Array (NOT hex or base64)
  null,               // signature (null for new keys)
  null                // contractBounds (null = no binding)
);
```

**Note**: The `data` parameter must be a `Uint8Array`, not a hex or base64 string.

---

## 2026-01-19: Phase 4 Learnings - DPNS Service Updates

### Key Matching Required for All State Transitions

**Critical Pattern**: The `findMatchingSigningKey()` pattern implemented in Phase 2 must be applied consistently across ALL services that perform state transitions, not just document operations.

The DPNS service had the same vulnerability as the state-transition-service:
- Old `findSigningKey()` selected keys based on security level alone
- This could select a key the user doesn't have the private key for
- The WASM signer matches private keys to identity keys via public key hash

**Fix Applied**: Updated `dpns-service.ts` to use the same `findMatchingSigningKey()` pattern:
1. Import `findMatchingKeyIndex` from `@/lib/crypto/keys`
2. Convert WASM keys to `IdentityPublicKeyInfo[]` format
3. Match private key to identity key
4. Verify security level is allowed (CRITICAL or HIGH for DPNS)
5. Return the matched WASM key

### DPNS Registration Security Level Requirements

DPNS registration operations (`sdk.dpns.registerName()`) require:
- **Purpose**: AUTHENTICATION (0)
- **Security Level**: CRITICAL (1) or HIGH (2)

MASTER (0) keys are NOT allowed for DPNS registration - they're reserved for identity operations only.

### Consistent Error Messages Across Services

Updated error messages to be consistent:
- State Transition Service: "No suitable signing key found that matches your stored private key. Document operations require a CRITICAL or HIGH security level AUTHENTICATION key."
- DPNS Service: "No suitable signing key found that matches your private key. DPNS operations require a CRITICAL or HIGH security level AUTHENTICATION key."

### Reusable Key Matching Logic

The `findMatchingKeyIndex()` function in `lib/crypto/keys.ts` is now the canonical way to match private keys to identity keys. It:
1. Decodes WIF to get private key bytes
2. Validates network prefix
3. Derives compressed public key
4. Computes hash160 of public key
5. Matches against identity keys (handles both ECDSA_SECP256K1 and ECDSA_HASH160 types)
6. Returns key info including id, securityLevel, and purpose

This function should be used whenever matching a private key to identity keys is needed.

---

## 2026-01-19: Phase 5 Learnings - Verification & Testing

### Verification Checklist for SDK Upgrades

When completing an SDK upgrade, verify the following:

1. **Build Verification**: `npm run build` must complete without errors
2. **Lint Verification**: `npm run lint` must pass (pre-existing warnings acceptable)
3. **Runtime Testing**: Dev server must start and SDK must initialize
4. **Document Operations**: Create, update, delete operations must work
5. **Identity Operations**: Identity fetching and key validation must work

### End-to-End Testing with Playwright

For comprehensive SDK upgrade testing:
1. Navigate to the application
2. Verify SDK initialization (check console logs)
3. Test authentication flow
4. Test document creation (most common operation)
5. Verify data persists and is queryable

### Console Logging is Essential

The logging added during the upgrade proved invaluable for debugging:
- "Matched private key to identity key: id=X, securityLevel=Y, purpose=Z"
- "Built document for creation, ID: ..."
- "Document creation submitted successfully"

These logs confirm the correct code path is executing and help diagnose issues.

### SDK Upgrade Complete - Key Takeaways

1. **Breaking API Changes**: dev.11 uses typed parameters (`{ document, identityKey, signer }`) instead of flat objects
2. **Key Matching Critical**: Always match private key to identity key before signing
3. **Security Level Enforcement**: Document ops require CRITICAL/HIGH; Identity ops require MASTER
4. **WASM Objects**: Use SDK-provided WASM types (Document, IdentityPublicKey, IdentitySigner)
5. **Error Handling**: WasmSdkError may have complex message structures - use helper functions
