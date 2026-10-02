# Yappr Mobile 1.0: agentic QA plan

- **Product:** Yappr native apps (React Native 0.86 / Expo SDK 57, hidden-WebView engine running the web's `lib/`), iOS + Android.
- **Candidate:** a release build of `staging` after the pending engine-perf PR merges (built by `bin/build-candidate staging` into `builds/<sha8>/`, linked as `builds/current`). Record the exact sha in every report.
- **Baseline:** none. 1.0 is greenfield, so every finding is "new in 1.0" (no regression vs pre-existing verdict). Where a defect could be web `lib/` behaviour, check yap.pr/devnet (sakura) in a browser and say so ("shared with web" vs "mobile only").
- **Specs (source of truth, read from the candidate worktree `builds/current/src/`):** `docs/mobile/PRD.md` (141 stories, section 7 global rules G-1..G-16), `docs/mobile/UX_SPEC.md` (screens, copy deck, deep links §3.5), `docs/mobile/EXECUTION.md` §7 (1.0 exit matrix), `docs/mobile/QA_RELEASE.md`, `mobile/CLAUDE.md`, `mobile/RELEASE.md`.
- **Workspace:** `/Users/pasta/workspace/yappr-mobile-qa/` (`env.sh`, `bin/`, `builds/`, `evidence/`, `site/`).

## 1. Environment

| Item | Value |
| --- | --- |
| Host | Mac, 14 cores, 48 GB. Shared with other agents' simulators/emulators: see section 9 (capacity) |
| iOS | Xcode 26.6, iOS 26.5 simulators "Yappr iPhone 17", "… L2", "… L3", "… L4" (+ spare "… (M4 host)") |
| Android | API 35 google_apis arm64 AVDs `yappr_pixel`, `_l2`, `_l3`, `_l4` (+ spare `_m4`), userdebug (adb root works), gesture navigation, TalkBack installed |
| Builds | `builds/current/{ios-devnet.app, ios-testnet.app, android-devnet.apk, android-testnet.apk}`, Release config, debug-signed APKs (same key for every candidate) |
| Variants | **devnet** `pr.yap.app.dev`, scheme `yappr-dev://`, network devnet **sakura** (Platform 5.0.0-beta.1), social **v11** topology, DM v5, DashPay profile + `yapprProfile`: read **and write** with personas 90–98. **testnet** `pr.yap.app.beta`, scheme `yappr-beta://`, production yap.pr contracts (topology v2, DM v3): **read-only, never write** |
| Personas | sakura pool `identities.json`, personas 90–99 reserved for mobile (99 = proof posts: key-entry sign-in only, never write). Each has ≈ 0.298 DASH in credits (29.8e9) and a DPNS name |
| Wallet | No wallet app on simulators. Key exchange is answered by the Node test-wallet responder (`bin/wallet-respond`, devnet only) from the sign-in QR code |
| Driver | `bin/qa` (Maestro 2.11 flows; idb fast path on iOS), `simctl`, `adb` |
| Moderation | sakura's social contract has an elected, seated team (E1: tess1999, alice7, bot1), so reports should be accepted. If refused, assert the "elects its moderation team" path (PRD M4) |
| Known network caveats | sakura DAPI uses Let's Encrypt IP certificates that **expire 2026-10-07**; the quorum service has had 4-quorum window outages. Record times of any DAPI/quorum error burst (E-09) so it can be told apart from app defects |

### Device streams

| Stream | Platform | Device | Theme | Personas | Partner (pairs for follow/DM) |
| --- | --- | --- | --- | --- | --- |
| L1i | iOS | 7E2918AC-42DF-45F3-86AE-8DCA092BE07B | light | 90 (+98 2nd account) | L1a |
| L1a | Android | emulator-5554 (`yappr_pixel`) | dark | 91 (+99 key-entry only, no writes) | L1i |
| L2i | iOS | 0BA11478-0F45-486B-9077-7F418A81647A | dark | 92 | L2a (93) |
| L2a | Android | emulator-5556 (`yappr_pixel_l2`) | light | 93 | L2i (92) |
| L3i | iOS | A6B5008C-C31B-4C2D-89BE-6CAADA46CE48 | light | 94 | L3a (95) |
| L3a | Android | emulator-5558 (`yappr_pixel_l3`) | dark | 95 | L3i (94) |
| L4i | iOS | A48BD1B8-856D-4D22-9576-14DC405FE330 | dark | 96 (+98 group member) | L4a (97) |
| L4a | Android | emulator-5560 (`yappr_pixel_l4`) | light | 97 | L4i (96) |
| SR | none | code reading of `builds/current/src/mobile/{app,engine}` | | | |
| SPi / SPa | spare iOS 0FB7985F… / emulator-5570 | SR-reproduction wave (phase 2) | | 98 | |

Serials can change when emulators restart: `qa stream <id> <cmd>` resolves them by AVD name. Themes alternate so that every lane pair covers iOS light + Android dark (L1, L3) or iOS dark + Android light (L2, L4).

### Persona rules

- 90–98: QA-usable on devnet. One stream owns each primary persona; nobody else writes with it (two devices writing with one identity at the same moment trips "Another write from your account went out at the same moment").
- 98: L1i's second account (account switching, E-06) and the third member of L4's group DM (it never needs a device for that).
- 99: L1a's second account for multi-account **reads only**; never sign it in through the wallet path (the responder writes) and never write with it.
- Pairs: L2 92↔93 (Following feed, replies), L3 94↔95 (follow, block, engagements, reports), L4 96↔97 (DMs, notifications), L1 90↔91 (multi-device sign-in checks).
- Clean up at the end: unblock what you blocked, delete test posts that would pollute other streams' feeds only if your stories don't need them as evidence (prefer leaving them; feeds are global and that is realistic).

## 2. Change areas and risk ranking

1.0 is greenfield: every area is new. Ranked by risk (impact × likelihood), which drives tier B and the static-review focus:

| Rank | Area | Why it is risky | Main stories | Static-review focus |
| --- | --- | --- | --- | --- |
| 1 | Sign-in, key handling and storage security | Keys in Keychain/Keystore, encrypted MMKV, key exchange crypto, redaction, reinstall wipe, app lock, screen privacy | AUTH-*, SET-02, SET-08, E-23..E-26 | `src/features/auth`, `src/engine/storage`, `redact.ts`, `modules/background-flush`, `plugins/release-hardening` |
| 2 | Write tickets and optimistic writes | Double send, lost writes, blind resend, unconfirmed (504) handling, retry only after proven absent, thread partial post | COMP-05, COMP-10, NET-04, NET-05, ENG-*, E-04, E-07, E-08 | `src/data/writes*`, engine `tickets`, `methods.ts` (write classification) |
| 3 | DMs (encryption, keys, state) | DM v5 groups, key recovery, state flush on background, plaintext persistence | DM-*, E-20 | engine DM modules, persistence opt-in, `pagehide` flush |
| 4 | Engine boot, supervisor, lifecycle | Boot queueing, crash restart, read replay only, 3-restart cap, foreground-only polling | NET-01, NET-04, NET-08, NET-09, FEED-11 | `src/engine/supervisor.ts`, `EngineHost.tsx`, `page.ts` |
| 5 | Feeds and paging | Cache-first launch, pill, 3-page auto cap, memory over 500 posts, Top windows | FEED-*, E-21 | feed queries, FlashList usage |
| 6 | Compose limits | 1000 chars + 2000 bytes, code points vs graphemes, hashtags/mentions inline rules, drafts | COMP-01..09, E-10, E-11 | counter vs `lib/compose/limits.ts` |
| 7 | Safety and blocking | Block propagation to caches, NSFW/media gates on every surface, reports | SAFE-*, G-6, G-14 | gates in `PostItem`, cache eviction on block |
| 8 | Settings and persistence | Device-wide vs per-account settings, sign-out wipe | SET-*, AUTH-11 | settings store, `clearAccountCache` |
| 9 | Deep links | Untrusted input, routing, never-from-outside screens | NET-11, POST-07, E-24 | `src/navigation/deep-links.ts` |
| 10 | Accessibility | Labels, hit targets, Dynamic Type 200%, RTL, Reduce Motion | A11Y-*, E-12, E-17, E-18 | testIDs, accessibilityLabel coverage |
| 11 | Performance | Cold start budgets, scroll, memory | M6–M8, E-21, E-22 | |

## 3. Test matrix (tiers)

- **Tier A:** the EXECUTION §7 exit-matrix scenarios (rows A1–A15). Each row must pass on iOS light, iOS dark, Android light and Android dark (A14/A15 light only). The owning lane runs it in its two cells; the **partner lane** runs a cross-theme smoke in the other two cells (L1↔L2, L3↔L4).
- **Tier B:** core-risk depth (failure paths, security, resilience) for the top risk areas.
- **Tier C:** data/write flows that touch the shared seams (profiles, DMs, follow/notify, threads).
- **Tier D:** secondary features (P1/P2 and gated extras).
- **Tier E:** accessibility stories plus the edge battery E-01..E-28 (offline, slow network, engine crash/restart, account switch mid-write, app kill mid-write, unconfirmed writes, sakura quorum errors, RTL, emoji/byte limits, 200 % text, dark mode, small screen, Android back/predictive back, keyboard, screen readers) and the static review.

Depth: **D** = every acceptance bullet of the story, evidence per bullet; **S** = smoke (main path, one screenshot, ui-text); **N/A** = impossible on that platform (reason given). Every P0 story is D on both platforms. Every story is exercised on both platforms at least at S, except the platform-impossible ones (NET-06 Android, NET-02 iOS).

Global rules G-1..G-16 are not stories but every stream checks them on the screens it visits (G-6 blocked authors, G-8 signed-out write controls, G-9 text, G-12 theme and type, G-13 formatting, G-16 accessibility).

### Story assignment (generated from `bin/lib/stories.py`; `STORY-MATRIX.md` has the same data)

<!-- STORIES -->

## 4. Execution model

1. **Build** (orchestrator): `bin/build-candidate staging` once the engine-perf PR merges. Smoke each artefact on the spare devices (launch, Diagnostics shows Engine Ready, network sakura/testnet).
2. **Install** (each stream, first step): `qa <plat> <dev> install builds/current/<artefact>` for both variants. The lane devices currently hold debug dev clients signed differently, so Android needs `--replace` once (this wipes app data, which is what we want: a fresh install).
3. **Wave 1, in parallel:** 8 device streams (time budget 3–4 h each) + the static-review stream SR (~3 h, no device). Order inside each stream: setup → Tier A own rows → B → C → D → its E items → cross-theme smoke for the partner's A rows → report. Start long waits first (key registration takes up to a minute; DM state restore; write confirmations).
4. **Merge** (orchestrator): dedupe into `DEFECT-LEDGER.md`, fill `STORY-MATRIX.md`, append harness notes to `AGENT-BRIEF.md`.
5. **Wave 2:** SR-reproduction on the spare devices (SPi, SPa) per `SR-REPRO-BRIEF` in the skill, plus targeted follow-ups for any S1/S2.
6. **Report:** `EXEC-SUMMARY.md`, `QA-REPORT.md`, `bin/build-site` → `site/` (publish only after the redaction decision).

Coordination rules: one stream = one device = one theme. Never touch another stream's device, never kill shared processes (Metro, emulators, the responder server), never rebuild. The responder server is started once by the orchestrator (`wallet-respond --serve`); streams call `wallet-respond <persona> --from <plat> <dev>`.

### Cross-theme smoke (partner rows)

| Lane | Runs a smoke of these rows in its own theme | Because it owns |
| --- | --- | --- |
| L1 (iOS light, Android dark) | L2's A rows: A4, A5, A6, A1 feed/thread parts, A15 offline | L2 owns them in iOS dark / Android light |
| L2 (iOS dark, Android light) | L1's A rows: A1 welcome/sign-in parts, A2, A3, A13, A14, A15 engine kill | L1 owns them in iOS light / Android dark |
| L3 (iOS light, Android dark) | L4's A rows: A10, A11, A13 settings parts | L4 owns them in iOS dark / Android light |
| L4 (iOS dark, Android light) | L3's A rows: A1 profile/explore parts, A7, A8, A9, A12 | L3 owns them in iOS light / Android dark |

Budget ~30–45 min; one screenshot per screen in the row, plus ui-text; writes stay on the stream's own persona.

## 5. Severity scale

| Sev | Meaning | QA_RELEASE gate |
| --- | --- | --- |
| **S1** | Key or credential exposure, data or write lost, duplicate paid write, security bypass (lock, deep link into a secret screen), crash on launch or crash loop, sign-in impossible, a flow that never finishes | P0 (0 allowed at every gate) |
| **S2** | Needs user action to recover (reinstall, clear data), wrong data shown (stale account after switch, wrong counts persisting), privacy leak (DM plaintext persisted, media fetched against the gate), memory kill, core flow broken without workaround | P1 |
| **S3** | Flow bug with a workaround, wrong or missing copy that misleads, gating wrong, layout broken on one platform/theme/text size | P2 |
| **S4** | Cosmetic, spacing, log noise, copy nits | P2 (triaged) |

Every defect says: platforms seen on, variant, theme, whether it is mobile-only or shared with web (check yap.pr/devnet), and S-level. ENV rows (harness, emulator, network outages) are separate and never count as product defects.

## 6. ID ranges

| Stream | Defects | Env problems |
| --- | --- | --- |
| L1i / L1a | D-L1i-001… / D-L1a-001… | ENV-L1i-01… / ENV-L1a-01… |
| L2i / L2a | D-L2i-001… / D-L2a-001… | ENV-L2i-01… / ENV-L2a-01… |
| L3i / L3a | D-L3i-001… / D-L3a-001… | ENV-L3i-01… / ENV-L3a-01… |
| L4i / L4a | D-L4i-001… / D-L4a-001… | ENV-L4i-01… / ENV-L4a-01… |
| Static review | SR-01… | |
| SR reproduction | updates SR rows; new findings D-RPi-001… / D-RPa-001… | ENV-RP-01… |

At merge the orchestrator assigns consolidated ids D-001… in `DEFECT-LEDGER.md` and keeps the stream ids in a "seen as" column.

## 7. Evidence conventions

- `evidence/<stream>/<test-id>/NN-description.png` (+ `.mp4`, `.txt`, `ui-*.txt`), e.g. `evidence/L2a/COMP-05/03-posting-2-of-5.png`. Test ids are story ids, exit rows (`A6`), edge ids (`E-08`) or `XTHEME-A4`.
- Video for every write flow that can lose or duplicate data (COMP-05, COMP-10, E-04, E-07, E-08, DM-04, DM-14) and for sign-in.
- Logs for the whole session (`qa logs-start evidence/<stream>/logs`), `pull-logs` after each test and after any crash, `crash-info` after a crash.
- On Android, FLAG_SECURE screens (app lock on: everything; always: DM inbox, conversations, group info, key sign-in, DM unlock) capture **black by design**: save `ui-text` there and say so in the report.

## 8. Exit criteria for this QA pass

- Every story has a verdict on both platforms (PASS / PASS+ / FAIL / BLOCKED / N/A) with proof paths.
- Every Tier A row has evidence in all four cells (two for A14/A15).
- Every S1/S2 is reproduced twice (or reproduced by a second stream) with logs.
- SR items have a REPRODUCED / PARTIAL / NOT REPRODUCED / BLOCKED verdict after wave 2.

## 9. Capacity and known harness limits

- **Host load.** With 5 emulators + 5 booted simulators + other agents, the load average sat at 50–100 on 14 cores during harness testing; Maestro calls took 20 s – 3 min, and the spare emulator's Android watchdog killed `system_server` (`*** WATCHDOG KILLING SYSTEM PROCESS: Blocked … for 90s`), so `cmd settings/activity/uimode` failed for minutes. Before wave 1: shut down the spare M4 emulator and simulator (not needed until wave 2), exclude the workspace from Spotlight (done: `.metadata_never_index`), and consider running 3 Android streams at a time, or giving each AVD more cores. Streams must check `adb shell service check activity` before blaming the app.
- **iOS Simulator cannot go offline per device** (host network): offline/stall cases run on Android; iOS cells are BLOCKED(env).
- **No VoiceOver on the simulator**: iOS screen-reader checks are label audits (`qa ios … ui-text`).
- **Android Maestro typing is ASCII-only**: Unicode/RTL/emoji compose runs on iOS.
- **Clipboard on Android is unreadable from adb**: read Diagnostics with `ui-text`.
- **Lockdown Mode** needs a physical iPhone: NET-06 is BLOCKED(env) unless one is provided.
- **https://yap.pr links** need the app-link association files (OQ-8): expected to open the browser/fail to resolve in 1.0; record what happens.
- **System dialogs**: under load Android shows "… isn't responding" (Wait / Close app); tap "Wait" (`qa android <dev> tap-text Wait`) and file ENV, not a defect, unless it names a Yappr process.
