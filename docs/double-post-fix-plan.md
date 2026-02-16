# Double-Post Fix: Implementation Plan

## Problem Statement

When a user creates a post on yappr and the DAPI `waitForStateTransitionResult` times out (504), the post may have already succeeded on Platform. If the user retries, `sdk.documents.create()` bumps the identity contract nonce and creates a **new** state transition with a different nonce → **duplicate post**.

## 1. Root Cause Analysis

### The Create Flow Today

1. **User clicks Post** → `compose-modal.tsx` `handlePost()` calls `retryPostCreation()` from `retry-utils.ts`
2. **`retryPostCreation`** wraps the call in `retryAsync()` with up to 3 attempts, 2s initial delay, exponential backoff
3. **Inside the retry callback**, either `postService.createPost()` or `replyService.createReply()` is called
4. **`createPost`/`createReply`** → `BaseDocumentService.create()` → `stateTransitionService.createDocument()`
5. **`stateTransitionService.createDocument()`** (`state-transition-service.ts:109-155`):
   - Fetches identity, validates signing key
   - Calls `documentBuilderService.buildDocumentForCreate()` to build a WASM `Document`
   - Creates signer via `signerService.createSignerFromWasmKey()`
   - Calls `sdk.documents.create({ document, identityKey, signer })`
6. **`sdk.documents.create()`** → `DocumentsFacade.create()` → `WasmSdk.documentCreate()` (Rust WASM)
7. **Inside `documentCreate`** (`wasm-sdk/src/state_transitions/document.rs`):
   - Calls `document.put_to_platform_and_wait_for_response()` which:
     - **`put_to_platform()`**: Fetches & bumps nonce via `get_identity_contract_nonce(bump=true)`, builds `BatchTransition`, signs it, calls `transition.broadcast()`
     - **`wait_for_response()`**: Calls `waitForStateTransitionResult` and verifies proof

### Where the Bug Lives

The nonce bump happens **inside** `put_to_platform()` at the Rust SDK level (`rs-sdk/src/platform/transition/put_document.rs:51-53`):

```rust
let new_identity_contract_nonce = sdk
    .get_identity_contract_nonce(self.owner_id(), document_type.data_contract_id(), true, settings)
    .await?;
```

When the `wait_for_response()` times out but the broadcast actually succeeded:
- The nonce was already consumed on Platform
- On retry, `retryPostCreation` calls the entire `createPost` → `sdk.documents.create()` chain again
- This bumps the nonce **again** (N+1 → N+2), creates a new ST with new entropy, new document ID → **duplicate post**

### Key Insight

The WASM SDK's `documentCreate` is an atomic "build + sign + broadcast + wait" operation. There is no way to:
- Create the ST without broadcasting
- Get the serialized bytes of the ST before broadcast
- Rebroadcast the same bytes

This means **we cannot fix this at the SDK API level**. The fix must happen at yappr's application layer.

## 2. Proposed Architecture

### Strategy: Cache the Document ID, Verify Before Retry

Since we can't split create/broadcast in the WASM SDK, the strategy is:

1. **Before creating**: Generate and record the document ID deterministically (or immediately after creation)
2. **On timeout**: Cache the pending operation details
3. **Before retrying**: Check Platform to see if the document already exists
4. **If it exists**: Skip creation, return success
5. **If it doesn't exist**: Retry the creation (safe — nonce was unused)

### Document ID Predictability

Looking at the SDK code (`put_document.rs:67-77`), when entropy is provided, the document ID is deterministic:
```rust
Document::generate_document_id_v0(
    &document_type.data_contract_id(),
    &document.owner_id(),
    document_type.name(),
    entropy.as_slice(),
)
```

In yappr's `documentBuilderService.buildDocumentForCreate()`, the `Document` constructor generates entropy internally. The document ID is available via `documentBuilderService.getDocumentId(document)` **before** the SDK call — it's set in the constructor.

This is critical: **we know the document ID before calling `sdk.documents.create()`**.

### Architecture Overview

