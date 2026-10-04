# Yappr Mobile 1.0: execution plan

- **Status:** plan of record, 2026-10-01. It implements [ADR-001](ADR-001-mobile-1.0.md) E9.
- **Replaces:** the phases, milestones, calendar and staffing in [README.md](README.md) for 1.0.
- **Companion:** [ENGINE.md](ENGINE.md), which most engine PRs here implement section by section.

## How work is done

- **One PR, one agent, one worktree.** Every PR is owned by one agent working in its own git worktree, branched off `staging` (or off its parent, for a stack). It is kept under about **2.5k changed lines**, not counting lockfiles and generated files. If a PR outgrows that, split it along the "split as" column of the PR map.
- **Agents do not push or open PRs.** The mobile lead does both, then babysits each PR until it merges (§5).
- **Branches** are named `mobile/<topic>`, for example `mobile/engine-core` or `mobile/screen-home`. Fix PRs from QA are `mobile/fix-<defect-id>`.
- **Evidence** goes to `/tmp/claude/yappr-mobile/evidence/<branch-topic>/` and is embedded in the PR (§6).
- **Write safety.** Automated tests write **only** to sakura pool identities. Nothing automated writes to the testnet production contracts (ADR E6).

## 1. Prerequisites outside `mobile/` (the web track)

Mobile does not own these, but some PRs wait on them.

| ID | What | State, 2026-10-01 | Blocks |
| --- | --- | --- | --- |
| W-606 | #606: blog v6, the contract tooling, and the evo-sdk / wasm-sdk pin at **5.0.0-beta.1** (base `staging`) | open | Engine builds that talk to sakura (5.0 protocol). Testnet reads work on the current pin. |
| W-SAKURA | `.env.devnet` cut over to sakura (DAPI list, `NEXT_PUBLIC_DEVNET_NAME`, quorum URL), Yappr contracts published, and a `devnet-<name>` contract snapshot added to `lib/contracts/bundled/` | contracts held for the v11 cut | Every sakura read and write test; Maestro write flows; the M3 live test |
| W-607 | #607: social **v11**, stacked on #606 | open | Nothing structurally: the engine follows `lib/contract-topology.ts`. Screens that show v11-only features. |
| W-FULLM | The "full M" social re-cut after #607 | planned | As W-607; expect one mid-build engine rebuild |
| W-WELLKNOWN | `public/.well-known/apple-app-site-association` and `assetlinks.json` for app links | not started | M8 (deep links) universal links only; custom-scheme links work without it |
| W-ERR | *(optional)* export three private predicates from `lib/error-utils.ts` (ENGINE §7.3) | not started | Nothing. M7a may use the string fallback instead. |

**Until W-SAKURA lands:**
- Engine PRs prove reads against **testnet**, with the `testnet` variant.
- Write suites are written and run in their unit-level form.
- The live sakura write suite is **required before Wave 4 closes**, not before each Wave 2 PR merges (see the M7a/M7b exit checks).

## 2. Waves and dependencies

```
Wave 0   M0 docs ───────────────────────────────────────────────────────────────┐
Wave 1   M1 scaffold        M2 engine core        M3 test-wallet responder      │ (all parallel)
            │   │               │   │                   │                       │
Wave 2   M5 design system   M4 EngineHost (M1+M2)   M6 reads (M2)   M7a session+writes core (M2)
            │                   │                     │               │
            │                   │                     │             M7b domain writes (M7a)
Wave 3   S1 sign-in (M4,M5,M7a; M3 for Maestro)   S2 home (M4,M5,M6)   S3 thread (M4,M5,M6)
         S4 compose (M7b)   S5 engagement+bookmarks (M7b)   S6 profiles+graph (M6,M7b)
         S7 explore (M6)   S8 notifications (M7b)   S9 safety (M7b)   S10 settings (M7b,M4)
         M-DM engine DMs (M7a)                                         (all parallel)
Wave 4   S11 DM screens (M-DM, M4, M5)   M8 deep links   M9 Maestro suite + CI
         M10 release plumbing (M1)   M11 Android polish sweep (all of Wave 3)
Wave 5   Q1 QA pass on both platforms → fix PRs (one per defect)
Post-1.0 R1–R5 Rust engine · N1–N3 push / relay / NSE · background sync
```

**Parallelism.**
- Wave 1 is fully parallel (three agents). M1 and M2 touch disjoint trees: `mobile/app` and `mobile/engine`.
- Wave 2 is four or five agents in parallel. M7b starts as soon as M7a's API skeleton and ticket store merge.
- Wave 3 is up to eleven agents in parallel. M1 creates a stub route file for every screen, so a screen PR edits **its own route files and adds files under its own feature folder**. It does not edit shared files (§5.4).
- Wave 4 PRs are parallel except M11, which runs after the Wave 3 screens merge.

