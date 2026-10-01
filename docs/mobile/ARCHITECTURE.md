# Mobile architecture

> **Status, 2026-10-01: the engine decision here is superseded by [ADR-001](ADR-001-mobile-1.0.md).**
> - **1.0 engine.** 1.0 runs on the **hidden-WebView engine** (the "fallback engine" row below), behind a domain-level RPC. It is specified in [ENGINE.md](ENGINE.md).
> - **Rust.** The Rust `yappr-platform` module described in this document becomes the **post-1.0 track**, required before mainnet, behind the same `EngineApi` ([ENGINE.md › The post-1.0 Rust engine](ENGINE.md#13-the-post-10-rust-engine)).
> - **Gone from the 1.0 plan:** the Phase 0 spike plan (S1–S6) and gate G0. They are replaced by the day-1 checks in the M2 and M4 PRs ([EXECUTION.md](EXECUTION.md)).
> - **Seams.** The `lib/` platform seams (Y5) are no longer a 1.0 dependency; they are step R3 of the Rust track.
> - **Background execution and push** move to 1.1. 1.0 is foreground only.
> - **Network.** Bonsia is abandoned. The devnet is **sakura** (Platform 5.0.0-beta.1, protocol 14). The web pin moves to evo-sdk 5.0.0-beta.1 in #606, and social v11 follows in #607, then a "full M" re-cut. Read "sakura" for "bonsia" below, and `v5.0.0-beta.1` for `v4.2.0-beta.7`.
>
> The rest of this document stays as the design reference for the Rust track: the signer and key store, data and caching, media, background execution, and variants.

## Decision (to confirm at gate G0; superseded by ADR-001 for 1.0)

**React Native (Expo, prebuild / dev client), with the shared TypeScript in
`lib/`, and a native Rust Platform module (`yappr-platform`) in place of the
WASM SDK.**

```
┌──────────────────────────── mobile/app (Expo, React Native, TypeScript) ─────────────────────────────┐
│  Screens & native UI (expo-router, Reanimated, FlashList, expo-image)                                 │
│  ───────────────────────────────────────────────────────────────────────────────────────────────────  │
│  Shared domain layer:  ../../lib  (services, DM v5 engine, private feeds, notification derivation,   │
│                         compose, payment plan, codecs, crypto)  ← reused as-is via Metro alias `@/`   │
│  ───────────────────────────────────────────────────────────────────────────────────────────────────  │
│  Platform seams (lib/platform/*):  sdk · signer · secrets · kv · lifecycle · crypto  (mobile impls)  │
└───────────────┬───────────────────────────────┬──────────────────────────────┬───────────────────────┘
                │ JSI (uniffi-bindgen-react-native)                            │
     ┌──────────▼───────────┐       ┌───────────▼───────────┐      ┌───────────▼──────────────┐
     │ yappr-platform (Rust)│       │ Keychain / Keystore   │      │ expo-sqlite + MMKV       │
     │ dash-sdk (rs-sdk) @  │       │ SE / StrongBox wrap   │      │ caches, cursors, prefs   │
     │ the wasm-sdk's tag;  │       │ (native signer)       │      │ (App Group on iOS)       │
     │ queries, proofs,     │       └───────────────────────┘      └──────────────────────────┘
     │ ST build+sign+submit │
     └──────────────────────┘
  iOS NotificationService extension (Swift, CryptoKit, no SDK) · Android FCM/UnifiedPush receivers (Kotlin)
```

### Options compared

| Option | Reuse of `lib/` (~48k lines) | Platform SDK | Background sync | Store risk | Verdict |
| --- | --- | --- | --- | --- | --- |
| **RN + native Rust module** | High, through seams | rs-sdk natively, the same Rust as wasm-sdk | Headless JS or Rust | Low: native UI | ~~Chosen~~ **Post-1.0 track** (ADR-001 E1) |
| RN + hidden WebView running evo-sdk | High | Unchanged evo-sdk | Poor. A WebView is unreliable in background tasks, and each launch must compile a 24.6 MB WASM module | Medium | ~~Fallback engine~~ **Chosen for 1.0** (ADR-001 E1; [ENGINE.md](ENGINE.md)); foreground only |
| Capacitor around the static export | Total | Unchanged | No SDK in `background-runner` | **High** (4.2 thin wrapper) | Rejected |
| Swift + Kotlin on `swift-sdk` / `kotlin-sdk` | None: all domain logic rewritten twice | Dash-maintained | Native | Low | Rejected: roughly 3× the cost for a 2–3 engineer team |
| Kotlin Multiplatform | None: domain logic rewritten once in Kotlin | cinterop over `rs-sdk-ffi` (unproven) | Native | Low | Rejected. The uniffi-KMP tooling (Gobley) lags. |

### Why not run the WASM SDK directly

These findings come from inspecting `@dashevo/wasm-sdk@4.2.0-beta.4`, and
still hold at `4.2.0-beta.7` (re-checked 2026-09-30).

- **Size and wasm features.** The module is 24.6 MB at beta.7. It needs reference types
  (an externref table), bulk memory and multivalue.
- **Host APIs it expects.** Streaming `fetch`, `DecompressionStream`,
  `WebAssembly.instantiateStreaming` and `performance.mark`.
- **Hermes.** There is no WebAssembly in a shipped Hermes. The Feb 2026
  "WebAssembly comes to Hermes" preview is interpreter-only and "not yet ready
  for production".
- **Other runtimes.** Polygen is stalled (last release March 2025, broken on
  RN 0.83+) and wasm3 is abandoned. `react-native-webassembly-runtime` (July
  2026) sits on wasm3, needs MVP-only wasm and runs on the JS thread, so it
  cannot load this module. iOS JavaScriptCore has had WASM disabled for
  in-process contexts since 16.4.
- **WebView hosting.** It works in WKWebView and Android WebView, but iOS
  **Lockdown Mode disables WebAssembly** there. That hits exactly the
  privacy-minded users Yappr attracts.

### Why our own Rust crate instead of `swift-sdk` / `kotlin-sdk`

1. **Semantics.** `wasm-sdk` is a thin layer over `rs-sdk`. A crate that calls
   `rs-sdk` directly, pinned to the **same platform tag** as the web app's
   `@dashevo/evo-sdk` (today `v4.2.0-beta.7`, `50d12037`), gives the same
   query and proof behavior as web. Natively, `rs-sdk` also has
   `with_action_fee_agreement`, which wasm-sdk lacks (the reason web keeps
   `lib/manual-batch.ts`), and it needs none of web's wasm workarounds such as
   `lib/services/dapi-path-shim.ts`. `swift-sdk` / `kotlin-sdk` are wallet SDKs
   (`ManagedPlatformWallet`, iOS 18+, SPV and persistence layers) with APIs
   that differ per platform, published only as GitHub release assets, with no
   React Native binding.
2. **One implementation.** The same crate serves iOS and Android. It is exposed
   to JS through **uniffi-bindgen-react-native**, which is pre-1.0 but ships in
   production in BDK, LWK, Breez and the Matrix RN SDK.
3. **Small surface.** Yappr uses a bounded set of SDK calls, counted across
   `lib/`, `components/`, `app/` and `hooks/`:

| Facade | Methods used (call sites) |
| --- | --- |
| `documents` | `query` (~44; including `timeRange` window reads for notifications and trending), `ranked`, `count`, `get`, `composite`, `average`, `replace`, `delete`, `create`, `queryWithProof` |
| `identities` | `fetch` (~13), `update`, `creditTransfer`, `contractNonce`, `nonce`, `balance`, `byPublicKeyHash`, `byNonUniquePublicKeyHash` |
| `contracts` | `fetch`, `getMany`, `addKnown`, `getLatestVersions`, moderation family (`moderatorChangeDocumentFields`, pot claim, `moderationCharters`; web-only in 1.0) |
| `dpns` | `resolveName`, `isNameAvailable`, `isContestedUsername`, `isValidUsername`, `convertToHomographSafe` (registration goes to the wallet) |
| `voting` | `contestedResourceVoteState`, `votePollsByEndDate` (read-only; username contests) |
| `tokens` | `identityBalances`, `calculateId` (read-only; YAPP transfer and purchase are refused on v10, and 1.0 never claims the grant) |
| `stateTransitions` | `broadcastStateTransition`, `waitForResponse`, `waitForAffectedState` |
| `epoch` | `current` |

Call counts drifted between the 2026-09-27 and 2026-09-30 counts; re-count
at G0.

The mobile 1.0 subset is about 30 methods. Anything moderator-only or
token-write stays on web.

**Risks flagged for the spike.** `documents.ranked`, `documents.composite`,
`timeRange` selectors (`newest`, `byStart`) and the beta.7 count-picker forms
(prefix-to-last, at-chain; `docs/SOCIAL_V10.md`) are recent query types;
confirm that `rs-sdk` exposes them at the pinned tag. If they are only in
`wasm-sdk`, port the thin wrappers.

## Phase 0 spike plan

> **Superseded** by ADR-001. No spikes or G0 gate; the questions S1, S2 and S5 asked are answered by the M2/M4 day-1 checks and the engine contract suites ([ENGINE.md › Open items](ENGINE.md#14-open-items-the-implementing-prs-must-settle)). S3, S4 and S6 move to the Rust and push tracks.

Each spike is timeboxed, runs against bonsia (the only chain with the v10
contract set), and has exit criteria measured on a 2021-generation mid-range
device: an iPhone 12 and a Pixel 6a.

| # | Spike | Timebox | Exit criteria |
| --- | --- | --- | --- |
| S1 | `yappr-platform` crate: `documents.query` / `get` / `count` plus `identities.fetch` with proofs, exposed via ubrn in an Expo dev client on both OSes | 6 days | Home-feed query results match web exactly (JSON diff over 50 fixtures); p50 query ≤ 1.2× web; cold init ≤ 800 ms; release binary adds ≤ 25 MB (per ABI) |
| S2 | Write path through `txBuilder` (see seams): a v10 **post with a `$actionFeeAgreement`** (credits), once at the declared cap and once at a seated charter's discounted share; a DashPay `profile` create plus a `yapprProfile` create/replace, each signed with a key bound to its contract; a real post delete; an indexOnly like delete; and pending-transition replay after a 504. All built and signed in Rust by the native signer. | 8 days | All land on bonsia from both OSes, with document IDs byte-identical to the web builder's for the same inputs; no private key or raw-digest API crosses into JS |
| S3 | Headless JS `SyncCore` via `expo-background-task` (BGTaskScheduler / WorkManager), run while the device is locked (encryption key only) | 3 days | A cold background run finishes the v10 request mix ([NOTIFICATIONS.md › Shared pipeline](NOTIFICATIONS.md#shared-pipeline)) plus a DM head check in ≤ 15 s p90, with peak memory ≤ 150 MB |
| S4 | NSE: RFC 8291 decrypt with an SE P-256 key, secp256k1 **recover** plus hash160 check, App Group SQLite read (read-only, WAL) | 2 days | ≤ 12 MB resident, ≤ 300 ms |
| S5 | Fallback engine: `PlatformSdk` over a hidden WebView running evo-sdk | 3 days | Same fixtures as S1 pass. Gives us a plan B with numbers. |
| S6 | Share `lib/` through Metro: boot the DM v5 engine and private-feed crypto under Hermes, using the WebCrypto polyfill | 2 days | `lib/**/*.test.ts` pure specs pass under a Hermes runner |

**Deciding at G0:**
- **All pass:** the chosen architecture stands.
- **S1 or S2 fail:** ship 1.0 on the S5 WebView engine for foreground work.
  S3 then falls back to a Rust port of `SyncCore` read-only, as below.
- **S3 fails:** port the notification derivation, a small set of queries, to
  Rust inside `yappr-platform`. Pin it to the TS version with shared test
  vectors.

## Monorepo layout

```
/ (repo root, web app — unchanged build)
├── lib/                      shared domain layer (web + mobile)
│   └── platform/             NEW: seam interfaces + web default impls (see below)
├── mobile/
│   ├── app/                  Expo app (package.json, app.config.ts, src/)
│   │   ├── src/app/          expo-router routes (tabs, stacks, modals)
│   │   ├── src/ui/           design system (tokens from tailwind.config.js)
│   │   ├── src/platform/     mobile seam impls (sdk shim, signer, secrets, kv, lifecycle)
│   │   └── src/sync/         SyncCore wiring, background task registration
│   ├── native/
│   │   ├── yappr-platform/   Rust crate (rs-sdk, pinned to evo-sdk's platform tag) + ubrn config
│   │   ├── ios/NotificationService/   Swift NSE target (config plugin)
│   │   └── android/push/     FCM + UnifiedPush receivers (config plugin)
│   ├── relay/                Go/Rust stateless wake-up relay + deploy/
│   ├── test-wallet/          debug-only DashConnect responder for E2E (emulators/simulators)
│   └── e2e/                  Maestro flows + fixtures
├── contracts/                + yappr-push-contract.json, next social cut (IDs in lib/constants.ts)
└── .github/workflows/mobile.yml   path-filtered: mobile/**, lib/**
```

**Keeping web insulated**
- Root `tsconfig.json`, `eslint` and `knip` exclude `mobile/**`.
- The mobile packages have their own lockfile. Metro's `watchFolders` and
  `extraNodeModules` point `@/lib` at the repo root, and `lib/` dependencies
  resolve from `mobile/app/node_modules`.
- The web `npm run build` never touches `mobile/`.
- CI runs the web jobs on `lib/**` changes, so a seam change cannot break web
  unnoticed.

**When to split into a separate repo:** once two or more lib consumers exist,
or the release cadences diverge. At that point, extract `lib/` into a
`packages/core` workspace.

## Platform seams in `lib/` (the minimal Yappr change)

> **Not part of 1.0** (ADR-001 E2): 1.0 makes no `lib/` changes, and swaps browser-bound modules with esbuild aliases inside `mobile/engine` ([ENGINE.md › Dependency inventory](ENGINE.md#10-browser--and-next-only-dependency-inventory)). These seams are step R3 of the post-1.0 Rust track.

These are the changes Yappr needs so its shared code runs outside a browser.
Each is a small interface, the web default keeps today's behavior, and mobile
registers its own implementation at startup.

| Seam | Today | Change |
| --- | --- | --- |
| `lib/platform/sdk.ts` `PlatformSdk` (reads) | `getEvoSdk(): Promise<EvoSDK>` returns the wasm facade | Add `type PlatformSdk = Pick<EvoSDK, …>`, narrowed to the read facades and methods used. `getEvoSdk()` returns `PlatformSdk`, and `setPlatformSdkProvider()` lets mobile register its shim. Web behavior is unchanged; this is a type narrowing plus a provider hook. |
| `lib/platform/tx.ts` `TxBuilder` (writes) | The write path bypasses the facade: `lib/manual-batch.ts:46-55` builds wasm-dpp objects directly (`DocumentCreateTransition`, `BatchTransition.fromBatchedTransitions`, `stateTransition.sign`), and `state-transition-service.ts` adds `DocumentActionFeeAgreement` (~394) and `TokenPaymentInfo` / `PrivateKey.fromWIF` (~681-703); the token, identity-update and moderation builders do the same | Add an **operation-level** interface: `createDocument`, `replaceDocument`, `deleteDocument`, `identityUpdateUnsigned`. Each takes a plain op description `{contract, type, data, payment, actionFee, signer: SignerRef}` and returns `{stBytes, documentId, status}`. (No tombstone op: v2 and v10 both delete for real.) The web impl moves today's builder code behind it, and the mobile impl is `yappr-platform`. This is the largest seam, estimated at 1.5–2 engineer-weeks on web. |
| Module-scope wasm imports | 16 lib modules import evo-sdk **runtime values** at top level, among them `document-id.ts`, `document-builder-service.ts`, `identity-service.ts`, `signer-service.ts`, `token-service.ts`, `token-*-builder.ts` (3), `moderation-service.ts`, `dm-v5/sdk-chain.ts`, `evo-sdk-service.ts`, `manual-batch.ts`, `identity-nonce.ts`, `identity-update-builder.ts`, `state-transition-service.ts` and `utils/username.ts`. Under Hermes these would load WASM. | Split each into a pure part (shared) and an evo-sdk part (web only, behind `TxBuilder` / `PlatformSdk`). An ESLint `no-restricted-imports` rule keeps `@dashevo/*` value imports out of shared modules. Mobile's Metro config aliases `@dashevo/*` to a stub that throws, so any leak fails loudly. |
| `lib/platform/signer.ts` | `signer-service.ts` builds a wasm `IdentitySigner` from a WIF | Add `SignerRef` (`{identityId, keyId}`). The web impl wraps the WIF as it does now; the mobile impl is a handle to the native signer, which picks the device key bound to the op's contract (D6). |
| `lib/platform/secrets.ts` | `secure-storage.ts` reads plaintext `localStorage` | Put the existing browser secret store behind an interface. The mobile impl uses Keychain/Keystore. **This also removes the `typeof window` guard** in `state-transition-service.ts:220`. |
| `lib/platform/kv.ts` | 18 files call `localStorage` directly, through `storage-scope` or not (15 in `lib/`, the rest in `components/`, `contexts/`, `hooks/` and `app/`); the seam covers the `lib/` ones, and mobile never loads the rest | Route them through `scopedStorage`, backed by `localStorage` on web and MMKV on mobile. zustand `persist` uses a `createJSONStorage` adapter. |
| `lib/platform/lifecycle.ts` | DM v5 flushes on `visibilitychange` / `pagehide`; `cache-manager` on `beforeunload`; 2 `window` CustomEvents | Add `onBackground(cb)` / `emit(event)`. The web impl uses the DOM events; mobile uses `AppState` plus background-task hooks. |
| `lib/crypto/aes-gcm.ts`, `message-encryption.ts`, `vendor/platform-auth/src/key-exchange/yappr-protocol.ts` | `crypto.subtle` AES-GCM and PBKDF2 | Mobile installs `react-native-quick-crypto`, which provides a native `subtle`. **No lib change**, unless S6 shows gaps, in which case switch AES-GCM to `@noble/ciphers/aes`. |

**Estimated diff:** about 40–60 files, with no behavior change on web. It
lands as five PRs, owned by the web/contracts engineer (Y5):

1. `kv`
2. `lifecycle`
3. `secrets` + `signer`
4. `sdk` (reads) + module-scope import split
5. `txBuilder`

PRs 1–2 land in Phase 0 and 3–5 in Phase 1. Each passes the existing web lint,
unit, build and **full e2e write suite**. The e2e requirement matters most for
PR 5, which moves every write.

### SDK shim

- `mobile/app/src/platform/sdk/` implements `PlatformSdk` on top of
  `yappr-platform`.
- **Arguments** use the same query shape evo-sdk takes (`where`, `orderBy`,
  `limit`, `startAfter`), serialized to the Rust crate.
- **Results** are plain objects with `Uint8Array` identifiers.
  `lib/services/sdk-helpers.ts` `normalizeSDKResponse` / `documentToPlainObject`
  already accept Map, array and object forms. Contract tests pin down any gaps.
- **Errors** map to the same codes `lib/error-utils.ts` classifies: timeout,
  `already-exists`, nonce, insufficient balance, and so on.
- **Unconfirmed writes.** The 504 / "assume success" logic in
  `unconfirmed-writes.ts` and the "never blindly retry a tip" rule carry over
  unchanged, because they sit above the shim.

## Signer and key store

- **Native signer.** A native module, `YapprKeys`, exposes **no arbitrary
  digest signing to JS**. Its operations:
  - `provision(identityId, keys)`, called once from the sign-in flow.
  - Signing happens only inside `yappr-platform`. Rust builds a state
    transition from a typed op, shows its own summary in debug builds, and
    calls the signer through a Rust-to-native callback that JS cannot reach.
  - `signPushPayload(identityId, fields)`: signs only with the
    `yappr-push-v1` domain prefix
    ([NOTIFICATIONS.md](NOTIFICATIONS.md#encrypted-payload)).
  - Encryption-key operations, each returning only derived output:
    - `ecdh(identityId, peerPub) → x`
    - `eciesDecrypt(identityId, blob)`
    - `dmHkdf(identityId, label, salt) → 32 bytes`
  - `wipe(identityId)`.
- **Where keys live.** Keys are unwrapped only inside the native call, as
  described in [WALLET_INTEGRATION.md › Key custody](WALLET_INTEGRATION.md#key-custody-on-the-device).
- **Rust integration.** `yappr-platform` takes a signer callback, so a state
  transition is built in Rust, its digest is signed by `YapprKeys`, and it is
  broadcast from Rust. No private key ever enters the JS heap.
- **What JS may see.** DM v5 and private-feed code need ECDH outputs and
  HKDF-derived keys in JS. Two of them are identity-wide, not per-conversation:
  - `selfRoot = HKDF(encPriv, "self")`, which decrypts all DM self-state;
  - `deriveGroupSecret(encPriv, gid)`, used in `lib/dm/keys.ts:34,74`.

  The secrets seam refactors those call sites (`lib/services/dm-v5/context.ts:84`,
  `lib/services/dm-v5/groups.ts:69,292,362`) to call `dmHkdf` instead of touching `encPriv`. The
  encryption private key then stays native, although `selfRoot` itself does
  live in the JS heap. The audit scope records this.

## Data and caching

| Store | Tech | Contents | Survives sign-out? |
| --- | --- | --- | --- |
| Secrets | Keychain / Keystore | Auth keys (one per bound contract), encryption key, pending sign-in request | No |
| Shared DB | SQLite in the App Group container (iOS) / app files (Android), WAL | Notification cursors and seen table, known-identities cache (for NSE verification), prefs, mutes, DM v5 local cache | No |
| KV | MMKV, per identity and network | zustand stores (feed settings, drafts, `payWith`), `storage-scope` keys | No |
| Media cache | `expo-image` disk cache | Avatars, IPFS media | Yes (pruned) |
| Document cache | SQLite | Post, profile and username caches (replacing in-memory `cache-manager` TTLs); stale-while-revalidate | No |

- **Network scoping.** Every store is namespaced by network (devnet, testnet
  or mainnet; `AppNetwork` in `lib/constants.ts`), mirroring
  `lib/storage-scope.ts`. A devnet wipe clears only the devnet namespace. A "testing" build variant uses
  the `.env.testing` contracts, as the web `/testing` deploy does.
- **Offline behavior.**
  - Browsing: the last loaded feed, threads and profiles.
  - Compose: drafts are kept, and **posting queues when offline**. The queue is
    persisted, sent in order, and each item shows as "sending" or "failed" with
    retry, except tips, which are never auto-retried.
  - DMs: queued the same way.

## Media

- **Upload.** The Storacha and Pinata providers in `lib/upload` are
  bring-your-own credential and `localStorage`-bound.
  - 1.0: Pinata JWT, plus Storacha via its email login in a
    `WebBrowser.openAuthSessionAsync` flow. Credentials are stored in secrets.
  - Transfers use background `URLSession` / WorkManager for large videos.
- **Before upload.** Resize and transcode on device: HEIC→JPEG, a 2048 px
  maximum, and EXIF/GPS stripped by default with a toggle.
- **Link previews.** Native fetch, so no CORS proxy. Reuse
  `lib/link-preview/parse-html.ts`, with a 256 KB cap and a 5 s timeout.

## Background execution

> **1.1.** 1.0 is foreground only (ADR-001 E1, E7). The table describes the post-1.0 design.

| Trigger | iOS | Android | Runs |
| --- | --- | --- | --- |
| Periodic | `BGAppRefreshTask` via `expo-background-task` | WorkManager periodic, 15 min | `SyncCore` (headless JS, S3) |
| Maintenance | `BGProcessingTask` | WorkManager, charging and unmetered | DM v5 self-state flush, cache prune, key-validity check, push-endpoint refresh |
| Push | NSE (Swift, no JS) + `content-available` follow-up | FCM / UnifiedPush → expedited work | Decrypt and show, then `SyncCore` |
| Leaving the app | `AppState` background + `beginBackgroundTask` | `onStop` + a short expedited job | Flush queued writes and DM self-state (replacing `pagehide`) |
| Large uploads | Background URLSession; `BGContinuedProcessingTask` on iOS 26+ with a progress UI | WorkManager foreground `dataSync`, short-lived | Media upload |

## Build variants and configuration

> **For 1.0, ADR-001 E6 sets the variants:**
>
> | Variant | Bundle id | Network |
> | --- | --- | --- |
> | `devnet` | `pr.yap.app.dev` | sakura, `.env.devnet` |
> | `testnet` | `pr.yap.app.beta` | testnet with the production yap.pr contracts, topology v2 |
> | `production` | `pr.yap.app` | mainnet, later |
>
> The engine bundle is built per variant from the matching env file ([ENGINE.md › Configuration](ENGINE.md#31-configuration)). OTA updates (`expo-updates`) are **off** for 1.0. The table below is the earlier plan.

| Variant | Network / contracts | Bundle / app ID | Distribution |
| --- | --- | --- | --- |
| `dev` | Bonsia (`.env.devnet`), test-wallet harness allowed | `pr.yap.app.dev` | Local, simulators |
| `beta` | Bonsia now; testnet once it runs protocol 14 with the Yappr contract set (D4) | `pr.yap.app.beta` | TestFlight, Play internal/closed |
| `prod` | Launch network (see README › Still open, item 2) | `pr.yap.app` | Stores |
| `foss` (Android) | Same as prod, no FCM, UnifiedPush only | `pr.yap.app` | F-Droid / GitHub releases (1.x; needs Android developer verification from 2026-09-30 in the first regions) |

- **Config at build time.** `lib/constants.ts` reads `NEXT_PUBLIC_*` values.
  Mobile sets the same variables through `app.config.ts` and Babel
  `transform-inline-environment-variables`, so contract IDs have **one
  source**.
- **Contract versions.** The contract version flags (social topology v2 or
  v10 and its successor, DM v3/v4/v5, storefront, blog, pollr) must be set
  **the same as the web deploy on that network**.
  CI fails a mobile build whose flags differ from `.env.<network>`.
- **Versioning.** Semantic versions, with a monotonically increasing build
  number.
- **OTA updates.** Allowed for JS-only fixes, with a runtime version pin.
  - JS drives every signed op, so an update channel is a way to take over
    accounts. Updates are therefore **code-signed** (`expo-updates` code
    signing, with the private key kept offline in the release HSM or
    YubiKey). The app refuses unsigned bundles.
  - Updates are served from a **self-hosted** static update server on
    `updates.yap.pr`, not Expo's, so launches don't contact a third party.
  - OTA updates never change features (Apple 2.5.2). The policy is in
    QA_RELEASE.
- **Minimum OS.** iOS 17 (iOS 18 only if S1 has to lean on `swift-sdk`) and
  Android 10 / API 29, matching `kotlin-sdk`'s minSdk, 64-bit only (arm64,
  plus x86_64 for emulators; the platform builds no armv7 slice). API 29
  differences (Keystore auth parameters, notification action authentication)
  are handled as described in WALLET_INTEGRATION and NOTIFICATIONS. Target
  SDK 36 on Android; build with Xcode 26.
