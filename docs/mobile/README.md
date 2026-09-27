# Yappr Mobile: product roadmap

Status: **planning** (written 2026-09-27). This folder holds the full plan for
native Yappr apps on iOS and Android, from the first spike to two shipped,
QA-signed-off store releases. It also lists the few things the apps need from
the wallets, Dash Platform and the Yappr web app.

| Doc | What it covers |
| --- | --- |
| [PRODUCT_UX.md](PRODUCT_UX.md) | Principles, personas, information architecture, key flows with wireframes, feature scope per release |
| [WALLET_INTEGRATION.md](WALLET_INTEGRATION.md) | Sign-in by DashPay handoff, key custody, payments, contacts, and what we ask the wallet teams for |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | Background polling (default) and the opt-in wake-up relay; the NSE, Android workers, preferences, privacy |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack decision, the `PlatformClient` facade, monorepo layout, shared-core seams, storage, background jobs, build variants |
| [COMPLIANCE.md](COMPLIANCE.md) | App Store and Play policy requirements: UGC, crypto and tipping, account deletion, age rating, export, privacy |
| [QA_RELEASE.md](QA_RELEASE.md) | Test strategy, device and scenario matrices, the test-wallet harness, phase exit criteria, beta and rollout |

## Decisions already taken

These came from the planning kickoff and hold throughout the plan.

1. **Only a DashPay wallet can sign you in.** The Yappr apps never import a
   mnemonic, WIF or password-vault key. Sign-in, key provisioning, credit
   top-ups, DASH payments and any CRITICAL or MASTER signature go to the
   user's DashPay wallet (iOS `org.dashfoundation.dash`, Android
   `hashengineering.darkcoin.wallet`) by app-to-app handoff.
2. **Notifications come two ways, and the relay is opt-in.** By default the
   device polls on its own schedule (BGAppRefresh / WorkManager) and posts local
   notifications, with no server involved. Users can switch on a stateless,
   self-hostable wake-up relay for timely notifications. The relay never sees
   notification content.
3. **Everything lives in this repo for now.** The apps go under `mobile/`, and
   the shared TypeScript in `lib/` is consumed in place rather than extracted.

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
  surfaces need anyway: reporting, account deletion, push-endpoint pings, App
  Connect login, and the small `lib/` seams that let the shared code run
  outside a browser.
- **Privacy by default.** Polling is the default. The relay is opt-in and only
  ever carries ciphertext. There are no analytics SDKs, and crash reporting is
  opt-in.

## Where things stand (facts the plan rests on)

