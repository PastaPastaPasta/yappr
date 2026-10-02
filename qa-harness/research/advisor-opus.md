# Yappr mobile: architecture advice (2026-10-01)

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Engine | **Build 1.0 on a hidden-WebView engine. Inside it, the existing `lib/` domain layer runs together with evo-sdk.** The boundary is a typed, domain-level RPC (`YapprEngine`), not the SDK. Rust (`yappr-platform`) comes in 1.x behind the same interface. |
| 2 | Domain layer | **Hybrid, with no changes to web `lib/` for 1.0.** The engine bundle uses all of `lib/` unmodified, and bundler aliases replace the few browser-bound modules. React Native imports only an allowlisted set of pure `lib` modules directly. The 5 seam PRs (Y5) move to the Rust phase. |
| 3 | UI stack | **Expo (latest SDK, New Architecture, prebuild/dev client) + expo-router + NativeWind v4, with the root `tailwind.config.js` as a preset.** Visuals are ported class-for-class from `components/`. |
| 4 | Sign-in | **Three ways in, ordered for QA now:** key entry (WIF, or mnemonic + identity), key-exchange v1 by `dash-key:` deep link or QR (already in `vendor/platform-auth`), and an App Connect button that stays off until a wallet supports it. A Node "test wallet" responder makes key-exchange testable on sakura. |
| 5 | 1.0 scope | Feed, thread, compose (text, reply, quote), likes, reposts, bookmarks, profiles (view and edit), follow, explore/search, in-app notifications, DMs (v5 1:1 and groups), block, report, EULA gate, settings. Deferred: push, relay, NSE, background sync, private feeds, tips, storefront, blog, polls (read-only link out), DPNS registration, image upload (stretch). |
| 6 | PRs | 5 waves, about 24 PRs (below). Most PRs within a wave run in parallel in separate worktrees, because files are split by namespace. |
| 7 | Testing | Vitest engine contract tests run **in Node against sakura** (no simulator needed). jest-expo and RNTL cover components. Maestro runs end to end on the iOS simulator and Android emulator. Agents check screens with `simctl`/`adb` screenshots and a component gallery route. |
| 8 | Overturned | The Rust-first engine, the Y5 seams before G0, the 26-week gates and staffing, bonsia/v10, D1 for non-mainnet builds, and D2 (background and push) in 1.0. Details at the end. |

---

## 1. Engine

**What I found:**

- **rs-sdk at the v5.0.0-beta.1 tag has every capability Yappr needs.**
  - wasm-sdk is a thin glue layer over it.
  - ranked, having, composite, chained, count, sum, average and history queries all come from `Fetch` impls (now in `packages/dash-platform-queries`).
  - `with_action_fee_agreement` and `with_token_payment_info` exist on the create, delete and purchase builders.
  - `contract_moderation`, `moderation_charters` and `contract_fee_pots` exist.
- **Cross-compiling is easy.**
  - `cargo tree -p dash-sdk --target aarch64-apple-ios` shows only `ring` (tonic `tls-ring`), `blst` and `secp256k1-sys` as native C. There is no C++, cmake, OpenSSL or RocksDB.
  - `swift-sdk/build_ios.sh` and `kotlin-sdk/build_android.sh` already ship builds for these targets.
  - Caveat: I ran this on the checkout's HEAD, not the tag (see the last point).
- **The real cost of Rust is elsewhere.** It is the glue and the seams:
  - wasm-sdk is about **31k lines** of JS↔Rust shaping; `document_ranked.rs` alone is 2.4k.
  - 26 `lib` files import `@dashevo` values.
  - The write path builds wasm-dpp objects by hand (`lib/manual-batch.ts`, `state-transition-service.ts`).
  - `lib` calls about 65 distinct SDK methods, including `sdk.wasm.refreshIdentityNonce`.
  - With v11 "FULL M" changing contract shapes every week, each new SDK call in `lib` would need a Rust shim method and a release in lockstep.
- **Warning:** `~/workspace/platform` is **not at the tag.** HEAD is `67340ad8` (v4.3 line, Cargo version 4.2.0-beta.6), with a large staged diff, and `packages/rs-sdk` and `wasm-sdk` differ from `v5.0.0-beta.1`. Any Rust work must start from a clean `git worktree add … v5.0.0-beta.1`.

**Why the WebView engine wins for "agents, days, churn":**

