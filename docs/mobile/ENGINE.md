# Yappr Mobile 1.0: engine specification

- **Status:** spec for Wave 1–3 implementation, 2026-10-01.
- **Binding input:** [ADR-001](ADR-001-mobile-1.0.md), in particular E1 (engine), E2 (no `lib/` changes), E6 (variants) and E8 (testing). Where this spec and the ADR disagree, the ADR wins; raise the conflict in the PR.
- **Delivery:** the PRs that build this are M2, M4, M6, M7a, M7b and M-DM in [EXECUTION.md](EXECUTION.md).

Paths are relative to the repo root. `file:line` citations point at the tree at commit `1e65cba5`. Line numbers drift; the function names are the stable reference.

## Contents

1. [Process model](#1-process-model)
2. [Loading the engine: origin, bundle and WASM](#2-loading-the-engine-origin-bundle-and-wasm)
3. [Boot, readiness and the supervisor](#3-boot-readiness-and-the-supervisor)
4. [RPC protocol](#4-rpc-protocol)
5. [Codec: the exact wire encoding](#5-codec-the-exact-wire-encoding)
6. [The `EngineApi` surface](#6-the-engineapi-surface)
7. [Write lifecycle](#7-write-lifecycle)
8. [Events](#8-events)
9. [Storage and lifecycle shims](#9-storage-and-lifecycle-shims)
10. [Browser- and Next-only dependency inventory](#10-browser--and-next-only-dependency-inventory)
11. [Security](#11-security)
12. [Testing](#12-testing)
13. [The post-1.0 Rust engine](#13-the-post-10-rust-engine)
14. [Open items the implementing PRs must settle](#14-open-items-the-implementing-prs-must-settle)

---

## 1. Process model

```
┌─────────────────────────── React Native process (Hermes) ────────────────────────────┐
│ screens (expo-router) ── TanStack Query ── engine client (typed proxy, codec)        │
│                                               │  ▲                                   │
│ EngineHost: <WebView> (1, hidden) + supervisor│  │ postMessage(string)               │
│ storage bridge: MMKV (kv) · expo-secure-store │  │ onMessage(string)                 │
│ lifecycle bridge: AppState, NetInfo           ▼  │                                   │
├───────────────────────── WebContent process (WKWebView / Android WebView) ───────────┤
│ bootstrap.js  shims (storage, lifecycle, console→log), RPC server, handshake         │
│ engine.js     mobile/engine/src/api/*  →  lib/** (unmodified) + vendor/platform-auth │
│               @dashevo/evo-sdk → @dashevo/wasm-sdk (≈25 MB WASM, inlined, gzip)      │
│                  │ fetch (gRPC-web)                │ fetch                           │
└──────────────────┼─────────────────────────────────┼─────────────────────────────────┘
                   ▼                                 ▼
        DAPI https://<ip>:1443            quorum service, Insight
```

Three layers, each with one job:

| Layer | Lives in | Job | Must never |
| --- | --- | --- | --- |
| UI | `mobile/app` (Hermes) | Render, navigate, cache engine results (TanStack Query → MMKV), hold the account registry and app prefs | import `@dashevo/*`, call the SDK, import non-allow-listed `lib/` modules (ADR E2) |
| Bridge | `mobile/app/src/engine/*` + `mobile/engine/src/protocol/*` | One WebView, the supervisor, the typed proxy, the codec, storage and lifecycle bridging | interpret domain data; it moves envelopes |
| Engine | `mobile/engine` bundle inside the WebView | Run `lib/` exactly as web does, expose `EngineApi`, emit events | render anything, navigate, hold state the host cannot rebuild |

**One engine per app process.** Exactly one WebView instance exists, mounted once by the root layout (`mobile/app/src/app/_layout.tsx`) before any screen, and never unmounted while the app runs (ADR E1 host rules). It is kept out of the visual tree: `position: 'absolute'`, zero size (fall back to 1×1 px only if M4 measures JS timer throttling at 0×0 on iOS), `opacity: 0`, `pointerEvents="none"`, `accessibilityElementsHidden`, `importantForAccessibility="no-hide-descendants"`. It is never focused and never shows content.

**Why `lib/` composition moves into `api/`.** Much of the web's orchestration lives in React hooks, not in `lib/`: `useFeedData` (`hooks/use-feed-data.ts:99`), `usePostDetail` (`hooks/use-post-detail.ts:277`), `useProgressiveEnrichment` (`hooks/use-progressive-enrichment.ts:122`), `useTopFeed` (`hooks/use-top-feed.ts:56`), `usePostEngagement` (`hooks/use-post-engagement.ts`) and the key-exchange state machines in `vendor/platform-auth/src/key-exchange/yappr-hooks.tsx:82,284`. The engine cannot run hooks. Each `api/*` function re-expresses one hook's data flow as a plain async function over the same `lib/` calls, and cites the hook it mirrors in a header comment. When a hook's flow changes on web, the matching `api/*` function must change too; the engine contract tests (§12) are the tripwire.

---

## 2. Loading the engine: origin, bundle and WASM

### 2.1 How the SDK loads WASM today

| Package (5.0.0-beta.1, npm `5.0-beta`) | Entry | What it does |
| --- | --- | --- |
| `@dashevo/evo-sdk` | `exports["."]` → `dist/evo-sdk.module.js` (12.0 MB) | A self-contained webpack bundle. It **inlines its own copy** of the gzip+base64 WASM and its own wasm-bindgen glue. |
| `@dashevo/evo-sdk` | `dist/sdk.js` (not in `exports`) | The unbundled entry. It re-exports `./wasm.js`, which imports `@dashevo/wasm-sdk/compressed` and inits it once (`ensureInitialized`). |
| `@dashevo/wasm-sdk` | `exports["./compressed"]` → `dist/sdk.compressed.js` (11.4 MB) | Inlines the WASM as base64 of gzip. `init()` decodes the base64, then compiles in a blob-URL `Worker` (with `DecompressionStream`), falling back to a main-thread `DecompressionStream` + `WebAssembly.compile`. In Node (`typeof window === 'undefined' && process.versions.node`) it gunzips with `zlib` and calls `initSync`. |
| `@dashevo/wasm-sdk` | `exports["."]` → `dist/sdk.js` (33.4 MB) | The same module, with the WASM inlined as uncompressed base64. It shares the glue file `dist/raw/wasm_sdk.no_url.js` with `./compressed`, so initialising either one initialises both. |
| `@dashevo/wasm-sdk` | `dist/raw/wasm_sdk_bg.wasm` | The raw module, 25.0 MB. |

The web imports all three entries:
- `@dashevo/evo-sdk`, from 19 `lib/` files (value and type imports);
- `@dashevo/wasm-sdk/compressed`, as values in `lib/services/identity-update-builder.ts:13` (with its own `initWasm()`);
- `@dashevo/wasm-sdk` (the root entry), as a value in `lib/utils/username.ts:10`.

The `/devnet` site's `evo-sdk` chunk is 23.6 MB, measured 2026-10-01. Two consequences for the engine:

1. **Use one WASM instance.** The engine build aliases both:
   - `@dashevo/evo-sdk` → `node_modules/@dashevo/evo-sdk/dist/sdk.js`;
   - `@dashevo/wasm-sdk` → `@dashevo/wasm-sdk/compressed`.

   Every importer then shares one glue module and one 25 MB compile, roughly halving cold-boot compile time and WASM memory against the web's layout. `dist/sdk.js` is outside the package `exports`, so M2 must prove the alias. It runs the read contract suite both ways and records bundle size, boot time and memory for each. If the alias breaks anything, M2 falls back to the stock entries and accepts two instances.
2. **A latent web bug, found while checking this.**
   - `lib/utils/username.ts:17-23` calls `WasmSdk.dpnsIsContestedUsername` on the `@dashevo/wasm-sdk` instance and returns `false` on any throw.
   - On web, that instance is initialised only if `identity-update-builder`'s `initWasm()` has run, which happens in the key-registration flow. The SDK itself runs on evo-sdk's separate inlined copy.
   - So contested-first username ordering silently never applies in a normal session.
   - Reproduced in Node against the 5.0.0-beta.1 tarballs: an uninitialised root `WasmSdk.dpnsIsContestedUsername('abc')` throws `TypeError: Cannot read properties of undefined (reading '__wbindgen_malloc')`; after initialising `./compressed` it returns `true`.
   - The engine's single-instance alias fixes this inside the engine. Web needs its own fix; this is a separate issue, not part of 1.0.

### 2.2 Bundle layout

`mobile/engine` builds two classic scripts with esbuild. They must be IIFE, not ES modules: Chromium refuses `<script type="module">` from a `file://` origin.

| Output | Format | Contents |
| --- | --- | --- |
| `dist/<variant>/index.html` | static | `<meta>` CSP (§11.3), then `<script src="bootstrap.js">`. No other markup. |
| `dist/<variant>/bootstrap.js` | IIFE, ES2022, about 30 KB | Storage, lifecycle and console shims (§9); the RPC server; the handshake. It imports nothing from `lib/`. |
| `dist/<variant>/engine.js` | IIFE, ES2022, about 13 MB | `mobile/engine/src/entry/engine.ts`: the API registry, `lib/**` and `vendor/platform-auth/src` (through the aliases in §10), and the SDK. |
| `dist/<variant>/manifest.json` | JSON | `{protocol, bundleHash, gitCommit, variant, network, devnetName, evoSdkVersion, builtAt}` |

These checks hold:
- **Same SDK as web.** The SDK resolves from the root `node_modules`, so the engine always ships exactly the evo-sdk version that web pins. CI asserts that `manifest.evoSdkVersion` equals the root `package.json` pin.
- **No top-level await.** esbuild cannot emit it in IIFE format, and neither SDK file uses it (checked in 5.0.0-beta.1).
- **`import.meta` is dead code here.** `wasm_sdk.no_url.js:41403` reads `import.meta.url` only when `init()` gets no module. The compressed entry always passes one, so the build defines `import.meta.url` as `"about:blank"` to silence the esbuild warning.
- **Bundled contract snapshots.** `lib/contracts/bundled-contracts.ts:38` loads `./bundled/${key}.json` with a template-literal dynamic `import()`. esbuild bundles every file matching that pattern, so both snapshots ship (about 160 KB).

### 2.3 The origin: three options

The engine's origin decides three things:
- whether `crypto.subtle` exists (it needs a secure context);
- what DAPI and the quorum service see in the CORS `Origin` header;
- whether the 13 MB `engine.js` crosses the RN bridge as a string.

**CORS was measured on 2026-10-01** with `curl -X OPTIONS` preflights.

| Endpoint | Origin sent | Answer |
| --- | --- | --- |
| sakura DAPI `https://68.67.122.86:1443/org.dash.platform.dapi.v0.Platform/getStatus` | `null` | `access-control-allow-origin: null` |
| sakura DAPI `https://68.67.122.86:1443/org.dash.platform.dapi.v0.Platform/getStatus` | `https://engine.yap.pr` | the origin is echoed |
| sakura DAPI `https://68.67.122.86:1443/org.dash.platform.dapi.v0.Platform/getStatus` | `http://localhost:8787` | the origin is echoed |
| `https://quorums.sakura.networks.dash.org/quorums` | any | `access-control-allow-origin: *` |
| `https://quorums.testnet.networks.dash.org/quorums` | any | `access-control-allow-origin: *` |

- **DAPI preflight.** It allows the headers the gRPC-web transport sends (`content-type`, `x-grpc-web`, `x-user-agent`, `grpc-timeout`) and exposes `grpc-status`, `grpc-message` and `dash-serialized-consensus-error-bin`.
- **TLS.** The sakura DAPI certificate verifies against the system trust store (`ssl_verify_result=0`).
- **Not yet verified:** testnet DAPI with `Origin: null`. The sampled node `44.240.98.102` did not answer, and testnet addresses are discovered at runtime. M2 must verify it against live discovered testnet nodes.

**COOP/COEP is not needed.** `next.config.js:73-79` and `scripts/serve-static.mjs:6` say WASM needs cross-origin isolation, but production yap.pr is served by GitHub Pages (`.github/workflows/deploy.yml:141-160`), which cannot set response headers, and its CSP is a `<meta>` tag (`app/layout.tsx:28`). The SDK runs there without isolation; it uses no `SharedArrayBuffer`. M2 confirms the same in both WebViews.

| Option | Origin | Secure context | Bridge cost | Native deps | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. `file://` from the app bundle** | `null` (DAPI echoes it; the quorum service sends `*`) | Chromium and WebKit treat `file:` as potentially trustworthy; **M2 must assert `isSecureContext && crypto.subtle`** | none: `engine.js` loads as a local `<script src>` | none (`react-native-webview` only) | **Default for 1.0** |
| B. `source={{html, baseUrl: 'https://engine.yap.pr/'}}` | `https://engine.yap.pr` | yes | The whole 13 MB bundle has to be inlined in the HTML string and pass through the RN bridge (about 26 MB as UTF-16 in Hermes) at every boot. A relative `<script src>` would hit the network. | none | Fallback only if A fails on a platform and C is blocked |
| C. Embedded static server on `http://127.0.0.1:<random port>` | `http://127.0.0.1:<port>` (DAPI echoes it) | yes (loopback is potentially trustworthy) | none | A native static server (Expo module or config plugin); an open loopback port that serves only the public bundle | Fallback if A fails a day-1 check |

**Option A, per platform:**

- **iOS.**
  - Copy `dist/<variant>/` into the app bundle as `engine/` with a config plugin.
  - Load `file://<bundle>/engine/index.html` with `allowingReadAccessToURL` set to the `engine/` directory.
  - `allowFileAccessFromFileURLs` and `allowUniversalAccessFromFileURLs` stay at `false`.
- **Android.**
  - Copy to `android/app/src/main/assets/engine/` and load `file:///android_asset/engine/index.html`.
  - Set `allowFileAccess={true}`, which is required for the local `<script src>`.
  - Keep `allowFileAccessFromFileURLs={false}` and `allowUniversalAccessFromFileURLs={false}`.

**Day-1 checks for option A** (M2 in a browser, M4 in both WebViews). If any fails on a platform, that platform switches to C:

1. `isSecureContext === true` and `crypto.subtle.importKey` exists.
2. `typeof WebAssembly === 'object'` and `DecompressionStream` exists.
3. `engine.js` loads from the same directory.
4. evo-sdk `connect()` succeeds against sakura (`Origin: null`) and testnet.
5. The blob-URL `Worker` compile either works or falls back cleanly.

### 2.4 Platform requirements the bundle assumes

| Capability | Needed by | iOS 17 WKWebView | Android System WebView |
| --- | --- | --- | --- |
| WebAssembly with reference types, bulk memory and multivalue | the WASM module (see the old [ARCHITECTURE.md › Why not run the WASM SDK directly](ARCHITECTURE.md#why-not-run-the-wasm-sdk-directly)) | yes (absent under Lockdown Mode) | Chrome 96+ |
| `DecompressionStream('gzip')` | `sdk.compressed.js` | 16.4+ | Chrome 80+ |
| `crypto.subtle` (AES-GCM, HKDF, PBKDF2) | `lib/crypto/aes-gcm.ts`, `lib/message-encryption.ts`, `vendor/platform-auth/src/key-exchange/yappr-protocol.ts:76-96` | secure context only | secure context only |
| `crypto.randomUUID` | `lib/store.ts:53` (module scope, via `createInitialThreadPost`), `lib/services/identity-nonce.ts:153` | 15.4+ | Chrome 92+ |
| `new Function(...)` | wasm-bindgen glue (`wasm_sdk.no_url.js:39665`) | needs CSP `'unsafe-eval'` | needs CSP `'unsafe-eval'` |

**Minimum Android WebView:** Chrome 100. The bootstrap reads the major version from `navigator.userAgent` and reports it in the handshake. Below the minimum, the host shows "Update Android System WebView" with a Play Store link instead of booting.

---

## 3. Boot, readiness and the supervisor

### 3.1 Configuration

**The environment is fixed at build time.** The engine bundle is built per variant (ADR E6) from that variant's env file:

| Variant | Env file | Network |
| --- | --- | --- |
| `devnet` | `.env.devnet` | sakura once the web cutover lands; it still names bonsia on `staging` today |
| `testnet` | none: the production defaults in `lib/constants.ts`, topology v2 | testnet |
| `production` | `.env.mainnet` (later) | mainnet |

The build `define`s all 28 `NEXT_PUBLIC_*` names `lib/` reads (listed in §10.2), plus `process.env.NODE_ENV` and `process.env.LOG_LEVEL`.
- `NEXT_PUBLIC_STORAGE_SCOPE` is defined as `''`. Storage is namespaced by the MMKV instance instead (§9.1), so keys keep their production names.
- `NEXT_PUBLIC_BASE_PATH` is `''`.
- Nothing about contracts or topology is hard-coded in `mobile/` (ADR E6). `lib/constants.ts:348-360` `getContractTopology()` throws on an unknown topology, so a bad env fails at build-time smoke, not on a device.

**Runtime configuration is deliberately tiny.** The host sends only:
- platform facts: OS, OS version, app version and build, and the WebView version;
- the storage snapshot (§9.1);
- in `devnet` builds only, an optional DAPI address override for diagnostics.

The engine refuses an `init` whose `variant` or `network` differs from its own `manifest.json` (error `ENGINE_VARIANT_MISMATCH`).

### 3.2 Boot sequence

```
Host (RN)                                      Engine (WebView)
─────────                                      ────────────────
T0  app start; TanStack Query hydrates from MMKV; screens render cached data ("syncing")
T1  read MMKV engine namespace (sync), read active account id
    read active account's secrets from SecureStore (async)
T2  mount <WebView source=file://…/index.html
         injectedJavaScriptBeforeContentLoaded="window.__YAPPR_SID__='<128-bit random hex>'">
                                               bootstrap.js runs:
                                                 install shims (§9) before anything else
                                                 probe caps (wasm, subtle, secure, DecompressionStream, Worker, UA)
                                               ◄── {k:"hello", proto, manifest, caps}
T3  check proto == PROTOCOL_VERSION, manifest.variant, caps
    if !caps.wasm on iOS → state "unsupported:lockdown" (§11.4); stop
    ──► {k:"init", sid, platform, kv:{…}, secrets:{…}, overrides?}
                                               hydrate MemoryStorage(local) from kv + secrets
                                               append <script src="engine.js">
                                               engine.js evaluates lib/ module scope (storage now populated)
                                               register EngineApi
                                               start evoSdkService.initialize({network: getConfiguredNetwork(),
                                                                         contractId: YAPPR_CONTRACT_ID})
                                                 (not awaited; it sets its config synchronously, so later
                                                  getEvoSdk() calls wait for it. Mirrors contexts/sdk-context.tsx:45;
                                                  WASM init, connect, quorum prefetch on devnet, bundled-contract
                                                  seeding, one batched contract preload, evo-sdk-service.ts:124-173)
                                               start sessionRestored = controller.restoreSession() (controller.ts:175)
                                               open RPC
                                               ◄── {k:"ready", stage:"rpc"}
T4  flush queued calls (§3.3)
                                               await both; start DM engine if a session exists and dmIsV5()
                                               ◄── {k:"ready", stage:"sdk", timings}
                                                   evt engine.health {state:"ready"}
T5  UI marks data live; background refetch of visible queries
```

- **Why two scripts.** `lib/` reads storage at module scope. For example, the zustand `persist` stores hydrate when they are created (`lib/store.ts:218`, `lib/stores/notification-store.ts:74`), and `lib/store.ts:53` calls `crypto.randomUUID()` at load. `engine.js` must therefore not evaluate until the in-memory storage holds the snapshot. `bootstrap.js` waits for `init` and only then appends `engine.js`.
- **SDK readiness is not RPC readiness.** At `ready.rpc` the API is callable. `initialize()` must already have been *started* by then: `getSdk()` throws "SDK not configured" while the service has no config (`evo-sdk-service.ts:373-389`), and waits for the running initialization once it does. Methods marked `needsSession`, and `session.current`, also await `sessionRestored`, so a call made during boot never sees a false "signed out". If the SDK fails to initialize (for example, offline), the engine reports `engine.health {state:"degraded", reason}` and retries when the host forwards connectivity. The host's NetInfo `isConnected: true` becomes a synthetic `online` event and a call to `evoSdkService.restoreConnection()` (`evo-sdk-service.ts:459`), mirroring `contexts/sdk-context.tsx:49`.
- **Boot timings.** The engine reports `timings` (ms since `hello`): `initReceived`, `engineEvaluated`, `wasmReady`, `sdkConnected`, `contractsReady`, `sessionRestored`. M2 records them in Node and in Playwright webkit and chromium; M4 records p50 and p95 of each on the iOS simulator and the Android emulator, cold and warm (O3). Both put them in the PR, as ADR E1 requires.

### 3.3 Queueing calls made during boot

- **The queue.** The host holds every call made before `ready.rpc` in a FIFO queue, capped at 256 calls. At the cap, the oldest *read* is rejected with `ENGINE_BUSY`; writes are never dropped.
- **Held until boot settles.** Control calls (`engine.*` plumbing: lifecycle, connectivity) go out as soon as `engine.boot()` has been sent. App calls (reads, writes, session) stay queued until that boot answers, ready or failed (degraded): the engine loads its WASM before `boot()` calls `evoSdkService.initialize()`, so until then lib's `getSdk()` throws "SDK not configured" rather than waiting, and a read that failed that way (a replayed read after a restart, an account switch's refetch) was never retried.
- **Timeouts.** A queued call's timeout (§4.5) starts when the call is sent, not when it is queued. A separate boot deadline covers the queue: 90 s from mount.
- **Failure.** If boot fails terminally (§3.4), every queued call rejects with `ENGINE_UNAVAILABLE`, carrying the supervisor's `reason`.
- **No pre-boot cache in the engine.** The host's TanStack cache, persisted to MMKV, is what makes cold start feel instant. The engine has no cache of its own that is valid before boot.

### 3.4 Supervisor

States: `starting → handshaking → booting → ready ⇄ degraded → crashed → restarting → … | unsupported | failed`.

| Trigger | Detected by | Action |
| --- | --- | --- |
| WebContent process killed (iOS jetsam, memory pressure) | `onContentProcessDidTerminate` | restart |
| Render process gone (Android) | `onRenderProcessGone` (`didCrash` true or false) | restart; the WebView must be remounted with a new `key` |
| Hang | Host pings every 15 s while foregrounded (`{k:"ping"}`, 5 s timeout); 3 misses in a row | restart |
| Boot deadline exceeded | 90 s from mount without `ready.sdk` and without a `degraded` report | restart |
| Protocol violation | Bad envelope, `sid` mismatch, or a `proto` or variant mismatch | `failed` (a packaging bug; never loops) |
| No WASM on iOS | `hello.caps.wasm === false` | `unsupported:lockdown` |
| Android WebView too old | `hello.caps.chromeMajor < 100` | `unsupported:webview-outdated` |

**Restarts:**
- **Remount.** A restart remounts the WebView with a new `key` and a new `sid`, and increments `epoch`.
- **Backoff.** 0.5 s, 1 s, 2 s, 4 s, 8 s, then 30 s.
- **Giving up (PRD NET-04).** At most 3 restarts within 2 minutes; the next failure moves the supervisor to `failed` (no restart, so `restarts` does not grow), and every queued call rejects with `ENGINE_UNAVAILABLE`. Every cause counts: a crash, a hang, a missed hello or boot deadline, a failed prepare. Two counts, and the larger decides: the failures inside a sliding 2-minute window, and the epochs in a row that never came up (ready or degraded), however long each took to fail, so a 30 s hello or 90 s boot deadline cannot outlast the window and loop forever (SR-08). An epoch that comes up ends that run. Home and Notifications then show the "Couldn't connect to Dash Platform." banner with "Try again"; it, and the Troubleshooting screen's "Reconnect" (SET-08), reset both counts. A return to the foreground also retries with fresh counts. A start that fails in the background (a locked Keychain) is not counted: it waits for the foreground, and its queued calls with it.
- **Clean storage.** Storage is rehydrated from MMKV on every boot. Write-through (§9.1) keeps MMKV current to within one event-loop turn, so a crash loses at most the batch in flight.

**Replay after a restart:**

| In-flight call | Replayed? |
| --- | --- |
| `meta.kind === 'read'` | Yes, once, with a new id. A second crash during the replay rejects it with `ENGINE_RESTARTED`. |
| `meta.kind === 'write'` (returns a `WriteTicket`) | **Never.** The call rejects with `ENGINE_RESTARTED`. If the ticket was already issued, the engine reconciles it on the next boot (§7.4). |
| `meta.kind === 'session'` (sign-in steps, long polls) | Never. Rejects with `ENGINE_RESTARTED`, and the screen offers to try again. |
| `meta.kind === 'control'` | Never |

**Foreground and background.** iOS suspends WebContent along with the app.
- **Going to the background:** the host dispatches `visibilitychange` (hidden) and `pagehide`, and waits up to 2 s for the engine's flush acknowledgement (§9.3) before the app suspends. The flush runs inside a `beginBackgroundTask` window on iOS. No Expo API exposes that, so M4 adds a minimal local Expo module (`mobile/app/modules/background-flush`: `begin()` / `end()` on iOS, a no-op on Android).
- **Returning to the foreground:**
  - The host dispatches `visibilitychange` (visible).
  - It pings at once. A WebContent process the OS killed while suspended reports through `onContentProcessDidTerminate` on return, and the supervisor restarts.
  - It sends `online` if NetInfo says the device is connected.
- 1.0 does no background work (ADR E1).

---

## 4. RPC protocol

### 4.1 Transport

> **As built (M2 + M4, PR #626).** §4.1–§4.3 below are the original design. The shipped bridge is simpler; mobile/engine/README.md "RPC" is the reference for the envelopes:
> - **Envelopes** are `{t, v, …}` (`req`, `res`, `evt`, `log`, `ping`, `kv`/`skv`, `kv-ack`); there is **no `sid`**. Epochs are separated instead by a per-mount transport and RPC client (a remount gets new ones, and the old client is closed), plus the engine's `instanceId` in `engine.hello`: a request stamped with another instance is refused unrun, and a hello with a new instance on the same mount counts as a crash.
> - **Host → engine** is `injectJavaScript("window.__yapprEngineReceive && window.__yapprEngineReceive(<JSON string literal>)")`. The message is data inside a string literal, never code.
> - **Engine → host** is `window.ReactNativeWebView.postMessage(json)`.
> - **Hydration** is not `init`/`init-kv` frames: the host prepends a bootstrap script to the page that assigns the whole snapshot (`window.__YAPPR_ENGINE_STORAGE__`, `<` escaped) before the engine runs, and posts the WebView's capabilities (`host-caps`).
> - **Loading:** `engine.js` plus two sidecar scripts, `engine.avatars.js` (the DiceBear styles) and `engine.wasm.js` (the WASM, gzip + base64), run in that order (mobile/engine/README.md "How the wasm loads"). iOS loads `index.html` (engine.html plus the CSP) from the app bundle by file URL, with read access to its directory and the bootstrap as a document-start user script; Android loads a small loader page whose base is `file:///android_asset/engine/`, with the CSP and bootstrap inline (Android System WebView's `loadDataWithBaseURL` yields an empty page above about 15 MB, and its `injectedJavaScriptBeforeContentLoaded` races the page). iOS dev builds against `YAPPR_ENGINE_DEV_URL` load `engine.inline.html` with the base URL `https://engine.yap.pr/`. `mobile/app/src/engine/page.ts`.

- **Host → engine:** `webviewRef.current.postMessage(json)`. `react-native-webview` delivers it as a `message` event, on `window` on iOS and on `document` on Android, so the bootstrap listens on both.
- **Engine → host:** `window.ReactNativeWebView.postMessage(json)`, received by `onMessage`.
- **Frames.** Every frame is one UTF-8 JSON text whose top level is an envelope object. The values inside are codec-encoded (§5). A frame larger than 4 MiB is a protocol error. The engine pages results so this never happens; DTO pages are designed to stay under 512 KiB. Hydration is the one large payload: the host splits the storage snapshot into `init` plus as many `init-kv` frames as needed, each at most 2 MiB, and the bootstrap loads `engine.js` only after the frame with `more: false`.

### 4.2 Envelopes

Every envelope carries `k` (kind) and `sid`, the 128-bit hex session id injected by the host at mount. A receiver drops any frame whose `sid` differs from its own and counts it in diagnostics.

```ts
// Shared, pure: mobile/engine/src/protocol/envelope.ts
const PROTOCOL_VERSION = 1

type Envelope =
  // handshake
  | { k: 'hello'; sid: string; proto: number; manifest: EngineManifest; caps: EngineCaps }
  | { k: 'init'; sid: string; proto: number; platform: HostPlatform; kv: Record<string, string>;
      secrets: Record<string, string>; more: boolean; overrides?: { dapiAddresses?: string[] } }
  | { k: 'init-kv'; sid: string; kv: Record<string, string>; more: boolean }   // continuation, ≤ 2 MiB each
  | { k: 'ready'; sid: string; stage: 'rpc' | 'sdk'; timings: Record<string, number> }
  // calls
  | { k: 'req'; sid: string; id: number; path: string; args: Wire[]; deadline: number }
  | { k: 'res'; sid: string; id: number; ok: true; value: Wire }
  | { k: 'res'; sid: string; id: number; ok: false; error: Wire /* encoded EngineError */ }
  | { k: 'cancel'; sid: string; id: number }
  // engine → host notifications
  | { k: 'evt'; sid: string; name: EngineEventName; data: Wire }
  | { k: 'log'; sid: string; level: 'debug' | 'info' | 'warn' | 'error'; scope: string; msg: string; t: number }
  // storage write-through (engine → host), §9
  | { k: 'kv'; sid: string; seq: number; ops: KvOp[] }
  | { k: 'skv'; sid: string; seq: number; ops: KvOp[] }
  | { k: 'kv-ack'; sid: string; seq: number }            // host → engine, only for skv batches
  // lifecycle (host → engine), §9.3
  | { k: 'life'; sid: string; event: 'visible' | 'hidden' | 'pagehide' | 'online' | 'offline'; ackId?: number }
  | { k: 'life-ack'; sid: string; ackId: number }   // engine → host, once the flush for that event is done
  // health
  | { k: 'ping'; sid: string; id: number }
  | { k: 'pong'; sid: string; id: number; mem?: { jsHeapUsed?: number } }

type KvOp = ['set', string, string] | ['del', string] | ['clear']
```

### 4.3 Ids and epochs

- **Request ids** are unsigned 31-bit integers, increasing per host session (`sid`), starting at 1.
- **Epochs.** Each restart issues a new `sid`, so the epoch is implicit. A `res` that arrives for an unknown or old `sid` is dropped.

### 4.4 Dispatch

`path` is `"<module>.<method>"`, for example `"feed.home"`. The engine looks it up in a frozen registry built from `mobile/engine/src/api/index.ts`, and an unknown path rejects with `BAD_REQUEST`. Arguments are positional and decoded with the codec. Every API function receives a hidden first parameter, `ctx: CallContext`, which carries an `AbortSignal` and the deadline. The public `EngineApi` type strips it:

```ts
type CallContext = { signal: AbortSignal; deadline: number; callId: number }
type ApiFn = (ctx: CallContext, ...args: never[]) => Promise<unknown>
type Public<F> = F extends (ctx: CallContext, ...a: infer A) => Promise<infer R> ? (...a: A) => Promise<R> : never
```

**Method metadata** lives in pure data that both sides import, `mobile/engine/src/protocol/methods.ts`:

```ts
interface MethodMeta {
  kind: 'read' | 'write' | 'session' | 'control'
  timeoutMs: number       // host-side deadline
  sensitiveArgs?: boolean // host and engine never log args (e.g. session.signInWithKey)
  needsSession?: boolean  // reject with NOT_SIGNED_IN before dispatch
}
export const METHODS: Record<string, MethodMeta> = { /* one entry per EngineApi method */ }
```

A unit test asserts that `Object.keys(METHODS)` equals the set of registered API paths. The handshake's `manifest.apiHash` (sha256 of the sorted paths) lets the host detect skew between the app and the engine bundle.

### 4.5 Timeouts

| `kind` | Default `timeoutMs` | Notes |
| --- | --- | --- |
| `read` | 30 000 | The SDK's per-request timeout is 8 s (`evo-sdk-service.ts:143,149`), and composite reads retry across nodes. |
| `write` | 15 000 | A write call returns a `WriteTicket` once the write is accepted. The network round trip happens after the call returns and reports through `write.status` events (§7). |
| `session` | 30 000 | Except `session.awaitKeyExchange` (130 000; the protocol default is 120 000, `yappr-protocol.ts:17-30`) and `session.awaitKeyRegistration` (310 000; `DEFAULT_REGISTRATION_TIMEOUT_MS = 300000`, `yappr-hooks.tsx:80`). |
| `control` | 5 000 | |

When a deadline passes, the host:
- rejects the call with `ENGINE_TIMEOUT`;
- sends `cancel`;
- drops any late `res`.

`deadline` in `req` is the absolute epoch ms, so the engine can stop early.

### 4.6 Cancellation

`cancel` aborts the call's `AbortController`, and cancellation is cooperative:
- **Long polls.** `pollYapprKeyExchangeResponse` honours the signal (`controller.ts:125`, `yappr-protocol.ts:413-422`).
- **Composite flows.** `api/*` functions check `ctx.signal` between `lib/` steps and reject with `ABORTED`.
- **Single DAPI calls** cannot be aborted, because the SDK has no abort API. Their results are discarded.
- **Writes** ignore `cancel` once signing has started. A ticket is never cancelled half way.

TanStack Query's `signal` is wired to `cancel`, so a screen that unmounts cancels its reads.

### 4.7 Logging

- **Console.** `bootstrap.js` wraps `console.debug/info/warn/error` (which `lib/logger.ts` uses) and forwards each call as `log` after redaction (§11.2).
- **Release builds** forward only `warn` and `error`, and replace every non-string argument with its type tag (`<Error: message>`, `<Uint8Array 32>`, `<object>`).
- **Dev builds** forward everything, still redacted.
- **On the host,** logs go to a 2 000-line ring buffer shown on the diagnostics screen, and in dev to the Metro console. Nothing is sent off the device; there is no logging SDK.
- **Recent errors.** The host also keeps the last 50 engine errors (`src/engine/errors.ts`) for diagnostics: every call that failed (method path and redacted message, never the arguments; not the host's own `engine.*` control calls) and every `error`-level log line.

---

## 5. Codec: the exact wire encoding

The codec is pure TypeScript in `mobile/engine/src/protocol/codec.ts`, imported by both sides, with no dependencies. `encode(value): Wire` produces a JSON-safe tree; `JSON.stringify` then produces the frame.

**Plain JSON passes through unchanged:** `null`, booleans, finite numbers other than `-0`, strings, arrays without holes, and plain objects (prototype `Object.prototype` or `null`) that do not own the key `"$y"`.

**Everything else becomes a tagged object** with exactly one own key, `"$y"`, whose value is a two-element array `[tag, payload]`:

| Value | Tag | Payload | Example |
| --- | --- | --- | --- |
| `undefined` (also array holes) | `"u"` | `0` | `{"$y":["u",0]}` |
| `Date` | `"d"` | epoch ms as a number; an invalid date is `null` | `{"$y":["d",1764547200000]}` |
| `Uint8Array` | `"b"` | RFC 4648 base64, standard alphabet, padded | `{"$y":["b","AAEC"]}` |
| `bigint` | `"n"` | decimal string, optional leading `-` | `{"$y":["n","100000000000"]}` |
| `Map` | `"m"` | array of `[encodedKey, encodedValue]` pairs, in insertion order | `{"$y":["m",[["a",1]]]}` |
| `Set` | `"s"` | array of encoded members, in insertion order | `{"$y":["s",[1,2]]}` |
| `NaN`, `Infinity`, `-Infinity`, `-0` | `"f"` | `"NaN"`, `"Infinity"`, `"-Infinity"` or `"-0"` | `{"$y":["f","-0"]}` |
| `Error` (any subclass) | `"e"` | `{name, message, code?, consensusCode?, data?, stack?}` (see below) | `{"$y":["e",{"name":"EngineError","message":"…","code":"TIMEOUT"}]}` |
| plain object that owns `"$y"` | `"o"` | array of `[key, encodedValue]` pairs | `{"$y":["o",[["$y",1]]]}` |

**Rules:**
- **Error payloads.**
  - `name` and `message` are always strings.
  - `message` is copied **verbatim** from the original error, so `lib/error-utils.ts` substring matchers work on both sides (ADR E1).
  - `code` is an `EngineErrorCode` (§7.3) when present.
  - `consensusCode` is the five-digit number from `consensusCodeOf()` (`lib/error-utils.ts:52`).
  - `data` is an encoded plain object, such as `{outcome, retryable, userMessage}` for `EngineError`.
  - `stack` is sent only in dev builds.
  - The decoder rebuilds an `EngineError` (a subclass of `Error`) with those fields. It never rebuilds the original class.
- **Rejected values.** Functions, symbols, class instances other than those in the table, `ArrayBuffer`, other typed arrays and `DataView` all throw `CodecError` on encode, and so does nesting deeper than 64 levels. This is how "DTOs are plain data" is enforced at runtime. Convert at the edge: a lib `Identifier` becomes a base58 string, and other byte views become `Uint8Array`.
- **No cycles.** A cycle throws `CodecError`.
- **Decoding** is the exact inverse. An unknown tag, or an object with `"$y"` plus other keys, throws `CodecError`, which the receiver treats as a protocol violation (§3.4).
- **Identifiers on the wire are base58 strings.** Byte arrays are `Uint8Array`, never base64 strings inside DTOs. Credits and token amounts are `bigint`. Counts are `number`.

**Test vectors.** `mobile/engine/test/fixtures/codec-vectors.json` holds round-trip vectors for each tag, plus the rejection cases. The same vectors must pass under Node, Hermes (jest-expo) and the WebView (the M2 browser proof).

---

## 6. The `EngineApi` surface

The RN app imports **types only** from `mobile/engine/src/api` (`import type { EngineApi } from '@yappr/engine/api'`) and calls through the generic proxy: `engine.api.feed.home({...})`. `mobile/engine/src/protocol/*` (envelope, codec, methods, DTO types) is pure and may be imported by value; nothing else in `mobile/engine` may be.

### 6.1 Conventions

- **Pagination.** Every list returns `Page<T>`.
  - `cursor` is an opaque string. The engine encodes it as base64url JSON `{v:1, k:<kind>, …}`; RN never builds or parses one.
  - A cursor stays valid only within one engine `bundleHash`. After an update, or a cursor the engine cannot decode, the call rejects with `BAD_CURSOR` and RN reloads from the top.
- **Topology gating.**
  - A method that the active topology cannot serve rejects with `NOT_SUPPORTED`. Examples: `feed.home({sort:'top'})` off v9/v10, and `safety.report` where `contractTakesReports()` is false.
  - The UI should not get there: it reads `engine.info().capabilities` (the `engine` module, §6.3).
  - RN does not evaluate `lib/contract-topology.ts` at runtime. Capabilities come from the engine, so web and mobile agree by construction (a narrowing of ADR E2's allowlist: RN may import topology *types*, and may use the predicates only in unit tests).
- **Writes.** Every write returns a `WriteTicket` (§7). Optimistic UI keys on `ticket.id`.
- **Errors.** Every rejection is an `EngineError` (§7.3).

### 6.2 Shared DTOs

```ts
type Id = string                       // base58 identifier
type Cursor = string                   // opaque
interface Page<T> { items: T[]; cursor: Cursor | null }   // null = end
type TargetKind = 'post' | 'reply'
interface TargetRef { id: Id; kind: TargetKind; ownerId: Id; rootPostId: Id | null }
type RankingWindow = 'today' | 'all'   // hooks/use-top-feed.ts; RankingWindowToggle on web

interface AvatarDTO {
  uri: string | null                   // http(s) or ipfs:// as stored; RN resolves gateways (MediaDTO.uris rule)
  dicebear: { style: string; seed: string } | null   // set when uri is null; RN renders locally
}
interface AuthorDTO {
  id: Id
  username: string | null              // primary DPNS name (lib/utils/username.ts ordering)
  displayName: string | null
  avatar: AvatarDTO
  hasDpns: boolean | null              // null = unresolved
  viewerFollows: boolean | null        // null = signed out or unknown
  viewerBlocks: boolean | null
}
interface MediaDTO {
  kind: 'image' | 'video' | 'gif'
  uris: string[]                       // ordered candidates; ipfs:// expanded via getAllGatewayUrls (lib/utils/ipfs-gateway.ts:208)
  mediaHash: Uint8Array | null         // v10 (types/post.ts Media.hashes)
  fingerprint: Uint8Array | null
}
interface PostDTO {
  id: Id
  kind: TargetKind
  author: AuthorDTO
  text: string                         // '' for a v10 bare repost (rendered as a repost, never as an empty post)
  createdAt: Date
  sensitive: boolean
  media: MediaDTO[]
  stats: { likes: number; reposts: number; replies: number; quotes: number }
  viewer: { liked: boolean; reposted: boolean; bookmarked: boolean; ownQuoteId: Id | null } | null
  quote:
    | { state: 'loaded'; post: PostDTO }          // depth 1: quote.post.quote is always null
    | { state: 'removed' }                        // Post.quotedPostRemoved
    | { state: 'unavailable'; id: Id }
    | null
  replyTo: { id: Id; ownerId: Id; rootPostId: Id | null } | null
  repostedBy: { author: AuthorDTO; at: Date; others: number } | null
  embed: { contractId: Id; docType: string; id: Id; kind: 'poll' | 'other' } | null
  isPrivate: boolean                   // encrypted; 1.0 renders the "Private post" placeholder (ADR E7)
  state: 'live' | 'deleted' | 'removed' // v9 tombstone | proven-absent stub
  capabilities: { canRepost: boolean; canBookmark: boolean; canReport: boolean; canDelete: boolean }
}
```

`toPostDTO(post: Post, enrichment)` in `mobile/engine/src/dto/post.ts` is the only producer of `PostDTO`. It reads `types/post.ts` `Post`, drops the internal fields (`_enrichment`, the blog-quote fields, `blogContent`), and folds in the progressive-enrichment maps.

### 6.3 Modules

The "Wraps" column names the `lib/` (or vendor) functions each method composes, and the hook or page whose flow it mirrors.

#### `engine` (control)

| Method | Signature | Wraps |
| --- | --- | --- |
| `info` | `() => Promise<EngineInfo>` | `manifest.json`; `getContractTopology()` (`lib/constants.ts:348`); the capability predicates below |
| `ping` | `() => Promise<{ t: number }>` | — |
| `diagnostics` | `() => Promise<{ wasmMs: number \| null; dapi: { configured: number; endpoints: { origin; requests; failures; lastOkAt; lastErrorAt }[]; lastOkAt: number \| null } }>` | Troubleshooting's live figures (PRD SET-08), polled every 2 s while the screen is open: the WASM init time (`src/wasm-timing.ts`) and each DAPI endpoint's last answer, counted by a `fetch` wrapper over the SDK's gRPC-web requests (`src/dapi-monitor.ts`; origins and outcomes only). Engine-local, no network. `engine.info().contracts` also carries `pollr`. |

```ts
interface EngineInfo {
  protocol: number; bundleHash: string; gitCommit: string; evoSdkVersion: string
  variant: 'devnet' | 'testnet' | 'production'; network: 'devnet' | 'testnet' | 'mainnet'; devnetName: string | null
  topology: 'v2' | 'v9' | 'v10' | string
  capabilities: {
    rankings: boolean                 // likesAreIndexOnly() — Top sort, Explore Top, Creators
    windowedRankings: boolean         // windowedRankingsAvailable() (contract-topology.ts:724)
    followRankings: boolean           // followRankingsAvailable() (:650)
    repostsAreQuotes: boolean         // (:429)
    reports: boolean                  // contractTakesReports() (:1405)
    reportsResolved: boolean          // reportsAreResolved() (:1422)
    hashtagsInline: boolean           // (:621)
    contentLimits: { chars: number; bytes: number | null }   // contentLimits() (:863)
    profileLimits: { displayName: number; bio: number }      // profileTextLimits() (lib/profile/v10-profile.ts:66)
    dashpayProfile: boolean           // dashpayProfileExtension() (:904)
    dm: 'v5' | 'legacy' | 'none'      // dmIsV5() (lib/constants.ts:87)
    yappLocked: boolean               // yappIsLocked()
  }
}
```

#### `session`

| Method | Signature | Wraps |
| --- | --- | --- |
| `current` | `() => Promise<SessionDTO \| null>` | `controller.getState()` (`vendor/platform-auth/src/core/controller.ts:86`) |
| `restore` | `() => Promise<SessionDTO \| null>` | `controller.restoreSession()` (:175), run at boot. It validates the stored key with `storedKeyBelongsToIdentity` (`lib/auth/session-key.ts:21`). |
| `signInWithKey` *(sensitiveArgs)* | `(input: { key: string }) => Promise<SessionDTO>` | Accepts **WIF or hex**:<br>• `parsePrivateKey` (`lib/crypto/wif.ts:126`). Unlike web, hex is accepted: `key-login-form.tsx:34` sends hex down the password path.<br>• `validateWifNetwork` against `keyNetwork()` (`lib/constants.ts:282`).<br>• `identityService.getIdentityIdByPublicKeyHash` (`lib/services/identity-service.ts:147`).<br>• `keyValidationService.validatePrivateKey` (`lib/services/key-validation-service.ts:107`) / `matchIdentityKey` (`lib/crypto/keys.ts:138`), requiring an enabled AUTH key at CRITICAL or HIGH.<br>• `controller.loginWithAuthKey` (:221) with `skipUsernameCheck: true`. Mobile has no username gate in 1.0; DPNS registration links out to web.<br>**Signing an account in again (PRD AUTH-14)**, a parked account whose stored key no longer signs: only the new auth key is written. The engine was booted without the account's stored secrets, so lib cannot see an imported encryption key; the controller's encryption-key auto-derive treats that account as already having one (`createMobileAuthController({ unhydrated })`) and never writes over it, and `dm.unlock` does not derive one for it either. The host restarts the engine next, which loads the stored keys; if none was stored, Messages' unlock can then derive it. |
| `startKeyExchange` | `(opts?: { reauth?: string[] }) => Promise<KeyExchangeRequestDTO>` | `generateYapprEphemeralKeyPair` (`yappr-protocol.ts:55`), `controller.getYapprKeyExchangeConfig` (:106), `buildYapprKeyExchangeUri` (`yappr-protocol.ts:193`). The ephemeral private key stays in engine memory, keyed by `requestId`.<br>`reauth` lists the accounts whose stored keys no longer sign (PRD AUTH-14: every account the host has marked "Sign in again", whether the user is signing one in again or just adding an account). The wallet's answer for one parked here logs in with the new key instead of switching back to its saved one. The list is kept with the persisted request, so a request resumed by a restarted engine does the same.<br>That login's secure writes for the account are held back from the host (`EngineStorage.holdSecure`) until it succeeds, so a failed one, which clears the identity's keys by name, never deletes the stored secrets the engine was not given. **A successful one stores the wallet-derived encryption key (type `derived`), as web's wallet login does, so it replaces an imported encryption key** (one imported for older messages included). The key path keeps it (`signInWithKey`). |
| `awaitKeyExchange` | `(requestId: string) => Promise<KeyExchangeResultDTO>` | `controller.pollYapprKeyExchangeResponse` (:125), honouring cancel. Then `controller.checkYapprKeysRegistered` (:149). If the keys are registered, `controller.completeYapprKeyExchangeLogin` (:167) → `loginWithLoginKey` (:436). Otherwise it returns `needs-registration`. This ports the state machine in `useYapprKeyExchangeLogin` (`yappr-hooks.tsx:82`).<br>Before any wallet login, the auth key it would store (derived from the login key) is read against the identity afresh: neither `checkKeysRegistered` (`lib/services/identity-update-builder.ts:326`) nor `loginWithLoginKey` looks at `disabledAt`, so a disabled one would sign in and then fail every write. A disabled key fails `KEY_DISABLED` and spends the request; nothing is stored, and a marked account stays marked (PRD AUTH-14). |
| `cancelKeyExchange` | `(requestId: string) => Promise<void>` | aborts the poll; wipes the ephemeral key (`clearSensitiveBytes`, `yappr-protocol.ts:146`) |
| `awaitKeyRegistration` | `(requestId: string) => Promise<SessionDTO>` | Polls `checkYapprKeysRegistered` every 5 s until 300 s, then signs in. This ports `useYapprKeyRegistration` (`yappr-hooks.tsx:284,423`). The `dash-st:` URI comes from `buildYapprUnsignedKeyRegistrationTransition` (:159) → `buildUnsignedKeyRegistrationTransition` (`lib/services/identity-update-builder.ts:136`) → `buildYapprStateTransitionUri` (`yappr-protocol.ts:276`), and is returned inside `needs-registration`. |
| `accounts` | `() => Promise<AccountDTO[]>` | engine-held registry `yappr_engine_accounts` in engine kv (§9.1) |
| `switchAccount` | `(identityId: Id) => Promise<void>` | **A controlled engine restart**, so nothing of the previous account survives in the heap: `lib/` keeps viewer-specific state in memory (`cacheManager`, the status caches in `lib/caches/user-status-cache.ts:11-13`, the block cache), and `controller.logout()` cannot be used because it would wipe the account's secrets (:575). The engine:<br>1. `stopDmEngine()` (`lib/services/dm-v5/index.ts:73`) after a flush;<br>2. stashes the per-identity stores that `lib/` keeps globally: `yappr-notifications` (`notification-store.ts:165-170`) → `yappr_engine_stash:<oldId>:notifications`;<br>3. writes the target account's saved session snapshot to `yappr_session` (`lib/storage-scope.ts:38`) and restores its stash;<br>4. clears the sessionStorage flags `runLogoutCleanup` clears (`platform-auth-adapters.ts:259-265`);<br>5. resolves once the `kv` batch is flushed.<br>The host then records the new active account and restarts the engine (supervisor reason `account-switch`, not counted as a failure). `init.secrets` carries the new account's secrets, `restoreSession()` runs, and `session.changed {reason:'switched'}` follows. |
| `signOut` | `(opts?: { identityId?: Id }) => Promise<void>` | **Active account:** `stopDmEngine()`, then `controller.logout()` (:575-586), which clears `pk_`, `ek_`, `ek_type_`, `tk_`, `lk_` and `avd_` for the identity and runs `runLogoutCleanup` (`lib/auth/platform-auth-adapters.ts:259`). **Another account:** `controller.logout()` only acts on the current user, so the engine calls the `lib/secure-storage.ts` clear functions for that id directly (`clearPrivateKey`, `clearEncryptionKey`, `clearEncryptionKeyType`, `clearTransferKey`, `clearLoginKey`, `clearAuthVaultDek`); `MemoryStorage` forwards `yappr_secure_*` deletes even for keys not in the map. Either way the account's stash and registry entry are removed. |
| `refreshBalance` | `() => Promise<{ credits: bigint }>` | `controller.refreshBalance()` (:632) → `identityService.getBalance` (`identity-service.ts:158`) |

```ts
interface SessionDTO {
  identityId: Id; network: 'devnet' | 'testnet' | 'mainnet'
  username: string | null; usernames: string[]
  credits: bigint                                  // AuthUser.balance (contexts/auth-context.tsx:15), credits
  hasEncryptionKey: boolean                        // hasEncryptionKey(id) (lib/secure-storage.ts)
  method: 'key' | 'key-exchange' | 'app-connect'
}
interface AccountDTO { identityId: Id; username: string | null; avatar: AvatarDTO; lastUsedAt: Date; active: boolean }
interface KeyExchangeRequestDTO { requestId: string; uri: string /* dash-key:… */; expiresAt: Date }
type KeyExchangeResultDTO =
  | { status: 'signed-in'; session: SessionDTO }
  | { status: 'needs-registration'; requestId: string; uri: string /* dash-st:… */; expiresAt: Date }
```

App Connect (`FEATURE_APP_CONNECT`, ADR E5) adds `session.startAppConnect` and `session.awaitAppConnect` with the same shapes once the vendor module exists. Until then those paths are not registered, and the UI hides the button.

#### `feed`

| Method | Signature | Wraps (mirrors `hooks/use-feed-data.ts`, `hooks/use-top-feed.ts`, `app/hashtag/page.tsx`) |
| --- | --- | --- |
| `home` | `(q: { tab: 'forYou' \| 'following'; sort: 'recent' \| 'top'; window?: RankingWindow; cursor?: Cursor }) => Promise<Page<PostDTO>>` | **For You, recent:** `loadForYouFeed` (`lib/feed/load-for-you-feed.ts:87`; 20 per page, composite on v9/v10, cursor = last raw `$id`), then `enrichPostsWithRepostsAndQuotes` (`lib/feed/enrich-posts.ts:9`) and the progressive-enrichment reads `useProgressiveEnrichment` makes (`hooks/use-progressive-enrichment.ts:208-337`: `resolveUsernamesBatch`, `getProfilesByIdentityIds`, `getAvatarUrlsBatch`, `getBatchPostStats`, `getBatchUserInteractions`, `checkBlockedBatch`, `getFollowStatusBatch`), skipping whatever `preloaded` already covers.<br>**Following, recent:** `loadFollowingFeed` (`lib/feed/load-following-feed.ts:16`); the cursor wraps `FollowingFeedWindow {start, end, windowHours}`.<br>**Top:** `topLikedPostsHydrated` / `topLikedPostsByAuthorsHydrated` (`lib/services/ranked-likes.ts:286,323`), with `followService.getFollowingIds` (`follow-service.ts:202`) for Following. The cursor is `{k:'topK', limit}`: each page re-reads with `limit += 20`, up to 100, and returns only the new tail.<br>**All paths:** blocked authors are filtered as in `use-feed-data.ts:594-608` (including the author behind a v10 bare repost), and `filterHiddenSensitive` (`lib/sensitive-content.ts:26`) applies when the NSFW mode is `hide`. |
| `checkNew` | `(q: { tab: 'forYou' \| 'following'; since: Date }) => Promise<{ count: number; posts: PostDTO[] }>` | `queryPostsSince` / `queryPostsByOwnersSince` (`lib/services/document-service.ts:79,36`) with `since − 2000 ms`, limit 50, the language and following ids as at `use-feed-data.ts:448-467`, deduped and enriched. RN polls it every 15 s in the foreground for the pill (ADR E4). |
| `hashtag` | `(q: { tag: string; sort: 'recent' \| 'top'; window?: RankingWindow; cursor?: Cursor }) => Promise<Page<PostDTO>>` | **v9/v10:** `postService.queryForDisplay` (`post-service.ts:551`) on `[hashtag, $createdAt desc]`, 50 per page, cursor = last id.<br>**v2:** `hashtagService.getPostIdsByHashtag` (`hashtag-service.ts:210`) → `postService.getPostsByIds` (:964).<br>**Top:** `topLikedPostsHydrated({hashtag})`.<br>Then `enrichPostsBatch` (:302). Mirrors `app/hashtag/page.tsx:86,163,229`. |

#### `posts`

| Method | Signature | Wraps |
| --- | --- | --- |
| `get` | `(id: Id) => Promise<PostDTO \| null>` | `postService.getPostById` (`post-service.ts:596`), falling back to `replyService.getReplyById` (`reply-service.ts:600`) → `postService.replyToPost` (:62); then `enrichPostsBatch` |
| `thread` | `(id: Id, cursor?: Cursor) => Promise<ThreadDTO>` | Ports `usePostDetail` (`hooks/use-post-detail.ts:277-607`):<br>• A v10 bare repost redirects to its target.<br>• Ancestors: one `getPostById(rootId)` on flat threads; on v2, walk up the parents (max 50).<br>• Replies: `replyService.getReplies` (`reply-service.ts:299`; 50 per page flat, 20 on v2; cursor = `nextCursor`), plus `getNestedReplies` (:443) frontier expansion when the focus is a reply.<br>• v10 deleted parents: `provenAbsent` (`lib/feed/prove-absent.ts:13`) → `deletedReplyStubs` (`lib/feed/deleted-reply-stubs.ts:27`).<br>• v2: the v2 thread loader (`use-post-detail.ts:782+`). |
| `engagements` | `(target: TargetRef, tab: 'likes' \| 'reposts' \| 'quotes', cursor?: Cursor) => Promise<Page<EngagementDTO>>` | **Likes:** `likeService.getPostLikes` (`like-service.ts:726`).<br>**Reposts:** `repostService.getPostReposts` (`repost-service.ts:133`), off v10.<br>**Quotes:** `postService.getQuotePosts` (`post-service.ts:750`); on v10 one call with `limit:100`, split by `splitRepostsAndQuotes` (`lib/feed/quote-reposts.ts:97`).<br>Users come from `loadIdentityBatch` (`identity-batch.ts:14`) + `getFollowStatusBatch`. The fetch-all results are paged in memory, 30 per page. Mirrors `app/post/engagements/page.tsx:45-239`. |
| `engagementCounts` | `(target: TargetRef) => Promise<{ likes: number; reposts: number; quotes: number }>` | `loadEngagementCounts` (`lib/services/social-stats-service.ts:61`) |
| `poll` | `(embed: { contractId: Id; id: Id }) => Promise<PollDTO \| null>` | `pollrPollService.getPoll` (`lib/services/pollr-poll-service.ts:153`) plus the tallies from `pollr-vote-service.ts`. Read-only in 1.0. |
| `publish` | `(draft: DraftDTO) => Promise<WriteTicket>` | `planPosts` (`lib/compose/publish-thread.ts:33`) → `publishThread` (:109). `replyingTo` and `quotingPost` are resolved by id with `posts.get` internals. `onProgress` feeds the ticket's `progress`. `settleUnconfirmed` (`lib/unconfirmed-writes.ts:52`) runs inside `publishThread` (:162). On v2, `publishThread` also writes hashtag and mention indexes (:263-286). |
| `delete` | `(target: TargetRef) => Promise<WriteTicket>` | If `deletesAreTombstones()` (v9): `postService.tombstonePost` (:362) / `replyService.tombstoneReply` (:170). Otherwise `postService.deletePost` (:322) / `replyService.deleteReply` (:143). Mirrors `components/post/post-card.tsx:434-446`. |
| `mentionCandidates` | `(prefix: string) => Promise<AuthorDTO[]>` | `dpnsService.searchUsernamesWithDetails(prefix, 5)` (`dpns-service.ts:372`), enforcing the web's 3-character minimum (`MIN_SEARCH_LENGTH`, `components/compose/mention-autocomplete.tsx:13`); RN detects the active mention with the allow-listed `detectActiveMention` (`lib/compose/mention-query.ts:2`). Then `loadIdentityBatch`. |

```ts
interface ThreadDTO {
  focus: PostDTO | { state: 'removed'; id: Id } | null
  ancestors: (PostDTO | { state: 'removed'; id: Id })[]  // root first
  replies: Page<PostDTO & { depth: 0 | 1; isAuthorThread: boolean }> // one indent level, as components/post/reply-thread.tsx
}
interface DraftDTO {
  parts: { text: string }[]                 // 1..10 (threads, ADR E7); a reply or quote must have exactly 1
  replyTo: TargetRef | null
  quote: TargetRef | null
  sensitive: boolean
  media: null                               // image upload is deferred (ADR E7); field reserved
  resume: { knownThreadRootId: Id | null; postedIds: (Id | null)[] } | null  // retry after a partial failure
}
interface EngagementDTO { author: AuthorDTO; at: Date | null; quote: PostDTO | null }
interface PollDTO { question: string; options: { text: string; votes: number }[]; multi: boolean; endsAt: Date | null; totalVotes: number }
```

#### `engage`

| Method | Signature | Wraps (mirrors `hooks/use-post-engagement.ts`) |
| --- | --- | --- |
| `like` / `unlike` | `(target: TargetRef) => Promise<WriteTicket>` | First `settleUnconfirmed(target.id)` (`use-post-engagement.ts:92`; aborts with `PARENT_UNCONFIRMED` if the target is still unproven). Then `likeService.likePost(postId, ownerId, postOwnerId, kind, {author, hashtag})` (`like-service.ts:153`) / `unlikePost` (:207). |
| `repost` / `unrepost` | `(target: TargetRef) => Promise<WriteTicket>` | **v10:** a bare repost is `postService.createPost(viewer, '', resolveQuoteReference(post).fields)` (`use-post-engagement.ts:42-48`; `lib/feed/resolve-quoted-posts.ts:43`). On `DUPLICATE` (40105), recover the existing slot with `postService.getOwnQuotes` (`post-service.ts:806`; `use-post-engagement.ts:201-220`). Undo is `postService.deletePost(ownQuote.id)` (:136). If the own quote has text, `unrepost` rejects with `QUOTE_HAS_TEXT` and the UI confirms, then calls `posts.delete`.<br>**Off v10:** `repostService.repostPost` (`repost-service.ts:55`) / `removeRepost` (:86).<br>Gated by `canRepost(kind)`. |
| `bookmark` / `unbookmark` | `(target: TargetRef) => Promise<WriteTicket>` | `bookmarkService.bookmarkPost` (`bookmark-service.ts:26`) / `removeBookmark` (:53); gated by `canBookmark(kind)` |
| `bookmarks` | `(cursor?: Cursor) => Promise<Page<PostDTO>>` | `bookmarkService.getUserBookmarks` (:109; fetch-all, at most 1000, newest first) → `postService.getPostsByIdsForDisplay` (`post-service.ts:936`) → `enrichPostsBatch`; 20 per page, sliced in memory. Mirrors `app/bookmarks/page.tsx:65-85`. |
| `stats` | `(targets: TargetRef[]) => Promise<Record<Id, { stats: PostDTO['stats']; viewer: PostDTO['viewer'] }>>` | `postService.getBatchPostStats` (:712) + `getBatchUserInteractions` (:693); at most 100 targets |

#### `profiles`

| Method | Signature | Wraps (mirrors `app/user/page.tsx`, `hooks/use-profile-tabs.ts`, `hooks/use-profile-replies.ts`) |
| --- | --- | --- |
| `get` | `(ref: { id: Id } \| { username: string }) => Promise<ProfileDTO \| null>` | `dpnsService.resolveIdentity` (`dpns-service.ts:283`) for a name. Then `unifiedProfileService.getProfile` (`unified-profile-service.ts:722`), `loadUserStats` (`social-stats-service.ts:32`), `dpnsService.getAllUsernamesSorted` (`dpns-service.ts:159`), `followService.isFollowing(target, viewer)` (`follow-service.ts:108`; note the argument order) and `blockService.isBlocked` (`block-service.ts:659`). Returns `null` only when the identity does not exist. A missing profile document yields a DPNS-only profile (#605, D15). A failed read is an error, never "no profile". |
| `posts` | `(q: { id: Id; tab: 'posts' \| 'replies' \| 'top' \| 'mentions'; window?: RankingWindow; cursor?: Cursor }) => Promise<Page<PostDTO>>` | **posts:** `postService.getUserPosts(id, {limit:50, forDisplay:true, startAfter})` (`post-service.ts:574`). Off v10, merge `repostService.getUserReposts` + `resolveUserReposts` (`lib/feed/resolve-user-reposts.ts:16`).<br>**replies:** `replyService.getUserReplies` (`reply-service.ts:344`; cursor = `nextCursor`) + `fetchReplyParents` (`lib/feed/resolve-reply-parents.ts:60`).<br>**top:** `topLikedPostsHydrated({postAuthor:id, limit:10, window})`.<br>**mentions:** `mentionService.getPostsMentioningUser` (`mention-service.ts:260`) → `loadMentioningPosts` (:294), paged in memory.<br>Then `enrichPostsBatch`. |
| `batch` | `(ids: Id[]) => Promise<AuthorDTO[]>` | `loadIdentityBatch(ids, {includeUsername:true})` (`identity-batch.ts:14`); at most 100 ids |
| `update` | `(patch: ProfilePatchDTO) => Promise<WriteTicket>` | `unifiedProfileService.updateProfile` (`unified-profile-service.ts:816`). **v10:** `saveV10Profile` (:992) writes the DashPay `profile`, then `yapprProfile`, planned by `planV10ProfileWrite` (`lib/profile/v10-profile.ts:260`). **v2:** a full replace of `profile`; the first save creates it. Limits come from `profileTextLimits()`. Avatar by URL or DiceBear `{style, seed}`, encoded with `encodeAvatarData` (`unified-profile-service.ts:240`). On v10, an image-URL avatar is fingerprinted in the engine (`lib/media/image-digest.ts`, which needs canvas and CORS on the image host); a failure falls back to storing it in the extension only (`unified-profile-service.ts:1036-1043`). |

```ts
interface ProfileDTO {
  author: AuthorDTO
  bio: string | null; location: string | null; website: string | null; pronouns: string | null
  bannerUri: string | null; nsfw: boolean
  socialLinks: { platform: string; handle: string }[]
  paymentUris: { scheme: string; uri: string; label: string | null }[]   // display only in 1.0 (tips deferred)
  usernames: string[]; joinedAt: Date | null
  stats: { posts: number; followers: number; following: number }
  viewer: { follows: boolean; blocks: boolean | null; blockedBy: 'self' | 'list' | null; isSelf: boolean } | null
  hasProfileDocument: boolean
}
type ProfilePatchDTO = Partial<{
  displayName: string; bio: string; location: string; website: string; pronouns: string
  avatar: { uri: string } | { dicebear: { style: string; seed: string } } | null
  bannerUri: string | null; nsfw: boolean
}>
```

#### `graph`

| Method | Signature | Wraps (mirrors `components/profile/connection-list-page.tsx:96-207`, `hooks/use-follow.ts`) |
| --- | --- | --- |
| `follow` / `unfollow` | `(targetId: Id) => Promise<WriteTicket>` | `followService.followUser(viewer, target)` (`follow-service.ts:33`; refuses a self-follow) / `unfollowUser` (:78) |
| `followers` / `following` | `(id: Id, cursor?: Cursor) => Promise<Page<AuthorDTO & { followers: number; following: number }>>` | `getFollowers` (:138) / `getFollowing` (:169) fetch everything (up to 1000, in pages of 100; `pagination-utils.ts:503-509`). The engine keeps the id list for 60 s and pages it 30 at a time, hydrating each page with `getProfilesByIdentityIds` (`unified-profile-service.ts:1090`), `countFollowersBatch` / `countFollowingBatch` (:299/:311), `getAllUsernamesSortedBatch` (`dpns-service.ts:165`) and `getFollowStatusBatch` (:216). |
| `status` | `(ids: Id[]) => Promise<Record<Id, boolean>>` | `getFollowStatusBatch(ids, viewer)` |

#### `explore`

| Method | Signature | Wraps (mirrors `app/explore/page.tsx`, `app/search/page.tsx`, `components/explore/top-creators.tsx`) |
| --- | --- | --- |
| `trending` | `(q: { window?: RankingWindow }) => Promise<{ tag: string; count: number; countKind: 'posts' \| 'likes' }[]>` | `hashtagService.getTrendingHashtags({timeWindowHours:168, limit:12, window})` (`hashtag-service.ts:274`). On v9/v10 the count is a like count (`topHashtagsByLikes`), hence `countKind`. |
| `topPosts` | `(q: { window: RankingWindow; cursor?: Cursor }) => Promise<Page<PostDTO>>` | `topLikedPostsHydrated({limit, window})` + block filtering (`app/explore/page.tsx:56-62`); `rankings` capability |
| `topCreators` | `(q: { window: RankingWindow }) => Promise<{ author: AuthorDTO; count: number; by: 'likes' \| 'followers' }[]>` | `topCreatorsByLikes(10, window)` (`ranked-likes.ts:226`); `mostFollowedUsers(10)` (:237) when `followRankings`; hydrated with `loadIdentityBatch` |
| `searchUsers` | `(q: string, limit?: number) => Promise<AuthorDTO[]>` | `dpnsService.searchUsernamesWithDetails(prefix, limit=10)` + `resolveIdentity` for an exact match + `getProfilesByIdentityIds` (`app/search/page.tsx:112`) |
| `searchHashtags` | `(q: string) => Promise<{ tag: string; postCount: number }[]>` | `hashtagService.getPostCountByHashtag` (`hashtag-service.ts:181`) for the exact tag, plus trending tags matching the prefix (`app/search/page.tsx:184,202`) |
| `searchPosts` | `(q: string) => Promise<PostDTO[]>` | The web's own approach: a substring match over `postService.getTimeline({limit:100})` (`post-service.ts:506`), then `enrichPostsBatch` (`app/explore/page.tsx:159-179`). There is no server-side post search. |
| `welcome` | `() => Promise<{ totalPosts: number; featured: PostDTO[]; topUsers: AuthorDTO[] }>` | `loadHomepage()` (`lib/home/load-homepage.ts:66`), for signed-out browsing |

#### `notifications`

Notifications are derived on the client from documents (`lib/services/notification-service.ts`). Read state is local, in the `yappr-notifications` zustand store (`lib/stores/notification-store.ts:74,165`), which the engine uses through `getState()`; zustand works without React rendering.

| Method | Signature | Wraps |
| --- | --- | --- |
| `list` | `(q: { filter: NotificationFilter; cursor?: Cursor }) => Promise<Page<NotificationDTO>>` | On the first call per session, `notificationService.getInitialNotifications(userId, readIds)` (:749; 7 days, 100 per source). After that, the list the engine holds, sliced 30 at a time. Filters are `NotificationFilter` (`notification-store.ts:12`). |
| `poll` | `() => Promise<{ added: number; unread: number }>` | `pollNewNotifications(userId, lastFetchTimestamp, readIds)` (:761), merged with `addNotifications`. Emits `notifications.count`. RN calls it every 30 s while foregrounded, the same as `NOTIFICATION_POLL_INTERVAL` (`components/layout/sidebar.tsx:75`). |
| `markRead` | `(ids: string[]) => Promise<void>` | `markAsRead` |
| `markVisibleRead` | `() => Promise<void>` | `markAllAsRead(settings)`, which marks only visible, enabled types (`notification-store.ts`; the settled mark-visible-read decision) |
| `unread` | `() => Promise<number>` | `getVisibleUnreadNotificationCount(notifs, settings)` (`lib/notification-preferences.ts:30`) |

```ts
interface NotificationDTO {
  id: string; type: 'follow' | 'mention' | 'like' | 'repost' | 'quote' | 'reply'
    | 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked' | 'blogPost' | 'blogComment'
  actor: AuthorDTO; at: Date; read: boolean
  target: { id: Id; kind: TargetKind } | null; preview: PostDTO | null
}
```

1.0 renders the social types. Private-feed and blog types are listed under All with a "View on web" action, since both features are deferred (ADR E7).

#### `dm`

One surface for both backends:
- **DM v5** when `capabilities.dm === 'v5'`: `lib/services/dm-v5/*`, `DmEngine` (`engine.ts:103`).
- **Legacy 1:1** on testnet (`'legacy'`): `directMessageService` (`lib/services/direct-message-service.ts:947`).

Conversation keys are `d:…` or `g:…:…` for v5 (`ConversationView.key`, `engine.ts:54`), and `l:<conversationId>` for legacy.

| Method | Signature | v5 wraps | Legacy wraps |
| --- | --- | --- | --- |
| `status` | `() => Promise<DmStatusDTO>` | `getDmEngine(id)` (`dm-v5/index.ts:58`) → `getSnapshot()` (`engine.ts:141`): `ready`, `unreadTotal`, `capReached`, `retention`, `recovery`, `error` | `getUnreadTotal` (:340) |
| `conversations` | `() => Promise<ConversationDTO[]>` | `snapshot.conversations`; before the saved state has loaded, `ENGINE_BUSY`, or the first load's failure (`TIMEOUT` / `NETWORK`) once it failed, never an empty list. A group with no message is dated by when this device joined it (`entry.anchorChangedAt`). | `getConversations(userId, {includeParticipantInfo:true})` (:375); a first list read that failed rejects `NETWORK` |
| `refresh` | `() => Promise<void>` | `tick()`: poll now, the first load too if it failed (pull to refresh, "Try again"); a failure shows in `status().error` | re-reads the list once it is older than its TTL |
| `messages` | `(key: string, cursor?: Cursor) => Promise<Page<MessageDTO>>` | `engine.messages(key)` (:363), newest-first slices of 50 | `getConversationMessages` (:458) / `pollNewMessages` (:504) |
| `open` | `(key: string \| null) => Promise<void>` | `openConversation` (:376); polls every 4 s while open (`OPEN_POLL_MS`, :38) | starts a 3 s poll as `legacy-messages.tsx:342-412` |
| `markRead` | `(key: string) => Promise<void>` | `markRead` (:397) | `markAsRead` (:569) only if `sendReadReceipts` |
| `send` | `(key: string, text: string) => Promise<WriteTicket>` | `send` (:419), which returns `Promise<void>` and throws on failure; see §7.1 for the mapping | `sendMessage` (:66), which returns `{success, error?}` |
| `startDirect` | `(peerId: Id) => Promise<string>` | `startDirect` (:412) | `getOrCreateConversation` (:601) |
| `createGroup` | `(name: string, memberIds: Id[]) => Promise<{ key: string; failed: Id[] }>` | `createGroup` (:457); at most 100 members (`MAX_GROUP_MEMBERS`, `lib/dm/group.ts:22`) | `NOT_SUPPORTED` |
| `renameGroup` / `addMember` / `removeMember` / `leaveGroup` / `endGroup` / `resendKeys` | `(key, …) => Promise<WriteTicket>` | :476 / :468 / :472 / :488 / :480 / :484; refused at once with `BAD_REQUEST` for a group that is gone, ended or not the caller's to manage, and `resendKeys` to someone not in the group ("They are not in this group."), so none of these becomes an unknown outcome inside lib's run | `NOT_SUPPORTED` |
| `hide` | `(key: string) => Promise<void>` | `hide` (:433) | — |
| `setBlocked` | `(peerId: Id, blocked: boolean) => Promise<void>` | `setBlocked` (:444); stored in the encrypted self-state, separate from `safety.block` | — |
| `setRetention` | `(r: '30d' \| '90d' \| '1y' \| 'never') => Promise<void>` | `setRetention` (:451) | — |

The DM engine starts after sign-in. The `DmEngine` runs its own loop inside the engine: 30 s in the background, 4 s while a conversation is open (`engine.ts:38`). It notifies the host through `subscribe` (:136), which emits `dm.changed` and `dm.message` (§8). The legacy backend is polled by the engine and emits the same events.

```ts
interface ConversationDTO {
  key: string; kind: 'direct' | 'group'; peer: AuthorDTO | null; name: string | null
  members: Id[]; isOwner: boolean; lastMessage: { text: string; at: Date; own: boolean } | null
  unread: number; flags: { hidden: boolean; unreadable: boolean; removed: boolean; ended: boolean; blocked: boolean }
}
interface MessageDTO { id: string; sender: Id; text: string; at: Date; own: boolean; pending: boolean }
```

#### `safety`

| Method | Signature | Wraps |
| --- | --- | --- |
| `block` / `unblock` | `(targetId: Id, opts?: { message?: string }) => Promise<WriteTicket>` | `blockService.blockUser(viewer, target, message?)` (`block-service.ts:140`; message ≤ 280) / `unblockUser` (:239) |
| `blocked` | `(cursor?: Cursor) => Promise<Page<AuthorDTO & { message: string \| null }>>` | `getUserBlocks(userId)` (:294) + `loadIdentityBatch` |
| `isBlocked` | `(ids: Id[]) => Promise<Record<Id, boolean>>` | `checkBlockedBatch(viewer, ids)` (:735) |
| `blockedBy` | `(ids: Id[]) => Promise<Record<Id, 'self' \| 'list' \| null>>` | `getBlockSourcesBatch(viewer, ids)` (:716): the viewer's own block (`'self'`, which `unblock` deletes) vs. only a followed block list (`'list'`) |
| `report` | `(target: TargetRef, reason: number, note?: string) => Promise<WriteTicket>` | `reportService.fileReport(viewer, {kind, targetId, targetOwnerId, reason, note})` (`lib/services/report-service.ts:89`). `REPORT_REASONS` and codes 0–8 come from `lib/reports.ts:37`, which RN imports directly (allow-listed). Code 8 needs a note of up to 500 characters. Gated by `capabilities.reports`. |
| `ownReport` | `(target: TargetRef) => Promise<{ reason: number; status: 1 \| 2 \| 3 \| null; resolution: string \| null; withdrawable: boolean } \| null>` (`withdrawable` false on v14 once resolved) | `reportService.getOwnReport` (:78) |
| `withdrawReport` | `(target: TargetRef, reportId: Id) => Promise<WriteTicket>` | `reportService.withdrawReport(viewer, reportId)` (`report-service.ts:106`): the reporter deletes its own report (op `report.withdraw`; the ticket names the `delete`, which Check again proves absent). A report already gone (40101: dismissed on v9, or withdrawn elsewhere) fails `REPORT_GONE` with `withdrawFailureMessage`'s text. Gated by `capabilities.reports`. |

The NSFW gate and the media gate run in RN:
- **NSFW:** `shouldGateSensitive` (`lib/sensitive-content.ts:15`), with the `sensitiveContentMode` setting.
- **Media gate:** `AuthorDTO.viewerFollows` plus the `gateMediaFromNonFollowed` setting, mirroring `hooks/use-media-gate.ts`. Media is gated when signed out and when the follow status is unknown.
- **Removed and deleted stubs:** these come from `PostDTO.state` and `quote.state`.

Following other users' block lists (`blockFollow`) is post-1.0.

#### `settings`

The settings `lib/` reads live in the engine's `yappr-settings` store (`useSettingsStore`, `lib/store.ts:217-249`), because services consult them: for example `payWith` for transition agreements and `feedLanguage`.

| Method | Signature | Wraps |
| --- | --- | --- |
| `get` | `() => Promise<SettingsDTO>` | `useSettingsStore.getState()` |
| `set` | `(patch: Partial<SettingsDTO>) => Promise<SettingsDTO>` | `useSettingsStore.setState` (persisted through the kv shim) |

```ts
interface SettingsDTO {
  linkPreviewsEnabled: boolean; gateMediaFromNonFollowed: boolean; sendReadReceipts: boolean
  sensitiveContentMode: 'blur' | 'show' | 'hide'
  notificationSettings: { likes: boolean; reposts: boolean; replies: boolean; follows: boolean; mentions: boolean; messages: boolean; blogPosts: boolean }
  payWith: 'yapp' | 'credits'; feedLanguage: string
}
```

Some state is owned by RN and kept in MMKV `mobile.*`, never in the engine:
- the theme (Light / Dark / System);
- EULA and community-rules acceptance (no web equivalent exists);
- compose drafts;
- the last feed tab and sort;
- the account registry mirror used before boot;
- biometric-lock settings.

Link previews are fetched natively by RN, with no CORS proxy, through the allow-listed `lib/link-preview/parse-html.ts`, because the web's proxies (`lib/link-preview/fetch.ts:34-35`) exist only for CORS.

#### `writes`

| Method | Signature | Notes |
| --- | --- | --- |
| `list` | `() => Promise<WriteTicket[]>` | Tickets not yet dismissed: pending, unconfirmed and failed, plus those confirmed in the last 10 minutes |
| `get` | `(ticketId: string) => Promise<WriteTicket \| null>` | |
| `check` | `(ticketId: string) => Promise<WriteTicket>` | One check of an `unconfirmed` ticket; the host's reconciler runs it (§7.2) |
| `retry` | `(ticketId: string) => Promise<WriteTicket>` | Allowed only where §7.2 says so; otherwise `NOT_RETRYABLE` |
| `dismiss` | `(ticketId: string) => Promise<void>` | |

#### `diagnostics`

| Method | Signature | Wraps |
| --- | --- | --- |
| `snapshot` | `() => Promise<DiagnosticsDTO>` | Boot timings, `evoSdkService.isReady()` (`evo-sdk-service.ts:470`), network, devnet name, address count, quorum URL host, `manifest`, `caps`, `performance.memory` where present, in-flight call and ticket counts, the count of dropped frames |
| `reconnect` | `() => Promise<void>` | `evoSdkService.reconnect()` (`evo-sdk-service.ts:396`) |
| `recentQueries` | `(n: number) => Promise<{ method: string; ms: number; ok: boolean; at: Date }[]>` | The query inspector's capture (`lib/query-inspector/capture.ts`), with methods and timings only, never arguments or results. Dev and devnet builds only. |

---

## 7. Write lifecycle

### 7.1 `WriteTicket`

```ts
type WriteOp =
  | 'post.publish' | 'post.delete' | 'like' | 'unlike' | 'repost' | 'unrepost' | 'bookmark' | 'unbookmark'
  | 'follow' | 'unfollow' | 'block' | 'unblock' | 'report' | 'report.withdraw' | 'profile.update'
  | 'dm.send' | 'dm.group'
interface WriteTicket {
  id: string                         // uuid, engine-issued
  op: WriteOp
  state: 'pending' | 'confirmed' | 'unconfirmed' | 'failed'
  stage: 'queued' | 'waiting-parent' | 'signing' | 'broadcasting' | 'confirming' | null  // while pending
  target: TargetRef | { identityId: Id } | { conversationKey: string } | null
  documents: { contractId: Id; type: string; id: Id; confirmed: boolean }[]  // known ids (creates; deletes name the deleted id)
  progress: { done: number; total: number } | null                         // threads
  error: EngineErrorData | null       // set when failed; also when unconfirmed after a check
  createdAt: Date; updatedAt: Date; lastCheckedAt: Date | null
}
```

**The call path.** An API write method validates its input and creates the ticket with `pending/queued`. It persists the ticket (§7.4), returns it, then runs the `lib/` call in the background. Every transition emits `write.status` with the whole ticket.

**The deadline (PRD G-3).** A call that goes 60 s without a word (no stage, progress or document from its handler) makes the ticket `unconfirmed`, stage `null`, error `STILL_SENDING`/outcome `unknown`, not retryable: under a DAPI stall wasm's fetch never settles, so `lib/` would never answer and the UI would say "Posting…" or "Sending…" for good. The call is not cancelled (it cannot be), and its answer, whenever it comes, still settles the ticket (`confirmed`, `unconfirmed` or `failed`, as below), unless a check proved it landed first. A handler's `deadlineMs` changes the 60 s: `dm.group` waits 5 minutes (a creation writes the roster and a key per member, up to 100, and reports nothing until done); `null` turns it off.

**Mapping `lib/` results to states:**

| `lib/` result | Ticket |
| --- | --- |
| `StateTransitionResult {success:true, confirmed:true \| undefined}` (`lib/services/state-transition-service.ts:34`) | `confirmed` |
| `{success:true, confirmed:false}`: the confirmation wait timed out, or a broadcast or wait error without a verdict (`state-transition-service.ts:739,773-791,810,836`) | `unconfirmed` |
| `{success:false, error}`, or a thrown error | `failed`, with `error` from `classify()` (§7.3) |
| `PublishOutcome` (`publish-thread.ts:96`) | `successful[]` marks those parts `confirmed` (`wasConfirmed`). Any entry in `timedOut[]` makes the ticket `unconfirmed`. `failedAtIndex !== null` makes it `failed`, and keeps the posted ids in `documents` so the UI can resume. `syncRequired` is `failed`/`PRIVATE_FEED_SYNC_REQUIRED`, which is not reachable in 1.0. |
| DM v5 actions (`DmEngine.send`, the group operations; `engine.ts:419-488`) | They return `Promise<void>`; the chain-level `WriteOutcome` (`dm-v5/types.ts:50-52`) stays inside the DM engine. Resolve → `confirmed` for the ticket; the per-message "sending" state comes from `MessageView.pending` through `dm.changed`. Reject → `failed`, classified from the error (§7.3). `markRead`, `hide`, `setBlocked` and `setRetention` are synchronous and return no ticket. |
| A service method that returns `boolean` (`likePost`, `bookmarkPost`, `deletePost`, …) | `true` is `confirmed`; `false` is `failed`/`UNKNOWN`. **Limitation:** these services swallow the `confirmed:false` signal, as on web. When the topology enforces references (`referencesAreEnforced()`), a later dependent write still settles the parent through `settleUnconfirmed`. |
| Moderation `MAYBE_APPLIED` (not reachable in 1.0) | `unconfirmed` |

### 7.2 "Check again" and retry

`lib/unconfirmed-writes.ts` holds an in-memory map only, and "check again" is purely a UI pattern on web (for example `components/moderation/report-post-modal.tsx:103`). The engine makes it explicit. The host never asks the user to call it: its reconciler (`mobile/app/src/data/reconcile.ts`) runs `check` on every `unconfirmed` ticket of the active account 5, 20, 80 and 130 s after it goes `unconfirmed`, when the app returns to the foreground, when a feed, profile or thread read shows a document the ticket names, and when a message's conversation is read (PRD G-3).

**Absence needs time.** A transition that went out executes within a block or two, but until then a read cannot see it. So `check` calls any write absent (`retryable`, `NOT_RECORDED`) only once its last attempt stopped running at least 2 minutes before (`ABSENCE_AFTER_MS`, `tickets.ts`; a restart that cut it short counts as that stop). Earlier, a probe that does not find it leaves the ticket `unconfirmed`, not retryable, with `NOT_FOUND_YET_ERROR`: a like, delete or post still on its way is never rolled back or offered a second send. The reconciler's last automatic check (130 s) falls past this window, so a write that never landed still ends with Retry, not "Couldn't confirm".

**`writes.check(ticketId)`, for an `unconfirmed` ticket:**

| Ticket kind | What `check` does |
| --- | --- |
| A create with a known document id | `stateTransitionService.waitForDocument(contractId, type, id, {attempts: 2, intervalMs: 2000})` (`state-transition-service.ts:302`). If the document is found: `confirmed`, and `settleUnconfirmed` is satisfied as a side effect. |
| A delete | The document is proved absent with `documents.get` → `confirmed`. |
| An index-only like (v9/v10, `confirmation: 'affectedState'`) | Read it back with `likeService.isLiked` (`like-service.ts:676`). |
| A `post.publish` part with no known id (an engine restart, or a timeout, cut it short before `lib/` said it) | Looked for by its text among the author's newest posts and replies (`getUserPosts` / `getUserReplies`, `ownerAndTime`, 100 each, no lower date bound, so a device clock ahead of the chain's hides nothing). Found exactly once, dated no more than a minute before the ticket (a device clock ahead of the chain's; kept short so the same words posted elsewhere just before are not taken for it) and hanging where the part would (its reply target, the part before it, its quote), with no other post of the same words from the hour before the ticket (older ones are earlier posts of the same words): the part is named on the ticket and counts as landed. Its text nowhere, on two reads that reach at least an hour before the ticket, at least 2 minutes after the attempt stopped running (a transition that went out executes within a block or two): absent, and `writes.retry` posts it (the rest of a thread). Anything else (another post with the same words from the hour before, or any at all when proving absence; two candidates; a read that failed or did not reach back far enough; too soon) stays unconfirmed, and the app offers Edit once a check 10 minutes after posting still cannot tell. |
| Not found less than 2 minutes after the attempt stopped (`ABSENCE_AFTER_MS`) | Stays `unconfirmed`, not retryable (`NOT_FOUND_YET_ERROR`): it may still be on its way. |
| Not found, or the probe errors | Stays `unconfirmed`. `lastCheckedAt` updates, and `error` records the probe failure (for diagnostics: the host shows none of the store's own messages). |
| The call still runs (past its deadline) | Only a landing is proved (`confirmed`). Anything else stays `unconfirmed` with `STILL_SENDING`, never `retryable`: not found may mean still on its way, and a retry beside the running call could land twice. The probe's `sinceSettled()` is `null` until the call answers. A DM v5 write's probe (`dm.send`, `dm.group`) answers at once: lib's DM engine runs its reads on the queue the hung call holds, so a read would wait for the stall to clear. |

**`writes.retry(ticketId)`** re-runs the same operation through `lib/`, with a fresh nonce, only when:
- the ticket is `failed` and `error.data.outcome` is `refused` with `retryable: true` (for example `FEE_SHARE_MISMATCH`, or `FEE_CHANGED` or `PARENT_TOO_YOUNG` once their silent re-sends ran out);
- or the ticket is `failed` with outcome `not-sent` (`PENDING_WRITE`, `STORAGE`, `NETWORK` before broadcast);
- or the ticket is `unconfirmed` and a `check` has proved the document absent. On the create path, `lib/` reports that as `CREATE_NOT_RECORDED_ERROR`, which moves the ticket to `failed`/`NOT_RECORDED`, outcome `not-recorded`.

A thread resumes from `documents` (`DraftDTO.resume`), as on web.

**Silent re-sends of a passing refusal.** `PARENT_TOO_YOUNG` and `FEE_CHANGED` (`AUTO_RETRY_CODES`, `tickets.ts`) are Platform's verdicts about the moment, not the write: refused, they never executed, so sending again cannot duplicate anything. The store puts such a ticket back to `pending`/`queued` and starts it again after 2, 5 and 15 s (`AUTO_RETRY_DELAYS_MS`), as `retry` would, and reports `failed` only when the third re-send is refused too. Not while a thread names a part that is out but unconfirmed, nor for an account that is switching away (then it is reported as refused). A host `retry` starts the count again. `NONCE_CONFLICT` is never re-sent (it may be this very transition executing: it stays `unconfirmed` for a check), and nor is `PENDING_WRITE`: lib holds an unconsumed nonce for up to 15 minutes, so re-sending would only loop. Nor is `FEE_SHARE_MISMATCH`: Yappr always agrees to the full declared moderators fee, so it means the client and the contract disagree, and each re-send would be refused, and charged, the same way.

**A target still on its way.** A like, repost, bookmark, reply or quote that names a document this session created but has not seen confirmed (`isUnconfirmed`) waits for it (`settleTarget`: `settleUnconfirmed` up to six times, about two minutes), reporting `waiting-parent` each round so its deadline restarts; it fails `PARENT_UNCONFIRMED` (nothing sent) only if the target never shows.

**Never blindly.**
- No ticket that may have landed is retried automatically, ever. The engine does not loop: only a refusal above is re-sent, at most three times.
- A `pending` ticket cannot be retried, nor one whose earlier call still runs past its deadline.
- `lib/`'s own cached-bytes rebroadcast (`yappr:pending-st:<docId>`, `state-transition-service.ts:44,624-672`) and nonce reservations (`identity-nonce.ts`) keep a retry from double-spending a nonce.
- Tips, the one never-retry case, are out of 1.0.

### 7.3 Errors

```ts
type EngineErrorCode =
  // engine and bridge
  | 'ENGINE_TIMEOUT' | 'ENGINE_RESTARTED' | 'ENGINE_UNAVAILABLE' | 'ENGINE_BUSY' | 'ENGINE_VARIANT_MISMATCH'
  | 'STILL_SENDING'      // a ticket's call has not answered for its deadline (§7.1): outcome `unknown`, it may still land
  | 'ABORTED' | 'BAD_REQUEST' | 'BAD_CURSOR' | 'NOT_SUPPORTED' | 'NOT_SIGNED_IN' | 'NOT_RETRYABLE' | 'CODEC'
  // session
  | 'KEY_INVALID' | 'KEY_WRONG_NETWORK' | 'KEY_NOT_ON_IDENTITY' | 'IDENTITY_NOT_FOUND' | 'NO_KEY' | 'KEY_REVOKED'
  | 'KEY_EXCHANGE_TIMEOUT' | 'KEY_EXCHANGE_CANCELLED' | 'KEY_REGISTRATION_TIMEOUT' | 'KEY_DISABLED'
  // writes (classify(), from lib/error-utils.ts predicates)
  | 'MODERATION_BARRED' | 'MODERATION_NOT_SEATED' | 'TOO_LONG' | 'RULE_VIOLATION' | 'ALREADY_CLAIMED'
  | 'PARENT_TOO_YOUNG' | 'PARENT_UNCONFIRMED' | 'FEE_UNPAYABLE' | 'FEE_SHARE_MISMATCH' | 'EXPIRED' | 'CONTEST'
  | 'FEE_CHANGED' | 'NONCE_CONFLICT' | 'NOT_RECORDED' | 'PENDING_WRITE' | 'STORAGE' | 'APP_OUTDATED'
  | 'BUILD_DEFECT' | 'IMMUTABLE' | 'TARGET_GONE' | 'NOT_OWNER' | 'STALE' | 'FROZEN' | 'INSUFFICIENT_YAPP' | 'INSUFFICIENT_CREDITS'
  | 'DUPLICATE' | 'QUOTE_HAS_TEXT' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'PRIVATE_FEED_SYNC_REQUIRED' | 'UNKNOWN'
  // domain writes, raised by the engine itself (outcome `local`, never retryable)
  | 'STILL_BLOCKED'      // an unblock a followed block list overrides
  | 'REPORT_GONE'        // safety.withdrawReport: the report is already gone
  | 'MEDIA_UNREADABLE'   // posts.publish: the image link's host refuses it (HTTP 4xx) or it is no decodable image (v10), nothing sent
interface EngineErrorData {
  code: EngineErrorCode
  consensusCode: number | null            // consensusCodeOf() (error-utils.ts:52)
  outcome: 'refused' | 'unknown' | 'not-sent' | 'not-recorded' | 'local'
  retryable: boolean
  userMessage: string                     // categorizeError(err) (error-utils.ts:1002), verbatim web copy
}
```

**`classify(err)`** lives in `mobile/engine/src/writes/classify.ts`. It has two stages:

1. **The `categorizeError` chain.** It walks the predicates in **the same order** as `categorizeError` (`lib/error-utils.ts:1002-1157`). For every error that chain recognises, the code and the user message therefore come from the same branch.
2. **Cases `categorizeError` leaves generic.** It then checks the cases `categorizeError` folds into generic text: duplicate, already-exists, rate-limit and timeout. They get a specific code, but `userMessage` stays `categorizeError`'s text ("Network error…", "Failed to create post: …") for parity with web. Better copy for those codes belongs to the UX spec, keyed by `code`.

Three predicates that `categorizeError` uses are module-private: `isPropertyNotDistinctError` :664, `isReferencedDocumentTooYoungError` :712 and `isVoteChoiceNotAllowedError` :727. M7a does one of two things, and the error vectors pin whichever it picks:
- exports them, a small additive web change under ADR E2's rule (full web checklist);
- or recognises those three cases by the `categorizeError` string they produce.

**Stage 1**, in `categorizeError` order:

| # | Predicate (`lib/error-utils.ts`) | Code | `retryable` |
| --- | --- | --- | --- |
| 1 | `isModerationBarredError` :457 | `MODERATION_BARRED` | no |
| 2 | `isModerationNotYetSeatedError` :745 | `MODERATION_NOT_SEATED` | no |
| 3 | `isPropertyMaxBytesError` :630 | `TOO_LONG` | no |
| 4 | `isPropertyNotDistinctError` :664, then `isDocumentPropertyRuleError` :653, then `isDeleteConstraintError` (40147, 5.0.0-beta.3 `deleteConstraints`) | `RULE_VIOLATION` | no |
| 5 | `isOncePerIdentityAlreadyClaimedError` :614 | `ALREADY_CLAIMED` | no |
| 6 | `isReferencedDocumentTooYoungError` :712 | `PARENT_TOO_YOUNG` | yes |
| 7 | `isGasSponsorShortError` :580, then `isGasPayerError` :497 | `FEE_UNPAYABLE` | no |
| 8 | `isModeratorsShareMismatchError` :549 | `FEE_SHARE_MISMATCH` | yes (at the full fee) |
| 9 | `isDocumentExpiredError` :763 | `EXPIRED` | no |
| 10 | `isContestFullError` :834, `isContestFundError` :807, `isContestedDocumentsNotYetAllowedError` :876 | `CONTEST` | no (not reachable in 1.0: DPNS registration is deferred) |
| 11 | `isFeeMultiplierNotToleratedError` :564 | `FEE_CHANGED` | yes |
| 12 | `isIdentityNonceConflictError` :140 | `NONCE_CONFLICT` | yes |
| 13 | message is `CREATE_NOT_RECORDED_ERROR` / `PENDING_WRITE_ERROR` / `NONCE_STORE_ERROR` (:182-196) | `NOT_RECORDED` / `PENDING_WRITE` / `STORAGE` | yes |
| 14 | `isActionFeeAgreementError` :525 | `APP_OUTDATED` | no (the build is stale) |
| 15 | `isInvalidDocumentIdError`, `isTrailingBytesError`, `isReferencedTypeNotDeletableError`, `isReferenceRequirementError`, `isVoteChoiceNotAllowedError` | `BUILD_DEFECT` | no |
| 16 | `isImmutablePropertyChangedError` :396 | `IMMUTABLE` | no |
| 17 | `isReferenceNotFoundError` :276 | `TARGET_GONE` | no |
| 18 | `isWriteGateError` :365 | `NOT_OWNER` | no |
| 19 | `isPropertyAgreementError` :345 | `STALE` | no |
| 20 | `isFrozenBalanceError` :239 | `FROZEN` | no |
| 21 | `isInsufficientTokenError` :217 | `INSUFFICIENT_YAPP` | no |

**Stage 2**, after the chain:

| # | Predicate | Code | Effect |
| --- | --- | --- | --- |
| 21a | "Insufficient identity … balance … required …" / "credits balance … is not enough to pay" (`IdentityInsufficientBalanceError`, `BalanceIsNotEnoughError`; `categorizeError` has no branch) | `INSUFFICIENT_CREDITS` | `failed`, not retryable; the app shows PRD G-5's copy |
| 21b | The signing key was refused: 20006 `PublicKeyIsDisabledError` ("Identity key … is disabled"), 20003 `MissingPublicKeyError` ("Public key … doesn't exist"), 20016 `PublicKeyExpiredError` (`categorizeError` has no branch) | `KEY_REVOKED` | `failed`, not retryable; the app marks the account "Sign in again" (PRD AUTH-14) |
| 21b | `fromBoolean(false)`'s stand-in error (lib's boolean services swallow theirs) | `UNKNOWN`, outcome `refused` | `failed`, retryable, as web rolls it back. A delete's `false` (`deleteOwnPost`, `deleteOwnReply`) may hide a send whose wait gave no verdict, so the write's probe decides first: still there → this row; proved gone → `confirmed`; unreadable → `unconfirmed` |
| 22 | `isDuplicateUniqueIndexError` :968 (40105) | `DUPLICATE` | `failed`; the v10 repost path recovers the existing slot (§6.3 `engage`) |
| 23 | `isAlreadyExistsError` :116 (no consensus code) | `DUPLICATE` | `unconfirmed`, outcome `unknown`: the broadcast probably landed |
| 24 | `isRateLimitedError` :106 | `RATE_LIMITED` | `failed`, retryable |
| 25 | `isTimeoutError` :84 | `TIMEOUT` | `unconfirmed`, not `failed` |
| 26 | `evoSdkService.isConnectionError` (`evo-sdk-service.ts:496`), or a message with "no available addresses", "Network" or "connection" (the `categorizeError` tail) | `NETWORK` | `failed`, retryable |
| 27 | "Private key not found" / "Not logged in" (the `categorizeError` tail) | `NO_KEY` | `failed`; the engine also emits `session.keyRequired` |
| 28 | none of the above | `UNKNOWN` | `failed` |

`outcome` is `refused` when `isConsensusRefusal()` (`error-utils.ts:164`) is true. It is `unknown` for timeouts and already-exists. It is `not-sent` for the pre-broadcast errors (`PENDING_WRITE`, `STORAGE`, `NO_KEY`, local validation), `not-recorded` for `NOT_RECORDED`, and `local` for engine errors.

**Vectors.** `mobile/engine/test/fixtures/error-vectors.json` holds real error messages captured from the SDK, with their expected code and `userMessage`. When web adds a predicate, a vector is added in the same PR as the `classify()` change.

### 7.4 Persistence and engine restarts

- **Where tickets live.** Tickets persist in engine kv under `yappr_engine_writes`, which is MMKV through write-through: a JSON array, at most 100 tickets, with confirmed tickets pruned after 24 h.
- **On boot,** a ticket left in `pending`, or `unconfirmed` by its deadline while its call still ran (the record persists that the call runs), was interrupted by a crash, so whether it went out is unknown. The engine moves it to `unconfirmed`, with stage `null` and error `ENGINE_RESTARTED`/outcome `unknown`. It emits `write.status`; the UI keeps "Posting…" / "Sending…" while the host's reconciler checks it (§7.2). It is never re-sent.
- **Unless it provably sent nothing.** A handler with `stagedSends` (`posts.publish`: `publishThread` reports its progress before each part's write) reports a stage before any write call. A ticket of such a handler that a restart finds still `queued`, naming no unconfirmed document, sent nothing in that attempt: it becomes `failed`, error `ENGINE_RESTARTED`/outcome `not-sent`, retryable when its arguments were kept, and the UI shows "Couldn't post · Retry · Edit". The record persists that flag beside the ticket, and the time the attempt stopped running, which "check again" uses (§7.2).
- **What makes "check again" survive a restart.** `lib/`'s pending-transition cache (`yappr:pending-st:*`) and its nonce reservations (`yappr:nonce-reservation:*`, 15-minute lifetime, `identity-nonce.ts:60,72`) also live in the kv store. That is why a `check` or `retry` after a restart is still safe.

---

## 8. Events

Events go engine → host as `{k:'evt', name, data}`. The host fans them out to subscribers (`engine.on(name, cb) → unsubscribe`), and TanStack Query cache updaters are the main subscribers.

| Name | Payload | Emitted when |
| --- | --- | --- |
| `write.status` | `WriteTicket` | every ticket transition (§7) |
| `dm.changed` | `{ unreadTotal: number; changedKeys: string[]; ready: boolean; error: string \| null }` | the `DmEngine.subscribe` callback (`engine.ts:136`), coalesced to at most one event per 250 ms; or a legacy poll that finds changes |
| `dm.message` | `{ key: string; message: MessageDTO }` | a new incoming message (not `own`) appears in a snapshot diff |
| `notifications.count` | `{ unread: number }` | after `notifications.poll`, `markRead` or `markVisibleRead`, and when notification settings change |
| `engine.health` | `{ state: 'booting' \| 'ready' \| 'degraded'; reason: string \| null; sdkReady: boolean }` | SDK init, a failure, `restoreConnection`, or a rebuild (the `evoSdkService` connection-lost and rebuild paths, `evo-sdk-service.ts:396-470`). The host adds its own supervisor states (`crashed`, `restarting`, `unsupported`, `failed`). |
| `session.changed` | `{ session: SessionDTO \| null; reason: 'restored' \| 'signed-in' \| 'switched' \| 'signed-out' \| 'key-invalid' \| 'balance' }` | `PlatformAuthController.subscribe` (`controller.ts:90`); the balance refresh runs every 300 s (`DEFAULT_BALANCE_REFRESH_MS`, `controller.ts:39`) |
| `session.keyRequired` | `{ identityId: Id; purpose: 'auth' \| 'encryption' }` | `promptForAuthKey()` (`lib/auth-utils.ts:13`), through the aliased `@/hooks/use-login-modal`; and `@/hooks/use-encryption-key-modal` |
| `engine.notice` | `{ level: 'info' \| 'error'; message: string }` | the `react-hot-toast` alias (`lib/compose/publish-thread.ts:197-199`) |
| `content.created` | `{ kind: 'post' \| 'reply'; id: Id; post: PostDTO }` | the window `post-created` / `reply-created` CustomEvents (`publish-thread.ts:246-252`), forwarded by the event shim so feeds can insert optimistically (listener `use-feed-data.ts:528-561`, reconciliation `:206-256`) |

`hashtag-registered` and `mention-registered` (`lib/services/post-field-validation.ts:169-181`) are v2 recovery signals. They are forwarded as `content.indexed` only in dev builds, and 1.0 has no recovery UI for them.

---

## 9. Storage and lifecycle shims

### 9.1 `localStorage` (and the generic kv)

- **The store.** `MemoryStorage` implements the `Storage` interface: `getItem`, `setItem`, `removeItem`, `clear`, `key(i)` and `length`. It is backed by a `Map<string, string>`. `bootstrap.js` installs it as `window.localStorage` with `Object.defineProperty` before `engine.js` loads.
- **Reads are synchronous** from the map, as `lib/` expects. For example, `getPrivateKey` must return synchronously for `state-transition-service.ts:220-228`.
- **Hydration.** At `init`, the map is filled from `kv` plus `secrets` (§9.2).
- **Write-through.** Every `setItem`, `removeItem` and `clear` is applied to the map at once and recorded in a pending batch, coalesced per key (last write wins; a set that leaves the value unchanged is dropped; a key set and removed within one batch, absent before it, produces no op). The coalescing matters: the vendored secret store probes `setItem`/`removeItem('__storage_test__')` on every access (`secret-store.ts:43-48`). The batch is flushed in a microtask (`queueMicrotask`) as `{k:'kv', seq, ops}`, or as `{k:'skv', …}` for secure keys. Ordering holds because `seq` is monotonic.
- **The host side.**
  - The host applies `kv` batches to MMKV synchronously when they arrive. They need no acknowledgement.
  - `skv` batches go to `expo-secure-store`, and the host acknowledges each with `kv-ack` once the writes resolve.
  - `session.signInWithKey` and the other sign-in paths do not resolve until every `skv` batch they caused is acknowledged. A reported sign-in is therefore always durable.
- **Per-network namespace.** One MMKV instance per network: `id = "yappr.engine." + networkKey`, where `networkKey` is `devnet-<devnetName>`, `testnet` or `mainnet` (the `bundleKey` format, `lib/contracts/bundled-contracts.ts:28`).
  - A devnet wipe or a devnet rename (bonsia → sakura) starts from an empty namespace. "Reset devnet data" in diagnostics deletes the instance.
  - MMKV is encrypted with a random 32-byte key kept in the secure store (`yappr.mmkv-key.<networkKey>`).
- **Size.** Keys stay bounded:
  - `yappr:pending-st:*` holds at most 50 entries (`state-transition-service.ts:50`);
  - `yappr-notifications` keeps at most 1000 read ids;
  - DM v5 caches are per identity.

  The bootstrap reports the snapshot size in diagnostics. More than 8 MB is logged as a warning, because the snapshot crosses the bridge at every boot.

**`sessionStorage`** is a second `MemoryStorage` that never persists, which matches tab-close semantics. Its users:
- `lib/caches/block-cache.ts:67-112` (the merged bloom filter);
- `lib/caches/store-view-cache.ts`;
- the `yappr_dpns_username`, `yappr_skip_dpns` and `yappr_backup_prompt_shown` flags (`platform-auth-adapters.ts:267-269`).

A cold boot rebuilds the block cache from the network, as a new tab does on web.

**IndexedDB:** nothing in `lib/` or `vendor/platform-auth/src` uses it.
- The bloom filter lives in sessionStorage (above).
- Storacha's client bundles `StoreIndexedDB`, but Yappr passes an `InMemoryStore` (`lib/upload/providers/storacha/storacha-provider.ts:66-90,152,294`), and upload is out of 1.0 anyway.
- The DM v5 local cache uses `KeyValueStore` → `readScoped`/`writeScoped` → `localStorage` (`dm-v5/index.ts:35,66`).

The engine therefore shims no IndexedDB. The bootstrap sets `window.indexedDB` to `undefined` so that an unexpected user fails loudly in dev instead of writing to an origin store nobody backs up.

### 9.2 Secrets: `yappr_secure_*` → Keychain / Keystore

- **How lib stores secrets.** `lib/secure-storage.ts:11-20` builds `createBrowserSecretStore({prefix: scopedKey('yappr_secure_')})` (`vendor/platform-auth/src/browser/secret-store.ts:152`). It reads and writes `localStorage` synchronously, with these keys:

  | Key | Holds |
  | --- | --- |
  | `pk_<id>` | the auth WIF |
  | `lk_<id>` | the login key |
  | `avd_<id>` | the vault DEK |
  | `ek_<id>` | the encryption WIF |
  | `ek_type_<id>` | `derived` or `external` |
  | `tk_<id>` | the transfer WIF |

  Each value is JSON-encoded (`secret-store.ts:154-269`).
- **Routing.** Because `NEXT_PUBLIC_STORAGE_SCOPE` is `''` in the engine, the full key is `yappr_secure_<name>_<identityId>`. The `MemoryStorage` routes any key starting with `yappr_secure_` to `skv` instead of `kv`. `lib/secure-storage.ts` runs unchanged (ADR E1).
- **On the host:**
  - **Store:** `expo-secure-store`, with `keychainService: "pr.yap.app.secrets." + networkKey` and `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` (no iCloud or backup migration). On Android the values are encrypted with a Keystore-held key.
  - **Key encoding:** SecureStore keys allow only `[A-Za-z0-9._-]`. Each `-` and each character outside `[A-Za-z0-9._]` is written as `-` plus two lowercase hex digits. That is reversible and collision-free.
  - **Index:** SecureStore cannot enumerate keys, so the host keeps the list of secure keys per identity, names only, in MMKV `mobile.secure-index.<networkKey>`.
- **Hydration is per account.** At boot, `init.secrets` holds only the **active** account's `yappr_secure_*` entries. Switching accounts restarts the engine with the next account's secrets (`session.switchAccount`), so two accounts' secrets are never in the heap together.
- **Optional biometric lock (ADR E5).** The host runs `expo-local-authentication` *before* reading secrets for hydration. No per-key `requireAuthentication`, which would prompt once per key.

### 9.3 Lifecycle events

| Host signal | Engine receives | `lib/` effect |
| --- | --- | --- |
| `AppState` → `background` / `inactive` | `life: hidden`, then `life: pagehide` with an `ackId` | `document.visibilityState = 'hidden'`, then the `visibilitychange` and `pagehide` listeners fire, and `attachFlush` (`dm-v5/index.ts:38-49`) calls `engine.flush()`. The engine then flushes the pending kv batch and answers `life-ack`. The host holds the background window until the ack arrives, or for 2 s at most. |
| `AppState` → `active` | `life: visible` | `visibilityState = 'visible'` and `visibilitychange` fire. The DM loop speeds back up. |
| NetInfo connected | `life: online` | `window` `online` event, and `evoSdkService.restoreConnection()` (`evo-sdk-service.ts:459`) |
| NetInfo disconnected | `life: offline` | `window` `offline` event |

`document` is the real WebView document; only `visibilityState` is overridden, through an accessor the bootstrap controls. The WebView's own visibility signal is not used: it does not track `AppState` reliably for a hidden view. `beforeunload` (`lib/cache-manager.ts:277`) never fires, which is fine because it only stops a timer.

### 9.4 Window events and other aliases

- **Event forwarding.** The bootstrap wraps `window.dispatchEvent`. A `CustomEvent` whose type is in a forward list (`post-created`, `reply-created`, `hashtag-registered`, `mention-registered`) is also forwarded as an engine event (§8). Its `detail` is passed through the DTO mapper, never sent raw.
- **The `storage` event** (`lib/services/private-feed-key-store.ts:128`) never fires, because only one context writes. That is correct.
- **Web Locks.** `navigator.locks`, used by `lib/identity-write-lock.ts:31`, exists in both WebViews. Its fallback is in-process anyway.

---

## 10. Browser- and Next-only dependency inventory

These come from a sweep of `lib/` and `vendor/platform-auth/src`, 245 non-test files.
- **Nothing imports `next/*`**, and nothing uses IndexedDB.
- **Next's only coupling is the inlining of `process.env.NEXT_PUBLIC_*`.** `next.config.js:27-35` also injects `NEXT_PUBLIC_BASE_PATH`, `NEXT_PUBLIC_GIT_*` and `NEXT_PUBLIC_STORAGE_SCOPE`.
- **The 20 `'use client'` directives** are inert outside Next.

### 10.1 Aliases and shims (esbuild, inside `mobile/engine/build/aliases.mjs`)

Severity: **H** = breaks, or a key feature fails; **M** = degraded or silently wrong; **L** = cosmetic or dead code.

| Module (`file:line`) | Issue | WebView | Node harness | Engine treatment |
| --- | --- | --- | --- | --- |
| `lib/constants.ts` (28 vars), `storage-scope.ts:12`, `auth/return-to.ts:28`, `logger.ts:26,31` | `process.env.*`, mostly read at module scope | H (`process` is undefined) | — | `define` for every var (§10.2); no `process` global (keeps wasm-sdk's `isNode` false) |
| `@dashevo/evo-sdk` (19 `lib/` importers) | self-contained bundle with its own WASM copy | M (size, second instance) | M | alias → `dist/sdk.js` (§2.1), subject to the M2 proof |
| `@dashevo/wasm-sdk` (`lib/utils/username.ts:10`) | root entry: uncompressed 33 MB copy, uninitialised instance | M (bug §2.1) | M | alias → `@dashevo/wasm-sdk/compressed` |
| `platform-auth` → `vendor/platform-auth/src/index.ts` (imported by `lib/secure-storage.ts:6`, `auth/platform-auth-adapters.ts:13,18`, `webauthn/passkey-prf.ts:13`, `webauthn/passkey-support.ts:7`) | the barrel re-exports `react/context.tsx` (JSX) and `key-exchange/yappr-hooks.tsx`; the package `main` points at an unbuilt `dist/` | L (dead code, but must resolve) | L | alias `platform-auth` → `mobile/engine/src/shims/platform-auth.ts`, which re-exports only `src/browser`, `src/core` and `src/key-exchange/yappr-protocol` (and `key-exchange/index` minus the hooks) |
| `vendor/.../browser/passkey-prf.ts:39-205`, `passkey-support.ts:14-56` | `navigator.credentials`, `location.hostname` as the RP id | H if called | H | the shim omits passkeys; calls throw `NOT_SUPPORTED` (ADR E5: no vaults on mobile) |
| `lib/auth-utils.ts:1` → `@/hooks/use-login-modal` (statically imported by `state-transition-service.ts:9` and `direct-message-service.ts:27`) | opens a web modal | M | M | alias `@/hooks/use-login-modal` → a shim whose `getState().open()` emits `session.keyRequired` |
| `lib/compose/publish-thread.ts:195` → `@/hooks/use-encryption-key-modal` | web modal | M | M | alias → a shim that emits `session.keyRequired {purpose:'encryption'}` |
| `lib/auth/platform-auth-adapters.ts:251-258` → `@/hooks/use-dashpay-contacts-modal`; `window.setTimeout` | web modal (DashPay contacts) | L | H without `window` | alias → a no-op shim (contacts are post-1.0) |
| `lib/compose/publish-thread.ts:1,197,199` | `react-hot-toast` | L | L | alias → `shims/toast.ts`, which emits `engine.notice` |
| `lib/store.ts:1-2`, `stores/notification-store.ts`, `query-inspector/store.ts`, `modal-store.ts`, `stores/private-feed-refresh-store.ts` | zustand 4 (requires `react` and `use-sync-external-store`), `persist` → localStorage | L | L | **keep**; `react` resolves from root `node_modules` and runs without a DOM. Bundle cost is about 10 KB. |
| `lib/store.ts:4` | `import { ProgressiveEnrichment } from '@/components/post/post-card'` in value syntax, for an interface | L today (esbuild erases it) | L | keep. Build guard: a plugin fails the build if any `@/components`, `@/hooks`, `@/contexts` or `@/app` import survives to resolution, other than the three aliased hooks above. That catches a future `verbatimModuleSyntax` switch, which would drag in `next/link`. (A one-word `import type` fix on web is a follow-up, not a 1.0 dependency.) |
| type-only imports from `@/hooks/use-progressive-enrichment` (`lib/feed/load-for-you-feed.ts:5`, `load-post-enrichment.ts:1`, `composite-feed-page.ts:25-29`, `services/post-service.ts:1`, `post-enrichment-helpers.ts:1`, `mention-service.ts:10`) and `@/components/compose/compose-sub-components` (`publish-thread.ts:17`) | type-only | — | — | erased; covered by the guard above |
| `lib/services/state-transition-service.ts:220-221` | throws "State transitions can only be performed in browser" when `typeof window === 'undefined'` | — | **H** | the WebView has `window`; the harness defines it (§12.1) |
| `lib/services/dm-v5/index.ts:38-59` | `document.visibilityState`, `visibilitychange`, `pagehide`; returns `null` without `window` | M (a hidden WebView may never fire these) | H | lifecycle bridge (§9.3) |
| `lib/services/identity-nonce.ts:91,110,153` | localStorage nonce reservations; `crypto.randomUUID` | — (one context) | H (throws `NONCE_STORE_ERROR` without storage) | `MemoryStorage` |
| `vendor/.../browser/secret-store.ts:34-48,99-115` | local/sessionStorage; `typeof window` checks | — (shimmed) | **H** (stores nothing) | `MemoryStorage` + secure routing (§9.2) |
| `lib/auth/platform-auth-adapters.ts:106-107,283-288`, `services/sdk-helpers.ts:243-245`, `utils/ipfs-gateway.ts:51-54` | read `yappr_session` from localStorage | — | M | `MemoryStorage` |
| `lib/storage-scope.ts:19-35`, `starter-grant.ts`, `moderation-snapshots.ts:48-88`, `services/cart-service.ts:38-76`, `upload/providers/*/credential-storage.ts`, `services/private-feed-key-store.ts:62-131` | local/sessionStorage | — | M | `MemoryStorage` |
| `lib/caches/block-cache.ts:67-112`, `caches/store-view-cache.ts` | sessionStorage | — | M | session `MemoryStorage` |
| `lib/cache-manager.ts:248,273-279` | `setInterval` from a module-scope singleton; `beforeunload` | — | L (keeps Node alive) | keep; the harness calls `cacheManager.stopCleanup()` (`cache-manager.ts:256`) in teardown |
| `lib/services/identity-service.ts:474-477`, `dpns-service.ts:732-735` | `setInterval` when `window` exists | — | L | keep; the harness uses `--exit` / `teardown` |
| `lib/media/media-fingerprint.ts:25-39`, `media/image-digest.ts:13-30` (dynamic, from `unified-profile-service.ts:1038`) | `createImageBitmap`, `<canvas>`, `fetch` of the avatar image (CORS) | L (canvas works; a host without CORS falls back) | H (no canvas) | keep in the WebView; in Node, alias `lib/media/image-digest` to a stub that throws, which exercises the existing fallback (`unified-profile-service.ts:1036-1043`) |
| `lib/upload/local-image-cache.ts:26,31` | `URL.createObjectURL` (blob URLs from the engine origin are useless to RN) | M | L | not reachable in 1.0 (upload deferred); alias to a throwing stub to keep it out |
| `lib/upload/providers/storacha/*`, `pinata/*` | `@storacha/client`, `pinata` SDKs | L | L | not imported by any 1.0 API path; the bundle-graph check (§12.4) asserts they are absent |
| `lib/link-preview/fetch.ts:34-35,76`, `link-preview/urls.ts:33` | CORS-proxy fetches, `window.location.origin` | L | L | not used: RN fetches previews natively |
| `lib/auth/return-to.ts:98,104-105` | `window.location.search` | L | H if `location` is missing | not imported by the API; the harness defines `location` anyway |
| `lib/crypto/aes-gcm.ts`, `onchain-key-encryption.ts`, `dm/group.ts`, `crypto/auth-vault.ts`, `message-encryption.ts`, `yappr-protocol.ts:76-96` | `crypto.subtle` | **H unless secure context** | — (Node ≥ 19) | assert `isSecureContext` in `hello.caps` (§2.3) |
| `lib/identity-write-lock.ts:31` | `navigator.locks` with a fallback | — | — | keep |
| `lib/services/dapi-path-shim.ts:97-116` (installed at `evo-sdk-service.ts:134`) | wraps `globalThis.fetch` for devnet DAPI origins | — | — | keep; it runs on devnet as on web |
| `lib/services/insight-api-service.ts:39`, `crypto-price-service.ts:70-94` | `fetch` to Insight, CoinGecko and CryptoCompare | L | — | keep; price fetches are not on any 1.0 path |
| `lib/query-inspector/capture.ts` (via `evo-sdk-service.ts:4,163`) | zustand store, `CompressionStream` (guarded) | — | — | keep; it backs `diagnostics.recentQueries` |
| `lib/contract-topology.ts:29-30` | JSON imports from `@/contracts` | — | — | esbuild alias `@` → repo root |

### 10.2 `define`d environment

The build sets these 28 names, all read statically:

```
NEXT_PUBLIC_BASE_PATH, NEXT_PUBLIC_BLOG_TOPOLOGY, NEXT_PUBLIC_CONTRACT_TOPOLOGY, NEXT_PUBLIC_DAPI_ADDRESSES,
NEXT_PUBLIC_DEVNET_NAME, NEXT_PUBLIC_DM_TOPOLOGY, NEXT_PUBLIC_DPNS_CONTRACT_ID,
NEXT_PUBLIC_ENCRYPTED_KEY_BACKUP_CONTRACT_ID, NEXT_PUBLIC_INSIGHT_API_URL, NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID,
NEXT_PUBLIC_LOG_LEVEL, NEXT_PUBLIC_NETWORK, NEXT_PUBLIC_POLLR_CONTRACT_ID, NEXT_PUBLIC_POLLR_TOPOLOGY,
NEXT_PUBLIC_PROFILE_TOPOLOGY, NEXT_PUBLIC_QUORUM_URL, NEXT_PUBLIC_STORAGE_SCOPE, NEXT_PUBLIC_STOREFRONT_TOPOLOGY,
NEXT_PUBLIC_TOKEN_HISTORY_CONTRACT_ID, NEXT_PUBLIC_YAPPR_AUTH_VAULT_CONTRACT_ID, NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID,
NEXT_PUBLIC_YAPPR_CONTRACT_ID, NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID, NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID,
NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID, NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID, NEXT_PUBLIC_YAPPR_VAULT_CONTRACT_ID,
NEXT_PUBLIC_YAPP_TOKEN_AUTHORITY_ID
```

Plus `process.env.NODE_ENV` and `process.env.LOG_LEVEL`.

- **Where the values come from.** They are read from the variant's env file with the same parser `scripts/sdk-env.mjs` uses (`readEnvFile` from `scripts/derive-identities.mjs`). An unset variable becomes `undefined`, matching Next's behaviour, so the `|| default` fallbacks in `lib/constants.ts` apply.
- **Build check.** `build.mjs` greps the bundled `lib/` sources for `process.env.NEXT_PUBLIC_[A-Z_]+` and fails if a name is not in this list. A new variable on web therefore breaks the engine build loudly, not at runtime.

---

## 11. Security

### 11.1 Keys in 1.0

| Where | What | Duration |
| --- | --- | --- |
| Keychain / Keystore (`expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`) | Each account's `yappr_secure_*` values (§9.2) | At rest, until sign-out |
| WebView JS heap (`MemoryStorage`) | The **active** account's secrets, from `init` until a switch (an engine restart) or sign-out | While the engine runs (ADR E1 accepted cost) |
| WebView JS heap, transiently | Parsed private keys and wasm `PrivateKey` objects during signing (`state-transition-service.ts`, `signer-service.ts`); key-exchange ephemeral keys, shared secrets and login keys (wiped with `clearSensitiveBytes`); DM v5 `encPriv`-derived roots (`lib/services/dm-v5/context.ts`) | Per operation, or per DM session |
| RN (Hermes) heap | **Only** in transit: the host reads the secrets from SecureStore and passes them to `init`, and drops the references. RN never parses or uses a key. Exception: the `signInWithKey` argument the user typed, which is cleared from component state once the call resolves. | Per call |
| RN heap, decrypted DM text | `MessageDTO.text` and `ConversationDTO.lastMessage` cross the bridge in memory and may sit in the TanStack cache. **The DM query keys are excluded from MMKV persistence**, so DM plaintext is never written to disk by RN. The engine's DM v5 local cache holds positions and markers, not content. | In memory |

These go in the audit scope:
- the WebView-heap exposure;
- the fact that an XSS inside the engine would equal key compromise, which is why §11.3 forbids rendering content in the engine;
- that the Rust native signer (§13) is the remedy before mainnet.

### 11.2 What must never be logged or persisted outside the secure store

- **Never logged or persisted:**
  - Private keys (WIF or hex), login keys, vault DEKs, encryption keys, ephemeral private keys, ECDH shared secrets, mnemonics.
  - Any `yappr_secure_*` value.
  - The arguments of every method with `sensitiveArgs` (`session.signInWithKey`).
  - Decrypted DM text.
  - Raw `Uint8Array` payloads.
- **Redaction.** The bootstrap's console wrapper redacts, before forwarding:
  - base58 strings of 51–52 characters that start with a WIF prefix (`c`, `9`, `5`, `K`, `L`);
  - 64-hex runs;
  - `dash-key:` and `dash-st:` URIs (beyond the scheme);
  - base64 runs of 40 characters or more that contain `+`, `/` or `=` (a padded 32-byte key is 44 characters with one `=`; base58 identifiers never match).
- **Release logging.** Release builds forward only `warn` and `error`, with non-string arguments reduced to type tags (§4.7).
- **A test** feeds known secrets through `lib/logger` and asserts that none reaches a `log` envelope.

### 11.3 WebView hardening

- **No navigation.** `onShouldStartLoadWithRequest` allows only the engine's `index.html` URL. Also:
  - `setSupportMultipleWindows={false}` and `javaScriptCanOpenWindowsAutomatically={false}`;
  - `allowsLinkPreview={false}`, no `allowsBackForwardNavigationGestures`, and `dataDetectorTypes="none"`;
  - `mediaPlaybackRequiresUserAction`; `geolocationEnabled={false}` and `mixedContentMode="never"`;
  - `incognito` / non-persistent data store, since all state lives in the shims;
  - `webviewDebuggingEnabled={__DEV__}`.
- **No user content rendered.** The engine never writes DTO text to the DOM, never sets `innerHTML`, and appends only its own `<script src="engine.js">`. Images are fetched only by the avatar fingerprint path (§10.1), which draws to an off-DOM canvas.
- **CSP** (`<meta>` in `index.html`):

  ```
  default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src https:; worker-src blob:; img-src https: data: blob:; base-uri 'none'; form-action 'none'
  ```

  - `'unsafe-eval'` is required: wasm-bindgen glue calls `new Function` (`wasm_sdk.no_url.js:39665`), and web's CSP has it too (`app/layout.tsx:29`).
  - `connect-src` stays `https:` on every variant. Narrowing it on devnet would block the diagnostics DAPI override (§3.1) and the avatar fingerprint fetch (§10.1), so devnet would behave differently from testnet.
  - **M2 must verify** that `'self'` matches `file:` scripts in both WebViews. If it does not, switch to a `sha256-` hash of `engine.js`, computed at build time.
- **Bridge checks (as built).**
  - The host accepts `onMessage` only from the page's own URL (the bundled `index.html` file URL on iOS, `https://engine.yap.pr/` in iOS dev; on Android the `file:` loader page, which reports no URL). Each mount has its own transport and client, so a stale page cannot reach the current epoch's calls.
  - Navigation: every request goes through `onShouldStartLoadWithRequest` (`originWhitelist={['*']}`, so nothing falls through to `Linking`); iOS allows the page once per mount, Android allows nothing (its page never asks), and `about:blank`.
  - `injectJavaScript` carries host → engine messages as JSON string literals (data, never code), plus dev-only diagnostics probes.
  - Arguments are data. They are decoded by the codec and never evaluated.
  - The CSP is the host's `<meta>` (`mobile/app/src/engine/csp.json`), first in the page: `default-src 'none'; script-src 'self' file: 'unsafe-inline' 'unsafe-eval'; connect-src https:; img-src https: data: blob:; base-uri 'none'; form-action 'none'`. The inline page (iOS dev), whose https base is a real origin, drops `'self' file:`. There is no `worker-src`: nothing compiles in a blob Worker.
- **App Review 4.2.** The UI is fully native, and the WebView is invisible and never renders content (ADR E1).

### 11.4 Lockdown Mode

iOS Lockdown Mode disables WebAssembly in WKWebView, so `hello.caps.wasm` is `false` and the supervisor enters `unsupported:lockdown`. The host then shows a native screen:
- what is happening: Yappr's network engine needs a browser feature that Lockdown Mode turns off;
- the exclusion steps: Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing → Yappr → off;
- a "Try again" button that remounts the engine.

Signed-out cached content stays readable. `WKWebpagePreferences.isLockdownModeEnabled` (iOS 16+) reports the state; whether an app may set it is not relied on. Lockdown cannot be tested on the simulator, so it is part of the device QA on TestFlight (ADR E8).

---

## 12. Testing

### 12.1 Node harness

`mobile/engine/harness/node-env.ts` makes the engine entry run in Node 22 with **the same aliases** as the WebView build. esbuild builds it with `platform: 'node'`, plus the extra Node-only alias for `lib/media/image-digest`. Before importing the engine entry, it installs:

| Global | Shim |
| --- | --- |
| `window` | `globalThis`, with `addEventListener`, `removeEventListener` and `dispatchEvent` bound from a private `EventTarget` (Node's `globalThis` is not one) |
| `localStorage`, `sessionStorage` | the same `MemoryStorage` class the bootstrap uses, seeded from a fixture snapshot |
| `document` | an `EventTarget` with `visibilityState` (the same accessor as the WebView) |
| `location` | `new URL('https://engine.invalid/')` |
| `ReactNativeWebView` | absent; the harness calls the dispatcher in-process through the codec, so round trips are still exercised |

These are native in Node 22: `fetch`, `crypto` (`subtle`, `randomUUID`), `Blob`, `Response`, `DecompressionStream`, `CustomEvent`, `TextEncoder` and `performance`.

**WASM in Node.** Defining `window` makes wasm-sdk's `isNode` check false (`sdk.compressed.js:13`), so it takes the browser path. `Worker` is undefined in Node's globals, so `__compileInWorker` falls back to `DecompressionStream` + `WebAssembly.compile`. Both exist in Node 22, so no special case is needed. M2 asserts this path is the one taken.

**DAPI from Node** has no CORS. TLS is verified against Node's CA store.

### 12.2 Layout

```
mobile/engine/
  package.json            # private; scripts: build, build:<variant>, test, test:contract, test:contract:write
  build/build.mjs  aliases.mjs  env.mjs  csp.mjs
  src/protocol/           # pure, importable by RN: envelope.ts codec.ts methods.ts dto.ts errors.ts
  src/entry/bootstrap.ts  engine.ts
  src/shims/              # storage.ts lifecycle.ts events.ts console.ts toast.ts modal-hooks.ts platform-auth.ts
  src/api/                # index.ts (registry + type EngineApi) and one file per module in §6.3
  src/dto/                # toPostDTO, toAuthorDTO, … (only producers of DTOs)
  src/writes/             # tickets.ts classify.ts
  harness/                # node-env.ts boot-node.ts pool.ts
  test/unit/              # codec, storage routing, lifecycle, classify, dto mappers, methods/registry parity
  test/contract/read/     # one file per API module; unauthenticated
  test/contract/write/    # serial; pool identities
  test/browser/           # Playwright: boot the built index.html in webkit + chromium (M2 proof)
  test/fixtures/          # codec-vectors.json error-vectors.json kv-snapshot.json
  vitest.config.ts  vitest.contract.config.ts
```

### 12.3 Contract tests

**Reads** run on every engine PR and nightly, unauthenticated, against both:
- the `testnet` variant (production yap.pr contracts, topology v2);
- the `devnet` variant (sakura), once its contracts are published. Until then, the sakura read suite skips with an explicit reason.

**What a read test asserts:**
- **Shape.** Every result passes a runtime DTO validator generated from `protocol/dto.ts`, and it round-trips through the codec.
- **Invariants.** For example:
  - a `Page` cursor makes progress;
  - no blocked author appears in the feed;
  - `kind` matches `capabilities`;
  - a bare repost never surfaces as an empty post.
- **Parity with web where it is cheap.** `feed.home` page 1 for For You returns the same ids, in the same order, as calling `loadForYouFeed` directly.
- **Speed is recorded but does not gate.** Each test records `ms` into a JSON report, so the Rust engine can be compared later (§13).

**Writes** run on engine PRs that touch `api/` or `writes/`, and nightly. They are serial: one Vitest worker, `sequence.concurrent: false`. They use **sakura pool identities only** (ADR E6).

- **Where the pool comes from.** The pool file is the sakura ops `identities.json`: 100 `corpus` personas, each with `identityId`, `handle`, `dpns`, and `identityKeys[]`. The keys are:

  | `keyId` | Purpose | Level |
  | --- | --- | --- |
  | 0 | AUTH | MASTER |
  | 1 | AUTH | CRITICAL |
  | 2 | AUTH | HIGH |
  | 3 | TRANSFER | CRITICAL |
  | 4 | ENCRYPTION | MEDIUM |

  The file is located by the env var **`YAPPR_SAKURA_IDENTITIES`**, which on the lead's machine is `/Users/pasta/.local/share/yappr-sakura-20261001/identities.json`. It is **never committed**, never copied into the repo, and never printed. CI gets it as a secret file.
- **Which personas.** `harness/pool.ts` reads only the personas listed in `test/contract/write/slots.json`, which holds `personaIdx` numbers only and no keys.
  - **Proposed reservation:** personas 90–99, so mobile writes never collide with corpus seeding. The lead confirms this with the sakura ops owner before M7a.
  - Sign-in uses keyId 2 (HIGH) **as hex**, which exercises the hex path of `session.signInWithKey`. DM tests also hydrate keyId 4 as the encryption key.
  - Never keyId 0. Only the test-wallet responder (M3) signs `dash-st:` with MASTER.
- **Retries** happen only on `TIMEOUT`, `NETWORK` or `RATE_LIMITED`, at most twice, with a 5 s backoff. A `refused` outcome fails the test immediately.
- **Scenarios** (each self-cleaning where the topology allows real deletes):
  - sign in with a key, restore, switch accounts, sign out;
  - post → read back → delete;
  - a thread of 3 posts, with a forced partial failure and a resume;
  - reply and quote;
  - like / unlike, repost / unrepost (v10 bare repost and `DUPLICATE` recovery), bookmark / unbookmark;
  - follow / unfollow;
  - block / unblock;
  - report (when `capabilities.reports`);
  - profile update;
  - a DM v5 round trip between two pool slots, plus group create, rename and leave;
  - `writes.check` on a ticket forced `unconfirmed` (by stubbing the wait to throw a timeout).

**Credits.** The write suite records its credit spend per run. A pool identity whose balance falls below 0.5 DASH-equivalent fails setup with "top up via sakura ops (treasury asset lock)". Top-ups never come from the maker identity (each maker credit transfer shifts the planned contract ids).

### 12.4 Bundle checks (CI, per engine PR)

These run in CI on every engine PR:
- **Version.** `manifest.evoSdkVersion` equals the root `package.json` pin.
- **One WASM payload.** The bundle contains exactly one gzip+base64 WASM payload, unless M2 recorded the fallback.
- **No upload SDKs.** No `@storacha/*` or `pinata` module is in the bundle graph (an esbuild metafile check).
- **No leaked imports.** No `@/components`, `@/hooks`, `@/contexts` or `@/app` import survives, other than the three aliased hooks.
- **Size budget.** `engine.js` is at most 16 MB and `bootstrap.js` at most 64 KB.
- **Registry parity.** `METHODS` keys equal the registry paths, and `manifest.apiHash` is stable for the build.

### 12.5 Browser boot proof (M2)

Playwright (already a root devDependency) serves `dist/testnet/` (and `dist/devnet/` once W-SAKURA lands; until then that bundle still points at bonsia) from `file://` and from `http://127.0.0.1`, in **webkit** and **chromium**. M2 builds against whatever the root pins: 4.2.0-beta.7 until #606 merges, then 5.0.0-beta.1. The package layout in §2.1 was read from the 5.0.0-beta.1 tarballs, so M2 re-checks it on the pin in use. For each browser and origin, it asserts:
- the `hello` caps: `wasm`, `subtle`, `secure` and `DecompressionStream`;
- `ready.sdk` is reached against testnet (and sakura when available);
- `feed.home` returns a page.

It records the boot timings. This is the cheapest early check of §2.3 before a simulator is involved; M4 repeats it on the iOS simulator and the Android emulator.

---

## 13. The post-1.0 Rust engine

ADR E1 makes `yappr-platform` (rs-sdk + uniffi) a post-1.0 track that is required before mainnet. It must implement **the same `EngineApi`** and pass **the same contract suite**.

**How it slots in.** The host talks to an `EngineTransport`:

```ts
interface EngineTransport {
  start(init: InitPayload): Promise<HelloInfo>
  send(frame: string): void
  onFrame(cb: (frame: string) => void): () => void
  onExit(cb: (reason: string) => void): () => void
}
```

The 1.0 transport is `WebViewTransport`. A Rust engine plugs in as one of two transports, and the proxy, codec, envelopes, events, supervisor and every screen stay unchanged:

| Option (ADR E1) | Where `api/*` runs | Transport | What changes |
| --- | --- | --- | --- |
| **H: `lib/` on Hermes over a Rust `PlatformSdk`** | In the RN JS runtime, in-process | `InProcessTransport`, which calls the dispatcher directly with codec-encoded frames, so DTO plainness is still enforced | Needs the Y5 seams in `lib/` (old [ARCHITECTURE.md › Platform seams](ARCHITECTURE.md#platform-seams-in-lib-the-minimal-yappr-change)): `PlatformSdk` reads, `TxBuilder` writes, the signer and secrets. The shims in §9 become Hermes globals; `MemoryStorage` stays. |
| **P: a ported engine** | Rust, behind uniffi | `NativeTransport`: uniffi `call(frame) → frame` plus an event callback | `api/*` is reimplemented in Rust. The JSON-to-query and result-shaping glue (about 31k lines of wasm-sdk) has to be ported; that is the cost the ADR rejected for 1.0. |

**The native signer** (both options): the private key never enters a JS heap. The native module signs state-transition digests through a Rust-to-native callback, the design of [ARCHITECTURE.md › Signer and key store](ARCHITECTURE.md#signer-and-key-store). This also ends the Lockdown Mode issue (§11.4), because no WebView is used.

**Parity gate.** The Rust engine may become the default only when all of these hold:

1. **Reads.** The full read contract suite (§12.3) passes on both variants, in two consecutive nightly runs.
2. **Writes.** The full write suite passes against sakura, in two consecutive nightly runs.
3. **DTOs.** A recorded corpus of read responses diffs to zero against the WebView engine for the same inputs, excluding fields marked volatile (counts, timestamps). There are 200 calls across every read method, recorded by `harness/record.ts` against a frozen sakura height where possible.
4. **Errors.** Every vector in `error-vectors.json` maps to the same `EngineErrorCode` and `userMessage`.
5. **Speed.** Cold boot to `ready.sdk` and p50 `feed.home` are no slower than the WebView engine on the same simulator and emulator.
6. **Keys.** A heap-inspection test (JS heap snapshot in dev) finds no WIF or 32-byte key material after a signed write.
7. **UI.** Maestro (ADR E8) passes on both platforms with the Rust transport selected.

**Rollout.** A runtime flag (`engine: 'webview' | 'rust'`, devnet builds only, in diagnostics) lets QA switch transports. The WebView engine stays in the binary for one release after the Rust engine becomes the default.

---

## 14. Open items the implementing PRs must settle

| # | Item | Owner PR | How it is settled |
| --- | --- | --- | --- |
| O1 | `file://` origin passes the §2.3 day-1 checks on both WebViews (secure context, CSP `'self'`, worker, DAPI with `Origin: null` on testnet) | M2 (browser), M4 (devices) | Evidence in the PR; switch a platform to option C if it fails |
| O2 | Single-WASM-instance alias (`evo-sdk/dist/sdk.js`) is safe | M2 | Read contract suite both ways; size, boot and memory numbers |
| O3 | Cold-boot and memory numbers on the iOS simulator and the Android emulator | M4 | p50 and p95 per boot stage, in the PR |
| O4 | Zero-size WebView timer throttling on iOS | M4 | Measure the DM loop cadence at 0×0; fall back to 1×1 |
| O5 | **Accepted by the lead 2026-10-01.** Pool slot reservation (personas 90–99) | M7a (lead confirms with sakura ops) | Recorded in `slots.json` |
| O6 | Filed as #608. Web bug: `isUsernameContested` uses an uninitialised WASM instance (§2.1) | separate web issue | Not a 1.0 dependency |
| O7 | Web hygiene: `lib/store.ts:4` value-syntax type import | separate web PR | Not a 1.0 dependency; the build guard covers it |
| O8 | Testnet DAPI CORS with `Origin: null` | M2 | Probe discovered testnet nodes |
| O9 | **Accepted 2026-10-01 (ADR E2 amended).** ADR amendment: React Native takes topology capabilities from `engine.info()` and may use the `lib/contract-topology.ts` predicates only in unit tests, a narrowing of the E2 allowlist (§6.1) | lead | Amend ADR-001 E2, or reject and keep the predicates importable at runtime (which needs the env inlined into the RN bundle too) |

### Additions requested by the PRD (lead, 2026-10-01)

`engine.info()` also returns:
- `ipfsGateways`: the ordered gateway list from `lib/`, used for media fallback;
- `avatarStyles`: the DiceBear style list, plus the seed length limit.

A new `profiles.avatarSvg(identityId, style?, seed?)` returns the DiceBear SVG string generated by `lib/services/avatar-generator.ts`, so RN never bundles DiceBear. RN caches it per identity.

