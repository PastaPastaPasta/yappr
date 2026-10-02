# Yappr Mobile 1.0: architecture advice (agent-delivered, days not months)

## Decisions at a glance

| # | Decision |
| --- | --- |
| 1 | **Stage the engine.** 1.0 ships on a hidden-WebView evo-sdk engine behind a JSON-RPC `PlatformEngine` interface. A Rust `yappr-platform` crate (uniffi, same RPC) is built in a parallel lane and replaces the WebView when a fixture-parity gate passes; it is required before mainnet, not before 1.0. |
| 2 | **Hybrid, zero web changes.** Run `lib/` on Hermes unmodified. Mobile owns an `@dashevo/evo-sdk` shim and a short allowlist of shadowed lib modules via Metro `resolveRequest`, plus global polyfills. Overturn the five "seam PRs" to web `lib/`. |
| 3 | **Expo (SDK 57) + expo-router + NativeWind 4 consuming the web `tailwind.config.js` theme verbatim.** |
| 4 | **Sign-in now:** key entry (WIF/hex, identity by public-key hash) + the existing `dash-key:` QR key-exchange via `vendor/platform-auth`, exercised by a Node test-wallet responder. App Connect implemented as a third `SignInMethod` against the spec, testable only via the responder. |
| 5 | **1.0 scope:** feed, thread, compose (text + 1 image), replies, likes, quotes/reposts, profiles, follow, explore/search, in-app notifications, DMs v5, bookmarks, blocks, reports, settings, signed-out browsing. Defer push/NSE/background sync, private feeds, storefront, blog, pollr, tips, DPNS registration, account deletion, legacy DM read. |
| 6 | ~22 PRs in 5 waves; up to 6 agents in parallel worktrees after the scaffold lands (list below). |
| 7 | Vitest (root) + Jest (mobile) + fixture-driven engine contract tests + Maestro on simulators; agents verify UI with `xcrun simctl io`/`adb exec-out screencap` on every PR. |
| 8 | Top risk is contract churn (v11 → "FULL M"); mitigate by building the UI only on `lib/contract-topology.ts` predicates and keeping the engine topology-agnostic. |

## 1. Engine

**Decision: WebView-evo-sdk first, Rust in a parallel lane, one interface for both.**

Why not Rust first:
- rs-sdk at `v5.0.0-beta.1` does expose everything web uses: `/Users/pasta/workspace/platform/packages/dash-platform-queries/src/documents/` has `document_query` (with `time_range`), `document_count`, `document_average`, `composite_document_query`, `document_ranked_entries`, `document_having_entries`; `rs-sdk/src/platform/transition/put_document.rs` carries `ActionFeeAgreement` and `TokenPaymentInfo`; `contract_moderation.rs`, `moderation_charters/`, `contract_fee_pots.rs` exist. So parity is real. But wasm-sdk's JSON→`DocumentQuery` parsing (`packages/wasm-sdk/src/queries/document.rs` ~700 lines, `document_ranked.rs` ~1500, `composite_document.rs` ~500) and result serialization must be ported and then re-verified on every platform beta. `rs-sdk-ffi` is not a shortcut: its document FFI has `fetch/search/count/sum/average/create/replace/delete` but no `ranked`/`composite`/`having`.
- Tooling gaps on this Mac: the platform repo pins Rust **1.98.1** (`rust-toolchain.toml`; it is installed with `aarch64-apple-ios(-sim)`), but `aarch64-linux-android`/`x86_64-linux-android` targets, `cargo-ndk`, `uniffi-bindgen-react-native`, and `maestro` are all absent; NDK is 27.1 (kotlin-sdk wants r28+ for 16 KB pages, warning only). The checked-in xcframework is 1.4 GB, simulator+macOS only, dated Aug 12. Cold cross-builds of rs-sdk run tens of minutes per target.
- `ubrn` is at `0.31.0-6` (prerelease). Fine for a lane, bad for a critical path measured in days.

Why the WebView is acceptable for 1.0: it runs the exact evo-sdk bytes web pins (`@dashevo/evo-sdk@5.0.0-beta.1`, 25.9 MB unpacked, published 2026-10-01), so protocol churn costs mobile nothing beyond web's own bump; `lib/manual-batch.ts`, `document-builder-service.ts`, `identity-update-builder.ts` run inside it unchanged. Lockdown Mode and background sync are mainnet/1.1 concerns (push is deferred anyway). Load the `@dashevo/wasm-sdk/compressed` entry inline (it is what web's `identity-update-builder.ts` already uses, so no `file://` fetch/CORS fight); keep one hidden instance alive, queue calls during boot, restart on crash.

Key custody caveat: the WIF crosses into the WebView per operation. Equal to web's plaintext `localStorage` today; document it, and make the Rust engine's native signer callback the mainnet precondition.