- **Lockstep for free.** The engine bundle is built from the root `node_modules` and lockfile, so mobile gets exactly the evo-sdk that web pins. A contract topology change (v11, FULL M) lands in `lib/` once and mobile picks it up on rebuild.
- **No risk to web.** A real browser runs `lib` as-is: `localStorage`, IndexedDB (bloom filter, Storacha), `crypto.subtle`, `window` events and `visibilitychange`.
- **The domain-level RPC is chatty where it's cheap.** One RPC per user action, not dozens of SDK calls across the bridge.
- **The engine can be tested headless.** It is plain TypeScript over `lib`, so the same entry runs in Node under vitest against sakura, as `scripts/*.mjs` already do.

**Known costs and how to handle them:**

- **Lockdown Mode** disables WASM in WKWebView. Detect `typeof WebAssembly === 'undefined'` and show a screen explaining how to exclude Yappr from Lockdown Mode (Settings → Privacy → Lockdown Mode → Configure Web Browsing). Rust removes this in 1.x.
- **Background work.** The WebView isn't reliable in the background, which is fine because 1.0 is foreground only.
- **Cold boot** compiles about 25 MB of WASM. Show the MMKV-persisted query cache straight away and mark "syncing" until `engine.ready`.
- **Keys live in the WebView heap,** as they do on web today. Keychain and Keystore are the store of record. This is accepted for devnet and beta, and the Rust native signer fixes it.
- **iOS can kill the WebContent process.** A supervisor handles `onContentProcessDidTerminate` / `onRenderProcessGone` by rebooting the engine and replaying in-flight reads. Writes are not replayed blindly; they go through `unconfirmed-writes`.

**The interface that makes the Rust swap cheap.** Screens depend only on this. It lives in `mobile/engine/protocol/`, uses plain DTOs and a codec for `Date`, `Uint8Array` and `bigint`, and versions the protocol at handshake:

```ts
export interface YapprEngine {
  boot(cfg: EngineConfig): Promise<BootInfo>          // network, topology, contract ids, bundle hash
  session: { signInWithKey(i: KeyLogin): Promise<Session>; startKeyExchange(): Promise<KxRequest>;
             awaitKeyExchange(id: string): Promise<Session>; restore(id: string): Promise<Session|null>; signOut(): Promise<void> }
  feed:    { home(tab: 'following'|'forYou'|'top', cursor?: string): Promise<Page<PostDTO>>; hashtag(...); }
  posts:   { get(id); thread(id, cursor?); create(d: Draft): Promise<WriteTicket>; remove(id): Promise<WriteTicket> }
  engage:  { like(t: TargetRef); unlike(t); repost(t); bookmark(t, on: boolean); stats(ids: string[]) }
  profiles:{ get(idOrName); posts(id, tab, cursor?); follow(id, on: boolean); followers(id, cursor?); update(p) }
  search:  { users(q); hashtags(q); trending(); topCreators() }
  notifications: { list(cursor?); markSeen(upTo: number); unread() }
  dm:      { conversations(); messages(convId, cursor?); send(convId, body); startDirect(id); startGroup(ids) }
  safety:  { block(id, on: boolean); blocked(); report(target, reason) }
  on(event: 'write'|'dm'|'notification'|'engine', cb): Unsubscribe   // WriteTicket status, DM loop, health
}
```

In 1.x, `YapprEngine` gets a second implementation: `lib` running in Hermes over a Rust `PlatformSdk`. That is the point where the Y5 seams get built. The UI, the Maestro flows and the Node contract tests stay the same.

**Day-1 checks (inside PR 2 and PR 4, not a separate spike):**

- evo-sdk 5.0.0-beta.1 boots in WKWebView and Android WebView **without** COOP/COEP. `serve-static.mjs` claims it needs them, but GitHub Pages can't send them, so check.
- DAPI and quorum CORS work from the chosen origin. Prefer loading the HTML with an `https://` `baseUrl`, and fall back to an embedded localhost static server.
- Measure cold boot time and memory on both simulators.

## 2. Domain layer

- **Engine side.** Build `mobile/engine/` with esbuild (`define` for `NEXT_PUBLIC_*` taken from `.env.devnet`, `@/` alias to the repo root). Shims:
  - **`localStorage`:** a synchronous in-memory map, hydrated from MMKV at boot, written through over the bridge, and namespaced per network. Keys with the `yappr_secure_` prefix go to `expo-secure-store` instead, so `lib/secure-storage.ts` works unchanged.
  - **Lifecycle:** React Native `AppState` dispatches synthetic `visibilitychange` / `pagehide` events into the WebView, so the DM v5 flush works.
  - Anything else browser-bound is replaced by an esbuild alias inside `mobile/engine`. **No edits to `lib/`.**
