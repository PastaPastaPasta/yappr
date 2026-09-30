# Yappr Mobile: product roadmap

Status: **plan of record** (written 2026-09-27; revised and finalized
2026-09-30 for the bonsia devnet, social v10 and the decisions below). This
folder holds the full plan for native Yappr apps on iOS and Android, from the
first spike to two shipped, QA-signed-off store releases. It also lists the few
things the apps need from the wallets, Dash Platform and the Yappr web app.

| Doc | What it covers |
| --- | --- |
| [PRODUCT_UX.md](PRODUCT_UX.md) | Principles, personas, information architecture, key flows with wireframes, feature scope per release |
| [WALLET_INTEGRATION.md](WALLET_INTEGRATION.md) | Sign-in by DashPay handoff (App Connect), key custody, payments, contacts, and what we ask the wallet teams for |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | Background polling (default) and the opt-in wake-up relay; the NSE, Android workers, preferences, privacy |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack decision, the `PlatformClient` facade, monorepo layout, shared-core seams, storage, background jobs, build variants |
| [COMPLIANCE.md](COMPLIANCE.md) | App Store and Play policy requirements: UGC, crypto and fees, account deletion, age rating, export, privacy |
| [QA_RELEASE.md](QA_RELEASE.md) | Test strategy, device and scenario matrices, the test-wallet harness, phase exit criteria, beta and rollout |

## Decisions

These hold throughout the plan. D1–D3 came from the planning kickoff
(2026-09-27); D4–D15 were settled by the product owner on 2026-09-30.

