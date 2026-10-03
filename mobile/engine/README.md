# mobile/engine

The headless Yappr engine for the iOS and Android apps (ADR-001 E1/E2). It is an esbuild bundle of `@dashevo/evo-sdk` (the version pinned in the root `package.json`), the web `lib/` **unmodified**, and the curated API in `src/api/`. It runs in one hidden WebView. The React Native UI talks to it only through the RPC in `src/rpc/`, and imports `type EngineApi` and nothing else from here at type level.

```
mobile/engine/
  build.mjs              esbuild bundle per variant → dist/<variant>/
  src/protocol/          envelope types + JSON codec (dependency-free; the RN app imports these at runtime)
  src/rpc/               transport, dispatcher (engine side), client proxy (host side)
  src/shims/             storage (sync Web Storage, write-through, secure routing), lifecycle events
  src/api/               engine, feed, posts, engage, profiles, graph, explore, safety, notifications, session, writes, settings, dm: thin calls into lib/; dto.ts
  src/dm/                the DM backends (v5, legacy), their DTOs and the event diff
  src/dto/               cursors, paging, enrichment pipeline, thread port, capabilities, DTO validators
  src/entry.webview.ts   the WebView entry; src/install-shims.ts runs before lib loads
  src/sidecar.ts         engine.wasm.js and engine.avatars.js, the scripts beside engine.js (wasm-source.ts, avatar-source.ts, avatars/)
  src/selftest.ts        selftest.html: engine + in-page host, for browsers nothing can drive
  test/unit/             codec, RPC, shims, DTO mappers (offline)
  test/contract/read/    the read API in Node against testnet, one file per module (ENGINE_VARIANT=devnet: sakura)
  test/browser/          the built bundle in Playwright WebKit + Chromium, file:// and https origins, and engine.inline.html
```

## Commands

Run `npm ci` at the repo root first: the bundle resolves `lib/`'s dependencies from the root `node_modules`. Then, in `mobile/engine`, run `npm ci` (only esbuild is installed here; vitest, TypeScript and Playwright come from the root).

| Command | What it does |
| --- | --- |
| `npm run build:testnet` / `build:devnet` / `build` | Bundle → `dist/<variant>/{engine.js, engine.wasm.js, engine.avatars.js, engine.html, engine.inline.html, selftest.html, manifest.json, meta.json}` |
| `npm run typecheck` | `tsc` over src, tests and the lib files they reach |
| `npm run lint` | ESLint with the engine's own config (`.eslintrc.cjs`; the root config ignores `mobile/**`) |
| `npm test` | Unit tests (offline) |
| `npm run test:contract` | Engine read API in Node against **testnet** (read only, unauthenticated). `ENGINE_VARIANT=devnet` runs the same suite on `.env.devnet`; it skips with a reason until `ENGINE_DEVNET_READY=1`. Per-call timings go to `$EVIDENCE_DIR/contract-read-<variant>/` |
| `npm run test:contract:write` | Writes on **sakura** with pool personas 90–99 (`YAPPR_SAKURA_IDENTITIES`), serial. Skips with the reason until W-SAKURA lands |
| `npm run test:browser` | Needs `build:testnet`. Boots the bundle in WebKit and Chromium; writes timings to `$EVIDENCE_DIR` (default `test-results/`, gitignored; `RUNS=n` per configuration) |

CI: `.github/workflows/mobile-engine.yml` (read-only token) runs typecheck, lint, unit tests and both bundle builds on changes to `mobile/engine/**`, `lib/**`, `types/**`, `hooks/**`, `vendor/platform-auth/**`, `contracts/**`, the root manifests, `tsconfig.json` and `.env.devnet`, so a web change that breaks the engine fails on the web PR. `build.mjs` fails if the bundle ever reads a file outside those directories (`WATCHED_INPUT_DIRS`), so the filter cannot silently fall behind. The contract and browser suites need the live network and run locally for now.

### Variants and env

- **`testnet`** uses **no env file**, like the production web build (`npm run build` loads none). `lib/constants.ts` falls back to its testnet defaults: network `testnet`, social `9oDC6xdg…` (topology v2).
- **`devnet`** reads `.env.devnet`, like `npm run build:devnet`.
- **Inlining:** only `NEXT_PUBLIC_*` keys are inlined (`define process.env.X`), as Next.js does. Any other `process.env.X` reads `undefined`.
- **Storage:** `NEXT_PUBLIC_STORAGE_SCOPE` and `NEXT_PUBLIC_BASE_PATH` are empty. The host namespaces storage per network instead.
- **`.env.devnet` is stale:** it still points at **bonsia**, which is abandoned. The devnet variant builds, but it can't boot until the sakura cutover rewrites `.env.devnet`.

## How the wasm loads

- **Three scripts, not one.** `engine.js` (1.5 MB) is the bundle: evo-sdk's unbundled entry (`dist/sdk.js`, aliased; the published `dist/evo-sdk.module.js` inlines its own glue and the WASM as 11 MB of base64), one copy of the wasm-bindgen glue, `lib/` and the API. Two **sidecar** scripts (`src/sidecar.ts`) each set one `window` global:
  - `engine.wasm.js` (11.4 MB): the SDK's WASM, gzip + base64 in a single string literal (`__YAPPR_ENGINE_WASM__`);
  - `engine.avatars.js` (2.0 MB): the DiceBear styles (`__YAPPR_ENGINE_AVATARS__`). In `engine.js`, `@dicebear/collection` is a stand-in (`src/avatars/collection-shim.ts`) whose styles read the real ones at call time.
- **Order.** Every page runs `engine.js`, then `engine.avatars.js`, then `engine.wasm.js`. The engine says hello while the sidecars are still being read, and the avatar styles do not wait for the 11 MB WASM script (the host draws avatars on its cached screens before the engine is ready):
  - iOS loads `index.html` (`engine.html` plus the host's CSP, written by the app's engine-assets plugin) by file URL;
  - the Android loader page inserts the three scripts in order (`async = false`), and they download in parallel;
  - `engine.inline.html` inlines all three (iOS dev builds against `YAPPR_ENGINE_DEV_URL`, and dev clients built before this split; the browser boot proof).
  `engine.js` installs a capture-phase `load`/`error` listener as it evaluates, so it sees every sidecar's outcome whenever it happens. Nothing is ever fetched or injected: a page without a sidecar fails at once.
