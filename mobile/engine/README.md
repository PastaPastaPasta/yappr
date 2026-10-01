# mobile/engine

The headless Yappr engine for the iOS and Android apps (ADR-001 E1/E2). It is an esbuild bundle of `@dashevo/evo-sdk` (the version pinned in the root `package.json`), the web `lib/` **unmodified**, and the curated API in `src/api/`. It runs in one hidden WebView. The React Native UI talks to it only through the RPC in `src/rpc/`, and imports `type EngineApi` and nothing else from here at type level.

```
mobile/engine/
  build.mjs              esbuild bundle per variant → dist/<variant>/
  src/protocol/          envelope types + JSON codec (dependency-free; the RN app imports these at runtime)
  src/rpc/               transport, dispatcher (engine side), client proxy (host side)
  src/shims/             storage (sync Web Storage, write-through, secure routing), lifecycle events
  src/api/               engine, feed, posts, engage, profiles, graph, explore: thin calls into lib/; dto.ts
  src/dto/               cursors, paging, enrichment pipeline, thread port, capabilities, DTO validators
  src/entry.webview.ts   the WebView entry; src/install-shims.ts runs before lib loads
  src/selftest.ts        selftest.html: engine + in-page host, for browsers nothing can drive
  test/unit/             codec, RPC, shims, DTO mappers (offline)
  test/contract/read/    the read API in Node against testnet, one file per module (ENGINE_VARIANT=devnet: sakura)
  test/browser/          the built bundle in Playwright WebKit + Chromium, file:// and https origins
```

## Commands

Run `npm ci` at the repo root first: the bundle resolves `lib/`'s dependencies from the root `node_modules`. Then, in `mobile/engine`, run `npm ci` (only esbuild is installed here; vitest, TypeScript and Playwright come from the root).

| Command | What it does |
| --- | --- |
| `npm run build:testnet` / `build:devnet` / `build` | Bundle → `dist/<variant>/{engine.js, engine.html, engine.inline.html, selftest.html, manifest.json, meta.json}` |
| `npm run typecheck` | `tsc` over src, tests and the lib files they reach |
| `npm run lint` | ESLint with the engine's own config (`.eslintrc.cjs`; the root config ignores `mobile/**`) |
| `npm test` | Unit tests (offline) |
| `npm run test:contract` | Engine read API in Node against **testnet** (read only, unauthenticated). `ENGINE_VARIANT=devnet` runs the same suite on `.env.devnet`; it skips with a reason until `ENGINE_DEVNET_READY=1`. Per-call timings go to `$EVIDENCE_DIR/contract-read-<variant>/` |
| `npm run test:browser` | Needs `build:testnet`. Boots the bundle in WebKit and Chromium; writes timings to `$EVIDENCE_DIR` (default `test-results/`, gitignored; `RUNS=n` per configuration) |

CI: `.github/workflows/mobile-engine.yml` runs typecheck, lint, unit tests and both bundle builds on changes to `mobile/engine/**`, `lib/**`, `types/**`, `vendor/platform-auth/**`, `contracts/**`, the root manifests and `.env.devnet`, so a web change that breaks the engine fails on the web PR. The contract and browser suites need the live network and run locally for now.

### Variants and env

- **`testnet`** uses **no env file**, like the production web build (`npm run build` loads none). `lib/constants.ts` falls back to its testnet defaults: network `testnet`, social `9oDC6xdg…` (topology v2).
- **`devnet`** reads `.env.devnet`, like `npm run build:devnet`.
- **Inlining:** only `NEXT_PUBLIC_*` keys are inlined (`define process.env.X`), as Next.js does. Any other `process.env.X` reads `undefined`.
- **Storage:** `NEXT_PUBLIC_STORAGE_SCOPE` and `NEXT_PUBLIC_BASE_PATH` are empty. The host namespaces storage per network instead.
- **`.env.devnet` is stale:** it still points at **bonsia**, which is abandoned. The devnet variant builds, but it can't boot until the sakura cutover rewrites `.env.devnet`.

