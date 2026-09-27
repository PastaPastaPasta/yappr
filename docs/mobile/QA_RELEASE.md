# QA, release and operations

The goal is two store-shipped 1.0 apps that have been through complete QA:
automated coverage at every layer, a device matrix, wallet interop, security
and accessibility audits, and staged betas, each with measurable exit
criteria.

## Test pyramid

| Layer | Tooling | Scope | Runs |
| --- | --- | --- | --- |
| Shared-core unit | Vitest (existing `lib/**/*.test.ts`) **plus** the same specs under a Hermes runner (S6) | Crypto, codecs, DM v5 engine (in-memory chain), private feeds, notification derivation, payment plan, account-deletion plan, push payload | Every PR touching `lib/` or `mobile/` |
| Rust crate | `cargo test` plus **fixture parity tests** | `yappr-platform` query/proof/ST building compared against recorded `evo-sdk` outputs, so web and mobile stay byte-identical | Every PR under `mobile/native/` |
| Native units | XCTest (NSE decrypt/verify, key wrap), JUnit (Keystore wrap, FCM handler) | Security-critical native code | Every PR |
| Component | Jest + React Native Testing Library | Screens and state machines: sign-in, compose, unconfirmed writes, deletion | Every PR |
| E2E (simulated wallet) | **Maestro** on iOS Simulator and Android Emulator, with the **test-wallet harness** | Full flows on testnet `/testing` contracts, as in the web Playwright `write` project | Nightly, plus on release branches |
| E2E (read-only smoke) | Maestro | Browse signed out, search, thread, profile | Every PR (fast) |
| Device farm | BrowserStack App Automate (Maestro) or Firebase Test Lab | The device matrix below | Weekly, plus every RC |
| Manual exploratory | Test charters | Wallet interop, notifications on real devices, edge networks | Every RC |

**Test data and identities.** Setting up test data is a Phase 1 QA
deliverable. It needs Y0 (testnet at protocol 14 with the v9 contract set),
and covers:

- `/testing` copies of **every** contract mobile writes to: social v9,
  profile v2, DM v5, `yappr-push` and `yappr-report`. Today only social and
  profile have test copies, and web DM e2e writes to production (TESTING.md
  §7). Mobile must not.
- Registering mobile pool slots from the e2e seed (`docs/TESTING.md` §4, path
  `m/9'/1'/5'/0'/<i>'/<k>'`): at least 6 identities, so that 1:1 DMs, groups
  of 3 and blocked/unknown senders can be tested. They are separate from web
  CI's slots, because web runs `workers:1` due to DAPI rate limits. Today only
  slots 0–1 exist on testnet, and the 9-slot DM v5 pool is devnet-only under a
  different seed.
- Mobile-reserved identities with an **external** encryption key (created via
  the web pasted-key path) and a **passkey vault**. These cover the web-user
  migration cohorts.
- CI secrets are shared with web.

### Test-wallet harness

- A debug-only app at `mobile/test-wallet/`, installed on simulators and
  emulators only and never shipped.
- It registers `dash-key` and `dash-st`, approves each request automatically
  or on a Maestro tap, and derives keys from a pool identity.
- It publishes real responses on testnet in both the App Connect and
  key-exchange-v2 formats, and honors `cb=`.
- Maestro drives the whole "open wallet → approve → return" loop across the
  two apps.

## Scenario matrix (release candidate)

Each scenario is **automated (A)**, **manual (M)**, or **both (A+M)**. Every one
must pass on iOS and Android.