```
┌─────────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│  compose-modal   │────▶│ state-transition-svc  │────▶│  pendingPostStore │
│  handlePost()    │     │ createDocument()      │     │  (IndexedDB)      │
└─────────────────┘     └──────────────────────┘     └───────────────────┘
                              │                              │
                              ▼                              │
                        ┌─────────────┐                      │
                        │ SDK create  │                      │
                        │ (timeout?)  │                      │
                        └─────────────┘                      │
                              │                              │
                         On timeout:                         │
                              │                              ▼
                        ┌─────────────┐     ┌───────────────────────┐
                        │ Retry logic │────▶│ Check if doc exists   │
                        │             │     │ on Platform by ID     │
                        └─────────────┘     └───────────────────────┘
                                                     │
                                           ┌─────────┴──────────┐
                                           │                    │
                                      Doc exists           Doc missing
                                           │                    │
                                    Return success        Retry create
                                    (clear pending)       (new nonce OK)
```

## 3. Specific Files to Modify

### 3.1 NEW: `lib/services/pending-post-store.ts`

A simple IndexedDB-backed store for tracking pending state transitions.

**Schema:**
```typescript
interface PendingPost {
  /** The predicted document ID (from Document constructor before broadcast) */
  documentId: string;
  /** The identity contract nonce used for this attempt */
  // Not available from WASM API — omitted
  /** Owner identity ID */
  ownerId: string;
  /** Contract ID */
  contractId: string;
  /** Document type ('post' or 'reply') */
  documentType: string;
  /** The document data that was submitted */
  documentData: Record<string, unknown>;
  /** Timestamp when the operation was initiated */
  createdAt: number;
  /** Current status */
  status: 'pending' | 'confirmed' | 'failed';
  /** Number of retry attempts */
  retryCount: number;
  /** Error message if failed */
  error?: string;
}
```

**Methods:**
- `savePending(post: PendingPost): Promise<void>` — save before broadcast
- `getPending(documentId: string): Promise<PendingPost | null>`
- `getAllPending(ownerId: string): Promise<PendingPost[]>` — for recovery on page load
- `markConfirmed(documentId: string): Promise<void>`
- `markFailed(documentId: string, error: string): Promise<void>`
- `removePending(documentId: string): Promise<void>`
- `cleanupOld(maxAgeMs: number): Promise<void>` — remove entries older than 24h

**Why IndexedDB over localStorage:**
- Structured data with indexes (query by ownerId, status, timestamp)
- No 5MB limit concerns
- Async API won't block the UI thread
- Can store larger payloads if needed (encrypted content bytes)

### 3.2 MODIFY: `lib/services/state-transition-service.ts`

**Changes to `createDocument()`:**

```typescript
async createDocument(
  contractId: string,
  documentType: string,
  ownerId: string,
  documentData: Record<string, unknown>
): Promise<StateTransitionResult> {
  try {
    const sdk = await getEvoSdk();
    const privateKey = await this.getPrivateKey(ownerId);

    // ... existing key validation code ...

    // Build the document (gets us the predicted document ID)
    const document = await documentBuilderService.buildDocumentForCreate(
      contractId, documentType, ownerId, documentData
    );
    const documentId = documentBuilderService.getDocumentId(document);

    // NEW: Check if this document already exists on Platform (idempotency check)
    const existingDoc = await this.checkDocumentExists(sdk, contractId, documentType, documentId);
    if (existingDoc) {
      console.log(`Document ${documentId} already exists on Platform — skipping creation`);
      return {
        success: true,
        transactionHash: documentId,
        document: existingDoc,
      };
    }

    // NEW: Check pending store for a previous attempt with same content
    const pendingStore = await getPendingPostStore();
    const existingPending = await pendingStore.findByContent(ownerId, contractId, documentType, documentData);
    if (existingPending && existingPending.status === 'pending') {
      // A previous attempt with the same content is pending — check Platform for it
      const prevDoc = await this.checkDocumentExists(sdk, contractId, documentType, existingPending.documentId);
      if (prevDoc) {
        console.log(`Previous pending attempt ${existingPending.documentId} confirmed on Platform`);
        await pendingStore.markConfirmed(existingPending.documentId);
        return {
          success: true,
          transactionHash: existingPending.documentId,
          document: prevDoc,
        };
      }
      // Previous attempt's doc not found — it genuinely failed, proceed with new creation
      await pendingStore.markFailed(existingPending.documentId, 'Not found on Platform after timeout');
    }

    // Save as pending BEFORE broadcast
    await pendingStore.savePending({
      documentId,
      ownerId,
      contractId,
      documentType,
      documentData,
      createdAt: Date.now(),
      status: 'pending',
      retryCount: 0,
    });

    // Create signer and perform the broadcast
    const { signer, identityKey: signingKey } = await signerService.createSignerFromWasmKey(
      privateKey, identityKey
    );

    try {
      await sdk.documents.create({ document, identityKey: signingKey, signer });

      // Success — mark confirmed
      await pendingStore.markConfirmed(documentId);
    } catch (createError) {
      // Check if this is a timeout error
      if (isTimeoutLikeError(createError)) {
        // Timeout — don't mark as failed yet, the post may have succeeded
        console.warn(`Document creation timed out for ${documentId} — post may have succeeded`);

        // Try to verify if it landed on Platform
        const verifyDoc = await this.checkDocumentExists(sdk, contractId, documentType, documentId);
        if (verifyDoc) {
          await pendingStore.markConfirmed(documentId);
          return {
            success: true,
            transactionHash: documentId,
            document: verifyDoc,
          };
        }

        // Can't verify — leave as pending, bubble up as timeout
        throw createError;
      }

      // Non-timeout error — check for "already exists" / nonce errors
      if (isAlreadyExistsError(createError)) {
        const verifyDoc = await this.checkDocumentExists(sdk, contractId, documentType, documentId);
        if (verifyDoc) {
          await pendingStore.markConfirmed(documentId);
          return {
            success: true,
            transactionHash: documentId,
            document: verifyDoc,
          };
        }
      }

      // Genuine failure
      await pendingStore.markFailed(documentId, extractErrorMessage(createError));
      throw createError;
    }

    return {
      success: true,
      transactionHash: documentId,
      document: { $id: documentId, $ownerId: ownerId, $type: documentType, ...documentData },
    };
  } catch (error) {
    console.error('Error creating document:', error);
    return { success: false, error: extractErrorMessage(error) };
  }
}

/**
 * Check if a document already exists on Platform
 */
private async checkDocumentExists(
  sdk: EvoSDK,
  contractId: string,
  documentType: string,
  documentId: string
): Promise<Record<string, unknown> | null> {
  try {
    const doc = await sdk.documents.get(contractId, documentType, documentId);
    if (doc) {
      const json = doc.toJSON();
      return json;
    }
    return null;
  } catch {
    // Document not found or network error — treat as not existing
    return null;
  }
}
```

