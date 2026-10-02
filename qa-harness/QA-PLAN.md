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

#### L1: Onboarding, sign-in, accounts, security, engine lifecycle, deep links

| Tier | Story | Pri | L1i | L1a | Note |
| --- | --- | --- | --- | --- | --- |
| A (A1) | AUTH-01 Welcome | P0 | D | D |  |
| A (A1) | AUTH-02 Browse signed out | P0 | D | D |  |
| A (A2) | AUTH-03 Sign in with a wallet on this phone | P0 | D | D | key exchange via bin/wallet-respond (QR path; release builds show no dash-key: text) |
| A (A2) | AUTH-04 Sign in with a wallet on another device | P0 | D | D | key exchange via bin/wallet-respond (QR path; release builds show no dash-key: text) |
| A (A2) | AUTH-06 First-time key registration | P0 | D | D | key exchange via bin/wallet-respond (QR path; release builds show no dash-key: text) |
| A (A2) | AUTH-08 Sign in with a private key | P0 | D | D | key exchange via bin/wallet-respond (QR path; release builds show no dash-key: text) |
| A (A3) | AUTH-09 Accept the terms and community rules | P0 | D | D |  |
| A (A2) | AUTH-10 Multiple accounts | P0 | D | D | key exchange via bin/wallet-respond (QR path; release builds show no dash-key: text) |
| A (A2) | AUTH-11 Sign out | P0 | D | D | key exchange via bin/wallet-respond (QR path; release builds show no dash-key: text) |
| A (A15) | NET-04 Engine restart | P0 | D | D | qa engine-kill; 3 kills in 2 min -> 'Couldn't connect' |
| A (A3) | NET-06 Lockdown Mode | P0 | D | N/A | iOS only. Needs Lockdown Mode (physical iPhone + TestFlight); the release build has no simulate switch -> BLOCKED(env) on simulator unless a device is provided |
| A (A14) | NET-11 Deep links | P0 | D | D | cold + warm; https links expected unresolved until OQ-8 association files ship |
| A (A14) | POST-07 Open posts from links | P0 | D | D | cold + warm; https links expected unresolved until OQ-8 association files ship |
| A (A13) | SET-01 Settings root | P0 | D | D |  |
| A (A13) | SET-02 Account | P0 | D | D |  |
| A (A13) | SET-06 About | P0 | D | D |  |
| A (A13) | SET-07 Terms and privacy | P0 | D | D |  |
| A (A13) | SET-08 Engine diagnostics | P0 | D | D | Copy diagnostics: iOS clipboard-get; Android read the screen with ui-text |
| B | AUTH-05 No wallet installed | P0 | D | D |  |
| B | AUTH-07 Sign-in failures | P0 | D | D |  |
| B | AUTH-12 Biometric app lock | P0 | D | D |  |
| B | AUTH-14 Session expired or key revoked | P1 | D | D |  |
| B | NET-01 Engine boot | P0 | D | D |  |
| B | NET-09 Capabilities | P0 | D | D |  |
| D | AUTH-15 No profile, no username | P1 | D | S |  |
| D | NET-07 Network chip | P0 | D | D |  |
| D | NET-08 Foreground only | P0 | D | D |  |
| D | NET-10 App out of date | P1 | S | D | only reachable if sakura refuses a write as out of date; else BLOCKED(no trigger) |
| E | AUTH-13 App Connect (flagged off) | P2 | S | S | assert App Connect is ABSENT everywhere (flag off) |

#### L2: Feeds, post detail and threads, compose, write status