- **The init path:**
  1. The entry starts the WASM right after its hello, not at `engine.boot()`: decode the base64 (`Uint8Array.fromBase64`, else `atob`), decompress with `DecompressionStream`, and `WebAssembly.instantiateStreaming` the decompressed stream, which compiles off the main thread while it streams. `boot()` joins that init (`src/shims/wasm-sdk.ts`, which every `@dashevo/wasm-sdk` import shares: one glue module, one instance).
  2. It also preconnects to the quorum service the SDK reads first in `connect()` (`src/preconnect.ts`), so DNS and TLS overlap the compile.
  3. `boot()` waits for the avatar styles too (lib draws default avatars while it enriches reads), and `profiles.avatarSvg` waits for them.
  4. **Failure.** The WASM initializes once per page, failure included (as evo-sdk's `ensureInitialized` does). If it or the avatar styles did not load, `boot()` rejects with `ENGINE_LOAD_FAILED`, and the host's supervisor counts that as a crash and starts a fresh page (with backoff, then `failed`), instead of degrading and retrying a boot that cannot succeed.
- **No `.wasm` fetch.** Nothing fetches a binary, so the engine works from `file://` with no web server, no native asset handler and no COOP/COEP headers. A binary sidecar would need a native request interceptor (Android `shouldInterceptRequest`, iOS `WKURLSchemeHandler`) and a dev-client rebuild. It would save the base64 work, which measured in the Android emulator's WebView (Chrome 124) at 60–110 ms to scan the 11.4 MB literal, 13–24 ms for `atob` and 10–30 ms for the byte loop: one main-thread stall of about 0.1–0.15 s after the hello, ahead of the SDK's first request.
- **Node** (the test harness) gets the WASM from the package file instead (`test/setup/wasm.ts`), and the real DiceBear styles (the stand-in is aliased in `build.mjs` only).
- **`target: safari16.4, chrome110`:** `DecompressionStream` needs iOS 16.4 or later.

## Shims and stubs inventory

**Stubs: none needed.** The bundle does reach some React and Next.js-adjacent code, and all of it evaluates fine headless:

| Reached | Through | Why it is harmless |
| --- | --- | --- |
| `react`, `react/jsx-runtime`, `use-sync-external-store` | `vendor/platform-auth/dist` (via `lib/secure-storage`), `zustand` | Library code only; nothing renders |
| `zustand` (+ `persist`) | `lib/store.ts`, `lib/modal-store.ts`, `lib/query-inspector/store.ts` | Vanilla stores; `persist` reads the shimmed localStorage |
| `hooks/use-login-modal.ts` | `lib/auth-utils.ts` ← `token-service` ← `state-transition-service` | A zustand store, not a component |

No `next/*` module is reached. If a future lib change pulls in something browser-bound that breaks headless, swap it in `build.mjs` with esbuild's `alias` (ADR E2). Never edit `lib/`.

**Shims (in `src/shims/`):**

- **`localStorage`/`sessionStorage`:** synchronous in-memory maps.
  - **Hydrating `localStorage`:** the host injects `window.__YAPPR_ENGINE_STORAGE__ = { local, secure }` with `injectedJavaScriptBeforeContentLoaded`, and `install-shims.ts` hydrates from it **before any lib module is evaluated**.
  - **Why it can't wait for boot:** `lib/store.ts`'s zustand `persist` reads storage at module scope, so hydrating at `boot()` would be too late.
  - **The host must assign the snapshot as a property** (`window.__YAPPR_ENGINE_STORAGE__ = …`), not declare it with `var`. Each key is routed by its prefix whatever area the host filed it under; misfiled keys are logged as a warning.
  - **Write-through** (ENGINE.md §9.1): writes apply to the map at once and go to the host in batches, one per area per microtask: `{t:'kv'|'skv', v, seq, ops}` with `ops` of `['set', key, value]` / `['del', key]`.
    - **Coalescing:** batches are coalesced per key against the value before the batch: last write wins, an unchanged set is dropped, and a key set and removed while absent before produces nothing. That absorbs the vendored secret store's `__storage_test__` probe on every access.
    - **Ordering:** `seq` is shared by both areas and strictly increasing.
    - **Secure removals:** always forwarded, even for a key the engine never held, so signing out a non-hydrated account still clears its Keychain items.
    - **Acks:** the host acknowledges each `skv` batch with `{t:'kv-ack', v, seq}` once it is written. With `createEngineClient(…, { onStorage })`, the client acks when the returned Promise resolves, and never without a writer or on a failed write. Engine side, `engineStorage.secureDurable()` flushes and resolves once every secure batch so far is acknowledged; the sign-in paths (M5/P6) await it.
    - **Early writes:** batches flushed before the entry subscribes are queued for it.
  - **Where each area lives (decided; the host side is M4):**
    - `local`: an **encrypted MMKV** instance per network. Its 32-byte key is generated on first launch and kept in the Keychain/Keystore (this-device-only, available after first unlock).
    - `secure`: the Keychain/Keystore, one item per key. These are the keys under `SECURE_KEY_PREFIXES` (exported from `src/shims/storage.ts`, matched after the deployment scope):
      - `yappr_secure_`: lib/secure-storage (private and encryption keys);
      - `yappr:pf:`: the private-feed seed, path keys and cached CEKs;
      - `yappr_pinata_` and `yappr_storacha_`: upload-provider credentials.
    - Watch secure-store value size limits for `yappr:pf:path_keys:*`.
  - **`sessionStorage`:** memory only.
- **Lifecycle:** `engine.lifecycle('active'|'background'|'inactive')` replays React Native `AppState` as `visibilitychange` + `pagehide`/`pageshow`. `document.visibilityState` follows the app, not the always-hidden WebView. `engine.connectivity(online)` fires `online`/`offline` and asks the SDK to rebuild a dead instance.
- **Console:** forwarded to the host as `log` envelopes at or above a level (default `info`; `engine.setLogLevel('debug')` for diagnostics), filtered before formatting because devnet builds log at debug. tslog's `%c` styling is stripped.
- **IndexedDB:** `window.indexedDB` is set to `undefined` (ENGINE.md §9.1). Nothing in lib uses it and nothing on the host backs it up, so an unexpected user fails loudly.
- **`react-hot-toast`** (esbuild alias): lib's toasts become `engine.notice {level, message}` events.
- **`@dashevo/evo-sdk`, `@dashevo/wasm-sdk` and `@dashevo/wasm-sdk/compressed`** (exact-match aliases in `aliases.mjs`, the same in vitest): evo-sdk's unbundled entry, and one shim (`src/shims/wasm-sdk.ts`) for both wasm-sdk entries, which re-exports the shared glue and loads the WASM from a source the host page or the harness installs. evo-sdk, `lib/utils/username.ts` (so its contested-name check works) and the first-login key-registration builder (`lib/services/identity-update-builder.ts`) share one WASM instance, and the bundle carries no WASM at all.
- **`@dicebear/collection`** (`build.mjs` only): `src/avatars/collection-shim.ts`, filled from `engine.avatars.js` (above).
- **Early error reporter:** `install-shims.ts` posts uncaught errors and unhandled rejections straight to the bridge. If a lib module throws while loading, the bundle stops before the dispatcher exists, and that log line plus the client's hello timeout are what the host sees.

## RPC

- **Envelopes** (`src/protocol/envelope.ts`), each one JSON string through the codec:
  - `req {t,v,id,path,args}`
  - `res {t,v,id,ok,value|error}`
  - `evt {t,v,event,payload}`
  - `log {t,v,level,message}`
  - `ping {t,v}` (host → engine: re-send hello)
  - `kv` / `skv {t,v,seq,ops}` (engine → host) and `kv-ack {t,v,seq}` (host → engine): storage write-through, above
- **Handshake:**
  - The engine sends `evt engine.hello {protocol, bundleHash, instanceId}` when it can take calls, and again whenever it receives a `ping`. The client pings on creation, so a client created after the engine loaded still completes the handshake.
  - The client queues calls until the first hello. A hello with another protocol fails the client (`PROTOCOL_MISMATCH`); so does no hello within `helloTimeoutMs` (default 30 s, `ENGINE_HELLO_TIMEOUT`). The engine also refuses requests with a different `v`.
  - **Restart signal:** a hello with a new `instanceId` means the WebView reloaded. Every pending call is rejected with `ENGINE_RESTARTED`. Each request is stamped with the `instanceId` the client last heard (`instance`), and an engine with another id refuses it **without running it**, so a call rejected this way never ran on the new instance. The supervisor may retry reads; writes go through the unconfirmed-writes rules.
  - A malformed hello is ignored, and a throwing `on()` listener does not stop delivery to the others.
- **Deadlines:** each call's `timeoutMs` (default 60 s) counts from the call, including time spent waiting for the hello (`RPC_TIMEOUT`).
- **Undecodable messages** never leave a caller waiting: the engine answers a request it cannot decode with `BAD_ENVELOPE`, and the client rejects a response it cannot decode with `BAD_ENVELOPE`.
- **Codec** (`src/protocol/codec.ts`):
  - carries `Date`, `Uint8Array` (any binary view arrives as `Uint8Array`), `bigint`, `Map`, `Set`, `undefined`, NaN/±Infinity, and errors;
  - user objects with a `$t` key are escaped, and a `__proto__` key stays a key (never a prototype);
  - cycles throw.
- **Errors:** they arrive as `RemoteError {name, message, code?, kind?, isRetriable?, cause?, data?, remoteStack?}`.
  - evo-sdk's `WasmSdkError` does not extend `Error`, and exposes its fields as prototype getters. The engine reads them with guarded reads (a freed error's getters throw), so consensus codes survive the bridge.
  - **Error-like objects:** any class instance whose `name` and `message` read as strings travels as an error, so one held inside a value (a write result) keeps its fields too. Plain objects stay data.
  - **Wrapped errors:** an own `error` field is lifted to `RemoteError.error`, where `consensusCodeOf` looks.
  - `cause` is followed up to 3 levels.
  - Messages are verbatim, so `lib/error-utils` classifiers (`consensusCodeOf`, `isTimeoutError`) work on the host.
