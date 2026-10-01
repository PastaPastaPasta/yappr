# ADR-001: How Yappr Mobile 1.0 is built

- **Status:** accepted, 2026-10-01.
- **Supersedes:** the engine decision in [ARCHITECTURE.md](ARCHITECTURE.md), the Phase 0 spike plan and G0 gate, the 26-week phases and staffing in [README.md](README.md), and the "Y5 seams" dependency.
- **Inputs:** two independent architecture proposals (one from a Fable advisor, one from an Opus advisor), reconciled by the mobile lead, plus an inventory of the web app.

## Context

- **Who builds it.** 1.0 is built by AI agents working in parallel git worktrees, measured in days. Work lands as reviewed PRs to `staging`.
- **The contract keeps changing.** Social went v2 → v9 → v10 → v11 → "full M" in a few weeks. `lib/` already tracks each change behind `lib/contract-topology.ts`.
- **The network moved.** Bonsia is abandoned. The devnet is now **sakura** (Platform 5.0.0-beta.1, protocol 14). The web pins evo-sdk through `package.json` (#606 moves it to 5.0.0-beta.1).
- **The Rust SDK is not a shortcut.** rs-sdk at `v5.0.0-beta.1` can do everything Yappr needs. But the JSON-to-query and result-shaping glue in wasm-sdk is about 31k lines that would have to be ported, then re-verified on every platform beta. A uniffi-bindgen-react-native build is pre-1.0, and Android cross-compiles of rs-sdk take tens of minutes.
- **No wallet does App Connect yet.**

## Decisions

### E1: Engine. The web stack runs in a hidden WebView, behind a domain-level RPC.

1.0 runs a headless **engine** inside one hidden, never-rendered WebView. The engine is an esbuild bundle of:
- `@dashevo/evo-sdk`, the exact version web pins in the root `package.json`;
- the web domain layer `lib/` and `vendor/platform-auth`, **unmodified**;
- `mobile/engine/src/api/*`, a curated API that calls into the `lib/` services.

The React Native UI never calls the SDK. It calls the engine API through a typed proxy, with **one RPC per user-level operation** (for example `feed.home`, `posts.create`, `dm.send`), and listens for engine events.

Why this works:
- Protocol and contract churn cost mobile nothing beyond a rebuild of the engine, because `lib/` absorbs every topology change once, for web and mobile alike.
- Web's real write path (`lib/manual-batch.ts`, `state-transition-service.ts`) runs as-is, in a real browser runtime with `crypto.subtle`, `TextEncoder`, `fetch` and WebAssembly. No Hermes polyfills or module shadowing are needed.

**Interface.** The RN side imports **types only** from `mobile/engine/src/api` (`type EngineApi`). The proxy is generic: `engine.api.<module>.<method>(...args)` sends `{id, path, args}`, and the engine dispatches by `path`. Adding a method is one function in the engine plus its type. Bridge code never changes. A codec carries `Date`, `Uint8Array`, `bigint`, `Map`, `Set`, `undefined` and `Error` (with `name`, `message` and `code`) across the boundary.

Errors keep **verbatim evo-sdk messages**, so `lib/error-utils.ts` classification works on both sides.

**What happens later.** The Rust engine (`yappr-platform` over rs-sdk + uniffi) is a **post-1.0 track** and is required before mainnet. It implements the same `EngineApi`, either as `lib/` on Hermes over a Rust `PlatformSdk` or ported, and must pass the same engine contract tests. When it lands, the native signer removes private keys from the JS heap and Lockdown Mode stops mattering.

**Accepted 1.0 costs:**
- **Keys in the WebView heap.** They are signed with as on web today. The OS keystore is the store of record. Documented in the audit scope.
- **Lockdown Mode.** iOS Lockdown Mode disables WebAssembly. The app detects this and shows an explanation with the exclusion steps.
- **Foreground only.** There is no background sync in 1.0.
- **Cold-boot cost.** About 25 MB of WASM compiles at boot. The UI shows the persisted cache immediately, and the boot is measured in the engine PR.

**Engine host rules:**
- Exactly one WebView instance, kept out of the visual tree: zero-size, never focused, never rendering content.
- A supervisor restarts it on `onContentProcessDidTerminate` / `onRenderProcessGone` and replays in-flight **reads**. Writes are never replayed blindly; they go through the `unconfirmed-writes` rules.
- Calls made during boot are queued.

**Storage inside the engine:**
- `localStorage` is replaced by a synchronous in-memory map. It is hydrated from MMKV at boot, written through over the bridge, and namespaced per network.
- Keys starting `yappr_secure_` go to the Keychain / Keystore (`expo-secure-store`) instead of MMKV, so `lib/secure-storage.ts` works unchanged.
- App lifecycle: RN `AppState` dispatches synthetic `visibilitychange` / `pagehide` events into the engine, so DM v5 flushes still happen.

### E2: Domain layer. No changes to web `lib/` for 1.0.

- The engine uses `lib/` as-is. Anything browser-bound that does not work headless is swapped with an esbuild alias **inside `mobile/engine`**.
- The RN app imports from `lib/` only **types**, plus an allow-listed set of pure modules for formatting and validation, for example `lib/compose/limits`, `lib/post-helpers`, `lib/sensitive-content`, `lib/utils/format` and `lib/contract-topology` predicates. A lint rule in `mobile/` fails on anything else, and on anything that reaches `@dashevo/*`.
- Web edits are limited to:
  - root `tsconfig.json` `exclude: ["mobile"]`;
  - `eslint` and `knip` ignores for `mobile/**`;
  - a path-filtered CI workflow;
  - small additive, behavior-neutral exports if an engine API truly needs one. Any such export follows the full web checklist (lint, unit, build, and e2e where relevant).

### E3: UI stack. Expo, native screens, and the web's own design tokens.

- **Framework:** Expo SDK 57 (React Native 0.87, New Architecture), prebuild with a dev client (no Expo Go), and `expo-router`.
- **Lists and media:** FlashList 2 for lists, `expo-image` for images.
- **Gestures, motion and feedback:** Reanimated, Gesture Handler, `expo-haptics`.
- **Sheets:** `@gorhom/bottom-sheet` or native sheets for bottom sheets.
- **Data:** TanStack Query, persisted to MMKV, for engine data. Zustand for UI state.
- **Styling:**
  - NativeWind 4. `mobile/app/tailwind.config.js` uses the root `tailwind.config.js` theme as a preset, so `yappr-*`, `neutral-750/850`, `shadow-yappr` and the gradients are the same tokens as web.
  - Dark mode follows the system by default, with a Light / Dark / System setting as on web.
  - Fonts: the system fonts (SF Pro / Roboto) match web's `-apple-system`/Roboto stack.
- **Icons:** Heroicons (`react-native-heroicons`), outline by default and solid when active, matching web.
- **Fidelity to web:** port `components/ui/*`, `components/post/*` and `components/profile/*` **class-for-class** where it makes sense. Fix the web's purple inconsistency: generic spinners, inputs and buttons use `yappr`; purple is reserved for private and encrypted content.

### E4: Navigation and native UX (where 1.0 deliberately differs from mobile web)

- **Tabs.** Five tabs: **Home, Explore, Notifications, Messages, Profile.** Notifications become a primary tab, because it is native convention and the web hides them under "Menu".
  - A floating **compose button** (56 px, `bg-yappr-500`, `shadow-yappr-lg`) sits on Home, Explore and Profile.
  - Settings, Bookmarks, Followers, Following and Blocked are reached from Profile (your own) and a header menu.
- **Feed.** Tabs are **For You / Following**, in web order, with a Recent / Top sort where the topology supports it.
  - Native pull-to-refresh is added; the web has none.
  - The "Show N new posts" pill is kept and polls every 15 s while in the foreground.
- **Compose.** A full-screen modal sheet.
  - **Drafts persist**, unlike web.
  - Threads of up to 10 posts, as web.
  - Haptics on post, like and repost. Native share sheet. Long-press context menus mirror the web "⋯" menu.
- **Network indicator.** A compact amber "DEVNET" / "TESTNET" chip in the Home header and Settings replaces the web's full-width banner.
- **Native conventions.** Large titles on iOS, the Android back gesture, edge-to-edge layout, and safe areas.

### E5: Sign-in for 1.0

1. **Wallet key exchange (`dash-key:`).** Uses the existing `vendor/platform-auth` yappr protocol.
   - On the same device, the app deep-links to the wallet. Across devices, it shows a QR code.
   - The app polls for the response. First-login key registration goes through the `dash-st:` unsigned IdentityUpdate.
   - This is the default method.
2. **Private key entry**, under "Other ways to sign in": WIF or hex. The identity is found with `identities.byPublicKeyHash`, and the key must match an AUTH key.
3. **App Connect.** The method, return route and session model are implemented against `platform/docs/protocol/app-connect.md` behind `FEATURE_APP_CONNECT`. It stays off until a wallet ships it.
4. **Testing without a wallet.** A Node **test-wallet responder** (`mobile/tools/test-wallet-responder.mjs`) answers `dash-key:` and `dash-st:` requests for a pool identity on sakura. Maestro and agents drive real wallet-style round trips with it. No dev backdoor URLs and no secrets baked into builds.

- **Accounts.** Multiple accounts, each scoped by network and identity. Optional biometric unlock.
- **Not on mobile in 1.0:** passkey and password vaults.

### E6: Networks and build variants

| Variant | Bundle id | Network | Purpose |
| --- | --- | --- | --- |
| `devnet` | `pr.yap.app.dev` | sakura, from `.env.devnet` | Development, agents, Maestro, internal QA |
| `testnet` | `pr.yap.app.beta` | testnet, the production yap.pr contracts (topology v2) | Read-heavy dogfooding with real data |
| `production` | `pr.yap.app` | mainnet (later) | Store launch; out of scope until mainnet |

- The engine bundle is built per variant from the matching env file. It never hard-codes contract ids or topology.
- Writes by automated tests go **only** to sakura pool identities.

### E7: 1.0 scope

**In:**
- **Onboarding:** welcome, sign-in, EULA / community-rules gate, signed-out browsing.
- **Home:** For You and Following, Top where supported, the new-posts pill, pull-to-refresh, infinite scroll.
- **Post detail:** the thread with replies, removed and deleted stubs, and engagements (likes, quotes, reposts).
- **Compose:** post, reply, quote, threads, mentions with autocomplete, hashtags, the NSFW flag, the character and byte counter, persisted drafts, and write-status UI (posting / not confirmed: check again / failed: retry).
- **Engagement:** like, repost, bookmark (with a Bookmarks screen), share, and delete your own post.
- **Profiles:** posts, replies, top and mentions tabs; follow and unfollow; followers and following lists; edit the profile (DashPay `profile` + `yapprProfile` on v10/v11, the v2 profile on testnet), with avatar by URL or DiceBear style.
- **Explore:** search for users, hashtags and posts; trending; top posts and creators where supported; hashtag pages.
- **Notifications:** in-app, polled in the foreground, with filters, mark-visible-read and per-type toggles.
- **Messages:** DM v5 1:1 and groups (create, rename, members, leave); on testnet builds, legacy 1:1 DMs through the same conversation UI.
- **Safety:**
  - block and unblock, blocked list, block messages;
  - report posts and replies, wherever the topology takes reports;
  - the NSFW gate (Warn / Show / Hide);
  - the gate on media from accounts you don't follow;
  - removed-content stubs.
- **Settings:** account (identity, balance, names), notifications, privacy (link previews, media gate, NSFW mode, read receipts), appearance (theme), about, terms and privacy, and engine diagnostics.
- **Display:** media from IPFS with gateway fallback, link previews and polls (read-only).

**Deferred, post-1.0:**
- push, relay and NSE; background sync;
- private feeds: an encrypted post renders a "Private post" placeholder;
- tips; storefront; blog; poll voting; DPNS registration (links out to web); image upload (Storacha/Pinata);
- profile and DM reports (wait for the contract cut); account deletion (required before a public store release);
- moderator tools; iPad; localization; the Rust engine.

### E8: Testing

- **Unit:** the root Vitest suite is unchanged. `mobile/app` uses jest-expo with React Native Testing Library. `mobile/engine` uses Vitest for the codec, shims and API mappers.
- **Engine contract tests:**
  - The engine API runs in Node against the live network.
  - Reads are unauthenticated and run on every engine PR.
  - Writes use sakura pool identities from the sakura ops `identities.json`; they are never committed. They run serially with retries for DAPI flakiness.
  - The Rust engine must later pass the same suite.
- **UI E2E:** Maestro on the iOS simulator and the Android emulator.
  - Flows: signed-out browse, key sign-in, key exchange through the responder, post, like, reply, follow, a DM round trip, block and report.
- **Visual evidence:** every UI PR includes iOS and Android screenshots in light and dark mode, taken with `xcrun simctl io` / `adb exec-out screencap`, plus a dev-only `/__gallery` route that renders every primitive.

### E9: Delivery

Waves of parallel PRs. Each PR is owned by one agent in its own worktree off `staging`, kept under about 2.5k lines (excluding lockfiles and generated files), locally reviewed, then thepastaclaw-reviewed when the queue allows. [EXECUTION.md](EXECUTION.md) has the PR map.

## Consequences and what this overturns

These are overturned in the older docs:
- **The engine:** Rust-first becomes a post-1.0 track.
- **The plan:** the S1–S6 spikes, the G0 gate, the 26-week calendar and the staffing table.
- **Web changes:** the Y5 seam PRs to web `lib/` are removed from 1.0.
- **The network:** bonsia → sakura.
- **D1 is relaxed for non-production builds:** key entry and key exchange are allowed.
- **Notifications:** push, relay and NSE move to 1.1, so 1.0 is in-app only.
- **The test wallet:** the test-wallet *app* becomes a Node responder.

These stand:
- the product principles and copy rules in [PRODUCT_UX.md](PRODUCT_UX.md), except where E4 changes navigation;
- the compliance requirements, with account deletion and moderation gating before a public store release;
- no analytics or crash SDKs;
- topology-driven UI.