| Tier | Story | Pri | L2i | L2a | Note |
| --- | --- | --- | --- | --- | --- |
| A (A6) | COMP-01 Write a post | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-02 Character and byte counter | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-03 Reply | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-04 Quote | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-05 Threads | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-06 Mention autocomplete | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-07 Hashtags and cashtags | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-08 NSFW flag | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-09 Drafts persist | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A6) | COMP-10 Write status | P0 | D | D | Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android) |
| A (A4) | FEED-01 For You | P0 | D | D |  |
| A (A4) | FEED-02 Following | P0 | D | D |  |
| A (A4) | FEED-04 Top sort | P0 | D | D |  |
| A (A4) | FEED-05 New posts pill | P0 | D | D |  |
| A (A4) | FEED-06 Pull to refresh | P0 | D | D |  |
| A (A4) | FEED-07 Infinite scroll | P0 | D | D |  |
| A (A15) | NET-02 Offline | P0 | N/A | D | iOS Simulator cannot go offline per device (host network) -> BLOCKED(env) on iOS |
| A (A1) | POST-01 Open a post | P0 | D | D |  |
| A (A5) | POST-02 Replies | P0 | D | D |  |
| A (A5) | POST-04 Removed and deleted stubs | P0 | D | D |  |
| A (A5) | POST-05 Thread whose root is gone | P0 | D | D | dev only; needs a deleted root: L2 deletes its own root after replies |
| A (A5) | POST-06 Engagements | P0 | D | D |  |
| B | COMP-11 Disabled reasons | P0 | D | D | NET-03/NET-05 fault injection: Android `qa network stall`; iOS BLOCKED(env) for the offline/stall parts |
| B | FEED-11 Cache-first launch | P0 | D | D | NET-03/NET-05 fault injection: Android `qa network stall`; iOS BLOCKED(env) for the offline/stall parts |
| B | NET-03 Dash Platform unavailable | P0 | D | D | NET-03/NET-05 fault injection: Android `qa network stall`; iOS BLOCKED(env) for the offline/stall parts |
| B | NET-05 Unconfirmed writes | P0 | D | D | NET-03/NET-05 fault injection: Android `qa network stall`; iOS BLOCKED(env) for the offline/stall parts |
| C | COMP-12 Keyboard and input | P1 | D | S |  |
| C | FEED-08 Reposts and quotes in feeds | P0 | D | D |  |
| C | FEED-09 Post card interactions | P0 | D | D |  |
| C | FEED-12 Media and link previews | P0 | D | D |  |
| C | POST-03 Reply context | P0 | D | D |  |
| C | POST-10 Reply from the detail screen | P1 | D | S |  |
| D | COMP-13 Cost hint | P2 | S | D |  |
| D | FEED-03 Remember tab and sort | P1 | S | D |  |
| D | FEED-10 Feed language | P2 | D | S | testnet build only (v2): read-only, change feed language and observe |
| D | POST-08 Private post placeholder | P0 | D | D | needs a private post / poll on sakura; search corpus first |
| D | POST-09 Polls (read-only) | P0 | D | D | needs a private post / poll on sakura; search corpus first |

#### L3: Engagement, profiles, explore, safety

| Tier | Story | Pri | L3i | L3a | Note |
| --- | --- | --- | --- | --- | --- |
| A (A7) | ENG-01 Like | P0 | D | D |  |
| A (A7) | ENG-02 Repost and quote menu | P0 | D | D |  |
| A (A7) | ENG-03 Bookmark | P0 | D | D |  |
| A (A7) | ENG-04 Bookmarks screen | P0 | D | D |  |
| A (A7) | ENG-05 Share | P0 | D | D |  |
| A (A7) | ENG-06 Delete my post or reply | P0 | D | D |  |
| A (A1) | EXPL-01 Explore tab | P0 | D | D |  |
| A (A9) | EXPL-02 Trending hashtags | P0 | D | D |  |
| A (A9) | EXPL-03 Top posts | P0 | D | D |  |
| A (A9) | EXPL-04 Top creators | P0 | D | D |  |
| A (A9) | EXPL-05 Search | P0 | D | D |  |
| A (A9) | EXPL-07 Hashtag page | P0 | D | D |  |
| A (A1) | PROF-01 View a profile | P0 | D | D |  |
| A (A8) | PROF-02 Profile tabs | P0 | D | D |  |
| A (A8) | PROF-03 Follow and unfollow | P0 | D | D |  |
| A (A8) | PROF-04 Followers and following lists | P0 | D | D |  |
| A (A8) | PROF-06 Edit profile (v2) | P0 | D | D | testnet (v2): form, counters and validation only; NEVER tap Save on testnet |
| A (A8) | PROF-07 Edit profile (dev) | P0 | D | D |  |
| A (A8) | PROF-08 Avatar | P0 | D | D |  |
| A (A12) | SAFE-01 Block someone | P0 | D | D | SAFE-04: sakura has a seated team (E1); if it refuses, assert the 'elects its moderation team' path |
| A (A12) | SAFE-02 Unblock | P0 | D | D | SAFE-04: sakura has a seated team (E1); if it refuses, assert the 'elects its moderation team' path |
| A (A12) | SAFE-03 Blocked accounts list | P0 | D | D | SAFE-04: sakura has a seated team (E1); if it refuses, assert the 'elects its moderation team' path |
| A (A12) | SAFE-04 Report a post or reply | P0 | D | D | SAFE-04: sakura has a seated team (E1); if it refuses, assert the 'elects its moderation team' path |
| A (A12) | SAFE-06 NSFW gate | P0 | D | D | SAFE-04: sakura has a seated team (E1); if it refuses, assert the 'elects its moderation team' path |
| A (A12) | SAFE-07 Media from people you don't follow | P0 | D | D | SAFE-04: sakura has a seated team (E1); if it refuses, assert the 'elects its moderation team' path |
| B | ENG-07 Counts and action bar | P0 | D | D |  |
| B | ENG-08 Context menu | P0 | D | D |  |
| C | PROF-09 Message from a profile | P0 | D | D |  |
| C | PROF-11 Blocked profile | P0 | D | D |  |
| C | PROF-13 Profile menu (others) | P0 | D | D |  |
| C | SAFE-05 Report by email | P1 | D | S | testnet build: mail composer / copied address (no mail app on simulators -> copy path) |
| C | SAFE-08 Removed content in rankings | P0 | D | D |  |
| C | SAFE-09 Moderation notices for my account | P1 | S | S | needs a banned persona; likely BLOCKED(no fixture) |
| D | EXPL-06 Search results lists | P1 | D | S |  |
| D | EXPL-08 Recent searches | P2 | S | D |  |
| D | PROF-05 My profile | P0 | D | D |  |
| D | PROF-10 NSFW profile interstitial | P1 | D | S |  |
| D | PROF-12 Share a profile | P1 | D | S |  |
| D | SAFE-10 Media changed since posting | P2 | S | D |  |