- **React Native side:** a `mobile/app/src/shared/lib-allowlist.ts` re-export of pure modules only (`types/*`, `post-helpers`, `compose/limits`, `compose/mention-query`, `sensitive-content`, `profile-links`, `error-utils` classifiers, `link-preview/parse-html`, `bytes`). A dependency-cruiser/ESLint rule in mobile CI fails on any other `lib` import, and on anything that transitively reaches `@dashevo/*`.
- **Keeping web safe:**
  - The only web-tree edits allowed in 1.0 are root `tsconfig.json` `exclude: ["mobile"]` (required: the root includes `**/*.ts`, so `next build` would typecheck `mobile/`), plus `knip` and `eslint` ignores.
  - Any later `lib` change must pass web lint, vitest, build and, where relevant, the devnet e2e.
  - Mobile CI rebuilds the engine bundle on every `lib/**` change, so web authors see mobile breakage.

## 3. UI stack

- **Libraries:** Expo + expo-router (tabs: Home, Explore, a ✚ compose modal, Alerts, Chats), FlashList, expo-image, Reanimated, react-native-gesture-handler, TanStack Query (persisted to MMKV) over `YapprEngine`, `lucide-react-native` (web uses lucide and heroicons), `expo-haptics`.
- **Styling:**
  - NativeWind v4 works with web's Tailwind 3. `mobile/app/tailwind.config.js` does `presets: [require('../../tailwind.config.js')]`, so the `yappr-*` sky palette, `neutral-750/850`, the shadows and dark mode come from one source.
  - Agents port `components/post/*`, `components/ui/*` and `components/profile/*` **class-for-class** into React Native primitives, so styling stays in step with web's components.
  - `mobile/app/src/ui/tokens.ts` re-exports the resolved theme for non-className uses (navigation theme, status bar).
- **Native feel:** native stacks and sheets, platform haptics, the share sheet, pull to refresh, and the "↑ N new posts" pill, as in PRODUCT_UX.

## 4. Sign-in for 1.0

1. **Key entry ("Other ways to sign in"):**
   - WIF: resolve the identity with `identities.byPublicKeyHash`, then check that the key matches an AUTH CRITICAL/HIGH key, as `matchIdentityKey` does today.
   - Mnemonic + identity index: derive in the engine, as `scripts/derive-identities.mjs` does.
   - Storage: Keychain or Keystore.
   - Available in the dev and beta variants. In prod it is hidden behind a flag that only turns off once a store wallet does App Connect on the launch network.
2. **Key-exchange v1:**
   - The protocol is the existing `vendor/platform-auth/src/key-exchange/yappr-protocol.ts`, unchanged.
   - Same device: open `dash-key:` and poll for the response.
   - Other device: show a QR code and poll for the response.
   - It works with store DashPay on testnet today. On sakura it is driven by a **Node test-wallet responder** (`scripts/test-wallet-respond.mjs`, about 150 lines: it reads the request URI, derives the login key from a pool seed, encrypts it and writes the response document). That gives Maestro a real wallet-style round trip without building a second app.
3. **App Connect:** build the button, the `/app/connect` return route and the session model now (per-device key slots, contract binding as metadata), behind `FEATURE_APP_CONNECT=false`. The protocol module lands in `vendor/platform-auth` (Y3) when a wallet ships it.
4. **For Maestro:** pass the WIF with `maestro test -e WIF=…` and type it into key entry. **No dev backdoor URL and no secrets baked into builds.**

## 5. Scope of 1.0

**In:**

- **Home:** Following, For you and Top.
- **Thread:** threads, including removed and tombstone placeholders for v11 FULL M.
- **Compose:** post, reply and quote, with mentions and hashtags, drafts, and WriteTicket states (posting, not confirmed with check-again, failed with retry).
- **Engagement:** like and unlike, repost (a bare quote) with share, and bookmarks with their own screen.
- **Profiles:** posts, replies and likes tabs; follow and unfollow; followers and following lists; edit `yapprProfile`, with avatar by URL.
- **Explore:** user search (DPNS prefix), hashtags, trending, and top creators.
- **Alerts:** in-app only, polled in the foreground, with a badge.
- **Chats:** DM v5 1:1 and groups, with the engine's DM loop pushing events.
- **Safety:** block and blocked list, report posts and replies, the sensitive-content filter, and the EULA gate.
- **Settings:** account, sign out and switch account, theme, network and build info, engine diagnostics, about and terms.
- **Media display:** IPFS images and link previews.