| Area | Fact | Source |
| --- | --- | --- |
| Yappr prod | Runs on **testnet** with social contract v2, where YAPP token costs are *required* for post/reply/like/repost. DM v3. No mainnet contracts exist. Social v9 (token costs *optional*, but post and reply carry credit action fees to a moderators pot) runs only on devnet. | `lib/constants.ts`, `docs/SOCIAL_V9.md`, `contracts/*.json` |
| Web login | Wallet QR key exchange (`dash-key:` / `dash-st:`), passkey PRF vault, password vault, raw-key paste. Secrets sit in plaintext `localStorage`. | `vendor/platform-auth/src/core/controller.ts`, `lib/secure-storage.ts` |
| SDK | `@dashevo/evo-sdk` 4.2.0-beta.4, a 23 MB WASM module. Hermes has no WebAssembly, and the RN wasm runtimes are stalled. | Research notes, [ARCHITECTURE.md](ARCHITECTURE.md#why-not-run-the-wasm-sdk-directly) |
| Native SDKs | dashpay/platform ships `rs-sdk-ffi` (C ABI), `swift-sdk` (iOS 18+) and `kotlin-sdk` (minSdk 29). Both DashPay wallets run on them (Android: v12 integration branch). Documents support list/get/count/sum/average plus create/replace/delete. | `packages/swift-sdk/.../PlatformQueryExtensions.swift`, `packages/kotlin-sdk/PARITY_SUMMARY.md` |
| iOS DashPay | App Store 9.1.1 (2026-09-26) ships DashPay usernames, contacts and invites on mainnet. **DashConnect** (`dash-key:`/`dash-st:`) is on `develop` but works on testnet only; mainnet is blocked because the login contract is missing there (draft dashwallet-ios#1133). | dashwallet-ios `DashWallet/Info.plist`, `ConnectionsViewModel.swift:90` |
| Android DashPay | DashPay is live on mainnet. DashConnect was merged 2026-08-13 but `SUPPORTS_CONNECT=false` in prod, and it is in no release yet. Enabling it on mainnet for 11.9.1 was reverted. | dash-wallet `Constants.java:71`, PR #1510, #1567 |
| App Connect | A new system contract `H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ`, active from protocol v14, gives wallet→app login responses a fixed home on every network. Neither wallet uses it yet. | dashpay/platform `docs/protocol/app-connect.md`, PR #4869 |

## Milestones (single source of truth)

Every "needed by" date in these docs refers to this table. The weeks are
indicative and assume the team in [Staffing](#staffing).

| Gate | Week | Outcome |
| --- | --- | --- |
| G0 | 4 | Architecture decided from spike data; prototype validated; dependency owners committed |
| G1 | 12 | Internal alpha on the beta network ([Networks](#networks-and-environments)) |
| G2 | 18 | **Beta 1**: external testers on the beta network; **launch-network go/no-go** |
| G3 | 22 | **Beta 2 / RC** on the launch network; audit closed; compliance green |
| G4 | 26 | 1.0 live on both stores at 100% rollout |

```
Weeks        1   4   8   12  16  20  24  28
             |   |   |   |   |   |   |   |
Phase 0      ████                                Foundations, spikes, design, dependency asks
Phase 1          ████████                        Core social app → G1 internal alpha
Phase 2                ████████████              DMs, notifications, relay, private feeds, tips → G2 Beta 1
Phase 3                        ████████████      Hardening, audit, compliance → G3 Beta 2 / RC
Phase 4                                    ████  Store submission, phased rollout → G4 1.0
Web/contr.   ████████████████████                Yappr web + contract workstream (Y0–Y5)
⛓ deps       Y0 by G1 · W3/W4 by G2 · P1/Y1/W1/W2 by G3
```

The phases overlap on purpose. Phase 2 starts during Phase 1, and Phase 3
hardening starts before Beta 1 closes.

## Networks and environments

Yappr today has no network where the needed contracts and a wallet that can
sign users in exist together:

- **Testnet** has DashConnect in both wallets, but runs social **v2**, where
  YAPP is *required* to post (a blocker on iOS and for credits-only Android
  1.0).
- **Devnet** (moutai) has v9 and DM v5, but no store wallet build.
- **Mainnet** has neither.

Every environment needs its own contract set:

| Environment | Used for | Needs |
| --- | --- | --- |
| **Beta network = testnet** | Dev, internal alpha, Beta 1, all automated E2E | **Y0:** testnet at protocol 14; social v9, DM v5, profile v2, `yappr-push` and `yappr-report` deployed on testnet (plus `/testing` copies of each for E2E); mobile test-pool slots provisioned. Wallets: DashConnect on testnet (available today). |
| **Launch network = mainnet** | Beta 2 / RC and GA | **P1** protocol 14 on mainnet; **Y1** contracts on mainnet; **W1/W2** DashConnect/App Connect on mainnet in store wallet builds |
| Devnet | Fallback only, if testnet cannot reach protocol 14 by G1 | Wallet teams provide devnet-capable TestFlight / internal builds (both wallets already support `n=d`) |

**Launch-network go/no-go at G2.** If P1, Y1, W1 and W2 cannot all land by G3,
1.0 ships to the stores as a clearly labelled **testnet public beta**, and
mainnet GA follows as 1.1 once they do. Mobile development never waits on
mainnet; only the switch of the network flag does.

## Phases

### Phase 0: Foundations (weeks 1–4)

- **Architecture spikes** S1–S6. See
  [ARCHITECTURE.md › Spike plan](ARCHITECTURE.md#phase-0-spike-plan).
- **Wallet handoff proof.** Same-device sign-in on testnet using the real
  DashPay testnet builds on both platforms.
- **Protocol profile.** Write `APP_CONNECT_PROFILE.md` (sign-in payload, `cb`,
  error codes, key model) and `PUSH_PROFILE.md` (push payload and signature
  encoding), each with test vectors. Get sign-off from both wallet teams.
- **Design.** Information architecture; tokens extracted from
  `tailwind.config.js`; Figma prototypes of onboarding, feed, compose,
  notifications and DMs; an onboarding usability test with 5+ people.
- **Dependency asks.** Open requests with the wallet teams, Platform (P0/P1)
  and legal; set up the org developer accounts (C1); request the iOS
  notification filtering entitlement.
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
  (text, images, reply, quote, threads), like, repost, follow, profile view and
  edit, DPNS username registration, Explore, search, hashtags, bookmarks.
- **Safety baseline.** Block, report (needs Y2 report contract), the
  sensitive-content filter, the moderation denylist, and the EULA gate.
- **Notifications.** Foreground only: the tab, badges, and the same derivation
  as web.
- **Web workstream.**
  - Seam PRs 3–5: `secrets`, `sdk`, `txBuilder`.
  - Deploy Y0 contracts to testnet.
  - Report contract and moderator queue.
  - `.well-known` files and the `/app/connect` page.
- **Gate G1:** internal alpha on testnet (Y0 contracts). Core flows pass
  Maestro E2E on both platforms, with no open P0.

### Phase 2: Messaging, notifications, money (weeks 10–18)

- **Messaging.** DMs on DM v5, with legacy v3/v4 threads readable. Private
  feeds: view, request, approve, revoke, and owner management.
- **Notifications.**
  - Background polling: iOS BGAppRefresh and Android WorkManager, producing
    local notifications.
  - Opt-in instant delivery: the `yappr-push` contract, `lib/push/ping.ts`
    (web and mobile), relay v1, the NSE, FCM and UnifiedPush.
  - Preferences and notification actions.
- **Money and account.**
  - DashPay contact suggestions, and profile tips handed off to the wallet.
  - Account deletion in the app, plus `lib/account-deletion.ts` and the web
    `/delete-account` page.
- **Gate G2:** Beta 1 through TestFlight external and the Play closed track on
  testnet, with at least 50 testers per OS. Crash-free sessions ≥ 99.0%, the
  wallet interop matrix green, and the **launch-network go/no-go** made.

### Phase 3: Hardening and compliance (weeks 16–22)

- **Security.** External audit against the OWASP MASVS L2 checklist, covering
  key custody, the sign-in protocol, the relay, the NSE and the push payload.
  Relay load test and pen test.
- **Quality.** Accessibility audit; performance and battery budgets
  ([QA_RELEASE.md › Budgets](QA_RELEASE.md#performance-and-battery-budgets)).
- **Store readiness.**
  - Privacy labels and Data safety forms, checked against captured traffic.
  - Age rating; export compliance.
  - App Review package; **Apple pre-consult on action fees and tips**.
  - Strings ready for localization.
- **Launch network.** Launch-network config and Beta 2 on mainnet, if the G2
  go/no-go allowed it.
- **Gate G3:** no open P0/P1, audit High findings fixed, compliance checklist
  green.

### Phase 4: Launch (weeks 22–26)

- Full regression pass on the device matrix, then store submission.
- **Rollout.** iOS phased release over 7 days. Play staged rollout at 5%,
  20%, 50%, then 100%, with halt criteria.
- **Launch monitoring.** Opt-in crash reports, store reviews and relay health,
  with a hotfix train ready.
- **Gate G4 (done):** 1.0 live on both stores at 100%, crash-free sessions
  ≥ 99.5% over 7 days, and no open P0.

### Phase 5: Post-1.0 (1.1–1.3)

In priority order:

1. Mainnet GA, if 1.0 shipped as the testnet public beta.
2. Share extension.
3. Widgets.
4. Blog reader.
5. Pollr voting.
6. Android post tips and YAPP (once the Play declaration is done).
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
| P0 | Platform | Testnet at protocol 14 | G1 | Devnet betas with wallet devnet builds ([Networks](#networks-and-environments)) |
| P1 | Platform | Protocol 14 active on **mainnet** (App Connect, optional token costs, action fees, moderation, limited keys) | G3 | **None for mainnet.** v9, App Connect and the iOS-compatible fee model all need it. Ship the testnet public beta. |
| P2 | Platform | A tagged `rs-sdk` release that builds for `aarch64-apple-ios(-sim)`, `aarch64-linux-android` and `x86_64-linux-android`, pinned to the same tag as web's `@dashevo/evo-sdk` | G0 | Pin a commit and vendor its lockfile |
| W1 | iOS and Android wallets | DashConnect enabled on **mainnet** in a store release | G3 | Testnet public beta |
| W2 | Wallets + Yappr | One agreed mainnet login contract. **Recommendation:** App Connect (H8F9…), with one-hop key provisioning and the per-device key model | G3 | Deploy Yappr `key-exchange-v2` to mainnet; the wallets pin it (dashwallet-ios #1133) |
| W3 | Wallets | Same-device return: an optional `cb=` universal/app link, plus error codes | G2 | "Switch back to Yappr" plus polling. It works, but is clumsy. |
| W4 | iOS wallet | Re-login lookup fix (dashwallet-ios #1137 / platform #4822) | G2 | The wallet creates a new response |
| Y0 | Yappr | Testnet deploys of social v9, DM v5, profile v2, `yappr-push`, `yappr-report` (plus `/testing` copies); mobile test-pool slots provisioned | G1 | Devnet |
| Y1 | Yappr | The same contract set on mainnet, with an **iOS-compatible fee model** for post and reply ([COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping)) | G3 | None. v2 makes YAPP mandatory to post. |
| Y2 | Yappr web | Report contract and moderator queue; moderation denylist; `/delete-account` page; `.well-known` app-site association; `/app/connect` page; `lib/push/ping.ts`; zero-tolerance terms and community guidelines | G1 (report, denylist, terms), G2 (rest) | None. These are store blockers. |
| Y3 | Yappr | App Connect login support in `vendor/platform-auth`, shared with web | With W2 | Keep the `key-exchange-v2` path |
| Y4 | Yappr | ENCRYPTION key selection rule: skip keys bound to other contracts, prefer Yappr-bound or newest keys, fixed in `lib/crypto/encryption-key-lookup.ts` for web and mobile | G1 | None. Without it, DMs break for multi-key identities. |
| Y5 | Yappr | `lib/` platform seams (see [ARCHITECTURE.md](ARCHITECTURE.md#platform-seams-in-lib-the-minimal-yappr-change)) | Seams 1–2 by G0, 3–5 by G1 | None. Mobile cannot share `lib/` without them. |
| Y6 | Yappr | DM v5 encryption-key rotation (DM_V5 Appendix A), which enables "Reset messaging keys" after a lost device | 1.x | 1.0 documents the lost-device DM exposure |

## Staffing

Suggested team, for sizing:

| Role | Allocation |
| --- | --- |
| Mobile lead (RN + iOS native) | 1 |
| Mobile engineer (RN + Android native) | 1 |
| Rust / native bridge engineer (`yappr-platform`, transition builder, signer, NSE) | 1, heaviest in phases 0–2 |
| Yappr web / contracts engineer (Y0–Y5, seams, `ping.ts`, deletion, report and moderation) | 0.5 in phases 0–2, then 0.25 |
| Product designer | 1 in phases 0–2, then 0.5 |
| QA engineer | 0.5 from phase 1, 1 from phase 2 |
| Relay / infra | 0.25 |
| Moderation ops (report queue, 24 h SLA) | Rota from Beta 1 |
| Security audit | External, phase 3 |
| Product owner (pasta) | Decisions, wallet-team liaison, App Review contact |

## Open decisions

The next steps depend on these. Each has a recommendation in the linked doc.

1. **Launch network.** Sign-in is wallet-only, and store DashPay builds are
   mainnet-first, so a mainnet mobile GA *is* Yappr's mainnet launch.
   *Recommendation:* betas on testnet, then the G2 go/no-go described in
   [Networks](#networks-and-environments).
2. **Key model.** Use per-device auth keys plus one shared encryption key, so
   revoking a lost phone does not sign out every device or lose DM history.
   See [WALLET_INTEGRATION.md › Key model](WALLET_INTEGRATION.md#key-model-per-device-auth-shared-encryption).
   This needs wallet agreement (W2).
3. **Existing web users with an "external" encryption key** (passkey or pasted
   key logins). Mobile cannot import that key, which is the wallet-only rule.
   *Recommendation:* those users move to the wallet-derived key; old DMs stay
   readable on web only. See
   [WALLET_INTEGRATION.md › Existing web users](WALLET_INTEGRATION.md#existing-web-users).
4. **Login contract.** App Connect system contract or Yappr `key-exchange-v2`
   on mainnet. *Recommendation:* App Connect
   ([WALLET_INTEGRATION.md](WALLET_INTEGRATION.md#login-contract-app-connect-vs-yappr-key-exchange)).
5. **iOS fee model for posting.** On v9, every post and reply pays a
   credit *action fee* into a moderators pot that the contract owner claims
   while no charter is seated. On iOS that is a crypto payment to the developer
   to unlock posting. *Recommendation:* the mainnet cut sets post and reply
   action fees to zero, or the pot is provably not claimable by Yappr. See
   [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping).
6. **Legal entity** for organization developer accounts on Apple and Google.
   This is required for crypto features, and it also avoids Play's 12-tester
   gate for new personal accounts.
7. **Relay operator.** Who runs the default relay, and in which jurisdiction.
   *Recommendation:* the Yappr team hosts one default, and the relay is
   open-source so anyone can self-host it.
8. **Crash reporting.** *Recommendation:* self-hosted GlitchTip/Sentry,
   opt-in, with IP and PII stripped.
9. **Architecture pick.** Decided at G0 from spike data. *Current
   recommendation:* React Native (Expo) with a native Rust SDK module
   ([ARCHITECTURE.md](ARCHITECTURE.md)).