## How the wasm loads

- **No separate wasm file.** evo-sdk's `dist/evo-sdk.module.js` is a self-contained webpack bundle. It carries its own wasm-bindgen glue and the gzip+base64 wasm inline (the `@dashevo/wasm-sdk/compressed` format). Nothing fetches a `.wasm` file, so the engine works from `file://` with no web server and no COOP/COEP headers.
- **The init path:**
  1. `EvoSDK.connect()` decodes the base64.
  2. It compiles in a blob `Worker` (with `DecompressionStream`).
  3. If the worker fails, it falls back to decompressing and compiling on the main thread.
- **How compilation is cheap:** V8 and JSC compile lazily, so the main-thread `WebAssembly.compile`/`instantiate` calls measure in tens of milliseconds, not seconds.
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
  - **The host must assign the snapshot as a property** (`window.__YAPPR_ENGINE_STORAGE__ = …`), not declare it with `var`.
  - **Write-through:** every write is emitted as the event `storage.change {area, key, value|null}`. Writes lib makes while its modules load (before the entry subscribes) are queued and delivered to the first subscriber.
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
- **Early error reporter:** `install-shims.ts` posts uncaught errors and unhandled rejections straight to the bridge. If a lib module throws while loading, the bundle stops before the dispatcher exists, and that log line plus the client's hello timeout are what the host sees.

## RPC

- **Envelopes** (`src/protocol/envelope.ts`), each one JSON string through the codec:
  - `req {t,v,id,path,args}`
  - `res {t,v,id,ok,value|error}`
  - `evt {t,v,event,payload}`
  - `log {t,v,level,message}`
  - `ping {t,v}` (host → engine: re-send hello)
- **Handshake:**
  - The engine sends `evt engine.hello {protocol, bundleHash, instanceId}` when it can take calls, and again whenever it receives a `ping`. The client pings on creation, so a client created after the engine loaded still completes the handshake.
  - The client queues calls until the first hello. A hello with another protocol fails the client (`PROTOCOL_MISMATCH`); so does no hello within `helloTimeoutMs` (default 30 s, `ENGINE_HELLO_TIMEOUT`). The engine also refuses requests with a different `v`.
  - **Restart signal:** a hello with a new `instanceId` means the WebView reloaded. Every pending call is rejected with `ENGINE_RESTARTED`. The supervisor may retry reads; writes go through the unconfirmed-writes rules.
- **Deadlines:** each call's `timeoutMs` (default 60 s) counts from the call, including time spent waiting for the hello (`RPC_TIMEOUT`).
- **Undecodable messages** never leave a caller waiting: the engine answers a request it cannot decode with `BAD_ENVELOPE`, and the client rejects a response it cannot decode with `BAD_ENVELOPE`.
- **Codec** (`src/protocol/codec.ts`):
  - carries `Date`, `Uint8Array` (any binary view arrives as `Uint8Array`), `bigint`, `Map`, `Set`, `undefined`, NaN/±Infinity, and errors;
  - user objects with a `$t` key are escaped, and a `__proto__` key stays a key (never a prototype);
  - cycles throw.