## 3. PR map

Notation:
- **Deps** are PRs that must be merged first. "Stack on X" means the PR may branch from X before X merges (§5.3).
- **Exit checks** are the commands and observations that must pass.
- **Evidence** is what the PR body must contain.

The common definition of done (§4) applies to every PR in addition to its row.

### Wave 0

| ID | Title (conventional commit) | Scope | Owns | Deps | Exit checks | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| **M0** | `docs(mobile): ADR-001, engine spec and the 1.0 execution plan` (plus the PRD and UX spec commits from the product agent) | ADR-001; ENGINE.md; EXECUTION.md; PRD.md; UX_SPEC.md; status notes in README, ARCHITECTURE and PRODUCT_UX | `docs/mobile/**` | — | Links resolve; no contradiction with ADR-001 (reviewer checks) | — |

### Wave 1

| ID | Title | Scope | Owns | Deps | Exit checks | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| **M1** | `feat(mobile): Expo app scaffold, route stubs, NativeWind and CI` | See the M1 notes below. | `mobile/app/**`, `mobile/CLAUDE.md`, `.github/workflows/mobile.yml`; root `tsconfig.json`, `.eslintrc.json`, `knip.json` (exclude lines only) | M0 | See the M1 notes below. | Screenshots of the tab shell on both platforms in light and dark; the CI run link |
| **M2** | `feat(mobile/engine): engine bundle, RPC protocol, codec, shims and Node harness` | `mobile/engine` per ENGINE §2, §4, §5, §9, §10, §12:<br>• the esbuild build per variant with aliases, `define`s, the CSP and `manifest.json`;<br>• `protocol/` (envelope, codec, methods, DTO and error types);<br>• `bootstrap.ts` with the storage, secure-routing, lifecycle, event, console and toast shims;<br>• `engine.ts` with the registry, `engine.info`, `engine.ping` and `diagnostics.*` (`snapshot`, `reconnect`, `recentQueries`);<br>• the Node harness;<br>• the Playwright browser-boot proof in webkit and chromium. | `mobile/engine/**` | M0 | `npm --prefix mobile/engine run build:testnet`, `build:devnet`, `test` (codec vectors, storage routing, lifecycle, registry parity) and `test:browser`. The bundle checks of ENGINE §12.4. A harness boot to `ready.sdk` on testnet. | Boot timings (webkit, chromium, Node); bundle sizes for the single-instance alias vs. stock (O2); `isSecureContext`, worker and CSP results for `file://` and `127.0.0.1` (O1, browser part); testnet DAPI CORS with `Origin: null` (O8) |
| **M3** | `feat(mobile/tools): test-wallet responder for dash-key and dash-st` | See the M3 notes below. | `mobile/tools/**` | M0 | Unit test (no network): a request built with `buildYapprKeyExchangeUri` is answered, then decrypted with `decryptYapprKeyExchangeResponse` and `deriveYapprAuthKeyFromLogin`. A `dash-st:` transition parses and signs. **Live** (after W-SAKURA): an engine harness sign-in through the responder. | Unit-test log; the live run log once sakura is up (key ids only, no secrets) |

**M1 notes.**
- **Scope:**
  - Expo SDK 57 (RN 0.87, New Architecture) with a dev client and prebuild (no Expo Go). TypeScript strict.
  - `expo-router` with **a stub route for every 1.0 screen**: the 5 tabs; post, thread and engagements; compose (modal); profile and edit; followers and following; bookmarks; hashtag; search; notifications; messages, conversation, new chat and group info; settings and its sections; blocked; welcome, sign-in, key entry and key exchange; EULA; Lockdown; diagnostics; `/__gallery`.
  - NativeWind 4, with `mobile/app/tailwind.config.js` taking the root `tailwind.config.js` as a preset.
  - `app.config.ts` variants `devnet` / `testnet` / `production` (bundle ids per ADR E6).
  - jest-expo and RNTL.
  - The import lint rule: only allow-listed `lib/` modules, types only from `mobile/engine/src/api`, and `mobile/engine/src/protocol/*`; fail on `@dashevo/*`.
  - Root excludes: `tsconfig.json` `exclude: ["mobile"]`, an ESLint ignore of `mobile/**`, a knip ignore of `mobile/**`.
  - `.github/workflows/mobile.yml`, path-filtered on `mobile/**`, `lib/**`, `vendor/platform-auth/**`, `types/**`, `package*.json`, `.env.*` and `tailwind.config.js`, with jobs:
    - app: typecheck, lint, jest;
    - engine: build and unit;
    - engine: read contract (testnet).
  - `mobile/CLAUDE.md`: the validation checklist, the screenshot recipe, the sandbox notes and the allowlist rule.
