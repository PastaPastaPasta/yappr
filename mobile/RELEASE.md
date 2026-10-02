# Releasing the Yappr mobile apps

How to build, sign and upload release builds of `mobile/app`. Store policy is
in [`docs/mobile/COMPLIANCE.md`](../docs/mobile/COMPLIANCE.md), and the beta
programme and gates are in [`docs/mobile/QA_RELEASE.md`](../docs/mobile/QA_RELEASE.md).
Run every command below from `mobile/app`.

**Owner credentials.** Everything up to an unsigned or locally signed build
runs without secrets. Uploading to TestFlight and Google Play needs the
credentials listed in [What the owner provides](#what-the-owner-provides).

## Variants

`APP_VARIANT` picks the variant (ADR-001 E6). Each variant has its own
application id, so each one is a **separate app record** in App Store Connect
and in the Play Console.

| `APP_VARIANT` | Name | Bundle id / package | Icon badge | Network |
| --- | --- | --- | --- | --- |
| `devnet` | Yappr Dev | `pr.yap.app.dev` | amber "DEV" | devnet (sakura) |
| `testnet` | Yappr Beta | `pr.yap.app.beta` | blue "BETA" | testnet |
| `production` | Yappr | `pr.yap.app` | none | mainnet; refused until the Rust engine (`YAPPR_ALLOW_PRODUCTION=1` overrides) |

## Versions

- **Version** (`CFBundleShortVersionString`, `versionName`): `version` in
  `mobile/app/package.json`. Bump it there for each store release.
- **Build number** (`CFBundleVersion`, `versionCode`): `YAPPR_BUILD_NUMBER`,
  default `1`. Both stores refuse a second upload with the same build number,
  so CI passes its run number. EAS keeps its own counter (`appVersionSource:
  remote`, `autoIncrement`) and ignores this variable. The three counters are
  independent, so upload to each app record through **one** channel only
  (local/CI or EAS), or the numbers collide.

## Icons and splash

The icons in `assets/images/icons/<variant>/` and `assets/images/splash-icon.png`
are generated from the fox (`assets/images/icon.png`) by
`npm run icons` (`scripts/generate-icons.mjs`) and committed. Rerun it after
changing the art or the badges. It fetches `sharp` into a temp folder, so the
app gets no new dependency.

| File | Used for |
| --- | --- |
| `ios-light.png` | The iOS icon and App Store icon (opaque) |
| `ios-dark.png`, `ios-tinted.png` | iOS 18+ dark and tinted home screens |
| `android-foreground.png` | Adaptive icon foreground, inside the 66/108 safe zone, on `#0f87cf` |
| `android-monochrome.png` | Android 13+ themed icon |

The splash shows the fox on the icon's blue in light mode and on the app's
dark surface (`#171717`) in dark mode.

## What a release build contains

- **iOS:**
  - The privacy manifest: no tracking, no collected data, and the
    required-reason APIs UserDefaults `CA92.1`, file timestamps `C617.1`,
    system boot time `35F9.1` and disk space `E174.1`. Expo SDK 57 links some
    modules as precompiled frameworks with empty privacy bundles, so the app
    manifest declares their reasons. Check the first TestFlight upload's
    email for ITMS-91053/91061.
  - `ITSAppUsesNonExemptEncryption = YES` (COMPLIANCE C8). Before launch in
    France, file the French encryption declaration, or leave France out.
  - Face ID is the only usage description. expo-dev-launcher's local-network
    keys (`NSLocalNetworkUsageDescription`, `NSBonjourServices`) are removed
    from Release builds by its own script phase. That phase can be skipped on
    an incremental build, so `release-ios.sh` removes them as well.
  - ATS blocks `http://` loads, as on Android.
  - Known leftover: expo-dev-client registers the `exp+yappr` scheme in every
    build and every variant. The dev-client workflow (mobile/CLAUDE.md)
    depends on it. It is harmless in Release, where the launcher is not
    compiled in.
- **Android:**
  - 64-bit only. `gradle.properties` sets `arm64-v8a,x86_64`, so x86_64
    emulators work. The release scripts and the EAS profiles narrow release
    builds to `arm64-v8a` with `-PreactNativeArchitectures=arm64-v8a`.
  - R8 minify and resource shrinking.
  - Hermes.
  - No cleartext traffic: `http://` media and endpoints fail in release.
    Only the debug manifests allow cleartext, for Metro.
  - `allowBackup=false`, plus data extraction rules that exclude everything
    from device-to-device transfer.
  - Unused permissions are blocked: storage, media, `SYSTEM_ALERT_WINDOW`,
    camera, microphone, and the Play install referrer. What remains is
    `INTERNET`, `ACCESS_NETWORK_STATE` and `ACCESS_WIFI_STATE` (NetInfo),
    `USE_BIOMETRIC`/`USE_FINGERPRINT` (app lock), `VIBRATE` (haptics), and
    the app's own `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.
  - These settings come from `app.config.ts` and `plugins/release-hardening`.
- **OTA updates are off.** `expo-updates` is not installed, and a test
  (`src/__tests__/dependencies.test.ts`) keeps it that way.
- **No dev menu.** `expo-dev-client` is compiled into Debug builds only.

## Local release builds

### Android

```bash
# Once: an upload keystore outside the repo (prints the env to export)
scripts/android-upload-keystore.sh ~/.yappr/yappr-upload.jks

APP_VARIANT=devnet npm run release:android            # APK + AAB in build/release/
APP_VARIANT=testnet npm run release:android -- aab    # just the AAB
adb install -r build/release/yappr-devnet-1.0.0-1.apk    # …-debugsigned.apk without an upload key
```

Without the `YAPPR_UPLOAD_*` variables, the build is signed with the debug key
and named `…-debugsigned.apk/.aab`. That's fine for installing on a device, but
Play rejects it.

| Variable | Meaning |
| --- | --- |
| `YAPPR_UPLOAD_STORE_FILE` | Absolute path to the upload keystore (`.jks`) |
| `YAPPR_UPLOAD_STORE_PASSWORD`, `YAPPR_UPLOAD_KEY_PASSWORD` | Its passwords |
| `YAPPR_UPLOAD_KEY_ALIAS` | Key alias (`yappr-upload` from the script) |
| `YAPPR_ANDROID_ABIS` | ABIs to build (default `arm64-v8a`; `arm64-v8a,x86_64` for an x86 emulator) |
| `YAPPR_SKIP_PREBUILD=1` | Reuse `android/` instead of `expo prebuild --clean`. It must have been prebuilt for the same variant and build number. |

Keystores never go in git. `.gitignore` covers `*.jks` and `*.keystore`, and
the script refuses to write one inside the repo.

### iOS

```bash
APP_VARIANT=devnet npm run release:ios -- simulator   # Release .app for the simulator
xcrun simctl install <udid> build/release/yappr-devnet-1.0.0-1-simulator.app

APP_VARIANT=devnet npm run release:ios -- archive     # unsigned device archive + unsigned .ipa
```

The unsigned `.ipa` shows the upload size; it can't be installed. To sign and
upload, see [TestFlight](#testflight).

## CI: `Mobile release` workflow

`.github/workflows/mobile-release.yml` runs on manual dispatch, with inputs
`variant` (devnet or testnet) and `build_number` (defaults to the run number).

- **Android** (ubuntu): a release APK and AAB, uploaded as artifacts.
  - Both are signed with the debug key unless these secrets are set:
    `ANDROID_UPLOAD_KEYSTORE_BASE64` (`base64 -i yappr-upload.jks`),
    `ANDROID_UPLOAD_STORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` and
    `ANDROID_UPLOAD_KEY_PASSWORD`.
  - Put them in the `mobile-release` GitHub environment, restricted to
    protected branches or gated by a required reviewer. Anyone with write
    access can dispatch the workflow.
  - Only the decode step sees the secrets, and it runs after `npm ci`.
- **iOS** (macos-26, Xcode 26): an unsigned archive, uploaded as an unsigned
  `.ipa` together with the xcodebuild log.

Neither job needs secrets to run.

## EAS (optional)

`eas.json` maps profiles to variants:

| Profile | `APP_VARIANT` | Build | Distribution |
| --- | --- | --- | --- |
| `development` | devnet | dev client (debug APK, iOS simulator) | internal |
| `preview` | devnet | release (AAB, arm64) | store: TestFlight / Play internal (G1 alpha) |
| `beta` | testnet | release | store |
| `production` | production | release | store; fails until production is buildable |

Setup by the owner:

1. Run `npx eas-cli login`, then `npx eas-cli init` in `mobile/app`. Add the
   printed project id to `app.config.ts` as `extra.eas.projectId` and
   `owner`. The id is public.
2. Run `npx eas-cli credentials` for each variant. Let EAS create or upload
   the iOS distribution certificate and the provisioning profile for each
   bundle id, and upload the Android upload keystore. Credentials stay on
   EAS, never in git.
3. Store the CI token as the GitHub secret `EXPO_TOKEN`, if CI should start
   EAS builds.
4. Run `npx eas-cli build --profile preview --platform all`, then
   `npx eas-cli submit --profile preview`.

`eas-build-post-install` (package.json) installs the root and engine
dependencies that the engine build needs at prebuild.

## TestFlight

**Needs:** an Apple Developer **organization** account (COMPLIANCE C1), and an
App Store Connect app record per variant: `pr.yap.app.dev`,
`pr.yap.app.beta`, and later `pr.yap.app`.

1. In App Store Connect → Users and Access → Integrations, create an **App
   Store Connect API key** with the App Manager role. Keep the `.p8`, the key
   id and the issuer id out of git (`*.p8` is gitignored).
2. Create an **Apple Distribution** certificate. Create an **App Store**
   provisioning profile for each bundle id. Xcode automatic signing with the
   API key can do both.
3. Archive with signing, then export and upload in one step:

   ```bash
   # The archive re-evaluates app.config.ts (expo-constants), so APP_VARIANT must reach both steps.
   export APP_VARIANT=devnet YAPPR_BUILD_NUMBER=<n>
   npm run release:ios -- archive   # makes the project; the unsigned archive is not uploaded
   cd ios && xcodebuild -workspace YapprDev.xcworkspace -scheme YapprDev -configuration Release \
     -destination 'generic/platform=iOS' -archivePath ../build/release/YapprDev.xcarchive \
     -allowProvisioningUpdates DEVELOPMENT_TEAM=<TEAM_ID> \
     -authenticationKeyPath <AuthKey.p8> -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID> \
     archive
   xcodebuild -exportArchive -archivePath ../build/release/YapprDev.xcarchive \
     -exportOptionsPlist <ExportOptions.plist> -exportPath ../build/release/export \
     -allowProvisioningUpdates \
     -authenticationKeyPath <AuthKey.p8> -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID>
   ```

   `ExportOptions.plist` contains `method` = `app-store-connect`,
   `destination` = `upload`, `teamID` = `<TEAM_ID>`, and
   `manageAppVersionAndBuildNumber` = `false`. For testnet, export
   `APP_VARIANT=testnet` and use `YapprBeta.xcworkspace` and the `YapprBeta` scheme.
4. In App Store Connect, answer the export compliance question: standard
   algorithms not provided by Apple (COMPLIANCE, Encryption export). Then add
   the build to the internal testing group. The first external build goes
   through Beta App Review.

## Google Play internal testing

**Needs:** a Play Console **organization** developer account with developer
verification of the package (COMPLIANCE C1), and an app per package.

1. Create the app in the Play Console. Enroll in **Play App Signing**: Google
   holds the app signing key, and you upload with the upload key from
   `scripts/android-upload-keystore.sh`.
2. Upload the **first** AAB by hand (Testing → Internal testing → Create
   release). Play requires the first upload to come from the console.
3. For later uploads, create a **service account** in Google Cloud with
   access to the app in Play Console → Users and permissions, and download its
   JSON key (keep it out of git). Then upload with `npx eas-cli submit
   --profile preview --platform android --path build/release/<name>.aab`, or
   with fastlane `supply --track internal --aab <file> --json_key <key.json>`.
4. Fill in the Data safety form (COMPLIANCE, Privacy disclosures), the
   Financial features declaration ("non-custodial; no exchange"), content
   rating, and the testers list.

## What the owner provides

| Item | For | Where it lives |
| --- | --- | --- |
| Apple Developer organization account, team id | All iOS distribution | Apple |
| App Store Connect app records (3 bundle ids) | TestFlight | App Store Connect |
| App Store Connect API key (`.p8`, key id, issuer id) | Signing with `-allowProvisioningUpdates`, upload, `eas submit` | Password manager or EAS |
| Apple Distribution certificate and App Store profiles | Signing | Keychain or EAS |
| Play Console organization account, developer verification | All Android distribution | Google |
| Android upload keystore and passwords | Signing AABs | Password manager; optionally GitHub secrets `ANDROID_UPLOAD_*` or EAS |
| Play service account JSON | Automated uploads | Password manager or EAS |
| EAS project id and `EXPO_TOKEN` | EAS builds (optional) | `app.config.ts` (public id), GitHub secret |