#### L4: Notifications, messages, settings, accessibility, testnet read-only pass

| Tier | Story | Pri | L4i | L4a | Note |
| --- | --- | --- | --- | --- | --- |
| A (A11) | DM-01 Inbox | P0 | D | D | 1:1 between 96 (L4i) and 97 (L4a); group with 96+97+98 |
| A (A11) | DM-03 Read a conversation | P0 | D | D | 1:1 between 96 (L4i) and 97 (L4a); group with 96+97+98 |
| A (A11) | DM-04 Send a message | P0 | D | D | 1:1 between 96 (L4i) and 97 (L4a); group with 96+97+98 |
| A (A11) | DM-05 Start a 1:1 conversation | P0 | D | D | 1:1 between 96 (L4i) and 97 (L4a); group with 96+97+98 |
| A (A11) | DM-06 Create a group | P0 | D | D | 1:1 between 96 (L4i) and 97 (L4a); group with 96+97+98 |
| A (A11) | DM-07 Group info | P0 | D | D | 1:1 between 96 (L4i) and 97 (L4a); group with 96+97+98 |
| A (A11) | DM-11 Legacy DMs on testnet | P0 | D | D | testnet (v3) legacy read: needs a signed-in testnet identity with DMs -> likely BLOCKED(no fixture); verify gating (no New group / Group info) |
| A (A15) | DM-14 State survives backgrounding | P0 | D | D | kill right after 'Sent'; relaunch; nothing lost |
| A (A10) | NOTIF-01 Notification list | P0 | D | D | L4i and L4a generate each other's notifications (96 <-> 97) |
| A (A10) | NOTIF-02 Filters | P0 | D | D | L4i and L4a generate each other's notifications (96 <-> 97) |
| A (A10) | NOTIF-03 Polling and badge | P0 | D | D | L4i and L4a generate each other's notifications (96 <-> 97) |
| A (A10) | NOTIF-04 Mark visible read | P0 | D | D | L4i and L4a generate each other's notifications (96 <-> 97) |
| A (A10) | NOTIF-05 Per-type toggles | P0 | D | D | L4i and L4a generate each other's notifications (96 <-> 97) |
| A (A13) | SET-03 Notifications | P0 | D | D |  |
| A (A13) | SET-04 Privacy & Safety | P0 | D | D |  |
| A (A13) | SET-05 Appearance | P0 | D | D |  |
| B | DM-02 Unlock messages | P0 | D | D | DM-02 uses persona-key --purpose encryption (key-entry users) |
| B | DM-08 Group states | P0 | D | D | DM-02 uses persona-key --purpose encryption (key-entry users) |
| B | DM-10 Block from a conversation | P0 | D | D | DM-02 uses persona-key --purpose encryption (key-entry users) |
| C | DM-09 Delete a conversation | P1 | D | S |  |
| C | DM-12 Message settings | P1 | D | S |  |
| C | DM-13 Messages badge | P0 | D | D |  |
| C | NOTIF-08 Blocked actors | P0 | D | D |  |
| D | NOTIF-06 Grouped like notifications | P1 | D | S | v11 / windowed: devnet runs v11 |
| D | NOTIF-07 Windowed history | P1 | D | S | v11 / windowed: devnet runs v11 |
| D | NOTIF-09 Signed out | P0 | D | D |  |
| D | SET-09 Settings persistence | P0 | D | D |  |
| E | A11Y-01 Text size | P0 | D | D | A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text |
| E | A11Y-02 Screen readers | P0 | D | D | A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text |
| E | A11Y-03 Hit targets | P0 | D | D | A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text |
| E | A11Y-04 Contrast | P0 | D | D | A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text |
| E | A11Y-05 Reduce Motion | P0 | D | D | A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text |
| E | A11Y-06 Announcements | P1 | D | S |  |
| E | A11Y-07 Right-to-left content | P0 | D | D | A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text |
| E | A11Y-08 Test identifiers | P0 | D | D | A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text |
| E | A11Y-09 Bold text and increased contrast | P2 | D | S |  |

