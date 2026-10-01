# mobile/engine

The headless Yappr engine for the iOS and Android apps (ADR-001 E1/E2). It is an esbuild bundle of `@dashevo/evo-sdk` (the version pinned in the root `package.json`), the web `lib/` **unmodified**, and the curated API in `src/api/`. It runs in one hidden WebView. The React Native UI talks to it only through the RPC in `src/rpc/`, and imports `type EngineApi` and nothing else from here at type level.

```
mobile/engine/
  build.mjs              esbuild bundle per variant → dist/<variant>/
  src/protocol/          envelope types + JSON codec (dependency-free; the RN app imports these at runtime)
  src/rpc/               transport, dispatcher (engine side), client proxy (host side)
  src/shims/             storage (sync Web Storage, write-through, secure routing), lifecycle events
  src/api/               engine.*, feed.*, posts.*, profiles.*: thin calls into lib/, mapped to DTOs
  src/entry.webview.ts   the WebView entry; src/install-shims.ts runs before lib loads
  src/selftest.ts        selftest.html: engine + in-page host, for browsers nothing can drive
  test/unit/             codec, RPC, shims, DTO mappers (offline)
  test/contract/         the API in Node against testnet, read only
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
| `npm run test:contract` | Engine API in Node against **testnet** (read only, unauthenticated) |
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
- **`@dashevo/wasm-sdk/compressed`** (esbuild alias, same in vitest): re-exports evo-sdk's own copy, so the first-login key-registration builder (`lib/services/identity-update-builder.ts`, reached through `lib/auth/platform-auth-adapters`) shares evo-sdk's WASM instance. Without it the bundle carries a second 11.2 MB WASM payload (26.3 MB instead of 15.0 MB).
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
- **Host client:** `createEngineClient<EngineApi>(transport, {timeoutMs, helloTimeoutMs, onLog})` gives a Proxy. `client.api.feed.forYou({cursor})` sends path `feed.forYou`. Coercing or inspecting the proxy (`then`, `toString`, `toJSON`, `$$typeof`, …) sends nothing. `close(reason)` rejects in-flight calls (for the supervisor on WebContent death), and `ping()` asks for a fresh hello.

## API (initial)

| Method | Calls into lib | Returns |
| --- | --- | --- |
| `engine.boot()` | `evoSdkService.initialize({network, contractId})`, as web's `SdkProvider` does | `EngineInfo` |
| `engine.info()` | — | `EngineInfo`: protocol, variant, bundle sha256, evo-sdk version, network, topology, contract ids, ready, webAssembly, bootMs |
| `feed.forYou({cursor?})` | As web's `useFeedData`: `loadForYouFeed` with the persisted `feedLanguage` (where `postsHaveLanguage()`), `sortFeedByTimestamp`, then `postService.enrichPostsBatch` (authors, stats, viewer marks, block and follow status, quotes) and `enrichPostsWithRepostsAndQuotes` (repost attribution, drops tombstones). Web's page cache and new-post polling are the host's job. | `Page<PostDTO>` |
| `posts.get(id)` | As web's `usePostDetail`: `postService.getPostById`, falling back to `replyService.getReplyById` + `replyToPost`; a v10 bare repost resolves to its target; then `enrichPostsBatch` | `PostDTO \| null` |
| `profiles.get(idOrName)` | `dpnsService.resolveIdentity` (for names), `loadUserStats`, `unifiedProfileService.getProfile`, `dpnsService.getAllUsernamesSorted`, as web's `/user` does | `ProfileDTO \| null` |
| `engine.lifecycle(state)` | lifecycle shim | — |
| `engine.connectivity(online)` | `online`/`offline` events, then `evoSdkService.restoreConnection()` once a boot was attempted (rebuilds a dead instance or finishes a failed boot, as web's `SdkProvider`) | — |
| `engine.setLogLevel(level)` | console forwarding threshold | — |

DTOs live in `src/api/dto.ts`. `boot()` fails with code `NO_WEBASSEMBLY` when WebAssembly is missing (iOS Lockdown Mode).

- **Authors:** `author.displayName` and `author.avatarUrl` are never empty. They fall back to the DPNS label, then `User <last 6>`, and to the default DiceBear avatar.
  - `author.resolved` is false when lib's lookup failed (it swallows the error), so the host knows the fallbacks are placeholders.
  - That covers a feed author left in the loading shape and a quoted post's author left as lib's `Unknown User` placeholder, whose name is then dropped in favour of the fallbacks.
- **Viewer state:** signed in only. Covers `liked`, `reposted`, `bookmarked`, `authorBlocked` and `followsAuthor`.
- **`ProfileDTO.hasProfile`:** false means either no profile document or a failed read (lib's `getProfile` returns null for both). Re-check strictly before an owner edit, as web's `/user` page does.

## Session, writes and settings (M7a)

**`session.*`** (`src/api/session.ts`, `src/session/`). A `PlatformAuthController` built from web's `createYapprPlatformAuthDependencies()`, with vaults, passwords, passkeys and the username and profile gates turned off (ADR-001 E5). Post-login tasks, the encryption-key auto-derive and the 5-minute balance refresh stay on, as on web.

| Method | What it does |
| --- | --- |
| `restore()` / `current()` | `controller.restoreSession()`, once per boot; every session call waits for it. A stored key that no longer signs for the identity drops the session (`session.changed {reason: 'key-invalid'}`) |
| `checkKey({key})` | WIF or hex → `identities.byPublicKeyHash` (then the non-unique index) → `matchIdentityKey` against the identity's keys (an enabled AUTH key, CRITICAL or HIGH; lib's `validatePrivateKey` ignores `disabledAt`, web bug #616). For "Identity found" before signing in. Errors: `KEY_INVALID`, `KEY_WRONG_NETWORK`, `IDENTITY_NOT_FOUND`, `KEY_NOT_ON_IDENTITY` (lib's reason, e.g. a MASTER key) |
| `signInWithKey({key})` | `checkKey`, then `controller.loginWithAuthKey(id, wif, {skipUsernameCheck: true})`. Hex is stored as a WIF for this network. Resolves only after `secureDurable()` (the host acknowledged the key batch). Arguments are sensitive: never log them |
| `startKeyExchange()` | `dash-key:` request (`buildYapprKeyExchangeUri`, the configured network and label). One request at a time; it lives 10 minutes, and until the wallet answers it (ephemeral key included) is also kept under `yappr_secure_kx_request`, so a killed app resumes it (`pendingKeyExchange()`) |
| `awaitKeyExchange(id, {waitMs?})` | Polls for the wallet's answer for up to `waitMs` (default 45 s, at most 120 s), so one call fits the client deadline. `pending` → call again ("Check again"). Then `signed-in` if the identity has Yappr's keys, else `needs-registration` with the `dash-st:` URI (`buildUnsignedKeyRegistrationTransition`) and the keys it adds. A wallet approval is kept for retries; nothing derived from it is persisted |
| `awaitKeyRegistration(id, {waitMs?})` | Checks every 5 s for the registered keys for up to `waitMs`, then signs in (`completeYapprKeyExchangeLogin`) |
| `cancelKeyExchange(id)` | Aborts the poll and zeroes the keys (`KEY_EXCHANGE_CANCELLED` for the waiting call). The keys are also wiped when the request expires, even if the host never calls back. Overlapping calls that complete the same approval share one sign-in |
| `accounts()` | The engine's registry, `yappr_engine_accounts` in kv |
| `switchAccount(id)` / `prepareAddAccount()` | lib has one session slot, so both are a controlled engine restart: they stop DM v5, save the active account's `yappr_session` and stash its `yappr-notifications`, put the target's in place (none for "add"), and resolve. The host must then restart the engine with the target's secrets; the next restore reports `switched`. Until that restart, session and write calls reject with `RESTART_REQUIRED`. Sign-ins run one at a time; one is refused (`BAD_REQUEST`) while any identity is active, including the same one (a failed wallet re-login would clear its keys): sign out first to re-enter a key |
| `signOut({identityId?})` | Offline. Active account: `controller.logout()` (secrets, session, logout cleanup). Another account: lib's secure-storage clear functions by id (forwarded as deletes even though the engine does not hold them). Either way its registry entry, stash and write tickets go, and it resolves after `secureDurable()`. **Host:** the `yappr:pf:*` private-feed keys carry no identity in their names, so the host must file every secure write under the account active at the time, and purge that account's secure index when it signs out while not active |
| `refreshBalance()` | `controller.refreshBalance()` → `{credits: bigint}` |

Events: `session.changed {session, reason}` (`restored`, `signed-in`, `switched`, `signed-out`, `key-invalid`, `balance`), and `session.keyRequired {identityId, purpose}` when lib opens its login or encryption-key modal (the engine closes it and asks the host).

**`writes.*`** (`src/api/writes.ts`, `src/writes/`). Every write gets a `WriteTicket` (`pending` → `confirmed` | `unconfirmed` | `failed`), emitted as `write.status` on each transition and persisted under `yappr_engine_writes` (at most 100; confirmed ones pruned after 24 h). A ticket still `pending` at load was interrupted: it becomes `unconfirmed` with `ENGINE_RESTARTED` and is never re-sent.

- **Handler contract** (M7b, M-DM). Register one `WriteHandler` per op with `tickets.register(op, {run, probe?, persistArgs?})` and call `tickets.submit({op, args, target, documents})`. `fromTransitionResult` and `fromBoolean` map lib's results.
  - **Once `run()` has started, a `NETWORK` or `RATE_LIMITED` failure counts as "may have landed"** (`unconfirmed`, outcome `unknown`, not retryable until a check proves it absent), because lib signs, broadcasts and waits in one call. To report a failure that provably happened before any lib write call (the handler's own validation, a read, a `settleUnconfirmed` probe), throw `new NotSentError(cause)` (exported from `src/writes/tickets.ts`): the cause is classified with outcome `not-sent`, and a transient one (network, rate limit, timeout) becomes retryable. A failure while the handler's last reported stage is `waiting-parent` counts the same; report `signing` (or later) before calling lib. Neither proof counts once the ticket names an unconfirmed document (an earlier thread part may be out): the ticket is then `unconfirmed`, outcome `unknown`, and needs a check before any retry.
  - `persistArgs` is **off by default**: arguments live in memory only, so after an engine restart that ticket cannot be retried. Opt in only for arguments that may sit in plain kv (MMKV): never DM plaintext or private-feed content.
  - Report document ids (`ctx.documents`, or the result's `documents`) as soon as they are known: `check` can prove only what the ticket names, unless the handler has a `probe`.
- `check(id)`, for an `unconfirmed` ticket: proves each named document present (create) or absent (delete) with proved `documents.get` reads (a create's absence needs two reads 2 s apart), or runs the handler's `probe`. Applied → `confirmed`; proved not applied → still `unconfirmed`, now `retryable`; unprovable → unchanged, with the probe's error. An answer a retry overtook is dropped.
- `retry(id)`: only a `failed` ticket whose error is retryable (refused retryably, or never sent), or an `unconfirmed` one a check proved not applied. Otherwise `NOT_RETRYABLE`. The earlier attempt's unproven documents are dropped (a fresh nonce gives fresh ids). Nothing is ever retried automatically.
- `get`, `check`, `retry` and `dismiss` act only on the active account's tickets (a retry signs with the active account's key), and the restart replay reports only the active account's reconciled tickets.
- **Deviation from ENGINE.md §7.3 row 12:** `NONCE_CONFLICT` (40204) is outcome `unknown` and `unconfirmed`, not "refused, retryable": the refusal can be this very transition executing before an SDK re-broadcast, and lib itself never rebuilds it (`state-transition-service.ts` `nonceRefused`). `NETWORK` and `NO_KEY` substring matches apply only to errors without a consensus code.
- `classify(err)` (`src/writes/classify.ts`) walks `categorizeError`'s predicates in its order, then the cases it leaves generic (duplicate, already exists, rate limit, timeout, network, missing key). `userMessage` is always `categorizeError`'s text. lib's three module-private predicates are recognised by the string `categorizeError` produces for them. `test/fixtures/error-vectors.json` pins 49 real messages (code, outcome, retryable, ticket state, user message); add one with every new web predicate.

**`settings.get()` / `settings.set(patch)`** (`src/api/settings.ts`): link previews, media gate, read receipts, NSFW mode, notification toggles, `payWith` and feed language, through lib's own `useSettingsStore` setters (persisted by its `persist`). A patch is validated whole before any of it applies (`BAD_REQUEST`).

## Measurements (2026-10-01, testnet, evo-sdk 4.2.0-beta.7, Apple Silicon Mac)

**Bundle:**
- `engine.js` is **14.92 MB**, **9.39 MB gzip**. About 11.8 MB of it is evo-sdk with the inlined wasm.
- The rest is wasm-sdk glue (0.5 MB), `lib/` (0.48 MB) and `@dicebear` avatar styles (about 2 MB).
- The build takes about 0.4 s.

**Browser boot proof:** `npm run test:browser`, 3 cold runs per configuration, each in a fresh browser context. Two more WebKit runs check the injected snapshot: a session read at call time (the feed comes back with viewer marks), and a persisted `yappr-settings` `feedLanguage: 'zz'` read by zustand `persist` when `lib/store.ts` loads (the v2 For You page comes back empty). Raw data is in `browser-boot-*.{json,tsv}`; the files for these numbers, the simulator screenshot and the reproducer below were saved **locally** on the build machine under `/tmp/claude/yappr-mobile/evidence/m2-engine/` and are not in the repo. "Boot" is the `engine.boot()` round trip (wasm decompress + compile, SDK connect, contract preload; testnet contracts are seeded from `lib/contracts/bundled`). "Feed" is the first `feed.forYou()` page, enriched.

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
   - Web's For You infinite scroll on testnet hits this too.
   - Reproducer: `node --input-type=module < repro-startafter-proof.mjs`, run from a checkout with the root deps. The script is in the local evidence directory (not in the repo); it pages the query above with `startAfter` and `startAt`, and then without the range clause.
2. **The same index ignores `desc` without a range clause** (same reproducer script, last line). `where language == 'en'`, `orderBy language asc, $createdAt desc` returns the documents in ascending `$createdAt`. Adding `$createdAt > 0` gives the expected descending order.
3. **Web bug (lib, not fixed here): `isUsernameContested()` always returns false.**
   - `lib/utils/username.ts` imports `WasmSdk` from `@dashevo/wasm-sdk`. That module is never initialized, because evo-sdk bundles its own copy of the glue and the wasm.
   - So `WasmSdk.dpnsIsContestedUsername` throws "Cannot read properties of undefined (reading '__wbindgen_malloc')" even after `EvoSDK.connect()`, the catch returns false, and "contested first" primary-name ordering never applies.
   - It only works after `identity-update-builder` has run `initWasm()`, which instantiates a second 24 MB wasm.
   - The engine inherits the same behavior.

## Known gaps

- `posts.get` returns `null` for a failed read as well as for a missing post. That's lib's single-document `get()`, kept as is.
- The devnet variant can't boot until `.env.devnet` moves to sakura.
- The bundle carries all 30 `@dicebear` styles (about 2 MB) because `unified-profile-service` imports the collection. Trimming it would need an alias.
- **Not yet done** (they belong to M4, the EngineHost): the encrypted-MMKV and Keychain/Keystore write-through on the host side, the supervisor and replay of reads, and memory numbers on devices.