- **Errors:** they arrive as `RemoteError {name, message, code?, kind?, isRetriable?, cause?, data?, remoteStack?}`.
  - evo-sdk's `WasmSdkError` does not extend `Error`, and exposes its fields as prototype getters. The engine reads them with guarded reads (a freed error's getters throw), so consensus codes survive the bridge.
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
| `posts.get(id)` | `usePostDetail`: post, else reply; a v10 bare repost resolves to its target | `PostDTO \| null` |
| `posts.thread(id, cursor?)` | `usePostDetail` + its module-private tree builders (ported to `src/dto/thread.ts`): ancestors (root on flat threads, the parent walk on v2), replies with the author's thread first, frontier expansion under a focused reply, deleted-parent stubs (v10, `deletedStub: true`, blank author). Pages are **cumulative** (a later page can nest under an earlier one); a call without a cursor re-reads everything. | `ThreadDTO` |
| `posts.engagements({id, kind}, tab, cursor?)` | `app/post/engagements/page.tsx`: `getPostLikes` / `getPostReposts` / `getQuotePosts` (v10: one list split by `splitRepostsAndQuotes`, `truncated` at 100), 30 users a page | `EngagementPage` |
| `posts.engagementCounts({id, kind})` | `loadEngagementCounts`; v10 splits the quote list as the engagements page does | `{likes, reposts, quotes, truncated}` |
| `posts.poll({contractId?, id})` | `components/poll/poll-card.tsx`: `getPoll`, `getTally` (`totalVotes: null` when unreadable), `getMyVotes` (`myVotes: null` when unreadable); each degrades alone | `PollDTO \| null` |
| `posts.mentionCandidates(prefix)` | `mention-autocomplete.tsx`: ≥3 chars, `searchUsernamesWithDetails(…, 5)`, one row per identity | `UserSummaryDTO[]` |
| `engage.stats(targets)` | `getBatchPostStats` + (signed in) `getBatchUserInteractions`, ≤100. lib reports a failed read as zeros, so the counts are advisory | `Record<id, EngageStatsDTO>` |
| `profiles.get(idOrName)` | `app/user/page.tsx`: `loadUserStats`, `getProfile`, `getAllUsernamesSorted`, viewer `isFollowing` / `isBlocked` (`blocks: null` when unreadable). A failed profile read rejects (checked with `profileExists`), never "no profile"; `null` for an unknown identity, or a name DPNS did not resolve (lib reports unreachable as not found, so that `null` may be transient). | `ProfileDTO \| null` |
| `profiles.posts({id, tab, window?, cursor?})` | `posts`: `getUserPosts` (+ reposts off v10, each placed on the page its time falls in); `replies`: `getUserReplies` + `fetchReplyParents` (`ProfileReplyDTO`); `top`: author ranking; `mentions`: `getPostsMentioningUser` → `loadMentioningPosts`, paged in memory | `Page<PostDTO \| ProfileReplyDTO>` |
| `profiles.batch(ids)` | `loadIdentityBatch`, ≤100, in order | `UserSummaryDTO[]` |
| `profiles.avatarSvg(id, style?, seed?)` | `generateAvatarSvg`: the recipe given, or the identity's own (`null` for an image avatar) | `string \| null` |
| `graph.followers(id, cursor?)` / `following` | `connection-list-page.tsx`: whole list once, 30 a page with names, profiles, counts, viewer follow | `Page<UserSummaryDTO>` |
| `graph.status(ids)` | `getFollowStatusBatch` (signed in), ≤100 | `Record<id, boolean>` |
| `explore.trending({window?})` | `getTrendingHashtags({168 h, 12})`; cashtags flagged; `countKind` likes on v9/v10 | `TagDTO[]` |
| `explore.topPosts({window?})` / `topCreators({window?})` | `app/explore/page.tsx`, `top-creators.tsx` | `PostDTO[]` / `RankedUserDTO[]` |
| `explore.searchUsers(q)` / `searchHashtags(q)` / `searchPosts(q)` | `app/search/page.tsx` (≥3 chars; exact-name fallback; trending + exact tag count); `app/explore/page.tsx` (substring over the newest 100 posts) | `UserSummaryDTO[]` / `TagDTO[]` / `PostDTO[]` |

DTO types and mappers live in `src/api/dto.ts`; `src/dto/` holds the cursor codec, paging, the enrichment-and-filter pipeline (`hydrate.ts`), the thread port, capabilities and the runtime validators (`validate.ts`, used by every contract test). `boot()` fails with code `NO_WEBASSEMBLY` when WebAssembly is missing (iOS Lockdown Mode).