#### Exit-matrix rows (Tier A)

| Row | Scenario | Variants | Stories | Owner lane |
| --- | --- | --- | --- | --- |
| A1 | Signed-out browse: welcome, feed, thread, profile, explore | both variants | AUTH-01, AUTH-02, EXPL-01, POST-01, PROF-01 | L1, L2, L3 |
| A2 | Sign in: key exchange (responder), key entry WIF + hex, key registration, restore, switch account, sign out | devnet (+ testnet key entry, read-only) | AUTH-03, AUTH-04, AUTH-06, AUTH-08, AUTH-10, AUTH-11 | L1 |
| A3 | EULA gate; Lockdown screen | devnet (Lockdown: physical iPhone only) | AUTH-09, NET-06 | L1 |
| A4 | Home: For You, Following, Top, pill, pull-to-refresh, infinite scroll | both | FEED-01, FEED-02, FEED-04, FEED-05, FEED-06, FEED-07 | L2 |
| A5 | Thread: replies, removed and deleted stubs, engagements | both | POST-02, POST-04, POST-05, POST-06 | L2 |
| A6 | Compose: post, reply, quote, 10-part thread, mentions, hashtags, NSFW, counter, drafts, check again / retry | devnet | COMP-01, COMP-02, COMP-03, COMP-04, COMP-05, COMP-06, COMP-07, COMP-08, COMP-09, COMP-10 | L2 |
| A7 | Engagement: like, repost, bookmark + Bookmarks, share, delete own | devnet | ENG-01, ENG-02, ENG-03, ENG-04, ENG-05, ENG-06 | L3 |
| A8 | Profiles: tabs, follow, lists, edit (DashPay + extension) | both (edit: devnet) | PROF-02, PROF-03, PROF-04, PROF-06, PROF-07, PROF-08 | L3 |
| A9 | Explore: search users/hashtags/posts, trending, Top, Creators, hashtag page | both | EXPL-02, EXPL-03, EXPL-04, EXPL-05, EXPL-07 | L3 |
| A10 | Notifications: filters, mark-visible-read, badge, toggles | devnet | NOTIF-01, NOTIF-02, NOTIF-03, NOTIF-04, NOTIF-05 | L4 |
| A11 | Messages: DM v5 1:1 + groups (devnet); legacy 1:1 read (testnet) | both | DM-01, DM-03, DM-04, DM-05, DM-06, DM-07, DM-11 | L4 |
| A12 | Safety: block / unblock / list, report, NSFW modes, media gate, removed stubs | devnet | SAFE-01, SAFE-02, SAFE-03, SAFE-04, SAFE-06, SAFE-07 | L3 |
| A13 | Settings: account, notifications, privacy, appearance, about, terms, diagnostics | both | SET-01, SET-02, SET-03, SET-04, SET-05, SET-06, SET-07, SET-08 | L1, L4 |
| A14 | Deep links: cold and warm (light only) | both | NET-11, POST-07 | L1 |
| A15 | Engine resilience: renderer kill recovers; background flush; offline -> online (light only) | devnet | DM-14, NET-02, NET-04 | L1, L2, L4 |