**The interface that makes the swap cheap** (`mobile/app/src/engine/types.ts`, spec in `docs/mobile/ENGINE_RPC.md`):

```ts
interface PlatformEngine {
  boot(cfg: { network; dapiAddresses; devnetName; quorumUrl; knownContracts: Record<string, unknown> }): Promise<{ engine: 'web'|'rust'; sdkTag: string }>
  call(method: string, params: Json): Promise<Json>   // 'documents.query', 'tx.buildCreate', ...
  on(ev: 'ready'|'crash'|'log', cb): () => void
}
```

Method set = the ~30 facade methods counted in `/Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/lib/services/sdk-facades.ts` usage (documents.query/get/count/average/ranked/composite/queryWithProof; identities.fetch/balance/nonce/contractNonce(+WithProof)/byPublicKeyHash/byNonUniquePublicKeyHash; contracts.fetch/getMany/addKnown/getLatestVersions; dpns.*; voting.votePollsByEndDate/contestedResourceVoteState; tokens.identityBalances/calculateId; epoch.current; st.broadcast/waitForResponse/waitForAffectedState) plus write builders `tx.buildCreate/buildReplace/buildDelete/buildIdentityUpdateUnsigned/buildAddKeys` taking `{contract, type, data, nonce, actionFee?, tokenPayment?, signerRef}` and returning `{stBytes, documentId}`. Wire rules: identifiers base58, bytes base64, u64 as decimal strings, **error messages copied verbatim from evo-sdk** so `lib/error-utils.ts` substring classification keeps working. A string-dispatched `call` means adding a method never changes the uniffi binding. CI asserts `sdkTag` equals the web `package.json` pin (WebEngine) or the crate's git tag (Rust).

## 2. Domain layer

**Decision: hybrid, web untouched.** `lib/` has 52.7k lines; only 26 non-test files import `@dashevo/*` and roughly 14 of those are value imports (`Identifier`, `Document.generateId`, `PlatformVersion`, `PrivateKey`, `IdentityPublicKeyInCreation`, wasm-dpp transition classes). The DM v5 engine is already behind `DmChain`/`KeyValueStore` (`lib/services/dm-v5/types.ts:68-112`) with an in-memory `test-chain.ts`. Reads funnel through `queryDocuments`/`queryDocumentBundle` in `lib/services/sdk-helpers.ts` and `document-query-bundle.ts`.

Mechanics (all in `mobile/`, none in `lib/`):
- Metro `watchFolders: [repoRoot]`, alias `@/` → repo root, and a `resolveRequest` allowlist that shadows: `@dashevo/evo-sdk` and `@dashevo/wasm-sdk(/compressed)` → `mobile/app/src/engine/evo-sdk-shim/` (facade proxy over `PlatformEngine`; pure-TS `Identifier`, `PlatformVersion`, and a fixture-verified port of `Document.generateId` because `lib/document-id.ts:105` calls it synchronously); `lib/secure-storage.ts` → Keychain/Keystore impl with identical exports; `lib/services/signer-service.ts`, `lib/manual-batch.ts`, `lib/services/identity-update-builder.ts` → engine-backed versions. Each shadow is type-pinned (`satisfies typeof import('@/lib/manual-batch')`) so a web change breaks mobile `tsc`, loudly.
- Global polyfills: `localStorage` → `react-native-mmkv` (synchronous, which the 47 lib files that touch storage assume), `crypto.subtle` → `react-native-quick-crypto`, no-op `document.addEventListener`/`window.addEventListener`/`CustomEvent`, `react-native-url-polyfill`. RN defines `window = global`, so `typeof window === 'undefined'` guards (e.g. `state-transition-service.ts:220`) pass.
- RN screens import pure lib modules directly (`lib/types`, `contract-topology`, `feed/*`, `post-helpers`, `compose/limits`, `error-utils`, `dm/*`, `utils/format`) and call the same service singletons web uses (`lib/services/index.ts`).

