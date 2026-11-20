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
| `staging-testnet` | Yappr Staging | `pr.yap.app.staging` | blue "BETA" | testnet (release set, `/staging` handoffs) |
| `testnet` | Yappr Beta | `pr.yap.app.beta` | blue "BETA" | testnet |
| `production` | Yappr | `pr.yap.app` | none | mainnet; refused until the Rust engine (`YAPPR_ALLOW_PRODUCTION=1` overrides) |

Release configuration is shared with the web's fail-closed validator:

| Variant | Authoritative public env | Web handoffs and wallet HTTPS return |
| --- | --- | --- |
| `staging-testnet` | committed `.env.testnet` (D20) | `https://yap.pr/staging` |
| `testnet` | committed `.env.testnet` | `https://yap.pr` |
| `devnet` | committed `.env.devnet` | `https://yap.pr/devnet` |

The testnet variants force `NEXT_PUBLIC_RELEASE=1` and validate every release
pin before building. A missing or incomplete `.env.testnet` fails intentionally;
ambient public env variables cannot supply missing pins. Neither variant needs a
local patch, copied env file or skip-build flag:

```bash
# From the repository root
node mobile/engine/build.mjs --variant staging-testnet
# From mobile/app (prebuild rebuilds the matching engine)
APP_VARIANT=staging-testnet npm run release:android -- apk
APP_VARIANT=staging-testnet npm run release:ios -- simulator
```

Run the Maestro smoke suite (deep links, wallet return, native routes) against
the installed staging build with
`mobile/e2e/run.sh --platform ios|android --device <id> --variant staging-testnet --suite smoke`
([mobile/e2e/README.md](e2e/README.md)).

Staging uses `yappr-staging://`, distinct from production beta's `yappr-beta://`,
so both can be installed together. All handoffs retain the deployment prefix.
The wallet returns to `<web-base>/connect/?r=…&app=<scheme>`; the exported web
bridge opens that app. Confirm the deployed bridge returns HTTP 200 before QA.
Universal/App Links must use the same deployment prefix; enabling verified
links still needs the owner's Team ID and distribution signing fingerprints
and matching `.well-known` association files. HTTPS-to-scheme return works
without those associations. The legacy root may remain 404 until cut-over.

Rebuild the engine explicitly after changing release env files; app config
rejects a stale manifest before prebuild starts.