### 3.3 MODIFY: `lib/retry-utils.ts`

**Changes to `retryPostCreation()`:**

The current retry utility blindly retries the entire creation flow. We need to make it aware that the inner function now handles idempotency:

```typescript
export async function retryPostCreation<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<RetryResult<T>> {
  return retryAsync(operation, {
    maxAttempts: 3,
    initialDelayMs: 2000,
    maxDelayMs: 8000,
    backoffMultiplier: 2,
    retryCondition: (error) => {
      // Use default retry condition plus Dash Platform specific errors
      if (defaultRetryCondition(error)) return true

      const errorMessage = error instanceof Error ? error.message.toLowerCase() : ''

      // Dash Platform specific retryable errors
      const dashErrors = [
        'internal error',
        'temporarily unavailable',
        'service unavailable',
        'consensus error',
        'quorum not available'
      ]

      // NEW: Also retry on timeout errors — the idempotency check in
      // state-transition-service will prevent double-posting
      if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
        return true
      }

      return dashErrors.some(dashError => errorMessage.includes(dashError))
    },
    ...options
  })
}
```

No other changes needed here — the idempotency logic is in `state-transition-service.ts`.

### 3.4 MODIFY: `compose-modal.tsx`

**Minimal changes needed.** The timeout handling in `handlePost()` already has branching for `isTimeoutError(result.error)` (line ~430). Since `state-transition-service.ts` now handles verification internally, timeout retries through `retryPostCreation` will automatically check Platform before re-creating.

**Changes:**
1. After a timeout, instead of keeping the post for manual retry, attempt automatic verification:

```typescript
// In handlePost(), after retryPostCreation returns:
if (!result.success && isTimeoutError(result.error)) {
  // The state-transition-service already tried to verify on Platform.
  // If we get here, it couldn't confirm. Give user the option to check manually.
  console.warn(`Post ${i + 1} timed out — may have succeeded.`);
  timeoutPosts.push({ index: i, threadPostId });
  continue;
}
```

2. **Add a "Check Status" button** for timed-out posts that calls `checkDocumentExists` to verify.

3. **On modal re-open for retry**: Check all pending posts from `pendingPostStore` and verify their status against Platform before allowing retry.

### 3.5 NEW: `lib/hooks/use-pending-posts.ts` (optional enhancement)

A React hook that:
- On mount, loads pending posts from IndexedDB for the current user
- Periodically checks Platform for their status
- Updates the pending store when confirmed/failed
- Provides state for UI indicators

