# Yappr mobile lanes (dev-client builds REBUILT 2026-10-02 from staging c0f5e294)

**Current golden (2026-10-02):** the iOS sim Debug .app and Android debug APK (arm64-v8a) for devnet and testnet, built from mobile/app-switcher-privacy 624ca202. That tree is identical to staging c0f5e294 (#642 release plumbing and #645 app-switcher privacy merged). New native modules: expo-screen-capture (iOS only) and the local modules/secure-window (Android FLAG_SECURE). Installed on ALL lane devices plus the M4 sim 0FB7985F and emulator-5570 (on emulator-5570 the old packages had a different signature, so they were uninstalled and reinstalled, which wiped their app data). mobile-golden is detached at c0f5e294, with npm ci run in root, mobile/app and mobile/engine. Its ios/ and android/ are stale: prebuild again before any native build.

Previous source: /Users/pasta/.t3/worktrees/yappr/mobile-golden (detached at staging 7df7fb08). iOS dev clients REBUILT 2026-10-01 (includes wipeKeychainServices in modules/background-flush); Android APKs are from the earlier mobile-host build (e3cfe3f4) and need no rebuild (the function is iOS-only). Debug dev clients, both variants on every lane device.
The M4 host sim ("Yappr iPhone 17 (M4 host)" 0FB7985F-...) and AVD yappr_pixel_m4 (Metro 8090) belong to another agent and were not touched.

| Lane | iOS simulator | iOS UDID | Android AVD | Serial | Metro port | Variants installed |
|---|---|---|---|---|---|---|
| L1 | Yappr iPhone 17    | 7E2918AC-42DF-45F3-86AE-8DCA092BE07B | yappr_pixel    | emulator-5554 | 8181 | devnet (pr.yap.app.dev), testnet (pr.yap.app.beta) |
| L2 | Yappr iPhone 17 L2 | 0BA11478-0F45-486B-9077-7F418A81647A | yappr_pixel_l2 | emulator-5556 | 8182 | both |
| L3 | Yappr iPhone 17 L3 | A6B5008C-C31B-4C2D-89BE-6CAADA46CE48 | yappr_pixel_l3 | emulator-5558 | 8183 | both |
| L4 | Yappr iPhone 17 L4 | A48BD1B8-856D-4D22-9576-14DC405FE330 | yappr_pixel_l4 | emulator-5560 | 8184 | both |

Serials are the boot order at install time; re-check with `adb devices` + `adb -s <serial> emu avd name` if emulators get restarted.

## PORTS: do NOT use 8081 / 8082
OrbStack listens on 127.0.0.1:8081 and 127.0.0.1:8082. Metro on 8081 binds `*` (IPv6) too, so `curl localhost:8081` works but the
simulator / adb reverse land on OrbStack and the app shows "404 page not found". Verified (evidence/lanes/ios-openurl-expyappr-8081.png).
Lane ports are therefore 8181-8184 (all free; 8083/8084 are also free if you prefer them for L3/L4). 8090 = M4 host agent.

## Variants / schemes
| APP_VARIANT | Bundle id / package | Scheme to use | Install artifact |
|---|---|---|---|
| devnet  | pr.yap.app.dev  | yappr-dev  | /tmp/claude/yappr-mobile/golden/devnet/YapprDev.app, yappr-dev-debug.apk |
| testnet | pr.yap.app.beta | yappr-beta | /tmp/claude/yappr-mobile/golden/testnet/YapprBeta.app, yappr-beta-debug.apk |

Both variants also register the dev-client scheme `exp+yappr`, so it is ambiguous on iOS when both are installed. ALWAYS use the per-variant
scheme (`yappr-dev` / `yappr-beta`) for the launch URL; it is handled by expo-dev-launcher and targets the right app.
Metro must run with the SAME APP_VARIANT as the app you open, or the app refuses to start.

## Start Metro (lane N, variant V)
    cd /Users/pasta/.t3/worktrees/yappr/mobile-golden/mobile/app   # or your own checkout's mobile/app
    APP_VARIANT=<devnet|testnet> npx expo start --dev-client --port <port>

## Launch the dev client against Metro
iOS (Metro reachable as localhost from the sim):
    xcrun simctl openurl <udid> "<scheme>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>"
    # e.g. xcrun simctl openurl 7E2918AC-42DF-45F3-86AE-8DCA092BE07B "yappr-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8181"
Android:
    adb -s <serial> reverse tcp:<port> tcp:<port>
    adb -s <serial> shell am start -a android.intent.action.VIEW -d "<scheme>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>" <package>
    # e.g. adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d "yappr-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8181" pr.yap.app.dev
Cold start the app first (`xcrun simctl terminate <udid> <bundle>` / `adb -s <serial> shell am force-stop <package>`) for a clean load.
Engine-without-rebuild dev port 8092 (`adb reverse tcp:8092 tcp:8092`) is shared across lanes; avoid running two engine:serve instances.

adb: /Users/pasta/workspace/android-sdk/platform-tools/adb (ANDROID_HOME=/Users/pasta/workspace/android-sdk).

## Verified
- iOS L1 devnet via `yappr-dev://` against Metro :8181 -> Home tab renders, engine ready (evidence/lanes/ios-openurl-yappr-dev-8181.png; ios-openurl-expyappr-8181.png via exp+yappr also landed on devnet).
- Android L1 devnet via `yappr-dev://` + adb reverse :8181 -> Home tab renders (evidence/lanes/android-yappr-dev-8181.png).
- testnet variants installed on all 8 devices (listapps / pm list packages) but launch not exercised.
- Evidence dir: /tmp/claude/yappr-mobile/evidence/lanes/

## Update after staging 7df7fb08 rebuild
- iOS .app for both variants rebuilt from mobile-golden and reinstalled on L1-L4 (listapps shows pr.yap.app.dev + pr.yap.app.beta on all four).
- Verified (devnet, Metro from mobile-golden :8181): `yappr-dev:///settings/diagnostics` shows Engine "Ready" on iOS L1 (evidence/lanes/ios-golden-diagnostics.png) and Android L1 / emulator-5554 (evidence/lanes/android-golden-diagnostics.png). Open the dev-client URL first, then the diagnostics link.
- mobile-golden's ios/ currently holds the testnet prebuild (android/ is from the old mobile-host prebuild). Re-run `APP_VARIANT=<v> npx expo prebuild --clean` before building natively.
- Build DerivedData was deleted; only the .app / .apk artifacts remain in /tmp/claude/yappr-mobile/golden/{devnet,testnet}/.

## Update after staging c0f5e294 rebuild (2026-10-02)
- **Artifacts:** /tmp/claude/yappr-mobile/golden/{devnet,testnet}/ were replaced: YapprDev.app, yappr-dev-debug.apk (sha256 3145550f8f4f…), YapprBeta.app, yappr-beta-debug.apk (c664a6945955…). The APK hashes were checked on all 5 emulators, and `simctl listapps` shows both bundles on all 5 sims. DerivedData was deleted.
- **Verified on devnet L1** (evidence/golden-2026-10-02/):
  - **iOS:** diagnostics shows the engine Ready (ios-l1-diagnostics.png). Info.plist LSApplicationQueriesSchemes = [dash-key, dash-st]. Sign-in shows the no-wallet path without crashing. The log has `canOpenURL dash-key: error -10814` (no handler installed), which means the query was allowed.
  - **Android:** the Settings row reads "Engine ready". The merged manifest <queries> has VIEW intents for dash-key and dash-st (devnet-merged-AndroidManifest.xml). There's no screenshot-detection toast. With app lock on, the window is FLAG_SECURE and the Recents thumbnail is black (android-recents-lock-on*.png), including after an Activity recreation from a font-scale change. The DM inbox is FLAG_SECURE.
- **Screenshot impact:** with app lock on, every Android screenshot is black. The DM inbox, conversation, group info, key sign-in and DM unlock sheet are always black on Android (`adb exec-out screencap` included). `simctl io screenshot` still shows the iOS key screens.
- **L1 state:** the app lock was turned back off on L1 Android, the emulator PIN was cleared, and font_scale is back to 1.0.