**Deferred (1.1 and later):**

- push, relay, NSE and background polling;
- private feeds (an encrypted post renders as "Private post");
- tips and money; storefront; blog; poll voting (polls link out to web);
- DPNS registration (links to web);
- profile and DM reports (wait for the contract cut);
- account deletion (needed before a public store release, not for TestFlight or Play closed);
- image upload: Pinata JWT is a stretch PR, Storacha is deferred.

"Ship" for 1.0 means signed builds on **TestFlight and the Play internal/closed track on sakura**. A public store listing depends on the network, wallet and charter, as before.

## 6. PR plan

Rules for every PR:

- Branch off `staging`; one agent per worktree.
- Under about 2.5k lines, excluding lockfiles and generated files.
- Every UI PR carries iOS and Android screenshots.
- **Engine PRs stack on the sakura/5.0 cutover (#606 → #607).** Bonsia is dead, and staging still pins 4.2.0-beta.7.

**Wave 0 (sequential)**

- **P0** `docs(mobile): ADR-001 WebView engine, agent plan, sakura`. Rewrites ARCHITECTURE and README (milestones, staffing, D1/D2/D4, spikes) and adds `mobile/CLAUDE.md` (validation checklist, screenshot recipe, allowlist rule).

**Wave 1 (parallel)**

- **P1** `mobile: Expo scaffold`:
  - expo-router tab skeleton with **stub screens for every route**, so wave 3 adds files and doesn't edit shared ones;
  - NativeWind with the root preset; `app.config.ts` dev and beta variants (`pr.yap.app.dev` / `.beta`) reading `.env.devnet`;
  - root `tsconfig`, `knip` and `eslint` excludes;
  - `.github/workflows/mobile.yml` (typecheck, lint, jest).
- **P2** `mobile/engine: protocol, bundle, Node harness`:
  - `YapprEngine` types, codec, RPC envelope, esbuild build, storage and lifecycle shims;
  - `engine.boot` plus a vitest contract test reading the home feed, one post and one profile on sakura.
  - Depends on #607.
- **P3** `scripts: test-wallet key-exchange responder, plus mobile pool slots`: provisions about 6 mobile slots from `E2E_DEVNET_SEED_PHRASE`, separate from web CI.

**Wave 2 (parallel)**

- **P4** `mobile: EngineHost`: hidden WebView, bridge, supervisor and restart, Lockdown detection, MMKV and secure-store bridges, a diagnostics screen, and the boot/CORS/memory numbers recorded in the PR (needs P1, P2).
- **P5** `engine: reads`: feed, thread, profiles, search and explore, notifications. Wraps `lib/feed/*`, `lib/home`, services and stats, with contract tests (P2). If it runs over 2.5k lines, split it into P5a (feed and thread) and P5b (profiles, search, notifications).
- **P6** `engine: session and writes`: key login, key-exchange, restore and sign-out; post, reply, quote and delete; like, repost, follow, bookmark, block, report, profile update; WriteTicket events. Contract tests write with a pool slot (P2).
- **P7** `mobile: design system`: primitives ported from `components/ui`, a presentational PostCard, RichText through allowlisted parsers, relative time, Avatar (dicebear and IPFS), and a `/__gallery` route rendered in light and dark (P1).

**Wave 3 (parallel; each needs P4 and P7 plus the relevant engine PR)**

| PR | Scope |
|---|---|
| P8 | Sign-in and onboarding: welcome, EULA, key entry, key-exchange with QR/deep link and polling, App Connect stub, signed-out browsing, account switch |
| P9 | Home feed and thread: FlashList, pagination, new-posts pill, persisted cache |
| P10 | Compose sheet and WriteTicket UI, mention autocomplete, drafts |
| P11 | Engagement actions with optimistic updates and haptics; share; bookmarks screen |
| P12 | Profiles: view, tabs, follow, lists, edit |
| P13 | Explore, search and hashtag screens |
| P14 | Alerts tab, badge, foreground poller |
| P15 | Safety: report sheet, block, blocked list, sensitive filter, removed placeholders |
| P16 | Settings and diagnostics |
| P17 | `engine: DMs` (can start right after P6): DM v5 engine, loop and events, with contract tests on 2 slots |

**Wave 4**

- **P18** DM screens: inbox, conversation, new chat, group info (needs P17).
- **P19** Deep links (`yappr://post|user|hashtag`) and `.well-known` files (the web side is a separate small PR).
- **P20** Maestro suite and CI: smoke flows on every PR, write flows nightly. Seed the suite in P8 and grow it per screen PR.
- **P21** Release plumbing: icons and splash, signing, build numbers, TestFlight and Play internal upload, `expo-updates` off for 1.0.
- **P22+** Full agentic QA pass on both platforms, then one fix PR per defect.

**Post-1.0 Rust track:** R1 crate skeleton building for iOS and Android at the tag. R2 the read `PlatformSdk` via uniffi-bindgen-react-native. R3 the Y5 seams in `lib`, each with the full web e2e. R4 native signer and writes. R5 swap `YapprEngine` to Hermes. R6 background sync.

## 7. Testing

- **Unit:** existing `lib` vitest (untouched). `mobile/engine` vitest for the codec, shims and DTO mappers. jest-expo and RNTL for components and state machines (WriteTicket, sign-in).
- **Engine contract tests:** Node vitest booting the engine entry against sakura.
  - Read tests run unauthenticated on every engine PR.
  - Write tests use mobile pool slots, run serially with retries for DAPI flakiness, and run nightly and on engine PRs.
  - These are the parity guard for both engines: the Rust engine must pass the same suite later.
- **UI E2E with Maestro** (YAML suits agents, has `takeScreenshot`, works on both platforms). Detox is rejected as too heavy.
  - Flows: signed-out browse, key login, post, like, reply, follow, DM round trip with two app instances or one app plus the Node responder, block and report.
- **Agent visual checks:**
  - `xcrun simctl io booted screenshot`, `adb exec-out screencap -p`, or the device tools.
  - The `/__gallery` route for per-component light and dark shots.
  - Each screen PR includes side-by-side shots with the matching web page (Playwright screenshot at a 390 px viewport).

## 8. Top risks and mitigations

1. **evo-sdk misbehaves in the WebView** (COI, CORS, boot time, memory, Android WebView version). P4 measures this on day 1. The fallback is an embedded localhost server, and the last resort is pulling R1 and R2 forward.
2. **Sakura cutover not merged.** Engine PRs stack on #607. Scaffold, design system and Maestro skeleton proceed without it.
3. **Contract churn (FULL M).** It's handled entirely in `lib`. Mobile DTOs carry `kind`, `removed` and `tombstone` flags, and CI rebuilds the engine on `lib/**` changes.
4. **Lockdown Mode and key exposure in the WebView heap.** Detection screen plus the documented exclusion; native signer in R4. Record it in the audit scope.
5. **Agents conflicting on shared files.** Route stubs in P1 and per-namespace engine files in P2, so wave 3 PRs mostly add files.
6. **4-hour review backlog.** Keep PRs small and stacked, run local review agents, and merge in waves.
7. **Web regression.** No `lib` edits in 1.0. Any exception follows the CLAUDE.md checklist and runs the devnet e2e.
8. **App Review (4.2).** The UI is fully native and the WebView is invisible. Keep it out of the view tree visually and never render content in it.

**Overturn in `docs/mobile`:**

- **The engine decision:** WebView engine for 1.0, Rust in 1.x.
- **The S1–S6 spike plan and G0 gate:** replaced by the P2/P4 day-1 checks.
- **Y5 seams as a 1.0 dependency:** moved to the Rust track.
- **The 26-week milestones and staffing table:** replaced by the agent waves.
- **Network facts:**
  - bonsia, 4.2.0-beta.7 and v10 are now sakura, 5.0.0-beta.1 and v11 / FULL M.
  - `.env.devnet` is rewired to sakura.
- **D1 for dev and beta builds:** key entry and key-exchange allowed. App Connect stays the target for prod.
- **D2 / NOTIFICATIONS in 1.0:** in-app only. Polling, relay and NSE move to 1.1.
- **The `mobile/test-wallet/` app:** replaced by the Node responder.
- **iOS 18 / swift-sdk talk:** irrelevant now. Minimum stays iOS 17 and Android API 29.

### Critical files for implementation
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/lib/services/state-transition-service.ts
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/lib/contract-topology.ts
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/vendor/platform-auth/src/key-exchange/yappr-protocol.ts
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/tailwind.config.js
- /Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/tsconfig.json