### 3.6 MODIFY: `lib/services/document-service.ts` (minor)

In `BaseDocumentService.create()`, the error from `stateTransitionService.createDocument()` now has better semantics. No structural changes needed, but update the error message:

```typescript
if (!result.success || !result.document) {
  throw new Error(result.error || 'Failed to create document');
}
```

This already works correctly since `stateTransitionService.createDocument()` returns `success: true` when the doc is found on Platform.

## 4. Edge Cases

### 4.1 Thread Posts (Post 2 depends on Post 1's ID)

**Scenario:** User posts a thread. Post 1 succeeds but times out. Post 2 uses Post 1's ID as `parentId`. If Post 1's timeout triggers a retry, we get duplicate Post 1, and Post 2 references the original Post 1's ID (which is correct).

**Solution:** The new flow handles this correctly because:
- Post 1 times out → `state-transition-service` checks Platform → finds Post 1 → returns its ID
- Post 2 uses that ID as parentId → no problem
- If Post 1 genuinely failed, the check returns null → retry creates Post 1 with a **new** document ID (new entropy) → Post 2 uses this new ID

**The document ID changes on retry** because `buildDocumentForCreate` generates new entropy each time. This is actually fine for threads since `compose-modal.tsx` uses the returned `postId` to chain: `previousPostId = postId`.

### 4.2 Encrypted Posts (Private Feed)

**Scenario:** Private posts go through encryption before creation. The `encryptedContent`, `epoch`, and `nonce` fields are generated in `prepareOwnerEncryption()` or `prepareInheritedEncryption()`.

**Solution:** The content is encrypted before reaching `stateTransitionService.createDocument()`. The `documentData` passed to the pending store already contains the encrypted fields. On retry:
- If the document exists on Platform → return it (encrypted content already there)
- If it doesn't exist → the retry will call `createPost` again, which re-encrypts

**Important:** Re-encryption produces different ciphertext (different AES nonce), but the same plaintext. The new document gets a new ID anyway (new entropy), so there's no collision.

### 4.3 Page Refresh Mid-Post

**Scenario:** User starts a post, broadcast happens, then they refresh the page before the response comes back.

**Solution:** The pending post is saved to IndexedDB **before** the SDK call. On next page load:
1. `use-pending-posts` hook loads pending items from IndexedDB
2. For each pending item, checks Platform for the document ID
3. If found → mark confirmed, clean up
4. If not found and age > reasonable threshold (e.g., 2 minutes) → mark failed, clean up

**User notification:** Show a toast or banner: "Your previous post was confirmed on the network" or "Your previous post may not have been published."

### 4.4 Nonce Desync

**Scenario:** After a timeout, the nonce was consumed on Platform but the WASM SDK's internal nonce cache still thinks it was used. On the next (different) operation, the SDK bumps to N+2 but Platform expects N+1 (because the timed-out ST actually consumed N+1, and the SDK correctly tracked that). Wait — actually:

The WASM SDK bumps the nonce in `get_identity_contract_nonce(bump=true)` which calls the Platform to get the current nonce and increments it. The nonce is fetched fresh (with a 20-minute cache in the JS SDK's NonceManager, but the WASM SDK fetches from Platform directly). So:

- Timeout on nonce N: Platform has N committed (or in mempool)
- Next call: SDK fetches current nonce from Platform → gets N → bumps to N+1 → this is correct

**However**, there's a race condition: if the timed-out ST is still in the mempool (not yet committed to a block), fetching the nonce from Platform returns N-1 (the on-chain nonce), and the SDK bumps to N. This creates a nonce collision with the in-flight ST.

**Mitigation:** The DAPI broadcast handler (`broadcast_state_transition.rs`) detects duplicates:
- If same bytes → "already in mempool" error → we can treat this as success
- If different bytes, same nonce → `InvalidIdentityNonceError` with `NonceAlreadyPresentAtTip`

We should handle `NonceAlreadyPresentAtTip` as "another operation with this nonce is in flight — back off and retry with a fresh nonce fetch".

### 4.5 Multiple Tabs

**Scenario:** User has yappr open in two tabs. Both try to post at the same time.

**Solution:** IndexedDB is shared across tabs, so both tabs see the same pending store. The `findByContent` check prevents exact duplicate content from being posted, but different posts from different tabs are fine — they'll get different nonces.

### 4.6 Document ID Prediction Accuracy

**Important caveat:** When `Document` is constructed with `undefined` as ID, the WASM constructor generates entropy and computes the ID. But the **SDK's `put_to_platform`** may also generate its own entropy if none is provided (see `put_document.rs:63-77`). Let's verify:

Looking at `document_create` in `wasm-sdk/src/state_transitions/document.rs:67-75`:
```rust
let entropy = document_wasm.entropy().ok_or_else(|| {
    WasmSdkError::invalid_argument("Document must have entropy set for creation")
})?;
```

The SDK **requires** entropy to be set on the Document. And since the Document constructor generates it, the entropy is passed through to `put_to_platform` as `Some(entropy_array)`. The `put_document.rs` code then uses this provided entropy (the `map` branch on line 66), not the random-generation fallback.

**Therefore: the document ID generated in the constructor IS the final document ID.** Our prediction is accurate.

## 5. Error Handling

### Errors That Mean "Already Succeeded"

| Error Pattern | Meaning | Action |
|---|---|---|
| `"state transition already in mempool"` | ST was broadcast, waiting for block | Treat as success, poll for confirmation |
| `"state transition already in chain"` | ST is committed | Definite success |
| `NonceAlreadyPresentAtTip` | Same nonce in current block | Check if our document exists on Platform |
| `NonceAlreadyPresentInPast` | Nonce was used in a previous block | Check if our document exists on Platform |
| Timeout after successful broadcast | ST probably landed | Check if document exists on Platform |

### Errors That Mean "Genuinely Failed"

| Error Pattern | Meaning | Action |
|---|---|---|
| `"insufficient balance"` / `"not enough credits"` | Identity can't pay fees | Don't retry, show error |
| `"document already exists"` (from validation) | Document with same unique properties exists | Check if it's ours |
| `NonceTooFarInFuture` | Nonce is way ahead of Platform state | Reset nonce cache, retry |
| `NonceTooFarInPast` | Nonce is stale (> 24 positions behind) | Reset nonce cache, retry |
| `"Invalid signing key"` / key errors | Auth issue | Don't retry, show error |
| `"no available addresses"` | Network issue | Retry with backoff |
| Network/connection errors | Transient | Retry with backoff |

### New Helper: `isAlreadyExistsError(error)`

Add to `lib/error-utils.ts`:

```typescript
export function isAlreadyExistsError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase();
  return (
    msg.includes('already in mempool') ||
    msg.includes('already in chain') ||
    msg.includes('nonce already present') ||
    msg.includes('already exists')
  );
}

export function isNonceError(error: unknown): boolean {
  const msg = extractErrorMessage(error).toLowerCase();
  return (
    msg.includes('nonce already present') ||
    msg.includes('nonce too far') ||
    msg.includes('invalid identity nonce') ||
    msg.includes('invalididentitynonceerror')
  );
}
```

## 6. Storage Strategy

### IndexedDB via `idb` library

Use the lightweight `idb` package (already common in Next.js apps, or use raw IndexedDB).

**Database:** `yappr-pending-posts`
**Object Store:** `pending` with keyPath `documentId`
**Indexes:**
- `ownerId` — for querying all pending posts for a user
- `status` — for querying pending/confirmed/failed
- `createdAt` — for cleanup

### Cleanup Policy

- **On success:** Remove entry immediately after confirmation
- **On failure:** Keep for 1 hour (allows user to see what failed), then auto-clean
- **On pending timeout:** Keep for 24 hours, then auto-clean
- **Periodic cleanup:** Run on app load and every hour during use
- **Max entries:** 100 per user (prevent unbounded growth)

### Why Not localStorage?

- localStorage is synchronous and blocks the main thread
- 5MB limit is shared with all yappr data
- No indexing — would need to parse entire JSON blob for lookups
- Can't handle concurrent access cleanly across tabs

## 7. Migration Notes

### Interaction with Existing Retry Logic

**Current flow:**
1. `compose-modal.tsx` → `retryPostCreation()` → calls operation up to 3x
2. On timeout, `handlePost()` keeps timed-out posts in the thread for manual retry
3. User presses "Post" again → entire flow runs again (double-post risk)

**New flow:**
1. `retryPostCreation()` still retries up to 3x
2. Each attempt goes through `stateTransitionService.createDocument()` which now:
   - Checks for existing document on Platform (idempotency)
   - Checks pending store for previous attempts with same content
   - Saves to pending store before broadcast
   - Verifies on Platform after timeout
3. On timeout reaching `handlePost()`, the system has already tried to verify
4. User pressing "Post" again → `createDocument` checks pending store + Platform → avoids duplicate

### What Changes for Users

- Timeout behavior is mostly invisible — the system auto-verifies
- If verification succeeds after timeout, they see "Post created successfully!" instead of the current "timed out" warning
- If verification fails (can't reach Platform), they still see the timeout warning but retrying is safe
- On page refresh, pending posts are checked and resolved automatically

### Backward Compatibility

- No changes to the data contract
- No changes to the document structure
- Pending store is additive — old versions of the app just don't have it
- No migration needed for existing data

## 8. Testing Plan

### 8.1 Unit Tests

**`pending-post-store.test.ts`:**
- Save/retrieve/delete pending posts
- `findByContent` matches on ownerId + contractId + documentType + content hash
- Cleanup removes old entries
- Max entries limit enforced

**`state-transition-service.test.ts`:**
- `checkDocumentExists` returns document when found
- `checkDocumentExists` returns null on network error
- `createDocument` skips creation when document already exists
- `createDocument` saves to pending store before broadcast
- `createDocument` marks confirmed on success
- `createDocument` handles timeout → verifies → returns success if found
- `createDocument` handles timeout → verifies → throws if not found
- `createDocument` handles "already exists" errors → verifies → returns success

**`error-utils.test.ts`:**
- `isAlreadyExistsError` correctly identifies mempool/chain/nonce errors
- `isNonceError` correctly identifies nonce-related errors

### 8.2 Integration Tests

**Simulated timeout scenario:**
1. Mock `sdk.documents.create()` to throw a timeout error
2. Mock `sdk.documents.get()` to return the document (simulating it landed)
3. Verify `createDocument` returns success
4. Verify pending store is marked confirmed

**Simulated genuine failure:**
1. Mock `sdk.documents.create()` to throw "insufficient balance"
2. Verify `createDocument` returns failure
3. Verify pending store is marked failed

**Thread posting with timeout on post 1:**
1. Mock first `sdk.documents.create()` to timeout
2. Mock `sdk.documents.get()` to return post 1
3. Verify post 2 correctly uses post 1's ID as parentId

### 8.3 Manual Testing Scenarios

1. **Happy path:** Create post → succeeds immediately → no pending entries
2. **Timeout + success:** Create post → times out → auto-verifies → shows success
3. **Timeout + failure:** Create post → times out → can't verify → shows warning → retry works
4. **Page refresh:** Create post → times out → refresh page → pending resolved on load
5. **Thread with timeout:** Create 3-post thread → post 2 times out → post 3 chains correctly
6. **Private post timeout:** Create encrypted post → times out → auto-verifies correctly
7. **Double-click prevention:** Click Post rapidly → only one pending entry created
8. **Multiple tabs:** Post from tab A → timeout → post from tab B → no duplicate

### 8.4 Lint and Build

After all changes:
```bash
npm run lint   # Must pass with zero warnings
npm run build  # Must succeed
```

## 9. Implementation Order

1. **`lib/services/pending-post-store.ts`** — New file, no dependencies
2. **`lib/error-utils.ts`** — Add `isAlreadyExistsError`, `isNonceError`
3. **`lib/services/state-transition-service.ts`** — Core idempotency logic
4. **`lib/retry-utils.ts`** — Allow timeout retries (minor change)
5. **`components/compose/compose-modal.tsx`** — Update timeout handling UI
6. **`lib/hooks/use-pending-posts.ts`** — Optional: page-load recovery hook
7. **Tests**
8. **Lint + Build validation**

## 10. Open Questions / Future Considerations

1. **SDK-level fix:** The ideal long-term fix is for the WASM SDK to expose `put_to_platform()` (broadcast only, no wait) separately from `wait_for_response()`. This would let us cache the serialized ST bytes and rebroadcast them on timeout. File an issue on `dashpay/platform`?

2. **Nonce tracking:** Should we track the identity contract nonce locally to detect desync proactively? The WASM SDK manages this internally, but we can't observe it.

3. **Pending post UI:** Should we show pending posts in the feed immediately (optimistic UI) with a "confirming..." badge? This would improve UX for the common timeout-but-succeeded case.

4. **Content hashing for dedup:** For `findByContent`, should we hash the document data for comparison? Deep equality on objects with `Uint8Array` fields (encrypted content) needs care. Use a content hash (SHA-256 of JSON-serialized data) as an index.
