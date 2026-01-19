# Learnings

## 2026-01-18: Contract Schema Design for Private Feeds

**Key observations:**
1. The `canBeDeleted: false` property in Dash Platform contracts is CRITICAL for the LKH (Logical Key Hierarchy) rekey mechanism. The `privateFeedRekey` documents must be immutable because node key versions are derived from the complete historical sequence of `revokedLeaf` values. Deleting any rekey document would break key derivation for all followers.

2. Two unique indices on `privateFeedGrant` (`ownerAndRecipient` and `ownerAndLeaf`) are needed to prevent both duplicate grants to the same recipient AND the critical security issue of assigning the same leaf index to multiple recipients (which would cause them to share identical path keys).

3. Byte arrays in Dash Platform contracts use `type: array` with `byteArray: true`, not a separate bytes type. The `maxItems`/`minItems` properties specify the exact byte count constraints.

4. For the notification type enum, used camelCase (`privateFeedRequest`) rather than snake_case to match the existing enum values (`like`, `repost`, `follow`, etc.)

**No issues encountered** - the contract registration was straightforward and the schema matched the SPEC requirements.

## 2026-01-18: PrivateFeedCryptoService Implementation

**Key observations:**

1. **@noble package import paths changed in v2.x**: The newer versions of `@noble/ciphers` and `@noble/hashes` require `.js` extension in import paths (e.g., `@noble/ciphers/chacha.js` not `@noble/ciphers/chacha`). Additionally, `sha256` moved from `@noble/hashes/sha256` to `@noble/hashes/sha2.js`.

2. **HKDF API requires Uint8Array for salt**: The HKDF function in `@noble/hashes` requires `Uint8Array | undefined` for the salt parameter, not strings. Using `new Uint8Array(0)` as an empty salt constant resolved this.

3. **secp256k1 ECDH returns full point**: When using `secp256k1.getSharedSecret()`, the returned value includes the point prefix byte. For ECIES, we need only the x-coordinate, so we slice `sharedPoint.slice(1, 33)` to get the 32-byte x-coordinate for hashing.

4. **XChaCha20-Poly1305 cipher is created per-operation**: The `xchacha20poly1305()` function from `@noble/ciphers` returns a cipher object with `.encrypt()` and `.decrypt()` methods. The cipher must be constructed with the AAD at creation time, not passed to encrypt/decrypt.

5. **Lint prefers assignment in loop condition over non-null assertion**: Instead of `while (stack.length > 0) { const n = stack.pop()! }`, TypeScript/ESLint prefers `while ((n = stack.pop()) !== undefined)` to avoid non-null assertions.

**No blockers encountered** - the service implementation follows the SPEC precisely and all build/lint checks pass.

## 2026-01-18: PrivateFeedKeyStore Implementation

**Key observations:**

1. **Base64 encoding for Uint8Array in localStorage**: localStorage only stores strings, so Uint8Array (keys, CEKs) must be encoded. Used manual base64 encoding with `btoa`/`atob` and binary string conversion rather than adding a dependency like `base64-js`. This is sufficient for the key sizes involved (32-byte keys, path of ~11 keys).

2. **SSR safety is critical**: Next.js renders components on the server where `localStorage` is undefined. All storage access must be wrapped with `typeof window === 'undefined'` checks. Created a reusable `isStorageAvailable()` helper that also tests storage access works (handles private browsing mode).

3. **Available leaves is a derived cache, not authoritative**: Per SPEC §6.3, the authoritative source of leaf assignments is the set of active `PrivateFeedGrant` documents. The local `availableLeaves` cache improves performance but must be re-derived from grants on recovery. The platform's unique index on `($ownerId, leafIndex)` prevents collisions even with stale cache.

4. **Consistent key prefix pattern**: Used `yappr:pf:` prefix as specified in PRD §3.4. Individual keys within this namespace use descriptive names like `feed_seed`, `path_keys:${ownerId}`, `cached_cek:${ownerId}` to keep storage organized and debuggable.

5. **Follower keys are per-feed-owner**: Unlike owner keys (single set), follower keys are stored per followed feed using the ownerId as part of the key. This allows following multiple private feeds while keeping keys separate.

**No issues encountered** - straightforward implementation following existing patterns from `secure-storage.ts`.

## 2026-01-18: PrivateFeedService Implementation

**Key observations:**

1. **Base58 identifier conversion for cryptography**: Dash Platform identifiers are base58-encoded 32-byte values. The cryptographic operations (AAD construction, etc.) require the raw bytes, so implemented `identifierToBytes()` with manual base58 decoding to convert identifiers to 32-byte Uint8Arrays.

2. **SDK byte array response normalization**: The Dash Platform SDK returns byte array fields in different formats depending on context: Uint8Array, regular arrays, base64 strings, or hex strings. Created a `normalizeBytes()` utility to handle all cases consistently.

3. **Sync check is critical for forward secrecy**: Per SPEC §7.6, before any write operation (post, approve, revoke), the client must check if another device has advanced the epoch. Implemented sync check in `createPrivatePost()` that compares chain epoch vs local epoch. Full recovery is deferred to Phase 4, but the check ensures we don't accidentally create posts with stale epochs.