| # | Decision |
| --- | --- |
| D1 | **Only a DashPay wallet can sign you in.** The Yappr apps never import a mnemonic, WIF, password-vault or passkey-vault key. Sign-in, key provisioning, credit top-ups, DASH payments and any CRITICAL or MASTER signature go to the user's DashPay wallet (iOS `org.dashfoundation.dash`, Android `hashengineering.darkcoin.wallet`) by app-to-app handoff. |
| D2 | **Notifications come two ways, and the relay is opt-in.** By default the device polls on its own schedule (BGAppRefresh / WorkManager) and posts local notifications, with no server involved. Users can switch on a stateless wake-up relay for timely notifications. The relay never sees notification content. |
| D3 | **Everything lives in this repo for now.** The apps go under `mobile/`, and the shared TypeScript in `lib/` is consumed in place rather than extracted. |
| D4 | **Networks: bonsia now, testnet later, then mainnet.** Development, internal alpha and Beta 1 run on the bonsia devnet (the `/devnet` staging deploy), the only chain with the v10 contract set. We move to testnet once it runs protocol 14 with the Yappr contract set deployed. See [Networks](#networks-and-environments). |
| D5 | **No owner-claimable fees.** The mainnet social cut declares elected moderation with `interim: {"$type": "notYetUsable"}`. Posts, replies, reports and `yapprProfile` are refused (41200) until an elected charter is seated; nobody, the contract owner included, can claim the moderators pot, which accumulates for the seated team. The post and reply action fees stay and go to elected moderators only. See [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping). |
| D6 | **Sign-in uses App Connect with per-device, multi-bound keys.** One wallet handoff grants a per-device auth key bound to each contract Yappr writes (social, DM v5, `yappr-push`, DashPay `profile`) plus one encryption key shared by the user's devices. See [WALLET_INTEGRATION.md](WALLET_INTEGRATION.md#key-model-per-device-auth-shared-encryption). |
| D7 | **Reports cover posts, replies, profiles and DMs, on chain.** The next social cut extends the v10 `report` doctype with an identity target (a profile and a user are the same target). A DM report carries the reported conversation's key, encrypted to the moderation team, so moderators can read that conversation. See [COMPLIANCE.md](COMPLIANCE.md#reports). |
| D8 | **Media become arrays in the next social cut.** A post or reply carries a list of media items (several images, or a video, or a GIF), each with its own hash. Until that cut is live, compose supports one image. |
| D9 | **No migration for non-wallet web keys.** Mainnet users all sign in from a wallet, so passkey, password-vault and pasted-key identities are a devnet/testnet artefact. Mobile does not handle them. |
| D10 | **Notification gaps are accepted.** On v10, reply and quote notifications live in 3.5-day windows, and likes notify only for recent posts. A device that has not synced for longer simply misses the older items. No recovery pass. |
| D11 | **Likes are out of the account-deletion scope.** v10 has no index by liker, and we do not add one. |
| D12 | **A Dash-affiliated organization publishes the apps** under its Apple and Google organization developer accounts. |
| D13 | **The Yappr team hosts the default relay.** It is open source and self-hostable; Android users can use UnifiedPush and skip it. |
| D14 | **No crash-reporting SDK.** We rely on the OS and store vitals (Xcode Organizer, Play Console) only. |
| D15 | **No profile step.** Profiles are optional (#605). On v10 the DashPay `profile` is the base profile and `yapprProfile` is the extension, so a DashPay user already has a name and avatar in Yappr. |

## Product principles

- **It's your identity, not our account.** No Yappr server holds keys, profiles
  or social data. The app is a client of Dash Platform, like the web app.
- **Treat the wallet as a trusted partner.** Every handoff says what is about to
  happen, returns the user to the same screen, and recovers if the app is killed
  in between.
- **The app must feel native.** Use native navigation, gestures, haptics, share
  sheets, deep links, notifications and the Keychain/Keystore. A web view does
  not pass as an app, either to users or to App Review (guideline 4.2).
- **Change web as little as possible.** Yappr web changes only for things both
  surfaces need anyway: profile and DM reports, account deletion, push-endpoint
  pings, App Connect login, and the small `lib/` seams that let the shared code
  run outside a browser.
- **Privacy by default.** Polling is the default. The relay is opt-in and only
  ever carries ciphertext. There are no analytics or crash-reporting SDKs.

## Where things stand (facts the plan rests on, 2026-09-30)

| Area | Fact | Source |
| --- | --- | --- |
| Yappr prod | Runs on **testnet** with social contract v2, where YAPP token costs are *required* for post/reply/like/repost. DM v3. No mainnet contracts exist. | `lib/constants.ts`, `contracts/*.json` |
| Yappr staging | **Social v10** runs on the **bonsia** devnet (yap.pr/devnet; Platform 4.2.0-beta.7, protocol 14): optional YAPP; post and reply credit action fees (80M / 16M credits) to a moderators pot with the owner as interim; YAPP locked (not purchasable or transferable; a one-time 100 grant); real deletes; reposts are quotes; the DashPay `profile` is the base profile; moderator-resolved `report`. DM v5, storefront v5, blog v5, pollr v4 and key exchange are live there too. Devnets are wiped by platform betas, so every id is disposable. | `docs/SOCIAL_V10.md`, `.env.devnet` |
| Web login | Wallet QR key exchange (`dash-key:` / `dash-st:`), passkey PRF vault, password vault, raw-key paste. Secrets sit in plaintext `localStorage`. No App Connect support yet. | `vendor/platform-auth/src/core/controller.ts`, `lib/secure-storage.ts` |
| SDK | `@dashevo/evo-sdk` 4.2.0-beta.7, a ~24.6 MB WASM module. Hermes has no WebAssembly (the Feb 2026 preview is not shipped), and the RN wasm runtimes are stalled or unproven. | `package.json`, [ARCHITECTURE.md](ARCHITECTURE.md#why-not-run-the-wasm-sdk-directly) |
| Platform | Latest release **v4.2.0-beta.7** (2026-09-29, devnet-only prerelease). `v4.2-dev` already carries more breaking protocol-14 changes, so expect further betas and re-cuts. **Protocol 14 is active on neither testnet nor mainnet** (both report 13 on 2026-09-30), and no activation date is published. | dashpay/platform releases; platform explorer |
| Native SDKs | `rs-sdk-ffi`, `swift-sdk` (iOS 18+) and `kotlin-sdk` build for arm64 iOS/simulator and arm64/x86_64 Android. Beta.7 ships an xcframework and an AAR as GitHub release assets only (no Maven Central, no remote Swift package), and there is no React Native or uniffi binding. Document create/replace/delete exist in the FFI. | `packages/{swift,kotlin}-sdk` at v4.2.0-beta.7 |
| iOS DashPay | App Store **9.1.2** (2026-09-29). DashConnect (`dash-key:`/`dash-st:`, same-device links since #1104) **ships in the store build, testnet only**; store builds cannot select a devnet. Mainnet waits on a login contract (draft #1133). Re-login bug #1137 is open. No App Connect, no `cb=` return. | dashwallet-ios v9.1.1 notes, `ConnectionsViewModel.swift:90` |
| Android DashPay | DashPay is live on mainnet. **11.9.1** (2026-09-28) shipped with `SUPPORTS_CONNECT=false` in the prod flavor (its GitHub release text wrongly says "enabled on mainnet"); testnet and devnet flavors have it. No App Connect, no `cb=` return. | dash-wallet `Constants.java:104`, PR #1567 |
| App Connect | A system contract `H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ` (platform #4869, in releases since beta.4) gives wallet→app login responses a fixed home on every protocol-14 network. Responses are `indexOnly`; re-login is delete plus create, never replace. Neither wallet uses it yet. | dashpay/platform `docs/protocol/app-connect.md` |

## Milestones (single source of truth)

Every "needed by" date in these docs refers to this table. The weeks are
indicative, count from the day the team in [Staffing](#staffing) starts, and
assume that team.

| Gate | Week | Outcome |
| --- | --- | --- |
| G0 | 4 | Architecture decided from spike data; prototype validated; dependency owners committed |
| G1 | 12 | Internal alpha on bonsia |
| G2 | 18 | **Beta 1**: external testers on bonsia (or testnet, if it is ready); **launch-network go/no-go** |
| G3 | 22 | **Beta 2 / RC** on the launch network; first moderation charter seated there; audit closed; compliance green |
| G4 | 26 | 1.0 live on both stores at 100% rollout |

```
Weeks        1   4   8   12  16  20  24  28
             |   |   |   |   |   |   |   |
Phase 0      ████                                Foundations, spikes, design, dependency asks
Phase 1          ████████                        Core social app → G1 internal alpha
Phase 2                ████████████              DMs, notifications, relay, private feeds, tips → G2 Beta 1
Phase 3                        ████████████      Hardening, audit, compliance → G3 Beta 2 / RC
Phase 4                                    ████  Store submission, phased rollout → G4 1.0
Web/contr.   ████████████████████                Yappr web + contract workstream (Y0–Y7)
⛓ deps       Y0/Y4/Y5 by G1 · Y1/W3/W4/W8 by G2 · P1/Y2/W1/W2 by G3
```

The phases overlap on purpose. Phase 2 starts during Phase 1, and Phase 3
hardening starts before Beta 1 closes.

## Networks and environments

Today no network has both the v10 contract set and a store wallet that can
sign users in:

- **Bonsia** (devnet; Platform 4.2.0-beta.7, protocol 14): the full v10 set is
  live, with a 9-slot CI/DM bot pool (`docs/TESTING.md` §1). Store wallets
  cannot reach a devnet; internal wallet builds can (`n=d`, `DASH_DEVNET`).
  There is no seed DNS, so clients take the explicit DAPI list, the devnet name
  and the quorum URL from `.env.devnet`. Platform betas wipe devnets, so every
  id is disposable.
- **Testnet**: DashConnect works in both store wallets, but testnet runs
  protocol 13, social **v2** (YAPP required to post) and DM v3.
- **Mainnet**: neither.

| Environment | Used for | Needs |
| --- | --- | --- |
| **Bonsia (now)** | Dev, spikes, all automated E2E, internal alpha, Beta 1 | **Y0:** `yappr-push` deployed and mobile pool slots provisioned; **Y1** (the next social cut) deployed by G2. Wallets: the test-wallet harness for automation; **W8** devnet-capable internal/TestFlight wallet builds for human testers. |
| **Testnet (later)** | Store-wallet interop; Beta 2 if mainnet is not ready | **P0** protocol 14 on testnet; the Yappr contract set (Y1 cut) deployed there. Wallets: DashConnect on testnet (in the stores today); App Connect (W2). |
| **Mainnet (launch)** | Beta 2 / RC and GA | **P1** protocol 14 on mainnet; **Y2** contracts on mainnet with a seated first charter; **W1/W2** DashConnect/App Connect on mainnet in store wallet builds |

**Keeping bonsia usable.** The mobile build reads contract ids and the network
config at build time from the same `.env.*` files as web, and the pool and
fixture setup is scripted, so a devnet wipe costs a rebuild and a re-seed,
not code changes.

**Launch-network go/no-go at G2.** If P1, Y2, W1 and W2 cannot all land by
G3, 1.0 ships to the stores as a clearly labelled **testnet public beta**
(which needs P0), and mainnet GA follows as 1.1 once they do. Mobile
development never waits on mainnet; only the switch of the network flag does.

## Phases

### Phase 0: Foundations (weeks 1–4)

- **Architecture spikes** S1–S6, run on bonsia. See
  [ARCHITECTURE.md › Spike plan](ARCHITECTURE.md#phase-0-spike-plan).
- **Wallet handoff proof.** Same-device sign-in with the test-wallet harness
  on bonsia, and with the store DashPay builds on testnet (key-exchange-v2),
  on both platforms.
- **Protocol profiles.** Write `APP_CONNECT_PROFILE.md` (sign-in payload, the
  per-device multi-bound key set, `cb`, error codes), `PUSH_PROFILE.md` (push
  payload and signature encoding) and `REPORT_PROFILE.md` (profile targets and
  the encrypted DM-key envelope), each with test vectors. Get sign-off from
  both wallet teams on the first.
- **Contract design.** Draft the next social cut (Y1): report identity
  target, DM-key envelope, media arrays, and the mainnet moderation block
  (`notYetUsable`, mainnet election windows).
- **Design.** Information architecture; tokens extracted from
  `tailwind.config.js`; Figma prototypes of onboarding, feed, compose,
  notifications and DMs; an onboarding usability test with 5+ people.
- **Dependency asks.** Open requests with the wallet teams (W1–W4, W8, W9),
  Platform (P0/P1) and legal; set up the organization developer accounts with
  the publishing organization (C1, D12), including Play developer verification
  (in force since 2026-09-30).
- **Scaffolding.**
  - Monorepo: `mobile/` Expo app, a CI job, and root
    `tsconfig`/`eslint`/`knip` exclusions.
  - Web workstream: lib seam PRs 1–2 (`kv`, `lifecycle`), plus the
    `encryption-key-lookup` fix (Y4).
- **Gate G0:** a signed architecture decision record (ADR), the validated
  prototype, and dependency owners with dates.

### Phase 1: Core social app (weeks 5–12)

- **App foundations.**
  - App shell: tabs, stacks, theming, SQLite cache, deep links and universal
    links.
  - Sign-in with DashPay, including re-login, sign-out, revoked-key detection
    and multiple accounts.
  - Keys held natively, plus an optional app lock.
  - Read-only browsing while signed out.
- **Social features.** Home (Following / For you / Top), threads, compose
  (text, one image until Y1, reply, quote, threads), like, repost (a bare quote
  on v10: one quote or repost per author per target), follow, profile view and
  edit, DPNS username registration via the wallet, Explore, search, hashtags,
  bookmarks.
- **Safety baseline.** Block, report posts and replies (v10 `report`), the
  sensitive-content filter, the moderation denylist, and the EULA gate.
- **Notifications.** Foreground only: the tab, badges, and the same derivation
  as web.
- **Web workstream.**
  - Seam PRs 3–5: `secrets`, `sdk`, `txBuilder`.
  - Deploy `yappr-push` to bonsia; provision mobile pool slots (Y0).
  - `.well-known` files and the `/app/connect` page.
  - App Connect module in `vendor/platform-auth` (Y3), against the harness.
- **Gate G1:** internal alpha on bonsia. Core flows pass Maestro E2E on both
  platforms, with no open P0.

### Phase 2: Messaging, notifications, money (weeks 10–18)

- **Messaging.** DMs on DM v5, with legacy v4 threads (bonsia) and v3 threads
  (testnet) readable. Private feeds: view, request, approve, revoke, and owner
  management.
- **Notifications.**
  - Background polling: iOS BGAppRefresh and Android WorkManager, producing
    local notifications.
  - Opt-in instant delivery: the `yappr-push` contract, `lib/push/ping.ts`
    (web and mobile), relay v1, the NSE, FCM and UnifiedPush.
  - Preferences and notification actions.
- **Safety.** Profile and DM reports on the Y1 cut, in the apps and on web.
- **Media.** Multi-image, video and GIF compose on the Y1 cut.
- **Money and account.**
  - DashPay contact suggestions, and profile tips handed off to the wallet.
  - Account deletion in the app, plus `lib/account-deletion.ts` and the web
    `/delete-account` page.
- **Gate G2:** Beta 1 through TestFlight external and the Play closed track on
  bonsia (with W8 wallet builds), or on testnet if P0 and the Y1 deploy there
  have landed, with at least 50 testers per OS. Crash-free sessions ≥ 99.0%
  (store vitals), the wallet interop matrix green, and the **launch-network
  go/no-go** made.

### Phase 3: Hardening and compliance (weeks 16–22)

- **Security.** External audit against the OWASP MASVS L2 checklist, covering
  key custody, the sign-in protocol, the relay, the NSE, the push payload and
  the DM-report key envelope. Relay load test and pen test.
- **Quality.** Accessibility audit; performance and battery budgets
  ([QA_RELEASE.md › Budgets](QA_RELEASE.md#performance-and-battery-budgets)).
- **Store readiness.**
  - Privacy labels and Data safety forms, checked against captured traffic.
  - Age rating; export compliance.
  - App Review package; **Apple pre-consult on the moderation fee and tips**.
  - Strings ready for localization.
- **Launch network.** Deploy the Y2 contract set, run the first moderation
  election and seat the charter, then Beta 2 on mainnet, if the G2 go/no-go
  allowed it.
- **Gate G3:** no open P0/P1, audit High findings fixed, compliance checklist
  green, and posting open on the launch network (charter seated).

### Phase 4: Launch (weeks 22–26)

- Full regression pass on the device matrix, then store submission.
- **Rollout.** iOS phased release over 7 days. Play staged rollout at 5%,
  20%, 50%, then 100%, with halt criteria.
- **Launch monitoring.** Store vitals, store reviews and relay health, with a
  hotfix train ready.
- **Gate G4 (done):** 1.0 live on both stores at 100%, crash-free sessions
  ≥ 99.5% over 7 days (store vitals), and no open P0.

### Phase 5: Post-1.0 (1.1–1.3)

In priority order:

1. Mainnet GA, if 1.0 shipped as the testnet public beta.
2. Share extension.
3. Widgets.
4. Proved credit tips on posts (Android and web; a tip document bound to a
   credit transfer, design still to do). iOS keeps profile tips only.
5. Blog reader.
6. Pollr voting.
7. Storefront: browse and buy, physical goods only on iOS; seller inbox.
8. iPad and foldable layouts.
9. Localization.
10. Watcher-mode relay.
11. Limited-key sessions (W7).
12. DM v5 encryption-key rotation (Y6).

Blog editing, store management and moderator tools stay on web.

## Critical dependencies outside the mobile apps

This list is kept short on purpose: only what 1.0 cannot ship without.
Details and fallbacks are in the linked docs.

| # | Owner | Need | Needed by | Fallback if late |
| --- | --- | --- | --- | --- |
| P0 | Platform | Testnet at protocol 14 | Testnet move (D4); a testnet public beta | Stay on bonsia; no testnet public beta |
| P1 | Platform | Protocol 14 active on **mainnet** (App Connect, optional token costs, action fees, elected moderation, limited keys) | G3 | **None for mainnet.** Ship the testnet public beta (needs P0). |
| P2 | Platform | An `rs-sdk` tag that builds for `aarch64-apple-ios(-sim)`, `aarch64-linux-android` and `x86_64-linux-android`, pinned to the same tag as web's `@dashevo/evo-sdk` (today `v4.2.0-beta.7`, `50d12037`) | G0 | Pin a commit and vendor its lockfile. Expect a pin bump (and a devnet re-cut) per platform beta. |
| W1 | iOS and Android wallets | DashConnect enabled on **mainnet** in a store release | G3 | Testnet public beta |
| W2 | Wallets + Yappr | App Connect (`H8F9…`) with one-hop provisioning and the per-device, multi-bound key model (D6): keys bound to social, DM v5, `yappr-push` and DashPay `profile` (plus DPNS if names are registered from Yappr); delete-plus-create re-login | G3 | Deploy Yappr `key-exchange-v2` to mainnet; the wallets pin it (dashwallet-ios #1133); DashPay profile edits hand off to the wallet |
| W3 | Wallets | Same-device return: an optional `cb=` universal/app link, plus error codes | G2 | "Switch back to Yappr" plus polling. It works, but is clumsy. |
| W4 | iOS wallet | Re-login lookup fix (dashwallet-ios #1137 / platform #4822) | G2 | Moot once App Connect's delete-plus-create re-login ships |
| W8 | Wallets | Devnet-capable internal/TestFlight builds that accept a custom devnet (DAPI list, quorum URL, devnet name) and run DashConnect/App Connect there | G2 | Beta 1 waits for testnet (P0) |
| W9 | Wallets | Confirm the dHash avatar fingerprint matches DashPay's `avatarFingerprint` | G2 | Yappr writes its own fingerprint only when it sets the avatar |
| Y0 | Yappr | On bonsia: `yappr-push` deployed; mobile test-pool slots provisioned | G1 | None |
| Y1 | Yappr | **The next social cut (mainnet candidate)** on bonsia: report identity target and DM-key envelope (D7), media arrays (D8), `interim: notYetUsable` (D5); then on testnet when P0 lands | G2 | Profile/DM reports by email plus the denylist; one image per post |
| Y2 | Yappr | The Y1 contract set on **mainnet** (mainnet election windows, ≥ 1 day), a first elected charter **seated before App Review**, and a moderation rota with a 24 h SLA | G3 | None. Nobody can post until a charter is seated. |
| Y3 | Yappr | App Connect login support in `vendor/platform-auth`, shared with web | With W2 | Keep the `key-exchange-v2` path |
| Y4 | Yappr | ENCRYPTION key selection rule in `lib/crypto/encryption-key-lookup.ts` (still returns the first active key): prefer the key bound to the contract in use, then an unbound key, then the newest | G1 | None. Without it, DMs break once identities carry bound keys. |
| Y5 | Yappr | `lib/` platform seams (see [ARCHITECTURE.md](ARCHITECTURE.md#platform-seams-in-lib-the-minimal-yappr-change)) | Seams 1–2 by G0, 3–5 by G1 | None. Mobile cannot share `lib/` without them. |
| Y6 | Yappr | DM v5 encryption-key rotation (DM_V5 Appendix A), which enables "Reset messaging keys" after a lost device | 1.x | 1.0 documents the lost-device DM exposure |
| Y7 | Yappr web | Moderation denylist (hides DashPay profile content, media and identities); `/delete-account` page; `.well-known` app-site association; `/app/connect` page; `lib/push/ping.ts`; profile and DM report UI; zero-tolerance terms and community guidelines | G1 (denylist, terms), G2 (rest) | None. These are store blockers. |

## Staffing

Suggested team, for sizing:

| Role | Allocation |
| --- | --- |
| Mobile lead (RN + iOS native) | 1 |
| Mobile engineer (RN + Android native) | 1 |
| Rust / native bridge engineer (`yappr-platform`, transition builder, signer, NSE) | 1, heaviest in phases 0–2 |
| Yappr web / contracts engineer (Y0–Y7, seams, `ping.ts`, deletion, reports) | 0.5 in phases 0–2, then 0.25 |
| Product designer | 1 in phases 0–2, then 0.5 |
| QA engineer | 0.5 from phase 1, 1 from phase 2 |
| Relay / infra | 0.25 |
| Moderation ops (report queue, 24 h SLA; charter candidates for mainnet) | Rota from Beta 1 |
| Security audit | External, phase 3 |
| Product owner (pasta) | Decisions, wallet-team liaison, App Review contact |

## Still open

Everything that changes the plan's shape is decided (see [Decisions](#decisions)).
What remains is either owned by someone else or settled by data at a gate:

1. **Architecture pick** (G0, from spike data). *Current recommendation:*
   React Native (Expo) with a native Rust SDK module
   ([ARCHITECTURE.md](ARCHITECTURE.md)).
2. **Launch network** (G2 go/no-go), per [Networks](#networks-and-environments).
3. **Which Dash-affiliated organization** enrolls the developer accounts (D12),
   by the end of week 2.
4. **Moderation-team key for DM reports** (D7): whether reporters encrypt to
   each seated moderator or to one team key the charter publishes. Settled in
   `REPORT_PROFILE.md` at G0.
5. **Charter continuity** under `notYetUsable` (D5): confirm with Platform
   what happens to posting if a seated charter later loses its seat, before the
   Y2 cut is frozen.