- **Bridge:**
  - engine → host: `window.ReactNativeWebView.postMessage(json)`;
  - host → engine: `webview.injectJavaScript("window.__yapprEngineReceive(" + JSON.stringify(json) + ")")`.
  - In Node tests an in-process pair stands in.
- **Host client:** `createEngineClient<EngineApi>(transport, {timeoutMs, helloTimeoutMs, onLog})` gives a Proxy. `client.api.feed.home({tab, cursor})` sends path `feed.home`. Coercing or inspecting the proxy (`then`, `toString`, `toJSON`, `$$typeof`, …) sends nothing. `close(reason)` rejects in-flight calls (for the supervisor on WebContent death), and `ping()` asks for a fresh hello.

## API

Each method re-expresses a web hook or page flow as a plain function over the same `lib/` calls; the table names the flow it mirrors. Signed-out callers get everything except what needs a viewer (`NOT_SIGNED_IN`).

| Method | Mirrors | Returns |
| --- | --- | --- |
| `engine.boot()` | `SdkProvider`: `evoSdkService.initialize({network, contractId})` | `EngineInfo` |
| `engine.info()` | — | `EngineInfo`: protocol, variant, bundle sha256, evo-sdk version, network, topology, contract ids, ready, webAssembly, bootMs, plus `capabilities`, `ipfsGateways`, `avatarStyles` (below) |
| `engine.lifecycle(state)` / `connectivity(online)` / `setLogLevel(level)` | lifecycle shim; `restoreConnection()` once a boot was attempted; console threshold | — |
| `feed.home({tab, sort?, window?, cursor?})` | `hooks/use-feed-data.ts`, `use-top-feed.ts`. **For You:** `loadForYouFeed` with the persisted `feedLanguage` (where posts carry one), `sortFeedByTimestamp`, `enrichPostsWithRepostsAndQuotes` (drops tombstones). **Following:** `loadFollowingFeed`'s time windows; a load lib swallowed rejects (`NETWORK`) instead of reading as the end. **Top:** `topLikedPostsHydrated` / `…ByAuthorsHydrated`, K widened by 20 per page up to 100, only unseen ids returned. | `Page<PostDTO>` |
| `feed.checkNew({tab, since, knownIds?})` | `checkForNewPosts`: `queryPostsSince` / `queryPostsByOwnersSince` from `since − 2 s`, 50 | `{count, posts}` |
| `feed.hashtag({tag, sort?, window?, cursor?})` | `app/hashtag/page.tsx`: v9/v10 `queryForDisplay` on `tagAndTime` (50/page); v2 `getPostIdsByHashtag` paged in memory with the tagger check; Top: tag-pinned ranking. Tags are normalised to storage form (`#Dash` → `dash`, `$DASH` → `dash_cashtag`) | `Page<PostDTO>` |
| `posts.get(id)` | `usePostDetail`: post, else reply; a v10 bare repost resolves to its target. lib answers a failed read as `null`, so a `null` is checked with proved `documents.get` reads: `null` only when neither a post nor a reply exists; a failed read rejects (`NETWORK`, `TIMEOUT`, `RATE_LIMITED`); a document lib missed is read once more | `PostDTO \| null` |
| `posts.thread(id, cursor?)` | `usePostDetail` + its module-private tree builders (ported to `src/dto/thread.ts`): ancestors (root on flat threads, the parent walk on v2), replies with the author's thread first, frontier expansion under a focused reply, deleted-parent stubs (v10, `deletedStub: true`, blank author). Pages are **cumulative** (a later page can nest under an earlier one); a call without a cursor re-reads everything. `focus: null` only for a post proved missing, and a flat-thread root goes in `removedAncestorIds` only when proved absent; a failed read rejects, as `posts.get` | `ThreadDTO` |
| `posts.engagements({id, kind}, tab, cursor?)` | `app/post/engagements/page.tsx`: `getPostLikes` / `getPostReposts` / `getQuotePosts` (v10: one list split by `splitRepostsAndQuotes`, `truncated` at 100), 30 users a page | `EngagementPage` |
| `posts.engagementCounts({id, kind})` | `loadEngagementCounts`; v10 splits the quote list as the engagements page does | `{likes, reposts, quotes, truncated}` |
| `posts.poll({contractId?, id})` | `components/poll/poll-card.tsx`: `getPoll`, `getTally` (`totalVotes: null` when unreadable), `getMyVotes` (`myVotes: null` when unreadable); each degrades alone. `null` only for a poll proved missing; an unreadable poll rejects | `PollDTO \| null` |
| `posts.mentionCandidates(prefix)` | `mention-autocomplete.tsx`: ≥3 chars, `searchUsernamesWithDetails(…, 5)`, one row per identity | `UserSummaryDTO[]` |
| `engage.stats(targets)` | `getBatchPostStats` + (signed in) `getBatchUserInteractions`, ≤100. lib reports a failed read as zeros, so the counts are advisory | `Record<id, EngageStatsDTO>` |
| `profiles.get(idOrName)` | `app/user/page.tsx`: `loadUserStats`, `getProfile`, `getAllUsernamesSorted`, viewer `isFollowing` / `getBlockProvenance` (`blocks: null` when unreadable; `blockedBy`: `'self'` for the viewer's own block, `'list'` when only a followed block list blocks, which `safety.unblock` cannot lift). A failed profile read rejects (checked with `profileExists`), never "no profile"; `null` for an unknown identity, or a name DPNS did not resolve (lib reports unreachable as not found, so that `null` may be transient). | `ProfileDTO \| null` |
| `profiles.posts({id, tab, window?, cursor?})` | `posts`: `getUserPosts` (+ reposts off v10, each placed on the page its time falls in); `replies`: `getUserReplies` + `fetchReplyParents` (`ProfileReplyDTO`); `top`: author ranking; `mentions`: `getPostsMentioningUser` → `loadMentioningPosts`, paged in memory | `Page<PostDTO \| ProfileReplyDTO>` |
| `profiles.batch(ids)` | `loadIdentityBatch`, ≤100, in order | `UserSummaryDTO[]` |
| `profiles.avatarSvg(id, style?, seed?)` | `generateAvatarSvg`: the recipe given, or the identity's own (`null` for an image avatar) | `string \| null` |
| `graph.followers(id, cursor?)` / `following` | `connection-list-page.tsx`: whole list once, 30 a page with names, profiles, counts, viewer follow | `Page<UserSummaryDTO>` |
| `graph.status(ids)` | `getFollowStatusBatch` (signed in), ≤100 | `Record<id, boolean>` |
| `explore.trending({window?})` | `getTrendingHashtags({168 h, 12})`; cashtags flagged; `countKind` likes on v9/v10 | `TagDTO[]` |
| `explore.topPosts({window?})` / `topCreators({window?})` | `app/explore/page.tsx`, `top-creators.tsx` | `PostDTO[]` / `RankedUserDTO[]` |
| `explore.searchUsers(q)` / `searchHashtags(q)` / `searchPosts(q)` | `app/search/page.tsx` (≥3 chars; exact-name fallback; trending + exact tag count); `app/explore/page.tsx` (substring over the newest 100 posts) | `UserSummaryDTO[]` / `TagDTO[]` / `PostDTO[]` |

DTO types and mappers live in `src/api/dto.ts`; `src/dto/` holds the cursor codec, paging, the enrichment-and-filter pipeline (`hydrate.ts`), the thread port, capabilities and the runtime validators (`validate.ts`, used by every contract test). `boot()` fails with code `NO_WEBASSEMBLY` when WebAssembly is missing (iOS Lockdown Mode).

- **Browsing lists** (feeds, tags, explore, search, profile tabs) drop v11's author tombstones (`withoutHiddenTombstones`, as `use-feed-data.ts`), then blocked authors, including the author behind a v10 bare repost, and apply the NSFW `hide` preference (`filterHiddenSensitive`), as web does. Profile tabs keep a blocked author's own posts; threads and single posts never filter (the host renders the gate).
- **Cursors** are opaque base64url JSON tied to the engine build, and to the list they page (tag, thread, profile, feed language, viewer for Following and Top); a foreign, stale or malformed one rejects with `BAD_CURSOR`. Lists lib reads whole are kept for 60 s per scroll (pruned as new ones load).
- **dashpay/platform#5244:** on testnet, paging past the last document of a mixed-direction query (`x asc, $createdAt desc`) throws a proof error instead of proving an empty page. A continuation that hits it ends the list (`src/dto/paging.ts`).
- **Topology:** a method the active contract cannot serve rejects with `NOT_SUPPORTED`; RN reads `engine.info().capabilities` (rankings, windows, quote-slot rules, reposts/bookmarks per kind, flat threads, tombstones, reports, content limits in chars and bytes, profile limits) instead of evaluating `lib/contract-topology.ts`.
- **Authors:** `displayName` is never empty (profile name, DPNS label, `User <last 6>`). `avatar` is `{uri}` for an image or `{dicebear: {style, seed}}` for a generated one, read from the stored profile field; render the latter with `profiles.avatarSvg` and cache it under `style:seed` (RN never bundles DiceBear). `resolved` is false when lib's lookup failed (it swallows the error): a feed author left in the loading shape, or a quoted post's author left as lib's `Unknown User` placeholder, whose name is then dropped for the fallbacks.
- **Viewer state:** signed in only: `liked`, `reposted`, `bookmarked`, `ownQuoteId` (v10's one quote-or-repost slot), `authorBlocked`, `followsAuthor`.
- **Polls:** `PostDTO.poll` is set for a native embed on the configured Pollr contract or a legacy Pollr link (`linkUrl`, which web hides from the text), exactly as `post-card.tsx` decides.

## Session, writes and settings (M7a)

**`session.*`** (`src/api/session.ts`, `src/session/`). A `PlatformAuthController` built from web's `createYapprPlatformAuthDependencies()`, with vaults, passwords, passkeys and the username and profile gates turned off (ADR-001 E5). Post-login tasks, the encryption-key auto-derive and the 5-minute balance refresh stay on, as on web.

| Method | What it does |
| --- | --- |
| `restore()` / `current()` | `controller.restoreSession()`, once per boot; every session call waits for it. A stored key that no longer signs for the identity drops the session (`session.changed {reason: 'key-invalid'}`) |
| `checkKey({key})` | WIF or hex → `identities.byPublicKeyHash` (then the non-unique index) → `matchIdentityKey` against the identity's keys (an enabled AUTH key, CRITICAL or HIGH; lib's `validatePrivateKey` ignores `disabledAt`, web bug #616). For "Identity found" before signing in. Errors: `KEY_INVALID`, `KEY_WRONG_NETWORK`, `IDENTITY_NOT_FOUND`, `KEY_NOT_ON_IDENTITY` (lib's reason, e.g. a MASTER key) |
| `signInWithKey({key})` | `checkKey`, then `controller.loginWithAuthKey(id, wif, {skipUsernameCheck: true})`. Hex is stored as a WIF for this network. Resolves only after `secureDurable()` (the host acknowledged the key batch). Arguments are sensitive: never log them. For a parked account (signed in again, AUTH-14) only the new auth key is written: the encryption-key auto-derive never writes over a stored key the engine was not given. The host restarts the engine next, which loads the account's other secrets |
| `startKeyExchange({ reauth? })` | `dash-key:` request (`buildYapprKeyExchangeUri`, the configured network and label). `reauth` lists the accounts marked "Sign in again" (AUTH-14): the wallet's answer for one parked here logs in afresh rather than switching back to its saved keys, and stores the wallet-derived encryption key as web does (replacing an imported one). One request at a time; it lives 10 minutes, and until the wallet answers it (ephemeral key and `reauth` included) is also kept under `yappr_secure_kx_request`, so a killed app or a restarted engine resumes it (`pendingKeyExchange()`) |
| `awaitKeyExchange(id, {waitMs?})` | Polls for the wallet's answer for up to `waitMs` (default 45 s, at most 120 s), so one call fits the client deadline. `pending` → call again ("Check again"). Then `signed-in` if the identity has Yappr's keys, else `needs-registration` with the `dash-st:` URI (`buildUnsignedKeyRegistrationTransition`) and the keys it adds. An answer for an account parked on this device ("Add account") is `switch {identityId}` instead: no login, the switch is prepared as `switchAccount` does it, and the host restarts the engine (a failed login-key login would clear the parked account's keys). A login whose derived auth key is disabled on the identity fails `KEY_DISABLED` before anything is stored. A wallet approval is kept for retries; nothing derived from it is persisted |
| `awaitKeyRegistration(id, {waitMs?})` | Checks every 5 s for the registered keys for up to `waitMs`, then signs in (`completeYapprKeyExchangeLogin`) |
| `cancelKeyExchange(id)` | Aborts the poll and zeroes the keys (`KEY_EXCHANGE_CANCELLED` for the waiting call). The keys are also wiped when the request expires, even if the host never calls back. Overlapping calls that complete the same approval share one sign-in |
| `accounts()` | The engine's registry, `yappr_engine_accounts` in kv |
| `switchAccount(id)` / `prepareAddAccount()` | lib has one session slot, so both are a controlled engine restart: they stop DM v5, save the active account's `yappr_session` and stash its `yappr-notifications`, put the target's in place (none for "add"), and resolve. The host must then restart the engine with the target's secrets; the next restore reports `switched`. Until that restart, session and write calls reject with `RESTART_REQUIRED`. Sign-ins run one at a time; one is refused (`BAD_REQUEST`) while any identity is active, including the same one (a failed wallet re-login would clear its keys): sign out first to re-enter a key |
| `signOut({identityId?})` | Offline. Active account: `controller.logout()` (secrets, session, logout cleanup). Another account: lib's secure-storage clear functions by id (forwarded as deletes even though the engine does not hold them). Either way its registry entry, stash and write tickets go, and it resolves after `secureDurable()`. **Host:** the `yappr:pf:*` private-feed keys carry no identity in their names, so the host must file every secure write under the account active at the time, and purge that account's secure index when it signs out while not active |
| `refreshBalance()` | `controller.refreshBalance()` → `{credits: bigint}` |

Events: `session.changed {session, reason}` (`restored`, `signed-in`, `switched`, `signed-out`, `key-invalid`, `balance`), and `session.keyRequired {identityId, purpose}` when lib opens its login or encryption-key modal (the engine closes it and asks the host).

**`writes.*`** (`src/api/writes.ts`, `src/writes/`). Every write gets a `WriteTicket` (`pending` → `confirmed` | `unconfirmed` | `failed`), emitted as `write.status` on each transition and persisted under `yappr_engine_writes` (at most 100; confirmed ones pruned after 24 h). A ticket still `pending` at load was interrupted: it becomes `unconfirmed` with `ENGINE_RESTARTED` and is never re-sent. A handler with `stagedSends` (publish) reports a stage before any write call, so its ticket still `queued` at load sent nothing: it becomes `failed`, `ENGINE_RESTARTED`/`not-sent`, retryable (ENGINE.md §7.4).

- **Handler contract** (M7b, M-DM). Register one `WriteHandler` per op with `tickets.register(op, {run, probe?, persistArgs?})` and call `tickets.submit({op, args, target, documents})`. `fromTransitionResult`, `fromBoolean` and `fromDeleteBoolean` map lib's results.
  - **Once `run()` has started, any failure without a verdict counts as "may have landed"** (`unconfirmed`, outcome `unknown`, not retryable until a check proves it absent), because lib signs, broadcasts and waits in one call: a transport error (wasm's `transport error … Failed to fetch` / `Load failed`), a rate limit, a timeout, an unrecognised (`UNKNOWN`) error. lib's boolean `false` (`fromBoolean`) is the exception: those services swallow the error, and web rolls the change back, so it ends `failed` and retryable. The delete services (`deleteOwnPost`, `deleteOwnReply`) also answer `false` for a send whose wait gave no verdict, so `fromDeleteBoolean` runs the write's own probe first (`ctx.probe()`): still there is `failed` and retryable, proved gone is `confirmed`, unreadable is `unconfirmed`. Only a verdict ends it `failed` (`provesNotApplied` in `src/writes/classify.ts`): a consensus refusal, a create proved absent (`NOT_RECORDED`), the engine's own refusal (outcome `local`), or one of lib's pre-signing errors (`PENDING_WRITE`, `STORAGE`, `NO_KEY`). To report a failure that provably happened before any lib write call (the handler's own validation, a read, a `settleUnconfirmed` probe), throw `new NotSentError(cause)` (exported from `src/writes/tickets.ts`): the cause is classified with outcome `not-sent`, and a transient one (network, rate limit, timeout) becomes retryable. A failure while the handler's last reported stage is `waiting-parent` counts the same for a transport failure, but an error with no verdict at all (a timeout, a nonce refusal, an unrecognised one) still ends `unconfirmed` there; report `signing` (or later) before calling lib. Neither proof counts once the ticket names an unconfirmed document (an earlier thread part may be out): the ticket is then `unconfirmed`, outcome `unknown`, and needs a check before any retry.
  - `persistArgs` is **off by default**: arguments live in memory only, so after an engine restart that ticket cannot be retried. Opt in only for arguments that may sit in plain kv (MMKV): never DM plaintext or private-feed content.
  - Report document ids (`ctx.documents`, or the result's `documents`) as soon as they are known: `check` can prove only what the ticket names, unless the handler has a `probe`. An empty list never proves anything (`unknown`), and a retry keeps a delete's documents (the same id is deleted again).
  - Arguments persist fail-closed: only for a registered handler that opts in, and never for `dm.*`. The boot-time rewrite of stored tickets waits a microtask, until the API has registered its handlers.
  - A handler's own `probe(ticket, args, kit)` gets the store's `ProbeKit`: `kit.proveDocuments(docs)` (the default proof) and `kit.recheckDelay()` (the gap before a second read confirms an absence). `relationProbe` (`src/writes/handler-kit.ts`) builds a probe from a read of the write's effect, read twice before a disagreement counts.
- `check(id)`, for an `unconfirmed` ticket: proves each named document present (create) or absent (delete) with proved `documents.get` reads (a disagreement, a create still absent or a delete still present, needs a second read 2 s later to count: one node can lag), or runs the handler's `probe`. Applied → `confirmed`; proved not applied → still `unconfirmed`, now `retryable`; unprovable → unchanged, with the probe's error. An answer a retry overtook is dropped.
- `retry(id)`: only a `failed` ticket whose error is retryable (refused retryably, or never sent), or an `unconfirmed` one a check proved not applied. Otherwise `NOT_RETRYABLE`. The earlier attempt's unproven documents are dropped (a fresh nonce gives fresh ids). Nothing is ever retried automatically.
- `get`, `check`, `retry` and `dismiss` act only on the active account's tickets (a retry signs with the active account's key), and the restart replay reports only the active account's reconciled tickets.
- **Deviation from ENGINE.md §7.3 row 12:** `NONCE_CONFLICT` (40204) is outcome `unknown` and `unconfirmed`, not "refused, retryable": the refusal can be this very transition executing before an SDK re-broadcast, and lib itself never rebuilds it (`state-transition-service.ts` `nonceRefused`). `NETWORK` and `NO_KEY` substring matches apply only to errors without a consensus code.
- `classify(err)` (`src/writes/classify.ts`) walks `categorizeError`'s predicates in its order, then the cases it leaves generic (duplicate, already exists, rate limit, timeout, network, missing key). `userMessage` is always `categorizeError`'s text. lib's three module-private predicates are recognised by the string `categorizeError` produces for them. `test/fixtures/error-vectors.json` pins 53 real messages (code, outcome, retryable, ticket state, user message; the state is `ticketStateFor`'s, for an error that ends a `run()` that may have broadcast); add one with every new web predicate.
- `tickets.observe(fn)` reports every ticket transition to engine-side caches a write makes stale (`safety.blocked`'s held list drops on a block or unblock that confirms or may have landed).

**`settings.get()` / `settings.set(patch)`** (`src/api/settings.ts`): link previews, media gate, read receipts, NSFW mode, notification toggles, `payWith` and feed language, through lib's own `useSettingsStore` setters (persisted by its `persist`). A patch is validated whole before any of it applies (`BAD_REQUEST`).

## Domain writes, notifications and safety (M7b)

Every write validates its input first (`BAD_REQUEST`, `NOT_SIGNED_IN`, `NOT_SUPPORTED` where `capabilities` says no; these reject the call, no ticket), then returns a `pending` ticket and runs one registered handler (`src/writes/handler-kit.ts`, `src/writes/publish.ts`). Each handler signs with the ticket's identity, persists its arguments (all of them are public content), and names what `check` proves. Writes that name a post this session created unconfirmed wait for it first, as web does (`settleUnconfirmed`; stage `waiting-parent`, then `signing` before lib's write; `PARENT_UNCONFIRMED` if it never shows).

| Method | Mirrors | Ticket mapping | `check` proves |
| --- | --- | --- | --- |
| `posts.publish(draft)` | `compose-modal.tsx` `handlePost` → `planPosts` → `publishThread`: 1–10 parts (a reply or quote: 1), NSFW flag, an image URL (`mediaUrl`, http(s)/ipfs; v10 hashes it in the engine with `imageDigestForUrl`), hashtag and mention indexes per topology (inside `publishThread`). Public only; replying to or quoting a private post is `NOT_SUPPORTED` | `documents[]` name each posted part (`part` index; `post` or `reply` as `publishThread` chained it), `progress` counts parts. A part that timed out (no id known) → `unconfirmed` even when a later part failed, so nothing can re-post it blindly; else `failedAtIndex` → `failed` with the posted parts kept; an unconfirmed part → `unconfirmed`. `writes.retry` (retryable refusals) resumes past the parts that landed; otherwise publish again with `resume.postedIds` from those documents | Every part named and proved; a part with no id (a restart or a timeout cut it short) is looked for by its text among the author's own posts and replies (`ownerAndTime`): found once where it would hang, it is named; nowhere on two reads, 2 minutes after the attempt stopped, it is absent and `writes.retry` posts it (ENGINE.md §7.2); otherwise it stays unconfirmed |
| `posts.delete(target)` | `post-card.tsx` `handleDelete`: lib's `deleteOwnPost`/`deleteOwnReply`, a tombstone where posts are permanent (v9, v11: posts are moderated and cannot be deleted), a delete elsewhere. Own posts only | `fromBoolean` | The document absent; a tombstone read back as `deleted` |
| `engage.like` / `unlike` | `use-post-engagement.ts` `toggleLike` (`likePost`/`unlikePost`, target author passed, its tag read by lib) | `fromBoolean` | the like document, by a read that throws (`src/writes/strict-reads.ts`; lib's `getLike` answers a failure as "none"), read twice before a disagreement counts |
| `engage.repost` / `unrepost` | `toggleRepost`. **v10:** a bare quote post (`createPost(viewer, '', resolveQuoteReference)`); a 40105 whose slot holds the viewer's own bare repost is that repost (`confirmed`), one holding a quote with text is `DUPLICATE`. Undo is `deleteOwnPost` on the bare quote (v11: a tombstone, which clears the quote and frees the slot; looked up with a throwing read, so an unreadable slot rejects the call); a quote with text rejects the call with `QUOTE_HAS_TEXT` (confirm, then `posts.delete(viewer.ownQuoteId)`). **Off v10:** `repostPost`/`removeRepost`. Gated by `canRepost` | the created quote post; the deleted one where deletes are real; `fromBoolean` off v10 | the slot (or the repost document) by a throwing read |
| `engage.bookmark` / `unbookmark` / `bookmarks(cursor?)` | `toggleBookmark`; `app/bookmarks/page.tsx` (all once, 20 a page, enriched). Gated by `canBookmark` | `fromBoolean` | `getBookmark` with `throwOnError` |
| `graph.follow` / `unfollow` | `use-follow.ts` (`followUser`/`unfollowUser`; no self-follow) | `fromTransitionResult`, the created `follow` named | `getFollowing` with `throwOnError` |
| `profiles.update(patch)` | `app/user/page.tsx` `handleSaveProfile`, `use-avatar.ts`: `updateProfile` (v10 DashPay `profile` + `yapprProfile`; v2 `profile`, created by the first save). Avatar `{uri}` or `{dicebear}` (encoded with `encodeAvatarData`), `null`/`''` clears; lengths from `profileTextLimits` | resolve → `confirmed` (lib does not surface an unconfirmed wait); lib's plan refusals (`ListLimitError`) → `BAD_REQUEST`, not sent | the profile read back field by field |
| `safety.block(id, {message?})` / `unblock(id)` | `use-block.ts`: `blockUser` (message ≤ 280) / `unblockUser`, then the provenance check: still blocked by a followed block list → `failed` `STILL_BLOCKED` | `fromTransitionResult` | the block document by a throwing read (lib's block status answers from a cache its write fills even when unconfirmed) |
| `safety.blocked(cursor?)` / `isBlocked(ids)` / `blockedBy(ids)` | `blocked-users.tsx` (`getUserBlocks`' query, up to 100, with each message; a failed read rejects, never an empty list; the list held for paging drops when a block or unblock lands); `checkBlockedBatch` (own blocks and followed lists alike); `getBlockSourcesBatch`: `'self'` (own block, wins when both apply), `'list'` (only a followed block list), `null` | — | — |
| `safety.report(target, reason, note?)` / `ownReport(target)` | `report-post-modal.tsx`: `reportInputProblem` (codes 0–8 from `lib/reports.ts`, "something else" needs a note, note ≤ 500), not one's own post, `fileReport`; `getOwnReport` (throws on a failed read). Gated by `capabilities.reports` | `fromTransitionResult`, the `report` named; a second report is `DUPLICATE` | `getOwnReport` |

**Notifications** (`src/api/notifications.ts`): web's `yappr-notifications` store and `notificationService`, as the sidebar loop and `app/notifications/page.tsx` use them. `list({filter, cursor})`: the first call per account reads the last 7 days (`getInitialNotifications`), then pages what is held, 30 at a time, keyset on time and id; types turned off in `settings.notificationSettings` are left out, and the tabs follow web's grouping (quotes under Reposts, blog comments under Blog). `poll()` merges `pollNewNotifications` from the watermark (RN calls it every 30 s while foregrounded). `markRead(ids)`, `markVisibleRead()` (only visible, enabled types) and `unreadCount()`. `notifications.count {unread}` fires after a load, a poll, a mark, and when a notification toggle changes.

**Caveats, all as on web:** "check again" judges the state now, so after a later opposite action (an unlike after the like, a newer profile edit) it reads `not-applied` and a retry re-applies the older intent (the UI should offer a retry only for the latest action on a target). lib's undo services (`unlikePost`, `unfollowUser`, `unblockUser`, `removeBookmark`) treat a failed pre-read as "nothing to undo" and succeed; `retryPostCreation` re-creates a thread part after a network error at broadcast, which can post it twice; `profile.update` and, on v2, thread parts cannot report an unconfirmed wait (lib does not surface it: a `confirmed` field on `SuccessfulPost` would fix the latter); part ids reach the ticket only when `publishThread` returns, so a restart mid-thread leaves no ids to prove. `unblock` reports `STILL_BLOCKED` as a failure, as `use-block.ts` does, although the own block was deleted.

**Spec drift (ENGINE.md §6.3, §8):** `DraftDTO.resume` is `{postedIds}` (the root is `postedIds[0]`), the image is `mediaUrl`, `notifications.unread` is `unreadCount`, and `content.created` adds `confirmed`.

**`content.created {kind, id, confirmed, post}`**: the window `post-created` / `reply-created` events `publishThread` dispatches for a thread's first part, forwarded with the document as a `PostDTO` (enriched when the reads answer).

**Live suite** (`test/contract/write/domain.test.ts`, personas 94–95; every scenario starts signed in as 94): post and delete, a 3-part thread failed on purpose at part 3 and resumed, reply and quote, like / repost (v10 slot recovery) / bookmark and their undos with the author reading the like notification (v11 likes are timeless: the author's device takes its baseline before the like), follow, block, report, profile update; retries only on transient codes and sakura's "Quorum not found in cache" (a quorum newer than the SDK's prefetch, see SDK bug 4; `retryQuorum`), credit spend to `$EVIDENCE_DIR/contract-write-domain.json`. `session.test.ts` also signs persona 96 in through the M3 test-wallet responder (`dash-key:`, then `dash-st:` on a first login). Pool personas need 0.05 DASH (5e9 credits) to run it; one domain run spent about 1.4e9 credits (2026-10-01). `test/contract/read/notifications.test.ts` reads a public testnet author's notifications read-only (lib's current user stubbed; nothing signed).

## Direct messages (M-DM)

**`dm.*`** (`src/api/dm.ts`, `src/dm/`): one surface and one set of DTOs (`ConversationDTO`, `MessageDTO`, `DmStatusDTO`) over two backends, picked by `dmIsV5()` and reported as `engine.info().capabilities.dm`:

- **`v5`** (devnet build): lib's `DmEngine` (`lib/services/dm-v5`), one per signed-in identity, which runs its own loop (30 s; 4 s while a conversation is open). Mirrors `components/messages/messages-v5.tsx`. Keys `d:…` / `g:…:…`.
- **`legacy`** (testnet build, the v3 contract): `directMessageService`, 1:1 only, mirroring `legacy-messages.tsx`: the open conversation polls every 3 s, the list is re-read at most every 30 s (when the host asks), and `markRead` writes a read receipt only with "Read receipts" on and something unread. Receipts are reciprocal (PRD DM-11): the peer's (`peerReadAt`) is read and shown only with the setting on. Without it v3's unread counts can never clear, so, as on web, there is no badge (`status` and `dm.changed` report 0; rows keep their counts). A conversation whose newest message is mine has nothing unread. lib reports failed reads as empty; the engine keeps the list, and each conversation's preview, it already holds. Keys `l:<conversationId>`. Group, hide, block and retention calls reject `NOT_SUPPORTED`. Web's merge of v3/v4 history into the v5 inbox is not ported: sakura is a fresh chain with no legacy history.

| Method | What it does | Returns |
| --- | --- | --- |
| `status()` | Readiness, `locked` (no encryption key on the device: PRD DM-02), unread messages and conversations (the badge), and on v5 the cap notice, retention, Messages block list and recovery progress | `DmStatusDTO` |
| `conversations()` / `search(q)` | The inbox by last activity, hidden ones flagged; 1:1 peers as `AuthorDTO` (cached 10 min). `search` matches group name, peer name, username, id and the preview | `ConversationDTO[]` |
| `messages(key, cursor?)` | Newest first, 50 a page; the cursor pages back in time (if its anchor message is gone, the page may repeat messages sharing its time: dedupe by id) | `Page<MessageDTO>` |
| `open(key \| null)` | The conversation on screen (fast polling, own streams, history) | — |
| `markRead(key)` | Read position (v5: coalesced into the next self-state save) | — |
| `send(key, text)` | `dm.send` ticket. v5 splits text over 4081 bytes, at most 20 parts. Refused before a ticket: empty or too long text, unknown conversation, blocked peer, a group I left or that ended (`BAD_REQUEST`) | `WriteTicket` |
| `startDirect(peerId)` | Opens (or finds) the 1:1 without writing; the first send starts it. A draft shows only while open | key |

On v5, a call naming a conversation before the saved state has loaded (`status().ready`) rejects with `ENGINE_BUSY` (retry), as do `startDirect` and the group actions; once loaded, an unknown key is `BAD_REQUEST`. Legacy reads the list first when a key arrives before it.
| `createGroup(name, ids)` / `createdGroup(ticketId)` | v5: up to 100 members with the creator, as a `dm.group` ticket (the roster, then a grant per member). One at a time: a second while one runs is `ENGINE_BUSY`, so a repeated tap never makes a duplicate group. Once confirmed, `createdGroup` gives `{key, failed}` (`failed`: resend keys); `null` before, or after an engine restart | `WriteTicket` / `{key, failed} \| null` |
| `renameGroup` / `addMember` / `removeMember` / `resendKeys` / `endGroup` (owner), `leaveGroup` (member) | `dm.group` tickets | `WriteTicket` |
| `hide(key)` / `setBlocked(id, bool)` / `setRetention(r)` | v5 "Delete conversation", block in Messages (the encrypted self-state, separate from `safety.block`), "Reclaim message fees"; saved at once | — |
| `unlock({key?})` | PRD DM-02, web's encryption-key modal: without `key`, derive it from the sign-in key; with `key` (WIF or hex, sensitive), check it against the identity and store it | `{unlocked, status}` or `{unlocked: false, reason}` |

- **Lifecycle.** The backend starts on `session.changed` with a session (`restored`, `signed-in`, `switched`), and on any `dm.*` call (so it starts once a key appears, as web's `retry`); a failure to start is logged, never a failed sign-in. Sign-out and account switch (run one at a time with sign-ins, through one session queue) call the session's `stopDm` before the keys go: the loop stops, lib's engine is released (`stopDmEngine(engine)`, which leaves a replacement lib made for a new key alone), and the self-state flush is awaited (at most 10 s, since sign-out works offline), then nothing restarts messages (`RESTART_REQUIRED`), ticket retries and checks included, until a session starts again or the sign-out fails (`resumeDm`). `dm.unlock` re-checks the session after its reads, so a key is never stored for an account that signed out meanwhile. `engine.lifecycle('background')` resolves once the DM flush is done, or after 2 s (ENGINE.md §9.3; PRD DM-14); `active` polls at once. The v5 loop itself keeps its 30 s timer in the background (lib has no pause); the host's WebView suspension bounds it.
- **Events.** `dm.changed {unreadTotal, unreadConversations, changedKeys, ready, error}`, coalesced to one per 250 ms from row diffs, and `dm.message {key, message}` once per new incoming message newer than the session start (history and recovery never notify). Limits: on legacy only loaded threads are read, so `dm.message` fires for the open conversation (others show through `dm.changed`); a re-activation in one boot (a new key, sign-out and in) may repeat the last minute's messages; a group message arriving out of order and already read past changes no row and is not announced.
- **Tickets.** `dm.send` and `dm.group` never persist their arguments (message text, group names). A v5 send resolves as `confirmed` (`DmEngine.send` reads uncertain broadcasts back itself); a transport failure is `unconfirmed`. Its "check again" first re-reads the chain (v5: my own streams of that conversation on the engine's queue, lib's `DmEngine.pollOwn`; legacy: `pollNewMessages` after the last one read), then is `applied` once every part shows as a message of mine that was not there at submit and that no other send accounts for (each run records the messages it made, each proof the ones it matched), so neither an earlier nor a concurrent identical "ok" ever counts. A send that finds the device locked fails as `NO_KEY` (not sent, retryable) and asks the host for the key; `dm.status().locked` says it is the encryption key. A group change's check polls and looks at the roster (renamed, member in or out, ended; a creation: a new group of mine with that name and members); leave and resend keys stay unknown. After a restart the arguments are gone, so such a ticket stays unconfirmed: send again.
- **Lost replace answers.** lib keeps an SDK-signed write (a roster or self-state replace) whose answer never came (a transport error after the broadcast) pending for 15 minutes, and refuses every DM write in between with `PENDING_WRITE`, even once the DM engine has read the replace back. Before each v5 write the engine calls lib's `settleSupersededReplaces`, which releases such an entry once Platform shows its document at the revision it writes, or later, and the nonce after the one Platform reported before it was signed consumed (a stale-revision replace still executes as a paid error and takes a nonce, so the revision alone is not enough; no nonce is guessed). A replace still unseen keeps holding writes back, as it must. The sakura write suite loses one rename answer on purpose and expects the next group change to confirm.
- **Tests.** `test/unit/dm.test.ts` runs both backends offline: v5 on lib's in-memory test chain with three users on one ledger (round trip, events, paging, groups, block, hide, retention, lifecycle, the unconfirmed send), legacy over a fake service. `test/contract/read/dm.test.ts` checks the session gate and, on testnet, lists a public legacy inbox (v3 invites name both sides in the clear) without decrypting anything. `test/contract/write/dm.test.ts` is the sakura suite on personas 94–96 (1:1 round trip; group create, rename, add, leave, through account switches); it skips with the W-SAKURA reason until the cutover.

## Cold start in the app (2026-10-02, devnet sakura, evo-sdk 5.0.0-beta.1)

Release builds (`npm run release:android -- apk`, `npm run release:ios -- simulator`) of staging `c0f5e294` against this split, on the Android emulator `yappr_pixel_l4` (Android 15, System WebView 124, signed out) and the iOS 26.5 simulator (signed in). Cold launches, interleaved build by build, 6 per build; medians, with the range. Mount, hello, boot and ready are the supervisor's timings (Settings → Engine diagnostics). The host was shared with other agents (load average 35–55), and the network part of boot varies run to run.

| | Android before | Android after | iOS before | iOS after |
| --- | --- | --- | --- | --- |
| Prepare (snapshot, page) | 130 ms | 70 ms | 390 ms | 63 ms |
| Mount → hello | 946 ms (824–1415) | 594 ms (387–867) | 886 ms (834–1117) | 656 ms (636–829) |
| Boot (`engine.boot()`) | 2012 ms (1509–2740) | 637 ms (268–1006) | 732 ms (657–870) | 215 ms (114–350) |
| **Mount → ready** | **3448 ms (2521–4162)** | **1400 ms (1105–1891)** | **1620 ms (1503–2014)** | **996 ms (904–1466)** |
| Launch → first avatar drawn (screen recording) | 3.60 s | 3.32 s | 2.80 s | 2.33 s |
| JS heap after boot (Chromium) | 72 MB | 60 MB | | |
| WebView renderer PSS | 251 MB | 236 MB | | |

- **What each change bought** (Android, earlier interleaved rounds): moving the WASM out of `engine.js` took mount → hello from about 840 to 600 ms. The bundled TokenHistory contract (one `getDataContracts` round trip, 0.3–0.7 s), the WASM preload at hello and the quorum preconnect took boot from about 2 s to 0.6 s. On iOS, loading the page by file URL took prepare from 390 to 63 ms: the 15 MB page no longer goes through Hermes and the bridge.
- **Launch → feed** stays about the same (2.7–2.9 s on Android, 1.6–1.7 s on iOS): the host shows the persisted feed before the engine is ready.
- **Under heavy load** (another agent's builds, load average up to 200), the same comparison on Android gave mount → ready 8.6 s before and 4.3 s after (medians of 6), and the "4–5 s to parse engine.js" seen before was mostly that load: on a quiet emulator, the old 15 MB bundle loaded and ran in 0.4–1.2 s.

## Measurements (2026-10-01, testnet, evo-sdk 4.2.0-beta.7, Apple Silicon Mac)

**Bundle:**
- `engine.js` was **15.09 MB**, **9.45 MB gzip** as of M7b (14.92 MB at M2; M7b adds the composer, the notification and report services, and the services index `publishThread` imports). About 11.8 MB of it was evo-sdk with the inlined wasm.
- The rest was wasm-sdk glue (0.5 MB), `lib/` (0.48 MB) and `@dicebear` avatar styles (about 2 MB).
- **Since the split (2026-10-02):** `engine.js` is 1.53 MB (0.34 MB gzip), `engine.wasm.js` 11.40 MB and `engine.avatars.js` 2.03 MB.
- The build takes about 0.4 s.

**Browser boot proof:** `npm run test:browser`, 3 cold runs per configuration, each in a fresh browser context. Two more WebKit runs check the injected snapshot: a session read at call time (the feed comes back with viewer marks), and a persisted `yappr-settings` `feedLanguage: 'zz'` read by zustand `persist` when `lib/store.ts` loads (the v2 For You page comes back empty). Raw data is in `browser-boot-*.{json,tsv}`; the files for these numbers, the simulator screenshot and the reproducer below were saved **locally** on the build machine under `/tmp/claude/yappr-mobile/evidence/m2-engine/` and are not in the repo. "Boot" is the `engine.boot()` round trip (wasm decompress + compile, SDK connect, contract preload; testnet contracts are seeded from `lib/contracts/bundled`). "Feed" is the first For You page (`feed.home`), enriched.

| Engine (version) | Origin | hello (parse + eval) | boot | first feed | cold start → feed |
| --- | --- | --- | --- | --- | --- |
| WebKit 26.5 | `file://` (null) | 143–199 ms | 443–936 ms | 646–1737 ms | 1.80–2.35 s |
| WebKit 26.5 | `https://engine.yap.pr` | 348–549 ms | 441–888 ms | 646–1659 ms | 1.44–2.66 s |
| Chromium 151 | `file://` (null) | 89–98 ms | 482–1991 ms | 1077–1503 ms | 2.09–3.16 s |
| Chromium 151 | `https://engine.yap.pr` | 213–253 ms | 427–456 ms | 770–1710 ms | 1.48–2.35 s |
| Chromium 151, CPU ×4 | `file://` | 202–210 ms | 632–1090 ms | 1004–1363 ms | 1.86–2.31 s |
| **iOS 26.5 Mobile Safari** (simulator) | `http://127.0.0.1` | 174 ms | 803 ms | 2522 ms | **3.50 s** |

- **What dominates:** most of the time goes to DAPI round trips, not wasm, and the spread between runs is network variance; four earlier runs of the suite landed in the same ranges. On WebKit over `file://` the blob Worker compile fails, and the main-thread fallback compile takes 22–110 ms. Over https, and in Chromium, the Worker compiles.
- **Memory:** the Chromium JS heap after boot is about 64–68 MB. The wasm linear memory comes on top of that.
- **Small sample:** testnet has only **2** `en` posts since the August rollback, so the first-feed numbers cover a 2-post page. A 20-post page will enrich more.
- **Mobile Safari:** this run used `dist/testnet/selftest.html` (the bundle before the review fixes, same engine core) served from a local http server. Simulator Safari treats `file://` as a download, so it can't test that origin. Screenshot: `ios-sim-safari-selftest.png`.
- **CPU throttle:** CDP throttles only the main thread, not the Worker that compiles the wasm.
- **Still to measure:** M4 must repeat these numbers in the real WKWebView/Android WebView hosts on devices.

**Node harness** (`npm run test:contract`): boot is about 450–520 ms, and the first For You page about 0.6–1.2 s.

**Read API, cold** (first call after boot in a fresh Node engine, testnet, 3 runs, p50): `feed.home` 1.55 s, `feed.checkNew` 1.29 s, `feed.hashtag` 0.20 s, `posts.get` 1.48 s, `posts.thread` 1.36 s, `posts.engagements` 0.70–0.81 s, `posts.engagementCounts` 0.47 s, `posts.poll` 0.21 s, `posts.mentionCandidates` 1.11 s, `engage.stats` 0.60 s, `profiles.get` 0.85 s, `profiles.posts` 0.51 s (posts), `graph.followers`/`following` 0.14–0.18 s, `explore.trending` 0.20 s, `explore.searchUsers` 0.61 s, `explore.searchHashtags` 0.41 s, `explore.searchPosts` 0.94 s. Warm calls after the first page are mostly 60–250 ms. The raw numbers are in the local evidence directory (`/tmp/claude/yappr-mobile/evidence/m6-engine-reads/`).

## Origin and CORS finding

- **CORS works from `file://`:** testnet DAPI nodes (`https://<ip>:1443`, grpc-web) **echo the request origin** in `Access-Control-Allow-Origin`. That is `null` for `file://` and `https://engine.yap.pr` for the custom base, so `fetch` from a `file://` page works in both WebKit and Chromium.
- **Quorum endpoint:** the trusted-context quorum fetch also succeeded from both origins, since every boot finished.
- **Both loading modes are viable for the host:**
  - `source={{ uri: 'file://…/engine.html' }}` (Android also needs `allowFileAccess`);
  - `source={{ html: inline, baseUrl: 'https://engine.yap.pr/' }}` with `engine.inline.html`.
- **What ships:** both platforms load by file URL (origin `null`): iOS `index.html` with read access to its directory, Android the loader page over `file:///android_asset/engine/`. Neither crosses the RN bridge with the bundle. The https base remains for `engine.inline.html` in iOS dev builds. (The https base was first preferred for WebKit's off-main-thread compile in a blob Worker; the engine now compiles with `instantiateStreaming` on both origins.)
- **Not origin-related:** every run logs 3–9 failed requests to unhealthy testnet evonodes (`85.209.243.2–9`, which answer `ERR_INVALID_HTTP_RESPONSE` / "network connection was lost"). The SDK bans them and retries elsewhere. The same nodes fail from both origins.

## SDK and platform bugs found

1. **evo-sdk 4.2.0-beta.7 fails proof verification when paging past the end of a descending query.**
   - On testnet's `post.languageTimeline`, the query is `where language == 'en' and $createdAt > 0`, `orderBy language asc, $createdAt desc`, `limit 20`, `startAfter <last id>`.
   - When there are no more documents, it throws `grovedb: invalid proof: Invalid V1 proof verification parameters: invalid proof error Proof op family does not match the query direction: upright op in a right-to-left walk; a layer proof is emitted entirely in the family of its own direction`. `startAt` fails the same way.
   - The ascending equivalent returns an empty page.
   - Web's For You infinite scroll on testnet hits this too. Filed as dashpay/platform#5244; the engine reads it as the end of the list.
   - Reproducer: `node --input-type=module < repro-startafter-proof.mjs`, run from a checkout with the root deps. The script is in the local evidence directory (not in the repo); it pages the query above with `startAfter` and `startAt`, and then without the range clause.
2. **The same index ignores `desc` without a range clause** (same reproducer script, last line). `where language == 'en'`, `orderBy language asc, $createdAt desc` returns the documents in ascending `$createdAt`. Adding `$createdAt > 0` gives the expected descending order.
3. **Web bug (lib, not fixed here): `isUsernameContested()` always returns false.**
   - `lib/utils/username.ts` imports `WasmSdk` from `@dashevo/wasm-sdk`. That module is never initialized, because evo-sdk bundles its own copy of the glue and the wasm.
   - So `WasmSdk.dpnsIsContestedUsername` throws "Cannot read properties of undefined (reading '__wbindgen_malloc')" even after `EvoSDK.connect()`, the catch returns false, and "contested first" primary-name ordering never applies.
   - It only works after `identity-update-builder` has run `initWasm()`, which instantiates a second 24 MB wasm.
   - The engine inherits the same behavior.
4. **wasm-sdk 5.0.0-beta.1 never refreshes its trusted quorum keys for a read.**
   - `WasmTrustedContext` builds `TrustedHttpContextProvider` with `with_refetch_if_not_found(false)` and fetches `/quorums` and `/previous` once, when the SDK is built. Only a state-transition broadcast refreshes them, and JS has no refresh call.
   - Sakura forms a quorum every 24 blocks (about 4 minutes at 10 s blocks), and Platform signs with it straight away. Any read whose proof names it fails with `invalid quorum: Quorum not found in cache for hash: …`, although the quorum service lists it. An SDK that is never rebuilt fails more often as the prefetched quorums leave the active set.
   - lib's failure observer rebuilds the SDK on that error, so the next call works; the call that hit it fails. In a 16-minute soak on sakura, feed.home every 20 s failed 3 of 47 times. The engine's read modules (`feed`, `posts`, `engage`, `profiles`, `graph`, `explore`, `notifications`) now wait for that rebuild and retry once (`src/api/stale-quorum.ts`); the same soak then failed 0 of 48 times in Node (2 retries) and 0 of 48 in WebKit on the built devnet bundle (1 retry). Writes, session and DM calls are not retried. Neither are failures lib turns into empty results or that the engine rethrows as `NETWORK` (the Following feed), nor `engage.bookmarks`, which lives with the writes.
   - Upstream fix: dashpay/platform#5236 (refresh on a miss inside the SDK). Remove the retry once evo-sdk ships it.

## Known gaps

- Not in the read API yet: `explore.welcome` (signed-out homepage) and blog results in search (blogs are not in 1.0).
- Testnet holds 2 `en` posts since the August rollback, so the contract suite cannot exercise a second page, rankings (v2 has none), trending or a native poll there; those paths run live only once sakura's contracts are published (the thread builders and cursors have unit tests).
- The devnet variant can't boot until `.env.devnet` moves to sakura.
- **Not yet done** (they belong to M4, the EngineHost): the encrypted-MMKV and Keychain/Keystore write-through on the host side, the supervisor and replay of reads, and memory numbers on devices.