The generated engine manifest records all public pins, the release storage
epoch, web prefix, native namespace and bundle hash. The app rejects a manifest from another variant or
configuration, including when reusing an engine with `YAPPR_ENGINE_SKIP_BUILD=1`.
The native storage namespace includes the epoch/prefix, isolating staging and
release; engine keys stay unscoped so host session and secret routing agree.

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
are generated from the brand set in the web's `public/brand/` by `npm run icons`
(the repo root's `scripts/brand-assets.mjs`, which also builds the web favicons)
and committed. Rerun it after changing the set or the badges; see
`docs/brand/README.md`. It fetches `sharp` into a cache folder, so the app gets no
new dependency.

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
  - Export compliance (COMPLIANCE C8): `ITSAppUsesNonExemptEncryption = YES`
    is written only together with the app record's approved documentation
    code (`YAPPR_IOS_EXPORT_COMPLIANCE_CODE`), since App Store Connect refuses
    YES without it (ITMS-90592). Without the code neither key is written and
    each build asks the compliance question in App Store Connect; the plist
    never claims exemption. The signing gate refuses YES without a code.
    Before launch in France, file the French encryption declaration, or
    leave France out.
  - Face ID is the only usage description. expo-dev-launcher's local-network
    keys (`NSLocalNetworkUsageDescription`, `NSBonjourServices`) are removed
    from Release builds by its own script phase. That phase can be skipped on
    an incremental build, so `release-ios.sh` removes them as well.
  - ATS blocks `http://` loads to host names, as on Android. Release builds
    (`YAPPR_RELEASE=1`, set by `release-ios.sh` and the EAS store profiles)
    drop the template's `NSAllowsLocalNetworking`, which only the dev client
    needs, so `.local` and unqualified hosts are blocked too. iOS never
    applies ATS to IP literals, so `http://192.168.x.x` still loads.
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

The unsigned `.ipa` shows the upload size; it can't be installed. With
`YAPPR_IOS_TEAM_ID` and `YAPPR_IOS_PROFILE_SPECIFIER` set, `archive` signs
instead (the app target only, "Apple Distribution" from the keychain); the
[TestFlight](#testflight) workflow does that.

## CI: `Mobile release` workflow

`.github/workflows/mobile-release.yml` runs on manual dispatch, with inputs
`variant` (devnet, staging-testnet or testnet) and `build_number` (defaults to the run number).

- **Android** (ubuntu): a release APK and AAB, uploaded as artifacts.
  - Both are signed with the debug key unless these secrets are set:
    `ANDROID_UPLOAD_KEYSTORE_BASE64` (`base64 -i yappr-upload.jks`),
    `ANDROID_UPLOAD_STORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS` and
    `ANDROID_UPLOAD_KEY_PASSWORD`.
  - Put them in the `mobile-release` GitHub environment, restricted to
    protected branches or gated by a required reviewer. Anyone with write
    access can dispatch the workflow.
  - Only the decode step sees the secrets, and it runs after `npm ci`.
- **iOS** (`xcode-27` runner, Xcode 27.2): an unsigned archive, uploaded as an unsigned
  `.ipa` together with the xcodebuild log.

Neither job needs secrets to run.

## EAS (optional)

`eas.json` maps profiles to variants:

| Profile | `APP_VARIANT` | Build | Distribution |
| --- | --- | --- | --- |
| `development` | devnet | dev client (debug APK, iOS simulator) | internal |
| `preview` | devnet | release (AAB, arm64) | store: TestFlight / Play internal (G1 alpha) |
| `staging-beta` | staging-testnet | release | store; separate optional rehearsal app record |
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

`eas-build-pre-install` (package.json) installs the root and engine
dependencies before Expo evaluates app config or runs prebuild. The shared
release validator needs those root dependencies even before an engine exists.

## TestFlight

**Needs:** the Dash Foundation's Apple Developer **organization** account
(COMPLIANCE C1), team `44RJ69WHFF`, "The Dash Foundation, Inc.", never a
personal account, and an App Store Connect app record per bundle id
(`pr.yap.app.beta` is "Yappr Beta").

### `iOS TestFlight` workflow

`.github/workflows/ios-testflight.yml` runs on manual dispatch only, on
the `xcode-27` runner with Xcode 27.2 (App Store Connect requires the iOS 27
SDK from April 2027, ITMS-90725; `scripts/check-xcode.sh` fails a beta or
older Xcode), in the `testflight` environment. Inputs:

| Input | Default | What |
| --- | --- | --- |
| `variant` | `testnet` | `testnet`, `devnet` or `staging-testnet` |
| `build_number` | the run number | `CFBundleVersion`; must be new for the app record |
| `dry_run` | `true` | build, sign, export and run the signing gate, but don't upload |
| `what_to_test` | `New beta build.` | TestFlight "What to Test" |

It prebuilds and archives with `scripts/release-ios.sh archive`, signing the
app target only (`CODE_SIGN_STYLE=Manual`, `DEVELOPMENT_TEAM`, `CODE_SIGN_IDENTITY
= Apple Distribution`, `PROVISIONING_PROFILE_SPECIFIER` = the profile's UUID)
from a temporary keychain with a random password. It exports an `.ipa` with a
generated `ExportOptions.plist` (`app-store-connect`, manual signing, the
profile mapped to the bundle id, `manageAppVersionAndBuildNumber` false), runs
the signing gate, and then, unless `dry_run`:

1. after a read-only App Store Connect check (also on dry runs), uploads that exact `.ipa` with `xcrun altool` and the App Store Connect API
   key (never an Apple ID or an Xcode account);
2. waits up to 45 minutes for processing (`scripts/asc-testflight.mjs`, the
   API key's JWT);
3. attaches an existing **approved, non-exempt** export compliance declaration with the
   standard-algorithm answers. It never answers "no encryption" and never
   creates one, because the French store answer is the owner's call
   (COMPLIANCE C8). If approved declarations disagree on the French store,
   none is picked. Without one the build stays in Missing Compliance and the
   summary lists the clicks;
4. sets What to Test and adds the build to the internal group **Yappr
   Internal**, creating it if missing.

The keychain, profile, certificate and key files are removed at the end, pass
or fail.

**Signing gate.** It runs on every run, dry runs included, before any upload,
and fails the job on any mismatch:

- the certificate's subject `O` is `APPLE_EXPECTED_ORG_NAME`, `OU` is
  `APPLE_TEAM_ID`, and `CN` is `Apple Distribution: <org> (<team>)`;
- the profile's `TeamName` and `TeamIdentifier[0]` match, its
  `application-identifier` is `<team>.<bundle id>`, it is an App Store profile
  (no devices, `get-task-allow` false) and it hasn't expired;
- the exported `.ipa` verifies, its first `codesign -dvv` `Authority` is
  `Apple Distribution: <org> (<team>)`, and it embeds the installed profile;
- the archived and exported `Info.plist` bundle id, version and build match the plan;
- no entry of `SIGNING_NAME_DENYLIST` appears in the certificate subject, the
  decoded profile, the `Authority` lines or the App Store Connect app, bundle id
  and certificate records (read-only, before the upload).

All of it goes to the run summary. Every value is checked against the
denylist before it is printed, and a hit prints the field's label only. Secret
values are never printed.

### The `testflight` environment

Restrict it to protected branches (`staging`) and add a required reviewer.
Values are never committed.

| Name | Kind | What goes in it |
| --- | --- | --- |
| `APP_STORE_CONNECT_API_KEY_ID` | secret | the API key's id (App Manager role) |
| `APP_STORE_CONNECT_API_ISSUER_ID` | secret | the issuer id |
| `APP_STORE_CONNECT_API_PRIVATE_KEY_BASE64` | secret | `base64 -i AuthKey_<id>.p8` |
| `APPLE_DISTRIBUTION_CERTIFICATE_BASE64` | secret | `base64 -i distribution.p12`: the team's Apple Distribution certificate and key |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | secret | the `.p12` password |
| `IOS_APPSTORE_PROFILE_BASE64` | secret | `base64 -i <profile>.mobileprovision`: the App Store profile for the `testnet` bundle id |
| `IOS_APPSTORE_PROFILE_BASE64_DEVNET`, `IOS_APPSTORE_PROFILE_BASE64_STAGING_TESTNET` | secret | the same for the `devnet` and `staging-testnet` records, needed only to run those variants |
| `APPLE_TEAM_ID` | variable | `44RJ69WHFF` |
| `APPLE_EXPECTED_ORG_NAME` | variable | `The Dash Foundation, Inc.` |
| `SIGNING_NAME_DENYLIST` | secret | optional; comma-separated names that must never appear in signing metadata. A secret, not a variable: run logs print variables unmasked, and the run refuses a variable-only denylist |
| `YAPPR_IOS_BUNDLE_ID` | variable | optional, `testnet` runs only; see below |
| `YAPPR_IOS_EXPORT_COMPLIANCE_CODE` | variable | optional, `testnet` runs only: the code of the app record's approved export compliance documentation (App Store Connect → App Information → App Encryption Documentation). Set, the build declares non-exempt encryption with that code; unset, each build answers compliance in App Store Connect |

**Bundle id fallback.** If the App Store record has to live under another id
(for example `org.dashfoundation.yappr.beta`), set `YAPPR_IOS_BUNDLE_ID` and
upload a profile for that id. The workflow applies it to `testnet` runs only. It changes the iOS bundle id only (Android keeps
the variant's package), must be reverse-DNS and may not be another variant's
id. The build records it in `extra.iosBundleId`, and `src/config.ts` accepts
that native id for the variant it was built for; the scheme, web links,
wallet return and engine stay the variant's.

### Running it

1. Dispatch from `staging` with `dry_run` on, approve the deployment, and
   read the gate's evidence in the run summary.
2. Dispatch again with `dry_run` off. If the build failed before the upload,
   start a new run rather than re-running it: a re-run keeps the run number,
   which is fine only if nothing was uploaded.
3. If the summary says Missing Compliance, answer it in App Store Connect as
   listed there: the app uses encryption, standard algorithms not provided by
   Apple (COMPLIANCE, Encryption export).
4. If the upload succeeded but a later step didn't (the summary shows the
   build id), don't upload again. In App Store Connect → TestFlight, open the
   build by version and build number, answer compliance if asked, add the What
   to Test notes, and add it to **Yappr Internal** (Internal Testing → the
   group → Builds → +).

The workflow file must also exist on the default branch for GitHub to offer
the dispatch; the run uses the `staging` copy.

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
| App Store Connect API key (`.p8`, key id, issuer id) | Upload and TestFlight setup, `eas submit` | `testflight` environment secrets, or EAS |
| Apple Distribution certificate and App Store profiles | Signing | `testflight` environment secrets, or EAS |
| Play Console organization account, developer verification | All Android distribution | Google |
| Android upload keystore and passwords | Signing AABs | Password manager; optionally GitHub secrets `ANDROID_UPLOAD_*` or EAS |
| Play service account JSON | Automated uploads | Password manager or EAS |
| EAS project id and `EXPO_TOKEN` | EAS builds (optional) | `app.config.ts` (public id), GitHub secret |
