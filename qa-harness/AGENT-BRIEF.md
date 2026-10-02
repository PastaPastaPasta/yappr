# QA agent briefing: Yappr Mobile 1.0 (read fully before touching a device)

You are one of 8 parallel QA agents testing the **Yappr native apps 1.0** (iOS + Android, React Native/Expo,
a hidden-WebView "engine" that runs the web app's `lib/` against Dash Platform). Everything is new in 1.0: there is
no baseline build, so every finding is a 1.0 defect. You own exactly **ONE device and ONE theme** (your row in
QA-PLAN §1). Never touch another device, never kill shared processes (emulators, simulators, Metro, the responder
server), never rebuild, never change source code. Devnet ("sakura") is the write network, with your personas only.
**Testnet is READ-ONLY: never post, like, follow, block, report, message or save a profile on the testnet build.**

Your stream id, device, theme, personas, story list, edge items and time budget are in your launch prompt and in
`QA-PLAN.md` §1/§3. The specs are in the candidate worktree: `$QA_BUILD/src/docs/mobile/PRD.md` (story acceptance
bullets + global rules G-1..G-16), `UX_SPEC.md` (screens, exact copy, deep links §3.5), `EXECUTION.md` §7.

## Setup, every shell

All device commands need `dangerouslyDisableSandbox: true`.

```bash
source /Users/pasta/workspace/yappr-mobile-qa/env.sh
cat $QA_ROOT/bin/qa            # once: every subcommand is documented at the top
qa devices                     # stream table + live state
Q="qa stream L2a"              # your stream (resolves the Android serial by AVD name); then: $Q screenshot …
E=$QA_EVIDENCE/L2a; mkdir -p $E
```

Shells are zsh: write `$=Q` or use `bash -c '…'` if you put the platform and device in one variable (zsh does not
word-split `$Q`). Simplest is to spell it out: `qa android emulator-5556 tap-id compose-fab`.

Builds (Release config, no Metro, no dev menu): `$QA_IOS_DEVNET_APP`, `$QA_IOS_TESTNET_APP`, `$QA_ANDROID_DEVNET_APK`,
`$QA_ANDROID_TESTNET_APK` (`builds/current/BUILD-INFO.md` has the sha; put it in your report header).

First steps of every stream:

```bash
# iOS
qa ios <udid> install $QA_IOS_DEVNET_APP;  qa ios <udid> install $QA_IOS_TESTNET_APP
qa ios <udid> clear-data devnet;  qa ios <udid> clear-data testnet        # fresh state: dev-client data and the Keychain go
# Android (--replace: the lane devices hold debug dev clients with another signature; uninstalling wipes data = fresh install)
qa android <serial> install $QA_ANDROID_DEVNET_APK --replace;  qa android <serial> install $QA_ANDROID_TESTNET_APK --replace
qa <plat> <dev> appearance <your theme>
qa <plat> <dev> logs-start $E/logs
qa <plat> <dev> memory devnet --watch 60 240 --out $E/memory.csv &   # 4 h of 1-min samples, in the background
qa <plat> <dev> launch devnet --fresh
qa <plat> <dev> screenshot $E/setup/01-first-launch.png
```

## Driving the UI

- **Read the screen with `qa … ui-text`** (id | text | a11y label | bounds | flags). On iOS RN text shows up in
  the a11y-label column, and tab buttons read "Profile, tab, 5 of 5". Save dumps as evidence: `qa … ui-text $E/<test>/NN-ui.txt`.
- **Tap by testID first** (`qa … tap-id compose-fab`): stable ids exist for nearly every control (A11Y-08). Common ones:
  `welcome-sign-in`, `welcome-browse`, `network-chip`, `home-tabs`, `home-sort`, `home-window`, `new-posts-pill`,
  `feed-load-more`, `compose-fab`, `compose-input-0`, `compose-post`, `compose-close`, `compose-nsfw`, `compose-add-part`,
  `compose-counter`, `write-status`, `post-card-<id>`, `like-btn-<id>`, `repost-btn-<id>`, `reply-btn-<id>`,
  `bookmark-btn-<id>`, `share-btn-<id>`, `more-menu-<id>`, `profile-follow`, `profile-menu`, `profile-message`,
  `profile-settings`, `settings-diagnostics`, `settings-account`, `account-sign-out`, `account-switcher`, `accounts-add`,
  `app-lock-switch`, `sign-in-other-ways`, `sign-in-private-key`, `key-input`, `key-found`, `key-sign-in`,
  `sign-in-other-device`, `kx-qr`, `kx-copy-link`, `kx-register-qr`, `kx-finishing`, `terms-agree`, `terms-not-now`,
  `messages-new`, `dm-composer`, `dm-send`, `dm-unlock-key`, `dm-unlock-save`, `notifications-mark-all`,
  `notifications-filters`, `block-confirm`, `block-note`, `report-reason`, `report-submit`, `toast`, `offline-banner`.
  The full list: `grep -rhoE "testID=\{?[\"'\`][^\"'\`]+" $QA_BUILD/src/mobile/app/src | sort -u`.
- **Tap by text** when there is no id: `qa … tap-text "Sign in"` (exact), `--contains`, `--regex`, `--index n`.
- **Type:** focus the field (tap it) then `qa … type "text"`. Android typing is **ASCII only** (Maestro limit): do
  emoji/CJK/RTL text on iOS. Avoid `${` in typed text (Maestro evaluates it).
- **Wait, never assume:** `qa … wait-for-text "Post created successfully!" 60 --contains`, `wait-for-id write-status 30`,
  `wait-gone-text "Posting…" 120`. Screenshot every time something changes.
- **Back:** Android `qa … back` (BACK key) and `back-gesture` (predictive back). iOS `back` taps the native back
  button or edge-swipes; modals (compose, sign-in, sheets) close with their close control (`compose-close`,
  `modal-close`, `sheet-close`, `sign-in-close`, `media-close`) or `qa … swipe down`.
- **Menus:** long-press a card (`long-press-id post-card-<id>`) or tap `more-menu-<id>`. iOS shows a native context
  menu, Android a bottom sheet (`action-sheet-<label>` ids).
- **Speed:** each Maestro step takes 10–60 s on this loaded host (idb on iOS is ~1 s for ui-text/tap/type). Batch your
  reading: one `ui-text` per screen, not one per element.
- **Engine state in a release build:** the dev-only diagnostics extras (quick sign-in, debug calls, kx-uri text) are
  compiled out, but **Settings → Engine diagnostics exists in release** (Profile tab → `profile-settings` (gear) →
  `settings-diagnostics`; signed out: Profile tab → Settings links; or `qa … open-url yappr-dev://settings` then tap
  "Engine diagnostics"). It shows engine state (Booting/Ready/Restarting/Unavailable), epoch/restarts, queued calls,
  boot timings (prepare, mount→hello, boot, mount→ready, first call), network, evo-sdk, bundle hash, topology, contract
  ids, WebView caps, storage counts and the **last 100 engine log lines** (scroll down). "Copy diagnostics" copies
  status + the last 200 redacted log lines: on iOS `qa ios <udid> clipboard-get $E/<test>/diagnostics.txt`; on
  Android adb cannot read the clipboard, so save `ui-text` of the screen (scroll for the logs). "Restart engine",
  "Clear cache" and "Reset devnet data" are destructive (confirmations): use them only in your assigned tests.
- **Deep links:** `qa … open-url "yappr-dev://post?id=<id>"`. Release builds accept only web-form routes (`/post?id=`,
  `/user?id=`, `/hashtag?tag=`, `/search?q=`, `/settings?section=account|notifications|privacy|appearance|about`,
  `/messages`, `/bookmarks`, `/explore`, `/notifications`) and validated path forms (`/post/<id>`, `/user/<id>`,
  `/hashtag/<tag>`, `/messages/<id>`). Sign-in, compose, media, gates and app-lock screens are never reachable by link
  (that is a test, E-24). `https://yap.pr/...` links are not associated yet (OQ-8): record the behaviour, it is not a defect.

## Signing in (devnet)

Personas: `bin/persona-key <idx> <file>` writes a key to a 0600 file **without printing it**. Keep key files in
`$QA_PERSONAS/` (never in evidence/, never published).

```bash
persona-key 92 $QA_PERSONAS/p92-auth.wif                         # AUTHENTICATION/HIGH (keyId 2), WIF
persona-key 92 $QA_PERSONAS/p92-auth.hex --format hex            # same key as 64 hex chars (AUTH-08 hex case)
persona-key 92 $QA_PERSONAS/p92-crit.wif --purpose critical      # AUTHENTICATION/CRITICAL (keyId 1)
persona-key 92 $QA_PERSONAS/p92-enc.wif --purpose encryption     # ENCRYPTION/MEDIUM: "Unlock your messages" (DM-02)
```

**A. Private key (fastest, AUTH-08):** Profile tab (or any write control) → Sign in → `sign-in-other-ways` →
`sign-in-private-key` → tap `key-input` → `qa … type-secret-from-file $QA_PERSONAS/p92-auth.wif` → wait for
`key-found` ("Identity found: …") → `key-sign-in` → "Before you start" (`terms-gate`) → `terms-agree` → Home.
- Never tap "Show key" with a real key on screen and never save a screenshot or ui-text while a real key is revealed.
  Test show/hide, invalid key, wrong network and "no identity" with **fake** values typed with `type`
  (e.g. `cNotARealKeyXXXX…`, 64 hex zeros).
- The key screen is FLAG_SECURE on Android: screenshots are black; use ui-text.

**B. Wallet key exchange (AUTH-03/04/06) with the test-wallet responder** (`bin/wallet-respond`, devnet only; the
orchestrator keeps one server running: `wallet-respond --health` should print `{"ok":true}`):
1. Sign in → "Open wallet" (`sign-in-open-wallet`): there is no wallet app on simulators/emulators, so this should
   show the AUTH-05 "no wallet" explanation. Screenshot it (that is AUTH-05 evidence).
2. "Use a wallet on another device" (`sign-in-other-device`) → QR (`kx-qr`). Answer it:
   `wallet-respond 92 --from <plat> <dev>` (screenshots the device, decodes the QR, publishes the persona's
   loginKeyResponse). Alternative on iOS: tap `kx-copy-link`, then `qa ios <udid> clipboard-get` gives the `dash-key:` URI
   and `wallet-respond 92 '<uri>'` answers it.
3. The app polls and shows "Wallet approved. Unlocking your keys" → "Checking your identity". The first time a persona
   signs in this way it needs key registration: "First time login" with a `dash-st:` QR (`kx-register-qr`). Run
   `wallet-respond 92 --from <plat> <dev>` again (signs the IdentityUpdate with MASTER and broadcasts) and wait for
   `kx-finishing` to finish (up to a minute; "Still confirming" after 60 s is expected behaviour, not a failure).
4. EULA → Home. A later re-login of the same persona needs only step 2.
- The responder refuses any request whose `n=` is not devnet. Never try to answer a testnet request.
- Each answer is a paid write by the persona. Do it for your persona only, and not in a loop.
- **App lock (AUTH-12)**: iOS `qa ios <udid> biometric enroll` then `biometric match|nomatch` at the prompt. Android:
  `qa android <serial> biometric enroll` (sets PIN 1111, opens fingerprint enrolment; finish with tap-text + repeated
  `biometric match`), then `biometric match` at the prompt. With app lock on, Android FLAG_SECURE is app-wide: every
  screenshot is black, use ui-text. Turn app lock off at the end of the test.

**Testnet build:** browse signed out. Key-entry sign-in on testnet is allowed only if the orchestrator gives you a
testnet identity (none is provisioned); in any case never write there.

## Evidence discipline (non-negotiable)

- Evidence dir: `$QA_EVIDENCE/<stream>/<test-id>/NN-description.png` (`.mp4`, `.txt`, `NN-ui.txt`). Test ids: story
  ids (`COMP-05`), exit rows (`A6`), edge ids (`E-08`), cross-theme smoke `XTHEME-A4`.
- Screenshot EVERY named step. Record video (`record-start/record-stop`) for every write that can be lost or
  duplicated (post, thread, reply, like/repost toggles under faults, DM send, kill/crash tests) and for sign-in.
- Logs: one capture for the whole session (`logs-start`), `qa … pull-logs $E/<test>` after each test and after any
  crash; `qa … crash-info devnet $E/<test>` after a crash or unexpected exit. Keep `memory.csv` running.
- Save the exact command output that proves a claim as a `.txt` next to the screenshots (greps, ui-text, timings).
- **Secrets:** before finishing, prove no persona key leaked: `grep -rcF -f $QA_PERSONAS/p92-auth.wif $E` must print
  only `:0` counts (E-25). Never `cat` a key file; never paste a key into a report.
- **FLAG_SECURE:** on Android the DM inbox, conversations, group info, the key sign-in screen and the DM unlock sheet
  are always FLAG_SECURE, and every screen is while app lock is on: screenshots there are BLACK by design. Save
  `ui-text` (or `ui-dump`) as the evidence and say "FLAG_SECURE: ui-text evidence" in the report. iOS simulator
  screenshots still capture those screens (the app only hides content in the app switcher on iOS).
- A claim without a file path is not a result. Never fabricate. If you could not observe something, write BLOCKED and
  why. If an expected value disagrees with what you see, check an independent source first (yap.pr/devnet in the
  browser shows the same sakura data; Settings → Account shows balances) before calling it a failure.
- Keep `$E/notes.md` as a running, timestamped journal so nothing is lost if you are cut off.

## What to check on every screen you visit (global rules)

G-1 offline banner/toast (Android only), G-2 boot states, G-3/G-4 write status and rollback, G-6 blocked authors
vanish everywhere, G-7 stubs not blanks, G-8 signed-out write controls open sign-in and return to the same place
without performing the action (compose keeps its text), G-9 text (line breaks, long words, RTL, emoji intact,
tappable links/@/#/$), G-11 read errors with "Try again", G-12 your theme + one pass at 200 % text, G-13 time and
count formats, G-14 NSFW/media gates on every surface, G-16 labels and hit targets. Compare copy with UX_SPEC §5
(copy deck): wrong copy that misleads is S3, a typo is S4.

## Shared fixtures and limits

- Personas 90–98: your own only (QA-PLAN §1). 99 = read-only (proof posts), key-entry sign-in only.
- Feeds, hashtags, notifications and search are global: other streams' test posts appear in your feed. Prefix every
  post you write with your stream id and a timestamp, e.g. `[L2a 0912] thread part 1`, so evidence is unambiguous and
  others can ignore it.
- Pair work (follow, block, DM, notifications) is with your lane partner's persona. Coordinate through
  `$QA_EVIDENCE/<lane>-pair.md` (append-only, timestamped lines: "L4i 09:12 sent DM 'ping 1' to 97, waiting").
- Do not change device-global settings you don't restore: put back font scale, locale, contrast, reduce motion,
  appearance (your theme), network, screen size and TalkBack after each test.
- Credits: each persona has ≈ 0.298 DASH of credits. Don't loop writes. Insufficient-credit tests (G-5) are BLOCKED
  unless the orchestrator provides a drained identity.

## Reporting

Write `$QA_EVIDENCE/<stream>/REPORT.md` from `REPORT-TEMPLATE.md`. Defect ids: `D-<stream>-NNN` (e.g. D-L2a-001),
environment problems `ENV-<stream>-NN`. If you cannot write REPORT.md, put the full report in your final message.
Your final message to the orchestrator: the summary table, the defects table, BLOCKED items, harness notes, paths.

Severity: **S1** key/credential exposure, write lost or duplicated, security bypass, crash on launch / crash loop,
sign-in impossible, never finishes · **S2** needs reinstall/clear data to recover, wrong data persists (stale account,
wrong counts), privacy leak, memory kill, core flow broken without workaround · **S3** flow bug with a workaround,
misleading copy, wrong gating, layout broken in one platform/theme/text size · **S4** cosmetic. Say for each defect:
platforms, variant, theme, mobile-only vs shared with web (check yap.pr/devnet), repro steps, evidence paths, and
the suspected file:line if you looked (`$QA_BUILD/src/mobile/app/src`, `$QA_BUILD/src/mobile/engine/src`).

## Useful log patterns

```bash
qa <plat> <dev> grep-log 'error|exception|fatal|unhandled|ANR|crash'
qa <plat> <dev> grep-log 'WebProcessProxy::processDidTerminate|onRenderProcessGone|renderer.*(gone|crash)'   # engine process death
qa <plat> <dev> grep-log 'ReactNativeJS'          # Android JS console (release builds keep warn/error)
qa <plat> <dev> grep-log 'chromium|CONSOLE'       # Android WebView console, if forwarded
qa <plat> <dev> grep-log 'FATAL EXCEPTION|AndroidRuntime|SIGSEGV|libc'
qa <plat> <dev> grep-log 'WATCHDOG|Low on memory|lowmemorykiller'                     # emulator health (ENV, not app)
```

Inside the app: Engine diagnostics "Recent logs" (last 100 lines) and "Copy diagnostics" (200 lines) carry the
engine's own redacted logs (supervisor restarts, boot, write tickets, DAPI errors). Grab them after every failure.

## Harness notes (from harness testing, 2026-10-02)

- **Host load is the main risk.** Load average 50–100 on 14 cores; Maestro steps took 10 s – 3 min; the spare
  emulator's watchdog killed `system_server` twice, after which every `cmd settings/activity/uimode` and app launch
  failed for minutes (`Can't find service: activity`). Before blaming the app, run
  `adb -s <serial> shell service check activity` (must say `found`) and check `uptime`. File ENV, wait, retry.
- Android shows "Pixel Launcher isn't responding" (and similar) dialogs under load: `qa android <dev> tap-text Wait`.
  It's an ENV problem unless the dialog names a Yappr process (`pr.yap.app.*`), which is a defect (ANR).
- `qa … launch` resolves the launcher activity per package (release and dev builds differ); Android prints launch
  `TotalTime` (ms), useful for E-22.
- iOS `hide-keyboard` can fail when the keyboard has no dismiss key: tap a static element instead.
- `qa … engine-kill` on Android needs `adb root`, which restarts adbd (qa restarts your logcat capture automatically)
  and kills every WebView renderer on the device. iOS kills only this simulator's WebContent processes; WebKit logs
  `processDidTerminate … reason=Crash` and a new WebContent starts.
- `qa … network` is Android only. `off` disables wifi+data, `airplane`, `slow`/`edge` shape the emulator link,
  `stall`/`unstall` drop only the app's packets (root) so the OS still reports online (DAPI-down simulation, NET-03,
  unconfirmed-write E-08). Always `network on` / `unstall` afterwards.
- Another agent may reinstall dev clients on the spare devices; the lane devices are yours for the run.

- Android `record-start` records at 720x1600 into `/data/local/tmp` (native 1080x2400 fails with codec error -38;
  `/sdcard` breaks with "Transport endpoint is not connected" after a `system_server` restart). A static screen makes
  few frames, so a short clip of an idle screen can be tiny; that's fine.
- iOS `ui-text` uses idb: RN text appears in the **label** column, tab buttons are "Home, tab, 1 of 5", and containers
  marked accessible hide their children (use `ui-text --maestro` for the full tree, slower). `tap-text "Profile"` will
  not match the tab on iOS: use `tap-text "Profile, tab" --contains`.
- `type` on iOS: ASCII goes through idb (fast); emoji/Arabic/CJK go through Maestro (slow but works, verified with
  "Wallpaper ✓ مرحبا 👍"). On Android `type` refuses non-ASCII with exit 3.
- `type-secret-from-file` keeps the key out of argv, stdout and Maestro's debug output (the temp flow + debug dir are
  deleted). Verified: no copy of the typed value under `~/.maestro` or `.state/`. The value is of course visible in
  `ui-text` if the field is not secure or "Show key" is on: don't dump the screen then.
- Exit codes: 0 ok, 1 failure (Maestro tail printed, flow kept under `.state/<device>/flow.*`), 2 usage, 3 BLOCKED
  (capability impossible on this platform: iOS network/talkback/screen size, Android clipboard/non-ASCII typing).
- `qa ios … clear-data` resets the **whole simulator Keychain** (both variants) unless `--keep-keychain`.

<!-- The orchestrator appends "Harness notes from <stream>" below as reports arrive. -->