| Area | Scenarios |
| --- | --- |
| Sign-in | First sign-in with cb (A+M); without cb, manual return (A+M); app killed while in wallet, then restored (A+M); wallet not installed (A); no identity (M); wrong network (A); cancel (A); timeout (A); request older than 10 min rejected (A); re-login after sign-out (A+M); second account and switching (A); **second device gets its own auth key and the same encryption key, and DMs are readable on both (A)**; revoking device 1 leaves device 2 signed in (A+M); key revoked in the wallet → signed out (M) |
| Web-user migration | Wallet-QR web user → mobile: DMs and private feed intact (A); external-key web user → mobile: the "move messaging" step, private-feed re-key, followers still decrypt new posts, old DMs labelled web-only (A+M); passkey-vault user, same (M); peers encrypt to the right key after migration (`findEncryptionKey` rule) (A) |
| Browsing | Signed-out browse (A); feeds Following / For you / Top (A); infinite scroll of 500+ posts with no memory growth over budget (A); thread with 200 replies (A); deep links and universal links, cold and warm (A) |
| Compose | Text, mentions, hashtags, 4 images, video, GIF, quote, reply, thread of 5 (A); private post (A); sensitive flag (A); offline queue → reconnect (A); DAPI timeout → unconfirmed → reconcile (A); low credits (M) |
| Engage | Like, repost, bookmark, follow/unfollow, block/unblock and immediate hiding (A); report every target type (A) |
| Messages | 1:1 send/receive between two devices (A+M); group create/invite/leave (A); request inbox (A); legacy v3 thread readable (A); missing encryption key → wallet handoff (M); app backgrounded mid-send, then flush (A) |
| Private feeds | Enable, request, approve, view, revoke, re-key (A) |
| Notifications | **Locked device:** background sync runs while locked and signing work is deferred until unlock (A+M). **NSE while the app is suspended mid-write to shared SQLite:** no `0xdead10cc` kill (M, repeated 50×). **Relay revocation:** after sign-out or account switch, no alerts for the old identity (A). **Spam burst:** 300 unverified pings produce one collapsed alert (A). **Endpoint allowlist:** a non-allowlisted or private-IP endpoint is never contacted (A); a web sender reaching an ntfy endpoint (A). **Polling:** iOS BGAppRefresh via `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"pr.yap.app.refresh"]` in the debugger; Android `adb shell cmd jobscheduler run` (A). **Instant:** relay → APNs sandbox / FCM on real devices (M). UnifiedPush with ntfy (M). Spoofed payload → generic text → reconciled or dropped (A). Dedupe of push + poll (A). Quiet hours, previews hidden on lock screen (M). Actions: reply and like from notification, with app lock on and off (M). Badge counts (A). |
| Tips | Profile tip → `dash:` → DashPay → return → Insight confirm (M on mainnet-candidate). Never auto-retried (A). Hidden post-tip UI on iOS (A). |
| Account | Account deletion full and partial, interrupted and resumed (A); web deletion URL (A, Playwright) |
| Updates | An OTA bundle with a bad signature is rejected (A); a runtime-version mismatch never loads (A); a mismatched contract topology shows "Update Yappr" (A) |
| Lifecycle | Cold/warm start, low-memory kill, OS upgrade, app upgrade migration from N-1 (A); airplane mode and flaky network (Network Link Conditioner / emulator throttling) (M); clock skew (M) |
| Security | Keys absent from backups (M: iCloud/ADB backup inspection); screenshot blocked on key screens (M); app lock timeout (A); jailbreak/root: advisory banner only (M); no secrets in logs (automated log scan) |
| Accessibility | VoiceOver/TalkBack walk of all 1.0 screens (M); Dynamic Type AX5 (A snapshot); contrast (A); Reduce Motion (M) |
| Localization readiness | Pseudo-locale (long strings, RTL mirroring) screenshots (A) |

## Device matrix

| Tier | iOS | Android |
| --- | --- | --- |
| Min | iPhone XS/XR class on iOS 17 | Android 10 (API 29), 3 GB RAM, e.g. Moto G-class |
| Mid (budgets measured here) | iPhone 12 / 13 on iOS 18 | Pixel 6a / Samsung A54 on Android 14–15 |
| Current | iPhone 16/17 on iOS 26 | Pixel 9/10 on Android 16; Samsung S25 (One UI) |
| Special | iPhone SE (small screen); Lockdown Mode on | Xiaomi/Oppo (aggressive battery killers); GrapheneOS (no Play services, UnifiedPush); foldable (layout smoke) |

## Performance and battery budgets

Measured on the mid tier. CI fails on regressions greater than 10% against the
last release baseline.

| Metric | Budget |
| --- | --- |
| Cold start to first feed content (cached) | ≤ 1.5 s |
| Cold start to fresh feed (network) | ≤ 3.0 s p75 on 4G |
| Scroll | ≥ 58 fps p95 on the feed; no jank > 50 ms |
| Memory | ≤ 250 MB after 10 min of mixed use; no growth over 500-post scroll |
| App size (download) | iOS ≤ 60 MB; Android ≤ 45 MB per ABI split |
| Background run | ≤ 15 s p90, ≤ 150 MB; iOS never killed for overrunning (`BGTask` expiration handler tested) |
| Battery | Private mode: ≤ 2% per day idle attributable in OS battery stats; Instant mode: ≤ 1% per day |
| NSE | ≤ 12 MB, ≤ 300 ms |

## Wallet interop

- **Matrix.** Yappr RC is tested against the latest store release and latest
  beta/TestFlight of **DashPay iOS** and **DashPay Android**, on testnet, and on
  mainnet once it is available. That is 2 wallets × 2 channels × the sign-in
  and payment scenarios above.
- **Shared test plan.** One test plan, `docs/mobile/APP_CONNECT_PROFILE.md`,
  with test vectors (request payload, derived keys, envelope) that all three
  codebases run in unit tests.
- **Escalation.** Any interop failure is P0 for the release unless both teams
  agree on a documented workaround.

## Relay

- **Tests.**
  - Unit tests: token AEAD, RFC 8291 pass-through size limits, rate limiter.
  - Integration against the APNs sandbox and the FCM test project.
  - Load test at 200 pings/s sustained with p99 under 500 ms.
- **Security.** Pen test (external, phase 3): token forgery, revocation
  bypass, amplification (per-IP limits), log leakage, TLS config, and CORS
  scope.
- **Operations.**
  - Two regions, health checks, and an uptime SLO of 99.5%.
  - The relay being down degrades users to polling. Nothing breaks.
