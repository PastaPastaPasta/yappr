# Yappr Mobile: lead handoff (2026-10-02)

This hands the "build the Yappr iOS + Android native apps" goal from the laptop session to a new lead agent on the Mac Studio. Read all of it before acting. It is self-contained; the transcript is extra context.

## 0. Where to find things

| What | Where |
| --- | --- |
| **Previous lead transcript** (laptop) | `/Users/pasta/.claude/projects/-Users-pasta--t3-worktrees-yappr-t3code-1b9cd312/f2901b31-a42d-4001-976f-dfe796928b7f.jsonl` |
| Subagent and workflow transcripts (laptop) | `/Users/pasta/.claude/projects/-Users-pasta--t3-worktrees-yappr-t3code-1b9cd312/f2901b31-a42d-4001-976f-dfe796928b7f/subagents/` (workflow journals under `subagents/workflows/wf_*/journal.jsonl`) |
| Lead memory notes (laptop) | `/Users/pasta/.claude/projects/-Users-pasta-workspace-yappr/memory/yappr-mobile-build-goal.md`, `yappr-mobile-roadmap.md`, `yappr-sakura-network.md`, `yappr-v5-beta1-upgrade.md` |
| Specs (repo, on `staging`) | `docs/mobile/`: `ADR-001-mobile-1.0.md` (binding, with amendments), `PRD.md` (141 stories, global rules G-1..G-16, §11.1 lead decisions), `UX_SPEC.md`, `ENGINE.md`, `EXECUTION.md` (waves, PR map, §7 1.0 exit matrix), plus the older long-term roadmap docs |
| App code | `mobile/app` (Expo SDK 57 / RN 0.86.3), `mobile/engine` (WebView engine), `mobile/tools` (test-wallet responder), `mobile/e2e` (Maestro flows), `mobile/CLAUDE.md`, `mobile/RELEASE.md`, `mobile/engine/README.md`, `mobile/app/src/data/README.md` |
| PR screenshots and evidence | Orphan branch **`mobile/evidence`** (`https://github.com/PastaPastaPasta/yappr/tree/mobile/evidence`), one folder per PR, raw URLs `https://raw.githubusercontent.com/PastaPastaPasta/yappr/mobile/evidence/<dir>/<file>` |
| **QA harness, plan and static-review report** | `mobile/evidence` branch → `qa-harness/` (copy of the laptop's `~/workspace/yappr-mobile-qa`, without key files or builds): `QA-PLAN.md`, `AGENT-BRIEF.md`, `REPORT-TEMPLATE.md`, `SR-BRIEF.md`, `STORY-MATRIX.md`, `DEFECT-LEDGER.md`, `bin/` (`qa` device CLI, `persona-key`, `wallet-respond`, `qr-decode`, `build-candidate`, `build-site`, `lib/stories.py`), `env.sh`, `evidence/SR/REPORT.md` |
| Team rules and lanes | `qa-harness/AGENT_RULES.md` (rules every subagent read first), `qa-harness/LANES.md` (device lanes), `qa-harness/upload-evidence.sh`, `qa-harness/extract.sh` |
| Research inputs | `qa-harness/research/`: `web-inventory.md` (web routes, stories, tokens, copy), `advisor-opus.md`, `advisor-fable.md` (the two architecture proposals behind ADR-001) |

## 1. The goal (unchanged)

The user's /goal: using workflows and subagents, implement both iOS and Android native apps for Yappr end to end:
- design, PRDs and specs;
- UX focus, following the web styling;
- implementation with tests and review at every stage;
- PRs to `staging`, thepastaclaw review (or a local review agent when it's backlogged), merge when ready;
- log platform/SDK bugs as issues and work around them;
- robust QA with edge cases resolved.

You are the lead and orchestrator. Decide things yourself, use a Fable advisor for hard calls, and only alert the user for critical blockers.

## 2. Status: implementation is done; QA has not started on devices

All 1.0 scope (ADR-001 E7) is merged to `staging` (head `fe0ae667` at handoff). That's 32 PRs, all merged:

| Area | PRs |
| --- | --- |
| Docs: ADR, PRD, UX spec, engine spec, execution plan | #609 |
| Engine (hidden WebView running web `lib/` + evo-sdk 5.0.0-beta.1, typed RPC) | #610 core, #615 read API, #614 session + write tickets, #619 domain writes/notifications/safety, #618 DMs (v5 + legacy), #629 stale-quorum read retry, #643 engine/data fixes, #646 perf (engine.js 15.4→1.5 MB; Android mount→Ready 3.4→1.4 s) |
| Tools | #611 test-wallet responder (`dash-key:` / `dash-st:` for sakura personas) |
| App foundation | #613 scaffold (expo-router per-tab stacks, NativeWind on the root Tailwind theme, variants devnet/testnet/production, deep links, import-boundary lint), #621 design system + PostCard + `/__gallery`, #626 EngineHost (supervisor, encrypted MMKV, secure store, diagnostics), #630 data layer + session hooks + PostItem |
| Screens (Wave 3) | #636 sign-in/onboarding, #631 home, #632 thread/engagements/media, #634 compose, #637 profiles/graph/bookmarks, #635 explore/search/hashtags, #633 notifications, #641 safety, #639 settings, #640 messages |
| Release + polish | #642 icons/splash/variants/release scripts/eas.json/`mobile-release.yml`, #645 FLAG_SECURE + iOS screen capture (AUTH-12), #647 Android polish (long-press freeze fixed, ripples, keyboard, tab labels) |
| Static-review fixes (47 findings: 8 S2, 30 S3, 9 S4) | #648 writes/compose, #650 DMs, #651 engine lifecycle/caches/offline, #649 app lock/sign-out/deep links/release |

Every PR had an independent `code-review-validator` review, with findings fixed. Most screen PRs also had thepastaclaw reviews, with blocking findings addressed and replies posted. **PRs #643, #645, #646, #647 and #648–#651 were merged before thepastaclaw reviewed them** (its queue was hours long). Check their thepastaclaw reviews when they arrive, and fix any valid blocking findings in follow-up PRs.

Live verification on sakura:
- engine write suite 17/17;
- DM suite green;
- devnet read suite 33 pass, 1 skip;
- testnet reads 34/34.

Screens were verified on the iOS 26.5 simulator and Android 15 emulator, in light and dark, with screenshots.

## 3. In-flight at handoff

1. **M9, Maestro regression suite and CI.** Branch `mobile/maestro-suite` (commit `e1cd6a6a` plus whatever its final push adds). It consolidates the per-screen flows into a suite with shared subflows, a `mobile/e2e/run.sh` runner and `.github/workflows/mobile-e2e.yml`. The exit check (full suite green on both platforms, twice) was still in progress. **No PR was opened.** Next: run the suite on the Studio, fix flakes, open the PR, and merge. See §8 for the agent's final status, if it arrived before handoff.
2. **QA phase, the next big step. Not started on devices.**
   - The plan, harness and stream assignment are ready in `qa-harness/`.
   - The release candidate build (`bin/build-candidate staging`) was started and stopped at handoff, so rebuild on the Studio.
   - The planned model, from the `agentic-qa` skill at `~/.claude/skills/agentic-qa/` (check that it exists on the Studio):
     1. Build release candidates for both variants on both platforms.
     2. Run **8 device streams**: 4 lanes × iOS/Android, each owning one device and one theme, about 3–4 h each. Run them in two waves (L1+L2, then L3+L4) if host load is high.
     3. Every story gets a verdict with screenshot and log proof. Every Tier-A exit row gets all four light/dark × platform cells. There are also 28 edge cases (E-01..E-28): offline, engine kill, app kill mid-write, 504/unconfirmed, quorum errors, RTL, emoji/byte limits, 200% text, small screen, back gestures, a11y.
     4. Consolidate into `DEFECT-LEDGER.md`, `STORY-MATRIX.md`, `EXEC-SUMMARY.md` and `QA-REPORT.md`.
     5. Publish the rendered report on the `mobile/evidence` branch under `qa/`. That's the lead's decision instead of a new public Pages repo. Never publish keys; `build-site` refuses if it finds any.
     6. **Fix loop:** one fix PR per defect or tight group, each validated before and after by an independent agent.
   - The static-review stream already ran; its 47 findings are fixed in #648–#651. Streams should regression-check those areas rather than reproduce them.
   - Lead answers to the harness's open questions:
     - No testnet identity exists, so signed-in testnet checks are BLOCKED; testnet is a read-only, signed-out pass.
     - No physical iPhone, drained identity or banned identity, so those cases are BLOCKED.
     - No iPhone SE simulator.
     - **Sakura DAPI TLS certs expire 2026-10-07.** Finish device QA on sakura before then, or confirm with the sakura/infra owner that they'll be renewed.

## 4. Backlog and decisions to carry

Decided by the lead, still to implement in the QA fix loop:
- **SR-08:** engine restart cap. The PRD wins: 3 restarts within 2 minutes, then stop and show "Couldn't start · Try again". The code still allows 5.
- **SR-20:** the block sheet copy over-promises on devnet. Reword it so it promises only what the network enforces.
- **Android navigation bar** follows the theme (needs `expo-navigation-bar`, a native module; approved). Enable **predictive back**, which is a native config change.
- The deferred items listed in the bodies of #648–#651:
  - SR-05: account-switch write queue;
  - SR-37: ipfs:// length;
  - SR-04: NO_KEY on engagement;
  - G-5: insufficient-credits copy;
  - SR-44: manual AX5 check;
  - SR-25: orphan tracking after kill;
  - SR-26: page cap;
  - SR-12(b): needs a physical device;
  - SR-38: UTF-16 caps on profile, report and block fields;
  - SR-13 extras.
- PRD gaps: **AUTH-14** ("Sign in again" marking for an expired session) is not built.
- **Universal links:** the `public/.well-known/` app-link files (apple-app-site-association, assetlinks.json) are not done. They need the Apple team id and the Android signing SHA-256, which are owner credentials. Custom-scheme links work.

Post-1.0:
- SR-47 hardware-keyboard post shortcut (P1, needs a native module);
- the Rust engine track (ADR E1; required before mainnet);
- push/relay/NSE; private feeds; tips; storefront; blog; image upload.

Known platform limits:
- Android System WebView must be Chrome 110 or newer. The API 29 stock image (WebView 91) shows the update-WebView screen, which is correct.
- iOS Lockdown Mode is detected and explained.
- Owner credentials for TestFlight/Play: Apple developer team, ASC API key, distribution certs and profiles, Play Console account, service account JSON and upload keystore, optional EAS token. See `mobile/RELEASE.md`. Release builds are otherwise ready: `npm run release:ios|release:android`, `eas.json`, `mobile-release.yml`.

## 5. Issues filed (track and update)

- Yappr:
  - #608: `isUsernameContested` runs on an uninitialised WASM instance (web).
  - #612: the `dash-st:` key-registration payload is an untagged IdentityUpdate.
  - #616: `validatePrivateKey` accepts disabled keys (web).
  - #644: a nonce reservation blocks writes for 15 min after a landed write whose answer was lost (web). Mobile works around it via `settleSupersededReplaces` in #643.
- dashpay/platform:
  - #5244: paging past the end of a mixed-direction query fails proof verification; desc is ignored without a range. Mobile treats it as end of list.
  - A comment with field data on the owner's own PR #5236 (stale quorum keys; mobile works around it in #629).
- expo/expo#50949: the dev-launcher "Strip Local Network Keys" phase is skipped on incremental Release builds. Worked around in `release-ios.sh`.
- react-native-menu/menu#1228: `show()` throws on Android New Architecture. Worked around in #647 by using a bottom sheet for long-press.

## 6. Environment to recreate on the Studio

**Toolchain:**
- Xcode 26.6 with the iOS 26.5 simulator runtime.
- Node 22, CocoaPods, JDK 21 (`/usr/libexec/java_home -v 21`).
- Android SDK with NDK 27.1.12297006, the emulator, `system-images;android-35;google_apis;arm64-v8a`, platforms 35/36 and build-tools 35.
- Maestro 2.11 (`curl -Ls https://get.maestro.mobile.dev | bash`).

**Devices:**
- 4 iOS 26.5 iPhone 17 simulators and 4 Pixel 7 API 35 AVDs (2 GB RAM, 4 GB data) as lanes L1–L4. Add a spare pair for ad-hoc work.
- Each lane gets its own Metro port. On the laptop that was 8181–8184, because OrbStack holds 8081/8082; check what's free on the Studio.
- Launch dev clients with the per-variant scheme: `yappr-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>` (devnet, `pr.yap.app.dev`) or `yappr-beta://` (testnet, `pr.yap.app.beta`). Don't use `exp+yappr`, which is ambiguous.
- Build one "golden" dev client per variant from `staging` and install it on every lane. Rebuild only when native modules or config change, and only with lead approval. The native module list is in `mobile/CLAUDE.md`.

**Golden worktree:** a detached worktree of `staging` with `npm ci` run in the repo root, `mobile/app` and `mobile/engine`. New worktrees clone `node_modules` from it with `cp -cR` (APFS clone), then run `npm install` in `mobile/app`.

**Secrets:** sakura pool identities are at `~/.local/share/yappr-sakura-20261001/identities.json` on the laptop. Copy them **securely** to the Studio. Never commit them and never print key material; `qa-harness/bin/persona-key` writes one key to a 0600 file.
- Personas 90–99 are reserved for mobile tests. Persona 99 has proof posts, so avoid writes there.
- The moderation team is personas 5 and 0 plus battery bot 1. Battery bots 0–3 belong to the sakura ops agent. Don't use any of these.
- The variant env comes from the repo: `.env.devnet` is sakura, and testnet uses the production defaults.

**Network:** sakura devnet, Platform 5.0.0-beta.1, protocol 14, social v11 "full M". The quorum service lists only recent quorums, so a transient "Quorum not found in cache" is handled by retry in #629.

## 7. Process notes and gotchas

- **`git fetch` over SSH hangs** in this setup. Use `timeout 90 git -c fetch.prune=false fetch https://github.com/PastaPastaPasta/yappr.git +refs/heads/staging:refs/remotes/origin/staging`. A plain fetch with prune deleted origin refs once. Push with `timeout 120 git push`.
- **Sandbox:** Bash in agent worktrees, devices and the network need `dangerouslyDisableSandbox: true`.
- **Commits** are signed automatically. Never pass `--no-gpg-sign`; never `git add -A`; use conventional commits with the Co-Authored-By trailer.
- **PR bodies:** write each to a unique file under the scratch dir, named for the repo and branch. Read the body back after creating the PR (`gh pr view N --json body`). Link every PR with the t3-code `link_pull_request` tool. Babysit PRs until merged.
- **GitHub comments** need the AI-attribution footer: `---` then "🤖 Posted autonomously by Claude on behalf of pasta."
- **Subagent reports:** a subagent's own review or simplifier subagents often report to the **lead**, not to the subagent that spawned them. Extract the report from the task's `.output` JSONL (see `extract.sh`) to a file and send the path to the subagent.
- **Review-reminder hook:** the PostToolUse hook measures the current worktree's last commit, not the one you committed in. It can fire falsely for small commits made in other worktrees.
- **thepastaclaw:** read its reviews with `gh api repos/PastaPastaPasta/yappr/pulls/N/reviews`. The "Prompt for all review comments with AI agents" block lists the findings. The gate comment shows queue position. The queue ran 4–11 h; merging after a local independent review was accepted by the goal.
- **Required CI** is everything except "End-to-End (devnet, non-blocking)", which fails on staging itself, and "Cloudflare Pages".
- **Disk and load:** the laptop hovered at 25–60 GB free with load 10–170. Remove merged worktrees, delete DerivedData from our builds (only `YapprDev-*`/`YapprBeta-*`, never other projects'), and keep at least 30 GB free.
- **Host load:** heavy load made emulators unreliable, which is why we ran lanes in two waves.
- **Android FLAG_SECURE:** DM screens, key entry, and everything while app lock is on capture black on Android by design. Use `ui-dump` (Maestro hierarchy) as evidence there.
- **Workflows:** large fan-outs (Wave 3 screens, review-fix-merge, static review, SR fixes) worked well as Workflow scripts. Their scripts are saved under `.../f2901b31-.../workflows/scripts/` on the laptop and can be adapted.

## 8. Suggested next steps for the new lead

1. **Set up and verify:**
   - Recreate the environment in §6.
   - Fetch `staging`.
   - Read `docs/mobile/*`, `mobile/CLAUDE.md`, and `qa-harness/` from the `mobile/evidence` branch into a QA workspace, for example `~/workspace/yappr-mobile-qa`. Copy the secrets file and generate persona key files with `bin/persona-key`.
2. **Finish M9:** check out `mobile/maestro-suite`, run the full suite on both platforms twice, open the PR and merge.
3. **Build the release candidate** (`bin/build-candidate staging`) and smoke it.
4. **Run the QA streams** per `QA-PLAN.md` §4, as a Workflow. Wave L1+L2, then L3+L4, then consolidate into the ledger, matrix and summary. Publish to `mobile/evidence/qa/`.
5. **Fix loop:**
   - one PR per defect or group, each with independent before/after validation;
   - include the §4 backlog (SR-08 restart cap, SR-20 copy, nav bar + predictive back, AUTH-14, the deferred SR items);
   - check late thepastaclaw reviews on the PRs merged before review.
6. **Re-run** a smoke QA plus the Maestro suite on the final `staging`. Report to the user:
   - what shipped and the QA verdict;
   - what's blocked on owner credentials (TestFlight/Play, universal links);
   - the post-1.0 list.
