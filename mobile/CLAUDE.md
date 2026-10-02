# CLAUDE.md: Yappr mobile

The native iOS and Android apps. The binding decisions are in
`docs/mobile/ADR-001-mobile-1.0.md`. The screen and route spec is
`docs/mobile/UX_SPEC.md`, and the PR map is `docs/mobile/EXECUTION.md`. Read them
before you change anything here.

- `mobile/app`: the Expo app. It uses Expo SDK 57, which pins React Native
  **0.86.3**, not the 0.87 the docs mention. New Architecture, TypeScript
  strict. It has its own `package.json` and `package-lock.json`. Run every
  command below from `mobile/app`.
- `mobile/engine` (coming in the engine PR): the hidden-WebView engine bundle.

## Rules

- **No web changes.** Do not edit the web's `app/`, `components/`, `contexts/`,
  `hooks/` or `lib/` from a mobile PR. The only exceptions are the ones ADR-001
  E2 lists:
  - the `mobile` excludes in the root `tsconfig.json` and `.eslintrc.json`
    (knip's `project` globs already skip `mobile/`);
  - the CI workflow;
  - small additive exports the engine truly needs, which go through the full
    web checklist in the root `CLAUDE.md`.
- **Shared files.** See EXECUTION §5.4.
  - Screen PRs edit only their own route files, plus files under their feature
    folder.
  - The root and tab layouts belong to M1 and M4.
  - Tab badges come from `useTabBadges()` in `src/state/tab-badges.ts`.
  - No barrel files, with one exception: `src/lib-allowlist.ts` (next item).
- **Import boundaries.** These are enforced by `eslint/import-boundaries.js`,
  which checks resolved paths for every import form: static, re-export,
  `import()`, `require`, `jest.*` module calls, and TS import-equals and
  `import()` types. So `..` tricks don't get around it.
  - `@dashevo/*` is never imported. A test also fails if it ever appears in
    `package.json` or the lockfile.
  - Everything resolves inside `mobile/app`. Use the aliases:
    - `~/` for `src/`;
    - `@assets/` for `assets/`;
    - `@engine/` for `mobile/engine/src`, `import type` only. Call the engine
      through `~/engine`. The one exception is `ENGINE_RUNTIME_ALLOWLIST`
      (`eslint.config.js`): the wire modules `protocol/*`, `rpc/client` and
      `rpc/transport`, which the host must share with the engine exactly.
      They stay dependency-free, which
      `src/__tests__/engine-runtime-imports.test.ts` enforces.
  - Module specifiers must be string literals.
  - Web `lib/` comes in only through `src/lib-allowlist.ts`:
    - `@/` points at the repo root, as on web;
    - value re-exports must be on `LIB_ALLOWLIST` (`eslint.config.js`);
    - `LIB_TYPE_ALLOWLIST` entries (`lib/types`) are for `export type` only.
  - **Pure** means pure including everything the module imports: no SDK, no
    browser globals, no storage, no `process.env`, and no dependency on
    `lib/constants` or `lib/contract-topology`. Those read the web's build
    env, which Metro doesn't inline. Contract limits and capabilities come
    from the engine. Check the import graph before you add a module.
  - **Both allowlists and `src/lib-allowlist.ts` are append-only.** Add your
    line at the end and don't reorder, so parallel PRs only ever conflict
    mechanically.
  - Tooling files (`*.config.*`, `eslint/`, `jest.setup.js`) are exempt. Test
    files (`*.test.*`, not helpers beside them) may read repo files, but
    never the SDK or engine values.
- **Dependencies** come from `mobile/app/node_modules` only. Metro watches the
  repo root but blocks every other `node_modules`. Add native packages with
  `npx expo install <pkg>`, so they get SDK-compatible versions.
- **Native projects are generated.** `ios/` and `android/` are gitignored
  (CNG). Configure native behaviour in `app.config.ts` and config plugins,
  never by hand.
- **No analytics or crash SDKs** (ADR-001).

## Layout

| Path | What |
| --- | --- |
| `src/app/` | expo-router routes (below). Every 1.0 screen exists as a stub. Fill it in; don't add a parallel route. |
| `src/app/+native-intent.tsx` | Every inbound link goes through `src/navigation/deep-links.ts` (UX_SPEC §3.5). Links are untrusted. Only known web routes (`/post?id=`, ...) and validated path-form detail routes (`/post/:id`, `/user/:id...`, `/hashtag/:tag`, `/messages/:id`) are accepted; anything else goes home. Dev builds also pass other app routes through, but never `sign-in/*`, `compose`, `lockdown`, `terms-gate`, `media` or `settings/app-lock\|accounts`. Each variant claims its own yap.pr prefix (`/devnet` for devnet, the root otherwise). |
| `src/config.ts` | `config.variant`, `config.network`, `config.scheme` and `config.appVersion`. They're derived from the native application id, and the app refuses to start if the JS bundle was built for another variant. Never read `Constants.expoConfig.extra` directly. |
| `src/variants.ts` | The variant table, shared with `app.config.ts`. |
| `src/ui/` | Tokens (`tokens.ts`), `Screen`, `Text`, `Placeholder`, `ComposeFab` and `stackScreenOptions`. The design-system PR adds the primitives. |
| `src/state/` | MMKV `syncStorage`, the TanStack Query client and its persister, the appearance store, `useTabBadges`. |
| `src/data/` | The data layer every screen uses: query keys, engine queries, events, session, writes and optimistic updates (its README). |
| `src/features/<feature>/` | Feature code, next to the routes that use it. `features/post` holds `PostItem` and the post writes. |
| `src/engine/` | The engine host (below). |
| `src/lib-allowlist.ts` | The only door into web `lib/`. |
| `tailwind.config.js` | NativeWind. It uses the root `tailwind.config.js` as a preset, so `yappr-*`, `neutral-750/850` and `shadow-yappr*` are the web's tokens. The gradients are tokens only, because NativeWind can't render `background-image`. |

**Routes.** Each tab has its own stack (UX_SPEC §3.1/§3.2).

- **Tab bar (lead decision, overriding UX_SPEC §3.1's native tabs):** the JS
  `Tabs` navigator with Heroicons (outline, solid when active), web-matching
  colors, and labels shown on both platforms.
- `src/app/(tabs)/(home,explore,notifications,messages,profile)/` holds the
  detail screens every tab can push: `post/[id]`, `post/[id]/engagements`,
  `user/[id]` and its `followers` / `following`, and `hashtag/[tag]`. They open
  on the current tab's stack, so Back returns to where the user came from (a
  profile opened from a conversation goes back to it).
- `+native-intent` pins only the launch link to `(home)`. Links that arrive
  while the app is open push onto the current tab.
- Each tab's own screens live in its group:
  - `(home)/index`;
  - `(explore)/explore/` (with `search` and `search/[kind]`);
  - `(notifications)/notifications`;
  - `(messages)/messages/` (the inbox, `settings`, `[conversationId]` and
    `[conversationId]/info`);
  - `(profile)/profile`, `bookmarks` and `settings/*`.
- Root modals: `compose`, `sign-in/*`, `welcome`, `terms-gate`, `lockdown`,
  `media`, `profile/edit`, `messages/new`, `messages/new-group`, and
  `block/[userId]` and `report/[postId]` (from a post's menu).
- Stubs set their header title with `<Stack.Screen options={{ title }} />`
  (inside `Placeholder`), so layouts never list screens.

**Data.** See `src/data/README.md`.

- **Persisting a query is opt-in.** Pass `{ persist: true }` to
  `useEngineQuery` (it spreads `persistedQuery`).
  Never persist decrypted DMs, notifications or balances, because MMKV is not
  encrypted.
- The persisted cache is busted by app version + `ENGINE_BUNDLE_HASH` + network.
- The session sync (`src/data/session.ts`) calls `clearAccountCache()` on
  sign-out and account switch.

**Appearance.** Dark mode follows the system.
`useAppearance().setTheme('light' | 'dark' | 'system')` overrides it app-wide,
and the choice is persisted and validated in MMKV. The root layout keeps the
splash up until a persisted override has reached NativeWind, so there's no
wrong-theme flash on cold start.

## Build variants

`APP_VARIANT` selects the variant at prebuild, start and export time. The
default is `devnet`. Each variant registers **only its own scheme**, so
side-by-side installs never compete for a link or a wallet callback.

| `APP_VARIANT` | Name | Bundle id / package | Scheme | Network |
| --- | --- | --- | --- | --- |
| `devnet` | Yappr Dev | `pr.yap.app.dev` | `yappr-dev` | `devnet` (sakura) |
| `testnet` | Yappr Beta | `pr.yap.app.beta` | `yappr-beta` | `testnet` |
| `production` | Yappr | `pr.yap.app` | `yappr` | `mainnet` (requires `YAPPR_ALLOW_PRODUCTION=1` until the Rust engine) |

Switching variants changes the bundle id, so prebuild again with
`APP_VARIANT=testnet npm run prebuild`. Metro must then be started with the
same `APP_VARIANT`, or the app refuses to start (`src/config.ts`).

**Engine host** (`src/engine/`, ENGINE.md §1, §3, §9, §11).

- `engine.api.<module>.<method>()` (`~/engine`) calls the engine. Screens go
  through the data layer instead (`src/data/README.md`): `queryKeys`,
  `useEngineQuery` / `useEngineInfiniteQuery`, `useEngineEvent`,
  `submitWrite` / `useWrite`, `useSession`, `useCapabilities` and
  `requireAuth`. Posts render with `src/features/post/PostItem.tsx`.
  `useEngineStatus()` (`~/engine/hooks`) is the supervisor's state.
- `EngineHost` (mounted by the root layout) renders the one hidden WebView.
  The supervisor (`supervisor.ts`) boots it, queues calls until boot, pings it,
  restarts it on a crash or hang with backoff, and replays an interrupted
  **read** once. Writes and session calls are never replayed (`methods.ts`
  classifies paths; unknown paths count as writes).
- The engine's `localStorage` lives in an encrypted MMKV instance per network
  (`yappr.engine.<networkKey>`; its key is in the Keychain/Keystore), and its
  secrets (`yappr_secure_*`, `yappr:pf:*`, upload credentials) in
  expo-secure-store (`storage/`).
- Without WebAssembly (iOS Lockdown Mode) the app routes to `/lockdown`; an
  Android WebView older than the bundle's Chrome 110 target to
  `/webview-update`. Diagnostics (`/settings/diagnostics`) shows state,
  versions, timings and the redacted log ring buffer.
- The config plugin `plugins/engine-assets` builds `mobile/engine` for the
  variant at prebuild (root `npm ci` first; `YAPPR_ENGINE_SKIP_BUILD=1` to
  reuse `dist/`) and ships it: `engine.inline.html` on iOS (loaded with an
  https base URL), and on Android `engine.js` and its sidecars
  (`engine.wasm.js`, `engine.avatars.js`) behind a small loader page, since
  that WebView silently loads nothing for inline HTML over about 15 MB.
- Dev builds of the devnet variant have a quick sign-in on the diagnostics
  screen (paste a WIF or hex key), for testing signed-in screens.
- **Engine changes without a native rebuild (dev):** rebuild the engine, run
  `APP_VARIANT=testnet npm run engine:serve` (serves `dist/<variant>` on
  127.0.0.1:8092; `adb reverse tcp:8092 tcp:8092` on Android), start Metro with
  `YAPPR_ENGINE_DEV_URL=http://127.0.0.1:8092`, then "Restart engine" in
  diagnostics.

**Native modules in the dev client: adding one requires a lead-approved
rebuild.** Screen PRs share one dev-client build, so they use only these:
`expo` and its modules (`expo-application`, `expo-clipboard`,
`expo-constants`, `expo-crypto`, `expo-dev-client`, `expo-file-system`,
`expo-haptics`, `expo-image`, `expo-linking`, `expo-local-authentication`,
`expo-router`, `expo-screen-capture` (iOS only), `expo-secure-store`, `expo-sharing`,
`expo-splash-screen`, `expo-status-bar`, `expo-system-ui`, `expo-web-browser`),
`@react-native-community/netinfo`, `@react-native-menu/menu` (native
long-press and dropdown menus; zeego 3 cannot build on RN 0.86),
`@react-native-segmented-control/segmented-control`,
`react-native-gesture-handler`, `react-native-mmkv` (+
`react-native-nitro-modules`), `react-native-reanimated` (+
`react-native-worklets`), `react-native-safe-area-context`,
`react-native-screens`, `react-native-svg`, `react-native-webview`, and the
local `modules/background-flush` and `modules/secure-window`. JS-only packages (for example
`react-native-qrcode-svg`) need no rebuild.

## Run

```bash
npm ci
npm run prebuild                       # expo prebuild --clean: regenerates ios/ and android/
npx expo run:ios --device "Yappr iPhone 17" --no-bundler
npx expo run:android --device yappr_pixel --no-bundler   # the AVD name, not emulator-5554
npx expo start --dev-client --port 8091
```

On this machine OrbStack holds port 8081, so run Metro on another port and
point the dev client at it. The dev-client launcher scheme is `exp+yappr`.
`--port` cannot be combined with `--no-bundler` on `expo run:*`.

```bash
xcrun simctl openurl booted "exp+yappr://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8091"
adb reverse tcp:8091 tcp:8091
adb shell am start -a android.intent.action.VIEW \
  -d "exp+yappr://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8091" pr.yap.app.dev
```

A fresh install opens the dev-client menu once. Dismiss it, with
`idb ui tap` on iOS and `adb shell input tap` on Android.

Android builds need `JAVA_HOME=$(/usr/libexec/java_home -v 21)` and
`ANDROID_HOME=/Users/pasta/workspace/android-sdk`.

## Validate

Run all of these before you commit:

```bash
npm run typecheck   # generates typed routes (expo customize tsconfig.json), then tsc --noEmit
npm run lint        # ESLint, warnings fail
npm test            # jest-expo + React Native Testing Library
npm run bundle -- --output-dir /tmp/expo-export   # Metro smoke test (expo export, both platforms), as in CI
```

A PR that changes native dependencies, `app.config.ts` or config plugins must
also prebuild and build on **both** platforms (see Run).

- Tests live next to the code they cover (`*.test.ts`) or in `src/__tests__/`.
  Never put them under `src/app/`, because every file there is a route.
- `src/__tests__/navigation.test.tsx` renders the real route tree with
  `expo-router/testing-library`. Add each new route to its "has a stub" table.
- RNTL stays on 13.x: expo-router's `renderRouter` renders synchronously,
  which RNTL 14's async render breaks.

The root `npm run lint`, `npm run test` and `npm run build` don't look at
`mobile/`. Run them anyway if you touched a root file.

## Release builds

See `mobile/RELEASE.md`. `APP_VARIANT=devnet npm run release:android` writes a
release APK and AAB, and `npm run release:ios -- simulator|archive` writes a
Release simulator app or an unsigned archive. Both go to `build/release/`.
Icons come from `npm run icons`. Release-only Android settings live in
`plugins/release-hardening`. Never commit keystores, `.p8` keys or
provisioning profiles.

## Screenshots (agents)

Every UI PR includes iOS and Android screenshots in light and dark
(ADR-001 E8). Save them under `/tmp/claude/yappr-mobile/evidence/<task>/` as
`<platform>-<theme>-<screen>.png`.

```bash
# iOS simulator
xcrun simctl ui booted appearance light    # or dark
xcrun simctl io booted screenshot ios-light-home.png

# Android emulator
adb shell cmd uimode night no               # or yes
adb exec-out screencap -p > android-light-home.png
```

Open a route with a deep link through `+native-intent`, for example
`xcrun simctl openurl booted "yappr-dev:///__gallery"` or
`adb shell am start -a android.intent.action.VIEW -d "yappr-dev:///__gallery" pr.yap.app.dev`.
Arbitrary app routes like this work in dev builds only. Web-form links such as
`yappr-dev://post?id=<id>` work in every build. Links can't open sign-in,
compose, media or the gates; reach those by navigating in the app.

Some screens block capture on purpose (`src/ui/screen-capture.ts`, AUTH-12),
so on Android their screenshots, including `adb exec-out screencap`, come out
black:
- `useBlockScreenCapture('secret')`: screens that show or take a private key
  (key sign-in, the DM unlock sheet), on both platforms. iOS uses
  expo-screen-capture, which blanks the user's screenshots and recordings.
  `xcrun simctl io screenshot` reads the framebuffer, so it still shows
  these screens.
- `useBlockScreenCapture('private')`: the DM inbox, conversations and group
  info, and the whole app while the app lock is on. This is Android only
  (FLAG_SECURE, which also blanks the Recents thumbnail).

For Android evidence of those screens, turn the app lock off and say in the
PR that the DM and key screens can't be captured.

Android blocks capture through the local `modules/secure-window`
(FLAG_SECURE, re-applied on every foreground). expo-screen-capture is linked
on iOS only (`expo.autolinking.android.exclude` in `package.json`). On
Android it registers a screenshot callback at startup, so Android 14+ would
show "Yappr detected this screenshot" on every screen. Never import
`expo-screen-capture` directly: `modules/secure-window/index.ios.ts` is the
only file that may.

`/__gallery` is dev-only. It renders the shared tokens and has a
Light/Dark/System switch for testing the override.
