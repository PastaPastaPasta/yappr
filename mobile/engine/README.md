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
| `npm test` | Unit tests (offline) |
| `npm run test:contract` | Engine API in Node against **testnet** (read only, unauthenticated) |
| `npm run test:browser` | Needs `build:testnet`. Boots the bundle in WebKit and Chromium; writes timings to `$EVIDENCE_DIR` (`RUNS=n` per configuration) |

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
  - **Write-through:** every write is emitted as the event `storage.change {area, key, value|null}`.
  - **Secure routing:** keys starting with lib/secure-storage's `yappr_secure_` prefix go to area `secure` (Keychain/Keystore), never `local` (MMKV).
  - **`sessionStorage`:** memory only.
- **Lifecycle:** `engine.lifecycle('active'|'background'|'inactive')` replays React Native `AppState` as `visibilitychange` + `pagehide`/`pageshow`. `document.visibilityState` follows the app, not the always-hidden WebView. `engine.connectivity(online)` fires `online`/`offline` and asks the SDK to rebuild a dead instance.
- **Console:** forwarded to the host as `log` envelopes (tslog's `%c` styling is stripped), as are uncaught errors and unhandled rejections.

## RPC

- **Envelopes** (`src/protocol/envelope.ts`), each one JSON string through the codec:
  - `req {t,v,id,path,args}`
  - `res {t,v,id,ok,value|error}`
  - `evt {t,v,event,payload}`
  - `log {t,v,level,message}`
- **Handshake:** the engine sends `evt engine.hello {protocol, bundleHash}` when it can take calls. The client queues calls until then, and rejects everything if the protocol differs. The engine also refuses requests with a different `v` (`PROTOCOL_MISMATCH`).
- **Codec** (`src/protocol/codec.ts`):
  - carries `Date`, `Uint8Array` (any binary view arrives as `Uint8Array`), `bigint`, `Map`, `Set`, `undefined`, NaN/±Infinity, and `Error {name, message, code, stack?, data?}`;
  - user objects with a `$t` key are escaped;
  - cycles throw.
  - **SDK errors** keep their message verbatim, so `lib/error-utils` classifiers work on the host.
- **Bridge:**
  - engine → host: `window.ReactNativeWebView.postMessage(json)`;
  - host → engine: `webview.injectJavaScript("window.__yapprEngineReceive(" + JSON.stringify(json) + ")")`.
  - In Node tests an in-process pair stands in.
- **Host client:** `createEngineClient<EngineApi>(transport)` gives a Proxy. `client.api.feed.forYou({cursor})` sends path `feed.forYou`, with per-call timeouts. `close(reason)` rejects in-flight calls (for the supervisor on WebContent death).

## API (initial)

| Method | Calls into lib | Returns |
| --- | --- | --- |
| `engine.boot()` | `evoSdkService.initialize({network, contractId})`, as web's `SdkProvider` does | `EngineInfo` |
| `engine.info()` | — | `EngineInfo`: protocol, variant, bundle sha256, evo-sdk version, network, topology, contract ids, ready, webAssembly, bootMs |
| `feed.forYou({cursor?})` | `loadForYouFeed` → `postService.enrichPostsBatch` (authors, stats, viewer marks, quotes) | `Page<PostDTO>` |
| `posts.get(id)` | `postService.getPostById` → `enrichPostsBatch` | `PostDTO \| null` |
| `profiles.get(idOrName)` | `dpnsService.resolveIdentity` (for names), `loadUserStats`, `unifiedProfileService.getProfile`, `dpnsService.getAllUsernamesSorted`, as web's `/user` does | `ProfileDTO \| null` |
| `engine.lifecycle(state)`, `engine.connectivity(online)` | lifecycle shims | — |

DTOs live in `src/api/dto.ts`. `boot()` fails with code `NO_WEBASSEMBLY` when WebAssembly is missing (iOS Lockdown Mode).

## Measurements (2026-10-01, testnet, evo-sdk 4.2.0-beta.7, Apple Silicon Mac)

**Bundle:**
- `engine.js` is **14.92 MB**, **9.39 MB gzip**. About 11.8 MB of it is evo-sdk with the inlined wasm.
- The rest is wasm-sdk glue (0.5 MB), `lib/` (0.48 MB) and `@dicebear` avatar styles (about 2 MB).
- The build takes about 0.4 s.

**Browser boot proof:** `npm run test:browser`, 3 cold runs per configuration, each in a fresh browser context. Raw data is in `browser-boot-*.{json,tsv}`. "Boot" is the `engine.boot()` round trip (wasm decompress + compile, SDK connect, contract preload; testnet contracts are seeded from `lib/contracts/bundled`). "Feed" is the first `feed.forYou()` page, enriched.

| Engine (version) | Origin | hello (parse + eval) | boot | first feed | cold start → feed |
| --- | --- | --- | --- | --- | --- |
| WebKit 26.5 | `file://` (null) | 122–191 ms | 442–918 ms | 983–1475 ms | 1.66–2.52 s |
| WebKit 26.5 | `https://engine.yap.pr` | 344–373 ms | 438–502 ms | 567–731 ms | 1.35–1.59 s |
| Chromium 151 | `file://` (null) | 81–108 ms | 827–911 ms | 876–1037 ms | 1.80–2.06 s |
| Chromium 151 | `https://engine.yap.pr` | 204–276 ms | 423–962 ms | 650–1071 ms | 1.28–2.10 s |
| Chromium 151, CPU ×4 | `file://` | 199–247 ms | 647–701 ms | 707–985 ms | 1.57–1.94 s |
| **iOS 26.5 Mobile Safari** (simulator) | `http://127.0.0.1` | 174 ms | 803 ms | 2522 ms | **3.50 s** |

- **What dominates:** most of the time goes to DAPI round trips, not wasm. On WebKit over `file://` the blob Worker compile fails, and the main-thread fallback compile takes 22–110 ms. Over https, and in Chromium, the Worker compiles.
- **Memory:** the Chromium JS heap after boot is about 64–68 MB. The wasm linear memory comes on top of that.
- **Small sample:** testnet has only **2** `en` posts since the August rollback, so the first-feed numbers cover a 2-post page. A 20-post page will enrich more.
- **Mobile Safari:** this run used `dist/testnet/selftest.html` served from a local http server. Simulator Safari treats `file://` as a download, so it can't test that origin. Screenshot: `ios-sim-safari-selftest.png`.
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
   - Reproducer: `node --input-type=module < /tmp/claude/yappr-mobile/evidence/m2-engine/repro-startafter-proof.mjs`, from a checkout with the root deps.
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
- **Not yet done** (they belong to M4, the EngineHost): MMKV/secure-store write-through on the host side, the supervisor and replay of reads, and memory numbers on devices.