4. **CEK caching optimization**: Rather than regenerating the full 2000-epoch chain every time, the service caches CEK[1] immediately after feed enablement and uses the cached CEK for posts. The deriveCEK() method in the crypto service can derive older epochs from a cached newer epoch via hash chain.

5. **Document data format for byte arrays**: When creating documents via state transitions, byte arrays must be passed as regular JavaScript arrays (`Array.from(uint8array)`), not as Uint8Array objects. The SDK/platform handles the conversion internally.

**No blockers encountered** - the service follows the existing patterns in post-service.ts and state-transition-service.ts.

## 2026-01-18: PrivateFeedFollowerService Implementation

**Key observations:**

1. **Import statements require `.js` extension**: Consistent with the crypto service, imports from `@noble/hashes` require the `.js` extension. Using `require()` statements inside functions triggers ESLint errors (`@typescript-eslint/no-var-requires`), so all imports must be at the top level using ES6 import syntax.

2. **stateTransitionService.deleteDocument requires 4 arguments**: Unlike some other delete patterns, `stateTransitionService.deleteDocument()` requires the `ownerId` as the 4th parameter. The follow request owner is the requester (not the feed owner), so `myId` must be passed for deletion.

3. **Rekey nonce derivation challenge for followers**: The SPEC defines nonce derivation using `wrapNonceSalt` derived from `feedSeed`, which followers don't have. The solution is either: (a) include wrapNonceSalt in the grant payload, (b) derive it from the root key (which followers receive), or (c) use a fixed/deterministic derivation. Current implementation uses approach (c) with empty salt, matching what owner should use. This may need revision when testing end-to-end.

4. **Iterative packet decryption for rekeys**: Rekey packets form a dependency graph - some packets are encrypted under keys that are themselves wrapped in other packets in the same rekey. The solution is iterative processing: keep attempting to decrypt remaining packets until no progress is made. If the new root key can't be derived after all iterations, the user was revoked.

5. **Access status requires both chain and local state**: Determining a user's access status combines platform queries (grants, requests) with local key state. A user with a grant document but no local keys is in a "revoked" state - the orphaned grant exists but keys are no longer derivable due to revocations.

**No blockers encountered** - the service implementation builds on the patterns established in the previous private feed services.

## 2026-01-19: Enable Private Feed UI Implementation

**Key observations:**

1. **Settings page uses URL query params for section navigation**: The settings page uses `?section=privateFeed` pattern for navigation rather than separate routes. This makes it easy to add new sections without creating new pages - just add to the `SettingsSection` type, `VALID_SECTIONS` array, and `settingsSections` navigation array.

2. **Component structure follows existing patterns**: The `PrivateFeedSettings` component follows the pattern established by `KeyBackupSettings` - using `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` from the UI library, with loading states using skeleton placeholders and state-based conditional rendering.

3. **Services must be dynamically imported in components**: To avoid SSR issues and ensure proper code splitting, services like `privateFeedService` must be dynamically imported using `await import('@/lib/services')` rather than top-level imports. This pattern is used throughout the settings components.

4. **Encryption key input requires careful validation**: The hex key input needs to validate:
   - Correct length (64 hex characters = 32 bytes)
   - Valid hex characters only
   - Valid secp256k1 private key (by attempting to derive public key)

5. **Stats display depends on both chain and local state**: The enabled state shows follower count and available slots, which requires checking both the on-chain `PrivateFeedState` document (for enabled status, created date) and local storage via `privateFeedKeyStore` (for recipient map, available leaves).

6. **Faucet identity creation during testing**: Used https://faucet.thepasta.org to create a fresh test identity. The faucet generates keys in the browser and registers the identity on Dash Platform. The identity ID and WIF private key are needed for login testing.

**No blockers encountered** - the UI follows established patterns and integrates cleanly with the existing private feed services.

## 2026-01-19: Compose Private Post UI Implementation

**Key observations:**

1. **Local state as fast path for private feed detection**: When checking if a user has a private feed enabled, first check local `privateFeedKeyStore.hasFeedSeed()` (synchronous, fast) before querying the platform (async, slower). If local keys exist, the user definitely has a private feed enabled locally, so we can skip the network call.

2. **Visibility selector only shows when private feed is enabled**: Per PRD, the visibility toggle only appears when the user has enabled their private feed. Users without a private feed see the normal compose modal without the selector.

3. **Private posts disable threading**: Threads are only for public posts. When a private visibility is selected, the "Add to thread" button is hidden and `canAddThread` is set to false. Private posts are single posts only.

4. **Teaser and content have separate character limits**: Per PRD §4.2, teaser is limited to 280 characters (same as public posts) while encrypted content can be up to 500 characters. The teaser input has its own character counter separate from the main content counter.

5. **Store extensions for visibility state**: Added `visibility` and `teaser` fields to `ThreadPost` interface and corresponding store actions. Visibility applies only to the first post in a thread (since threads are disabled for private posts anyway).

6. **Private post result format differs from public**: The `privateFeedService.createPrivatePost()` returns `{ success: boolean, postId?: string }` while `dashClient.createPost()` returns the full document. Updated the post ID extraction logic to handle both formats: `result.data?.postId || result.data?.documentId || ...`

**No blockers encountered** - the implementation follows established modal patterns and integrates with existing private feed services.