- **Browsing lists** (feeds, tags, explore, search) drop blocked authors, including the author behind a v10 bare repost, and apply the NSFW `hide` preference (`filterHiddenSensitive`), as web does. Profile tabs keep a blocked author's own posts; threads and single posts never filter (the host renders the gate).
- **Cursors** are opaque base64url JSON tied to the engine build, and to the list they page (tag, thread, profile, feed language, viewer for Following and Top); a foreign, stale or malformed one rejects with `BAD_CURSOR`. Lists lib reads whole are kept for 60 s per scroll (pruned as new ones load).
- **dashpay/platform#5244:** on testnet, paging past the last document of a mixed-direction query (`x asc, $createdAt desc`) throws a proof error instead of proving an empty page. A continuation that hits it ends the list (`src/dto/paging.ts`).
- **Topology:** a method the active contract cannot serve rejects with `NOT_SUPPORTED`; RN reads `engine.info().capabilities` (rankings, windows, quote-slot rules, reposts/bookmarks per kind, flat threads, tombstones, reports, content limits in chars and bytes, profile limits) instead of evaluating `lib/contract-topology.ts`.
- **Authors:** `displayName` is never empty (profile name, DPNS label, `User <last 6>`). `avatar` is `{uri}` for an image or `{dicebear: {style, seed}}` for a generated one, read from the stored profile field; render the latter with `profiles.avatarSvg` and cache it under `style:seed` (RN never bundles DiceBear). `resolved` is false when lib's enrichment failed.
- **Viewer state:** signed in only: `liked`, `reposted`, `bookmarked`, `ownQuoteId` (v10's one quote-or-repost slot), `authorBlocked`, `followsAuthor`.
- **Polls:** `PostDTO.poll` is set for a native embed on the configured Pollr contract or a legacy Pollr link (`linkUrl`, which web hides from the text), exactly as `post-card.tsx` decides.

## Measurements (2026-10-01, testnet, evo-sdk 4.2.0-beta.7, Apple Silicon Mac)

**Bundle:**
- `engine.js` is **14.92 MB**, **9.39 MB gzip**. About 11.8 MB of it is evo-sdk with the inlined wasm.
- The rest is wasm-sdk glue (0.5 MB), `lib/` (0.48 MB) and `@dicebear` avatar styles (about 2 MB).
- The build takes about 0.4 s.

**Browser boot proof:** `npm run test:browser`, 3 cold runs per configuration, each in a fresh browser context. Raw data is in `browser-boot-*.{json,tsv}`; the files for these numbers, the simulator screenshot and the reproducer below were saved **locally** on the build machine under `/tmp/claude/yappr-mobile/evidence/m2-engine/` and are not in the repo. "Boot" is the `engine.boot()` round trip (wasm decompress + compile, SDK connect, contract preload; testnet contracts are seeded from `lib/contracts/bundled`). "Feed" is the first For You page (`feed.home`), enriched.

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
- **Recommendation:** prefer the https `baseUrl`. It gets the off-main-thread wasm compile on WebKit, and gives a stable non-null origin.
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

## Known gaps

- `posts.get` returns `null` for a failed read as well as for a missing post. That's lib's single-document `get()`, kept as is.
- Not in the read API yet: `explore.welcome` (signed-out homepage) and blog results in search (blogs are not in 1.0).
- Testnet holds 2 `en` posts since the August rollback, so the contract suite cannot exercise a second page, rankings (v2 has none), trending or a native poll there; those paths run live only once sakura's contracts are published (the thread builders and cursors have unit tests).
- The browser test proves the injected snapshot reaches lib through the session (read at call time). It doesn't yet assert a module-scope read, such as a persisted zustand setting. The evaluation order was checked in the bundle by hand, and the review confirmed it.
- The devnet variant can't boot until `.env.devnet` moves to sakura.
- The bundle carries all 30 `@dicebear` styles (about 2 MB) because `unified-profile-service` imports the collection. Trimming it would need an alias.
- **Not yet done** (they belong to M4, the EngineHost): the encrypted-MMKV and Keychain/Keystore write-through on the host side, the supervisor and replay of reads, and memory numbers on devices.