#### Edge battery (Tier E, not stories)

| ID | Case | Stream(s) | Note |
| --- | --- | --- | --- |
| E-01 | Offline browse + write attempts (G-1, NET-02), back online refreshes once | L2a | Android only |
| E-02 | Slow network (`network slow/edge`): cold start, feed paging, compose | L2a |  |
| E-03 | DAPI unreachable while OS online (`network stall`): G-11 errors, NET-03 backoff, recovery | L1a |  |
| E-04 | Engine renderer kill during list scroll and during an in-flight write (no resend) | L1i, L1a |  |
| E-05 | 3 engine kills within 2 min -> 'Couldn't connect' banner, no loop | L1i, L1a |  |
| E-06 | Account switch mid-write (98 <-> 90): write stays attributed, no stale data after switch | L1i |  |
| E-07 | App kill mid-write (post, like, follow; DM on L4): relaunch shows truth, no duplicate | L2i, L2a, L4a |  |
| E-08 | Unconfirmed write (stall right after broadcast): 'Not confirmed yet · Check again', no blind resend | L2a | Android only |
| E-09 | Sakura quorum/DAPI errors: categorized messages, diagnostics error ring, recovery (record any outage window) | all | note times |
| E-10 | RTL content: Arabic + Hebrew posts (typed on iOS), read on Android; mixed-direction handles | L2i -> L2a |  |
| E-11 | Limits: 1000 chars, 2000 UTF-8 bytes with emoji/ZWJ/CJK; over-limit highlight; grapheme-safe truncation | L2i (Unicode), L2a (ASCII) |  |
| E-12 | Font scale 200% / AX5 on every main screen; no clipped text; action-bar counts move to labels | L4i, L4a |  |
| E-13 | Runtime theme switch (System/Light/Dark) + both OS appearances on every main screen | L4i, L4a |  |
| E-14 | Small screen: Android `qa screen small` (720x1280) on main flows; iOS SE needs an extra simulator (open question) | L3a |  |
| E-15 | Android back + predictive back gesture on every stack, modal, sheet; no app exit surprises | L3a, L1a | Android only |
| E-16 | Keyboard: editor growth, header/counter visible, paste with line breaks, hardware Ctrl/Cmd+Enter | L2i, L2a |  |
| E-17 | Screen reader basics: TalkBack walk (Android), label audit with ui-text (iOS) | L4a, L4i |  |
| E-18 | Reduce Motion: no springs, no heart burst, pill jumps | L4i, L4a |  |
| E-19 | Rotation request: app stays portrait (both) | L3i, L3a |  |
| E-20 | Background flush: DM v5 + drafts survive background -> kill | L4i, L4a |  |
| E-21 | Memory: 500-post scroll with `qa memory --watch` (no growth; <= 250 MB after 10 min mixed use) | L2i, L2a |  |
| E-22 | Cold start timing: cached vs fresh (M6) from Diagnostics timings + screenshots | L1i, L1a |  |
| E-23 | Reinstall: uninstall/reinstall wipes keys (iOS Keychain survives uninstall -> app must wipe) | L1i, L1a |  |
| E-24 | Deep link abuse: malformed ids, other network prefix (/testing, /devnet), sign-in/compose links refused | L1i, L1a |  |
| E-25 | Secrets: persona keys never appear in logs, diagnostics, screenshots (grep -c -F -f <keyfile>) | L1i, L1a |  |
| E-26 | Screen privacy (#645): app switcher snapshot / Recents, FLAG_SECURE screens on Android | L1i, L1a |  |
| E-27 | Testnet read-only pass: signed-out browse, gating (no Top/Creators/reports, 500-char limit, v2 profile), NO writes | L4i, L4a | never write |
| E-28 | System locale ar/he: chrome stays LTR, content direction correct, no crash | L3i, L3a |  |

#### Load per stream (stories at depth D / smoke S)

| Stream | D | S | N/A |
| --- | --- | --- | --- |
| L1a | 26 | 2 | 1 |
| L1i | 27 | 2 | 0 |
| L2a | 34 | 3 | 0 |
| L2i | 34 | 2 | 1 |
| L3a | 34 | 5 | 0 |
| L3i | 36 | 3 | 0 |
| L4a | 30 | 6 | 0 |
| L4i | 36 | 0 | 0 |


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