- **Runbook.**
  - APNs key rotation.
  - FCM credential rotation.
  - Abuse response (block a token, which the app rotates).
  - Incident comms: status line in Settings → Notifications → Diagnostics.

## Security review (phase 3)

The external audit uses the **OWASP MASVS L2** and MASTG checklists, and covers:

- Key custody: Secure Enclave / StrongBox wrap, access classes, backup
  exclusion, JS-heap exposure.
- The sign-in protocol: replay, request hijack (a malicious app reusing
  Yappr's contract ID), `cb` open redirect, and wrong-identity binding.
- NSE and push: spoofing, decrypt-oracle behavior, and lock-screen leaks.
- Deep link and universal link handling: injection, spoofed routes.
- JS signing surface: confirm no raw-digest signing is reachable from JS, and
  that `signPushPayload` domain separation holds.
- OTA update code signing and key custody. `selfRoot` in the JS heap is a
  documented, accepted exposure.
- Accepted risks to re-evaluate: sign-in request hijack
  ([WALLET_INTEGRATION.md](WALLET_INTEGRATION.md#accepted-risk-request-hijack)),
  and lost-device DM readability until Y6.
- DM v5 and private feeds on mobile, including local cache at rest (the SQLite
  file is protected with `NSFileProtectionCompleteUntilFirstUserAuthentication`
  and the Android file-based encryption default).
- Dependency audit, SBOM, and reproducible build notes for the Android FOSS
  flavor.

**Exit criteria:** no open Critical or High findings; Mediums either fixed or
accepted in writing.

## Bug severity and gates

| Sev | Definition | Allowed at G1 / G2 / G3 / G4 |
| --- | --- | --- |
| P0 | Key or fund loss or exposure, data loss, crash on launch, sign-in broken, policy blocker | 0 / 0 / 0 / 0 |
| P1 | Core flow broken without workaround, crash rate > 1% of sessions, notification delivery broken | ≤ 5 / ≤ 2 / 0 / 0 |
| P2 | Degraded flow with workaround, visual bugs on main screens | any / ≤ 20 / ≤ 10 / ≤ 10 (triaged) |

## Beta programme

| Stage | When | Audience | Network | Channels | Exit |
| --- | --- | --- | --- | --- | --- |
| Internal alpha | G1 (wk 12) | Team, 10–20 | Testnet | TestFlight internal, Play internal | Core flows green in Maestro, no P0 |
| Beta 1 | G2 (wk 18) | Yappr web power users and Dash community, 50–200 per OS | Testnet (Y0 contracts) | TestFlight external (first build goes through Beta App Review), Play closed | Crash-free ≥ 99.0%, feedback triaged, interop green |
| Beta 2 / RC | G3 (wk 22) | Beta 1 plus an open waitlist, up to 1,000 | **Launch network** (mainnet if Y1/W1/W2/P1 landed) | TestFlight external, Play open testing | Crash-free ≥ 99.5%, audit closed, compliance checklist green |
| GA | G4 (wk 26) | Public | Launch network. If the G2 go/no-go chose testnet, this is a store-listed "testnet public beta" and mainnet GA follows in 1.1. | App Store (phased release, 7 days), Play (staged 5/20/50/100%) | See rollout halt criteria |

**Feedback channels:**
- In-app "Send feedback" with optional diagnostics (a log bundle with secrets
  scrubbed).
- The TestFlight feedback screenshot flow.
- A GitHub Discussions category.

**Weekly triage** is run by QA and the product owner.

## Rollout and halt criteria

- **Halt triggers:** pause the phased or staged rollout if any of the
  following happens.
  - Crash-free sessions fall below 99.3%.
  - A P0 is reported.
  - Sign-in success rate falls below 90%. Measured client-side only when the
    user has opted into diagnostics, otherwise from support reports.
  - Relay error rate exceeds 5%.
  - More than 3 one-star reviews citing the same regression within 24 hours.
- **Hotfix path.**
  - Native changes: a patch release through expedited review if needed.
  - JS-only bug fixes: allowed as code-signed OTA updates from the
    self-hosted update server when they don't change features. Every OTA
    update gets a changelog entry and a runtime-version check, so it never
    reaches incompatible binaries. The signing ceremony needs two people.
- **Store listing.** Screenshots on 6.9" and 6.1" iPhones and Android phones,
  a short privacy-first description, the "requires DashPay" note, the support
  URL, and localized from 1.1.

## Release train after 1.0

- **Cadence.** Minor releases every 4 weeks and patches as needed. SDK and
  platform pins are bumped together with the web's evo-sdk pin, by one PR that
  updates `package.json` and `yappr-platform`'s `Cargo.toml`, and that PR must
  pass both suites.
- **Network upgrades.** Each Dash Platform protocol upgrade needs a
  compatibility RC to be in the stores **before** the network activation
  height. Track it in the platform release calendar.
- **Contract changes.** A new contract version (for example social v10) is
  treated as a coordinated web and mobile release. The mobile build refuses to
  start against a mismatched topology, and shows "Update Yappr" instead.