Keeping web safe: root `tsconfig`/`eslint`/`knip` exclude `mobile/**` (knip's `project` globs already omit it); mobile has its own lockfile; a path-filtered CI job runs mobile `tsc` + Jest on `lib/**` changes (advisory first). Note `.env.local` with `E2E_SEED_PHRASE` is not present in this worktree, so the web write e2e suite cannot be run here; one more reason not to touch web `lib/` for 1.0.

## 3. UI stack

**Confirm Expo + React Native**: Expo SDK 57 (latest stable; RN 0.87), `expo-router`, `expo-dev-client` (prebuild, since MMKV/quick-crypto/Keychain/WebView need native code), FlashList 2, `expo-image`, Reanimated, `expo-haptics`, `zeego` for native context menus, a bottom-sheet library for the compose/visibility sheets. No Expo Go.

Following upstream styling: **NativeWind 4 with `theme: require('../../tailwind.config.js').theme`**, so `bg-yappr-500`, `dark:bg-neutral-850`, `rounded-full`, `shadow-yappr` are literally the same tokens; `darkMode: 'class'` driven by `useColorScheme`; keep `cn()` from `lib/utils` and port `cva` variants from `components/ui/button.tsx` nearly verbatim. Icons: `lucide-react-native` + `react-native-heroicons` (same names as web). Fonts: system, matching web's `-apple-system/Roboto` stack. `components/` is 41.5k lines and `app/` 13k; port structure (PostCard, PostActionBar, FeedHeader, ComposeModal, ConversationList) rather than code, and reuse the 44 of 50 `hooks/` that do not touch `next/` or the DOM (e.g. `use-feed-data.ts` is importable as-is).

## 4. Sign-in for 1.0

- **Key entry** (dev/QA primary): WIF or hex, identity discovered via `identities.byPublicKeyHash`, same as `e2e/write/key-only-login.spec.ts`. Secrets in Keychain/Keystore scoped by network + identity; optional biometric lock; multi-account.
- **Wallet QR key exchange**: reuse `vendor/platform-auth` (`buildYapprKeyExchangeUri`, `pollForYapprKeyExchangeResponse`, `decryptYapprKeyExchangeResponse`, `deriveYapprAuthKeyFromLogin`) and `lib/services/key-exchange-service.ts`; first-login key registration keeps the `dash-st:` unsigned IdentityUpdate path. Register `dash-key:`/`dash-st:` return deep links.
- **Test-wallet responder** `scripts/test-wallet-responder.mjs` (Node, not an app): given a `dash-key:` URI it does ECDH, encrypts the pool identity's login key, publishes `loginKeyResponse` on the key-exchange contract, and signs `dash-st:` payloads with the pool identity's master key. DM e2e bots already sign from Node, so this is cheap, and it lets Maestro drive the QR flow (dev builds expose the URI under a testID).
- **App Connect** as the third `SignInMethod` implemented against `platform/docs/protocol/app-connect.md` and the `H8F9…` contract, responder-tested, shown as "coming soon" in UI until a wallet ships. Passkey/password vaults stay web-only.

## 5. Scope of 1.0

Ship: Home (Following / For you / Top), thread view with reply parents and deleted stubs, compose (text, mentions, hashtags, one image via Pinata JWT, quote, thread), like/unlike, quote-repost, bookmarks, profiles (DashPay `profile` + `yapprProfile`, edit), follow + lists, explore/trending/search/hashtag, in-app notifications (foreground poll with `notification-service.ts`), DMs v5 (1:1, groups, requests), block, report post/reply, sensitive gate, EULA gate, settings, signed-out browsing, deep links, light/dark.

Defer: push relay/NSE/background polling, private feeds (3.4k lines of crypto surface), storefront/blog/pollr, tips (trivial `dash:` URI later; no devnet wallet to test), DPNS registration (wallet-signed), account deletion (needs web Y7 first; store blocker, not devnet blocker), Storacha, legacy DM v3/v4 read, YAPP/token anything, moderator tools, share extension, iPad, localization.

## 6. PR plan

Prereqs on web, already in flight: #606 (5.0.0-beta.1 pin) → the sakura `.env.devnet` cut-over PR (not yet opened) → #607 (v11) → the FULL-M re-cut. Mobile reads `.env.devnet` at build time and never hardcodes a topology.

| PR | Scope | Deps | Parallel |
| --- | --- | --- | --- |
| M0 docs | `docs/mobile/EXECUTION_1.0.md` (supersedes phases), `ENGINE_RPC.md`, `SIGNIN.md`, PR map | — | — |
| M1 scaffold | `mobile/app` Expo 57, router, NativeWind+web theme, Metro watchFolders/alias/resolver skeleton, jest, root excludes, CI `mobile-typecheck` | M0 | — |
| M2 engine | `PlatformEngine` types, `engine-web/` bundle (evo-sdk + router + write builders, esbuild), `WebEngineHost`, Node reference tests, boot/memory numbers both OSes | M1 | with M3, M4, M18, R1 |
| M3 Hermes runtime | polyfills, `evo-sdk` shim, pure `generateId`/`Identifier` ports with fixtures, shadows (secure-storage, signer, manual-batch, identity-update-builder), device "lib smoke" screen booting the DM engine on `test-chain` | M1 | yes |
| M4 design system | tokens, UI primitives ported from `components/ui`, gallery screen for screenshots | M1 | yes |
| M5 sign-in | session store, Keychain, key entry, platform-auth adapters, QR key-exchange, responder script, multi-account | M2, M3 | with M6 |
| M6 shell | tabs/stacks/modals, deep-link map from web routes, headers, offline banner | M4 | yes |
| M7a/b feed | loaders + PostCard + FlashList; then like/quote/bookmark writes + unconfirmed-write UX | M5, M6 | M13a, M15 |
| M8 thread/replies | M7 | with M9–M12, M14 |
| M9 compose | image pick/resize/EXIF strip, Pinata, drafts | M7 | |
| M10 profiles/follow | M7 | |
| M11 explore/search | M7 | |
| M12 notifications | M7 | |
| M13a/b DMs | `DmChain` over engine, MMKV `KeyValueStore`, AppState lifecycle; then UI | M5, M6 | |
| M14 safety | block, report, sensitive, EULA | M7 | |
| M15 settings/bookmarks | M5, M6 | |
| M16 Android sweep | back/edge-to-edge/Material, WebView flags | all UI | |
| M17 Maestro + screenshot harness | start after M5, extend per feature | M5 | |
| M18 release scaffolding | icons, bundle ids per variant, privacy manifest, build profiles | M1 | yes |
| R1–R4 Rust lane | crate on dash-sdk @ `v5.0.0-beta.1` with `call(method,json)`; full read port + parity suite; writes + signer callback; ubrn Expo module + engine switch | R1 after M2's spec | 1 agent throughout |

Waves: M1 → {M2, M3, M4, M18, R1} → {M5, M6, M17, R2} → {M7, M13a, M15} → {M8–M12, M14, M13b} → {M16, QA pass, fix PRs}. Every UI PR must carry iOS + Android screenshots (light/dark). Use `/code-review` locally before opening, given the 4 h bot backlog; stack dependent PRs.

## 7. Testing

- Unit: root Vitest unchanged; mobile Jest (`jest-expo`) for shim, polyfills, pure ports.
- Engine contract tests: `scripts/record-engine-fixtures.mjs` records queries and built transitions from Node evo-sdk against sakura (reusing `scripts/sdk-env.mjs`); the same fixtures run through the WebView engine (hidden `/engine-test` route driven by Maestro) and `cargo test --features network-testing` for Rust. Live tests non-blocking in CI, blocking locally.
- UI E2E: Maestro (YAML, no test build, `takeScreenshot`, agent-friendly) over Detox. Flows: signed-out browse, key sign-in, post lifecycle, DM 1:1 with two pool slots.
- Agent verification: `xcrun simctl io booted screenshot`, `adb exec-out screencap -p`, `maestro hierarchy`, Metro logs; follow the `run-ios-simulator` and `capture-visual-evidence` skills. No physical devices, so real-device WKWebView wasm behavior and Lockdown Mode stay untested until TestFlight.

## 8. Top risks and what to overturn

1. **Contract churn** (#607's own body says D2 is not adopted; the owner has since chosen FULL M): build UI only on `contract-topology.ts` predicates; engine passes JSON through; expect one re-cut mid-build.
2. **WebView engine boot/memory** (25 MB wasm, +100–200 MB on Android): measure in M2 day one; Rust lane is the escape hatch.
3. **Hermes gaps in lib** (subtle AES-GCM/PBKDF2, sync storage): M3's device smoke screen catches them early; shadow per module if needed.
4. **Devnet wipe on 5.0.0-beta.2**: all ids from `.env.devnet`; CI asserts the engine SDK tag equals web's pin.
5. **WIF in WebView**: accepted for devnet; Rust + native signer before mainnet.
6. **Untested App Connect path** (the path every mainnet user will take): responder-tested now, wallet interop on testnet the day a wallet ships.
7. **Rust toolchain setup** (Android targets, cargo-ndk, ubrn, sccache) needs network and installs; keep off the critical path.

Overturn in `docs/mobile`: the 26-week gates and S1–S6 spikes; Rust-first; the five web seam PRs (replace with Metro shadows); D1 "only a DashPay wallet signs in" relaxed for dev/QA builds; bonsia → sakura; the test-wallet *app* → a Node responder; Y4 and D6 multi-bound keys deferred with App Connect; relay/NSE out of 1.0. Keep: Expo/RN, Maestro, `PlatformClient`-style facade (now `PlatformEngine`), topology-driven UI, no analytics SDKs.

### Critical Files for Implementation
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/lib/services/evo-sdk-service.ts (the SDK choke point the shim must mirror)
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/lib/services/state-transition-service.ts (write path; must run unchanged on Hermes over shadowed `manual-batch.ts`)
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/lib/services/dm-v5/types.ts (`DmChain`/`KeyValueStore`, the already-existing DM seam)
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/lib/contract-topology.ts (every UI decision must go through it)
- /Users/pasta/workspace/platform/packages/wasm-sdk/src/queries/document.rs (the JSON query grammar the Rust engine must port byte-for-byte)