- **Exit checks:**
  - `npm --prefix mobile/app run typecheck`, `lint` and `test` pass.
  - The dev client builds and launches on the iOS simulator ("Yappr iPhone 17") and the Android emulator (`yappr_pixel`), showing the tab shell with every stub route reachable.
  - Root `npm run lint`, `npm run test`, `npm run build`, `npx tsc --noEmit` and `npm run lint:dead` all pass with **no change** in web output.
  - The new workflow is green.

**M3 notes.**
- **Scope:** `mobile/tools/test-wallet-responder.mjs`, a Node tool built over `vendor/platform-auth/src/key-exchange/yappr-protocol.ts` (bundled with the engine's esbuild).
  1. **`dash-key:` request.** It parses the URI (`parseYapprKeyExchangeUri`) and derives a **deterministic** login key per (identity, app contract) from the pool identity's CRITICAL key with HKDF. Deterministic means a re-login yields the same derived keys. It then does ECDH with the app's ephemeral public key, encrypts with AES-GCM, and writes the `loginKeyResponse` document on the key-exchange contract, signed with the identity's HIGH key.
  2. **`dash-st:` request.** It parses the unsigned IdentityUpdate, signs it with the MASTER key (keyId 0) and broadcasts it.
  3. **Interfaces:** a CLI (`--uri <uri> --persona <idx>`) and an HTTP server (`--serve 127.0.0.1:8789`, `POST /respond {uri, persona}`), so Maestro `runScript` can drive it.
- **Secrets:** it reads the pool from `YAPPR_SAKURA_IDENTITIES` (ENGINE §12.3) and never prints keys.
- **Docs:** `mobile/tools/README.md`.

### Wave 2

| ID | Title | Scope | Owns | Deps | Exit checks | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| **M4** | `feat(mobile): EngineHost with supervisor, storage bridges and diagnostics` | See the M4 notes below. | `mobile/app/src/engine/**`, `mobile/app/plugins/engine-assets/**`, `mobile/app/modules/background-flush/**`, the Lockdown, WebView-update and diagnostics route files | M1, M2 | See the M4 notes below. | Simulator and emulator screenshots (light and dark) of diagnostics, Lockdown (forced) and the WebView-update screen; the crash and restart logs; a timings table |
| **M5** | `feat(mobile): design system primitives, PostCard and the component gallery` | See the M5 notes below. | `mobile/app/src/ui/**`, `mobile/app/src/app/__gallery*` | M1 | jest-expo and RNTL tests for the primitives' states. The gallery renders every primitive in light and dark on both platforms. | Gallery screenshots, 4 per platform-theme pair at least; side-by-side PostCard vs. web at 390 px |
| **M6** | `feat(mobile/engine): read API (feed, posts, profiles, graph, explore)` | ENGINE §6.3: `feed.*`; `posts.get`, `thread`, `engagements`, `engagementCounts`, `poll`, `mentionCandidates`; `profiles.get`, `posts`, `batch`; `graph.followers`, `following`, `status`; `explore.*`; `engage.stats` (anonymous); the DTO mappers (`dto/*`); cursors. **Split as** M6a (feed and posts) and M6b (profiles, graph, explore) if it exceeds 2.5k lines. | `mobile/engine/src/api/{feed,posts,profiles,graph,explore}.ts`, `src/dto/**`, `test/contract/read/**` | M2 | The read contract suite (ENGINE §12.3) passes on **testnet** and, once W-SAKURA lands, on sakura. Parity check: `feed.home` For You page 1 equals `loadForYouFeed` ids. DTO validators pass for every method. | Contract test report (per-method ms); a sample DTO dump for one feed page (redacted) |
| **M7a** | `feat(mobile/engine): session, write tickets and error classification` | ENGINE §6.3 `session.*` (key sign-in incl. hex, key exchange and registration, accounts, switch, sign-out, balance), `writes.*`, `settings.*`; §7 (tickets, persistence, `check`, `retry`, `classify` and its vectors); events `session.*`, `write.status`, `engine.notice`. | `mobile/engine/src/api/{session,writes,settings}.ts`, `src/writes/**`, `test/fixtures/error-vectors.json`, `test/contract/write/{session,tickets}.test.ts`, `harness/pool.ts`, `test/contract/write/slots.json` | M2; stack on M6 is allowed | Unit: classify vectors, ticket transitions, restart reconciliation (pending → unconfirmed). Contract (sakura, after W-SAKURA): sign-in with key (hex and WIF), restore, switch, sign-out; key exchange through M3. Before W-SAKURA: the session reads with a testnet identity that has **no writes**, and the write tests skip with a reason. | The write-suite log (identity ids only); the classify table coverage report |
| **M7b** | `feat(mobile/engine): domain writes, notifications and safety` | ENGINE §6.3: `posts.publish`/`delete`; `engage.*` writes and `bookmarks`; `profiles.update`; `graph.follow`/`unfollow`; `safety.*`; `notifications.*`; events `content.created` and `notifications.count`. **Split as** M7b-1 (posts, engage, graph) and M7b-2 (profiles, safety, notifications) if needed. | `mobile/engine/src/api/{engage,safety,notifications}.ts` plus the write halves of `posts.ts`, `profiles.ts` and `graph.ts` (coordinate with M6: M7b adds functions, never edits M6's) | M7a | Unit: every write method's ticket mapping (ENGINE §7.1) with stubbed `lib/` results. Live: the write contract scenarios of ENGINE §12.3 on sakura (pool slots 90–99, serial, with retries only on transient codes) and a notifications read for a pool identity. Before W-SAKURA, the live suite skips with a reason, and its first green run is tracked to close before Wave 4 ends (§1). | Write-suite log; the credit spend per run |

**M4 notes.**
- **Scope** (ENGINE §1, §3, §9, §11):
  - the single hidden `react-native-webview` mounted in the root layout;
  - the `WebViewTransport`, the generic typed proxy (`engine.api.*`) and the event bus;
  - the supervisor (states, restart backoff, ping, read replay, epochs);
  - the boot queue;
  - the MMKV kv bridge per network and the encrypted MMKV;
  - the `expo-secure-store` bridge with key encoding and the per-identity index;
  - the `AppState` and NetInfo lifecycle bridge with the background flush, including a minimal local Expo module for the iOS background window (`mobile/app/modules/background-flush`, ENGINE §3.4);
  - the Lockdown and WebView-outdated screens;
  - the diagnostics screen (timings, health, logs ring buffer, Reconnect, Reset devnet data; now "Troubleshooting", SET-08);
  - a config plugin that copies `mobile/engine/dist/<variant>` into the iOS bundle and the Android assets;
  - the TanStack Query client, persisted to MMKV, with DM keys excluded.
- **Exit checks:**
  - Boot to `ready.sdk` on the iOS simulator and the Android emulator (testnet; sakura when available).
  - Day-1 checks O1 (devices), O3 and O4 settled and recorded.
  - **Forced crash:** iOS, kill the WebContent process; Android, kill the renderer → the supervisor restarts, and an in-flight read is replayed.
  - A forced `pending` ticket becomes `unconfirmed` after the restart.
  - Backgrounding flushes within 2 s.
  - Logs are redacted (the ENGINE §11.2 test).

**M5 notes.**
- **Scope** (ADR E3; class-for-class ports of `components/ui/*` and `components/post/*`):
  - Button (cva variants), IconButton, Switch, Card, sheet and modal, ConfirmDialog, Spinner, LoadingState, EmptyState, Tabs, RadioGroup and skeletons;
  - Avatar (URI and local DiceBear);
  - a **presentational** PostCard from `PostDTO` fixtures, with the action bar, quote embed, removed and deleted stubs, the NSFW cover, the media gate placeholder and the "Private post" placeholder;
  - RichText (mentions, hashtags, links) through the allow-listed parsers;
  - relative time and number formatting;
  - the NetworkChip;
  - `react-native-heroicons`;
  - generic purple replaced by `yappr` (purple is kept for private content).

### Wave 3 (screens, in parallel)

Every Wave 3 screen PR:
- uses only the `EngineApi` through TanStack Query hooks in its own feature folder (`mobile/app/src/features/<feature>/**`);
- fills in its own stub route files;
- adds or extends its **Maestro flow** under `mobile/e2e/flows/smoke/` (signed out, read only) or `mobile/e2e/flows/full/` (signed in, sakura writes), built on the shared subflows (`mobile/e2e/README.md`);
- carries iOS and Android screenshots in light and dark, plus a side-by-side with the matching web page at a 390 px viewport (Playwright).

| ID | Title | Scope | Deps | Exit checks (in addition to §4) |
| --- | --- | --- | --- | --- |
| **S1** | `feat(mobile): onboarding and sign-in` | See the S1 notes below. | M4, M5, M7a; M3 for the Maestro flow | Maestro: signed-out browse; key sign-in (WIF typed through `-e`); key exchange through the M3 responder (sakura) |
| **S2** | `feat(mobile): home feed` | For You / Following tabs; Recent / Top sort and window where `capabilities.rankings`; FlashList; infinite scroll; native pull-to-refresh; the "Show N new posts" pill (`feed.checkNew` every 15 s while foregrounded); cached first paint from MMKV; network chip in the header; compose FAB | M4, M5, M6 | Maestro: scroll, refresh, switch tab; pill appears after a post by another pool identity (sakura) |
| **S3** | `feat(mobile): post detail, thread and engagements` | Thread with ancestors, replies (one indent level, author thread line), load more, removed and deleted stubs; the engagements screen (likes / reposts / quotes) | M4, M5, M6 | Maestro: open a thread from the feed, paginate replies |
| **S4** | `feat(mobile): compose` | See the S4 notes below. | M4, M5, M7b | Maestro: post, reply, a 3-part thread; forced timeout shows "check again" and resolves |
| **S5** | `feat(mobile): engagement actions and bookmarks` | Like, repost (with the v10 quote-slot rules and `QUOTE_HAS_TEXT` confirm), bookmark: optimistic and keyed by ticket, reconciled on `write.status`, with haptics. Native share sheet (yap.pr links). Long-press context menu mirroring the web "⋯" menu. Delete own post. The Bookmarks screen. | M4, M5, M7b | Maestro: like, unlike, repost, bookmark, delete own post |
| **S6** | `feat(mobile): profiles and social graph` | Profile header and tabs (posts, replies, top, mentions); follow and unfollow; the followers and following lists; edit profile (DashPay `profile` + `yapprProfile` on v10/v11, v2 profile on testnet) with an avatar URL or the DiceBear style picker; a DPNS-only profile when there is no document | M4, M5, M6, M7b | Maestro: follow and unfollow; edit the display name |
| **S7** | `feat(mobile): explore, search and hashtags` | Trending; Top posts and Creators where supported; search for users, hashtags and posts; the hashtag page (Recent / Top) | M4, M5, M6 | Maestro: search a user and open the profile; open a hashtag |
| **S8** | `feat(mobile): notifications tab` | Filters, list, mark-visible-read, tab badge (`notifications.poll` every 30 s while foregrounded, plus `notifications.count`), tap-through routing, link to the per-type toggles | M4, M5, M7b | Maestro: a like from another pool identity appears and marks read |
| **S9** | `feat(mobile): safety` | Block and unblock (with an optional message), the Blocked list, the report sheet (reasons from `lib/reports.ts`, note ≤ 500, gated by `capabilities.reports`), the NSFW gate modes, the media gate for non-followed authors, removed-content stubs | M4, M5, M7b | Maestro: block hides the author's posts; report a post |
| **S10** | `feat(mobile): settings` | Account (identity, credits, names, switch account, sign out); notifications toggles; privacy (link previews, media gate, NSFW mode, read receipts); appearance (Light / Dark / System); about; terms and privacy; a link to diagnostics | M4, M5, M7a | Maestro: toggle theme; toggle the NSFW mode and verify the gate |
| **M-DM** | `feat(mobile/engine): direct messages (DM v5 and legacy)` | ENGINE §6.3 `dm.*`; the `dm.changed` and `dm.message` events; DM v5 engine lifecycle tied to the session and `AppState`; legacy 1:1 on the testnet variant; contract tests on two pool slots (1:1 round trip; group create, rename, add, leave) | M7a | Legacy read on testnet. DM contract suite on sakura; before W-SAKURA it skips with a reason, and its first green run is tracked to close before Wave 4 ends (§1). |

**S1 notes.**
- **Screens:** Welcome; the EULA and community-rules gate (stored in RN MMKV); signed-out browsing; sign-in.
- **Key exchange:**
  - Same device: `Linking.openURL('dash-key:…')`. Across devices: a QR code.
  - Polling runs with no visible countdown and times out silently into "Check again".
  - A dev-only testID exposes the URI for Maestro.
- **Key registration:** the `dash-st:` step.
- **Other ways to sign in:** key entry (WIF or hex).
- **Not yet shipped:** the App Connect button behind `FEATURE_APP_CONNECT=false`.
- **Accounts:** the account switcher and an optional biometric lock.

**S4 notes.**
- **The sheet:** a full-screen compose modal. Post, reply and quote; threads of up to 10 parts.
- **Mentions** autocomplete after 3 characters (`posts.mentionCandidates`).
- **Hashtags** are highlighted.
- **The NSFW toggle**, and a character and byte counter from `capabilities.contentLimits` (amber at ≤ 50 left, red when over).
- **Drafts** persist in MMKV.
- **Write status:** posting / not confirmed: check again / failed: retry, with thread resume.
- **Haptics** on post.

### Wave 4

| ID | Title | Scope | Deps | Exit checks | Evidence |
| --- | --- | --- | --- | --- | --- |
| **S11** | `feat(mobile): messages` | Inbox, conversation (live via `dm.changed` / `dm.message`, 4 s while open), new chat (user search), group create, rename, members and leave, the hide / block / retention settings; legacy 1:1 through the same UI on testnet | M-DM, M4, M5 | Maestro: a DM round trip between the app and a second pool identity (driven from the harness); a group create | Screenshots ×4; the Maestro run |
| **M8** | `feat(mobile): deep links` | `yappr://` and `https://yap.pr` links for `/post?id=`, `/user?id=`, `/hashtag?tag=` and `/messages?startConversation=`; routing through expo-router; cold-start and warm handling | S2, S3, S6, S7; W-WELLKNOWN for universal links | `xcrun simctl openurl` / `adb shell am start -d` for each link, cold and warm | Screen recordings or screenshots per link |
| **M9** | `test(mobile): Maestro suite and CI` | The shared Maestro harness: launch per variant, sign-in subflows, responder wiring, screenshot steps. The full flow set of ADR E8 (signed-out browse, key sign-in, key exchange through the responder, post, like, reply, follow, DM round trip, block and report). Nightly CI: the engine write suite plus Maestro on the lead's macOS machine or a macOS runner; smoke flows per PR where runner time allows. | S1–S11 (it grows as they land) | The full suite green on both platforms twice in a row | Maestro reports and screenshots |
| **M10** | `build(mobile): icons, splash, signing and store variants` | App icons, splash, display names per variant, bundle and application ids (ADR E6), build numbers, the iOS privacy manifest, the Android 64-bit-only ABI filters, `expo-updates` **off** for 1.0, EAS or local signing config (secrets outside git), TestFlight and Play internal upload scripts | M1 | A signed `devnet` and a signed `testnet` build install on a physical device | TestFlight and Play internal build links |
| **M11** | `fix(mobile): Android polish sweep` | Back gesture and predictive back; edge-to-edge and insets; Material ripple; keyboard handling in compose and DMs; WebView flags re-check; small-screen and API 29 emulator pass | all of Wave 3 | Each screen checked on the Pixel emulator, plus an API 29 AVD | Before and after screenshots per fix |

### Wave 5

| ID | Title | Scope | Exit checks |
| --- | --- | --- | --- |
| **Q1** | `QA pass (no code)` | A full agentic QA run (the `agentic-qa` skill) over the user-story matrix (§7) on both platforms, in light and dark, for both variants. Report with a defect ledger and evidence. | The report is published, and every defect is filed with a severity |
| **F-*** | `fix(mobile): <defect>` | One PR per defect, with before and after evidence | Defect verified fixed; no regression in Maestro |

### Post-1.0

| ID | Title | Scope | Gate |
| --- | --- | --- | --- |
| R1 | `feat(mobile/native): yappr-platform crate skeleton` | A crate on `dash-sdk` at the web's platform tag. It must start from a clean `git worktree add … v5.0.0-beta.1`, not from a dirty platform checkout. It builds for `aarch64-apple-ios(-sim)` and `aarch64`/`x86_64-linux-android`, with an ubrn binding stub. | Builds in CI for all targets |
| R2 | `feat(mobile/native): read PlatformSdk` | The read facade (documents query/get/count/ranked/composite/average, identities, contracts, dpns, epoch) via uniffi | The read contract suite through option H's `InProcessTransport` (ENGINE §13) |
| R3 | `refactor(lib): platform seams` | The Y5 seams (sdk, txBuilder, signer, secrets, kv, lifecycle) in web `lib/`, each with the full web checklist **including e2e** | Web e2e green; no behaviour change |
| R4 | `feat(mobile/native): native signer and writes` | Rust builds and signs state transitions; the native key store; no key in any JS heap | The write contract suite; the heap-inspection test |
| R5 | `feat(mobile): Rust engine transport and parity gate` | `InProcessTransport` or `NativeTransport` selectable; the full parity gate (ENGINE §13) | All seven parity criteria; required before mainnet |
| N1–N3 | push, relay and NSE | Per [NOTIFICATIONS.md](NOTIFICATIONS.md) (the `yappr-push` contract, the relay, the NSE, FCM / UnifiedPush) | 1.1 |

## 4. Definition of done (every PR)

1. **Scope.** The PR matches its row, stays under about 2.5k changed lines (not counting lockfiles and generated files), and touches only the files it owns. Any shared-file edit is called out in the PR body (§5.4).
2. **Mobile checks pass:**
   - `npm --prefix mobile/app run typecheck`, `lint` and `test`;
   - `npm --prefix mobile/engine run build:testnet`, `build:devnet` and `test` (for engine PRs);
   - the engine read contract suite (for engine PRs);
   - the write suite (for M7a, M7b and M-DM once W-SAKURA has landed).
3. **The web is untouched, or still green:**
   - If a root file changed: root `npm run lint`, `npm run test`, `npm run build` and `npx tsc --noEmit`.
   - `npm run lint:dead` if exports or modules changed.
   - `npm run build:testing && npm run test:e2e` if anything under `lib/` changed (ADR E2).
4. **UI evidence:**
   - iOS (`xcrun simctl io booted screenshot`) and Android (`adb exec-out screencap -p`) screenshots, in light and dark, saved under `/tmp/claude/yappr-mobile/evidence/<topic>/` and embedded in the PR. Follow the `capture-visual-evidence` skill: shots must come from the PR's exact revision.
   - New primitives appear in `/__gallery`.
5. **E2E:** a user-facing flow adds or extends its Maestro flow (from S1 on).
6. **Safety:**
   - no secrets in the repo, logs or evidence;
   - no automated writes outside sakura pool identities;
   - nothing sensitive logged (ENGINE §11.2).
7. **Docs:** an `EngineApi` change updates the tables in ENGINE §6 in the same PR, and `METHODS` stays in parity.
8. **Review:**
   - a self-review of the diff, with no debug leftovers;
   - the local `code-review-validator` agent for any multi-file change;
   - `code-simplifier` after a significant amount of new code;
   - findings fixed or answered in the PR.
9. **Commits** are conventional, signed (never `--no-gpg-sign`), and end with the agent attribution trailer. Files are added by path, never with `git add -A`.

## 5. Review and merge protocol

### 5.1 Flow per PR

1. **The agent** finishes in its worktree, meets §4, commits, and reports to the lead: what was built, the files, the commands and their results, the evidence paths, known gaps, and platform or SDK bugs with reproducers.
2. **The lead** pushes the branch and opens the PR against `staging` (or the parent branch, for a stack).
   - The PR body is written to a unique absolute path, `/tmp/claude/yappr-mobile/pr-bodies/yappr-<branch-with-slashes-as-dashes>.md`, never a generic or `$TMPDIR` path (it differs inside and outside the sandbox). After creating or editing the PR, the lead reads the body back with `gh pr view N --json body` and fixes any mismatch first.
   - The lead links the PR to the thread.
3. **Review.**
   - The local review runs before opening; this is what the queue relies on.
   - **thepastaclaw** reviews when its queue allows.
   - It is **required** for engine and security-relevant PRs: M2, M3, M4, M6, M7a, M7b, M-DM, M10, and any PR that touches secrets, storage or the bridge.
   - For screen-only PRs (S1–S11, M8, M11), the lead may merge on green CI plus the local review if the review queue is longer than 4 h. Those PRs are listed for a post-merge review sweep at the end of the wave.
4. **Babysitting** (the `babysit` skill): the lead watches CI and review feedback, fixes valid findings in the same branch, and re-runs flaky jobs.
5. **Merge:**
   - Merge commits, as the repo does (`Merge pull request #…`), so stacks keep their history.
   - Delete the branch after merge.
   - Within a wave, merge in dependency order: M1 before M4 and M5; M2 before M4, M6 and M7a; M7a before M7b and M-DM.
   - Independent PRs merge as they go green.

### 5.2 Order of merges across waves

- **A wave closes** when every PR in it has merged. The next wave may *start* earlier on stacked branches (§5.3), but a PR never merges before its dependencies.
- **Wave 3 screens need their engine dependencies merged.** A screen that only needs M6 does not wait for M7b.

### 5.3 Stacked PRs

- **Starting a stack.** A PR that depends on an unmerged PR branches from the parent's branch and targets it as base. Its title starts with `[stack n/m]`.
- **Depth.** Keep stacks to at most 3 deep.
- **When the parent merges,** the lead:
  - retargets the child to `staging` (`gh pr edit N --base staging`);
  - rebases it with the `rebase-branch` skill (conflicts resolved from the actual blobs, then `git range-diff` to prove nothing was lost);
  - force-pushes with `--force-with-lease`.
- **Never merge a child into its parent branch.** Children merge to `staging` only, after their parent.

### 5.4 Shared files and conflict avoidance

| File or area | Owner | Rule for others |
| --- | --- | --- |
| `mobile/app/src/app/_layout.tsx`, `(tabs)/_layout.tsx` | M1, then M4 (engine mount) | Screen PRs do not edit them. Badges are supplied through the hook each tab layout already calls (stubbed in M1, implemented by S8 and S11). |
| Route stub files | M1 creates; one screen PR owns each | Edit only your own routes |
| `mobile/app/src/ui/**` | M5 | Screens may add feature-local components. A new shared primitive goes in a small follow-up to `ui/`, or in the screen PR with the lead's agreement. |
| `mobile/engine/src/protocol/{methods,dto}.ts` | M2 creates; M6, M7a, M7b and M-DM append | Append-only, in your module's section. Rebase conflicts there are mechanical. |
| `mobile/engine/src/api/index.ts` (registry) | M2 | Each module registers with one line |
| Root `package.json` and lockfile | nobody in 1.0 | Mobile has its own `package.json` files. The engine resolves the SDK from root `node_modules` and must not add root dependencies. |
| `.github/workflows/mobile.yml` | M1, then M9 | Other PRs propose changes in their body; the lead applies them |

No barrel files (`index.ts` re-exports) in `mobile/app`; import by path. That keeps parallel PRs from colliding on one file.

## 6. Evidence conventions

- **Screenshots:** `<platform>-<theme>-<screen>[-<state>].png`, for example `ios-dark-home-pill.png`, taken on "Yappr iPhone 17" (iOS 26.5) and `yappr_pixel` (API 35).
- **Web comparison:** `web-<theme>-<page>.png` at a 390 × 844 viewport from the `/devnet` or `/testing` deploy matching the variant.
- **Logs:** contract test reports (`*.json`), Maestro reports, and boot timing tables, as Markdown in the PR body.
- **Never in evidence:** keys, seed phrases, `identities.json` content, or decrypted DMs from real users. Pool identities' public ids are fine.

## 7. 1.0 release exit criteria

1.0 ships as **signed TestFlight and Google Play internal or closed-track builds** of the `devnet` (sakura) and `testnet` variants. A public store release additionally needs the [COMPLIANCE.md](COMPLIANCE.md) blockers, account deletion first among them (ADR E7). Both of these are required.

**QA matrix: every cell passes on both platforms with evidence.**

| User story (ADR E7) | iOS light | iOS dark | Android light | Android dark | Variants |
| --- | --- | --- | --- | --- | --- |
| Signed-out browse: welcome, feed, thread, profile, explore | ✓ | ✓ | ✓ | ✓ | devnet, testnet |
| Sign in: key exchange (responder on devnet; DashPay store wallet on testnet), key entry WIF and hex, key registration, restore, switch account, sign out | ✓ | ✓ | ✓ | ✓ | both (store wallet: testnet only) |
| EULA gate; Lockdown screen (physical iPhone, TestFlight) | ✓ | ✓ | ✓ | ✓ | devnet |
| Home: For You and Following, Top where supported, pill, pull-to-refresh, infinite scroll | ✓ | ✓ | ✓ | ✓ | both |
| Thread: replies, removed and deleted stubs, engagements | ✓ | ✓ | ✓ | ✓ | both |
| Compose: post, reply, quote, a 10-part thread, mentions, hashtags, NSFW, counter, drafts, check again / retry | ✓ | ✓ | ✓ | ✓ | devnet (writes) |
| Engagement: like, repost, bookmark and Bookmarks, share, delete own | ✓ | ✓ | ✓ | ✓ | devnet (writes) |
| Profiles: tabs, follow, lists, edit (DashPay + extension on devnet) | ✓ | ✓ | ✓ | ✓ | both (edit: devnet) |
| Explore: search users, hashtags, posts; trending; Top and Creators where supported; hashtag page | ✓ | ✓ | ✓ | ✓ | both |
| Notifications: filters, mark-visible-read, badge, toggles | ✓ | ✓ | ✓ | ✓ | devnet |
| Messages: DM v5 1:1 and groups (devnet); legacy 1:1 read (testnet) | ✓ | ✓ | ✓ | ✓ | both |
| Safety: block / unblock / list, report, NSFW modes, media gate, removed stubs | ✓ | ✓ | ✓ | ✓ | devnet (writes) |
| Settings: account, notifications, privacy, appearance, about, terms, diagnostics | ✓ | ✓ | ✓ | ✓ | both |
| Deep links: cold and warm | ✓ | — | ✓ | — | both |
| Engine resilience: forced WebContent / renderer kill recovers; background flush; offline → online recovery | ✓ | — | ✓ | — | devnet |

**Gates.** All of these must hold:

1. Every PR in Waves 0–4 has merged. The Q1 defect ledger has **no open P0 or P1**, and every P2 is triaged with an owner.
2. The Maestro full suite is green on both platforms in **3 consecutive** nightly runs.
3. The engine contract suites (reads on both variants, writes on sakura) are green in **3 consecutive** nightly runs.
4. Cold boot to `ready.sdk`, and p50 `feed.home`, are within 20 % of the baseline M4 recorded on the same simulator and emulator. Cold start shows cached content before the engine is ready.
5. The security checklist of ENGINE §11 is verified, with evidence:
   - the redaction test;
   - the CSP;
   - navigation blocked;
   - the Keychain accessibility class;
   - DM plaintext excluded from persistence;
   - no secrets in the repo (a secret scan of `mobile/**`).
6. Signed `devnet` and `testnet` builds install and run from TestFlight and from Play internal on at least one physical iPhone and one physical Android device.
7. ENGINE §14's open items O1–O5 and O8 are closed. O6 and O7 are filed as web issues.
