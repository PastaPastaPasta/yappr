# Yappr Mobile 1.0: product requirements

- **Status:** draft for 1.0, 2026-10-01.
- **Binding input:** [ADR-001](ADR-001-mobile-1.0.md). Where this document and the ADR disagree, the ADR wins and this document is wrong.
- **Companion:** [UX_SPEC.md](UX_SPEC.md) is the design spec that screens are built from (tokens, components, navigation, every screen, copy deck). This PRD says *what* 1.0 does and how we know it works; UX_SPEC says *what it looks like*.
- **Older docs:** [PRODUCT_UX.md](PRODUCT_UX.md) keeps the product principles and copy rules. For 1.0 scope, navigation and behaviour, this PRD and UX_SPEC are the source of truth.
- **Source of current behaviour:** the web app in this repo. Every limit and every reused string below was checked against the code (`lib/`, `components/`, `app/`); file references are given where it matters.

## Contents

1. [Summary](#1-summary)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Builds, networks and topology gating](#3-builds-networks-and-topology-gating)
4. [Personas](#4-personas)
5. [Success metrics](#5-success-metrics)
6. [Product decisions made in this PRD](#6-product-decisions-made-in-this-prd)
7. [Global acceptance rules](#7-global-acceptance-rules)
8. [User story catalogue](#8-user-story-catalogue)
9. [Deferred (post-1.0)](#9-deferred-post-10)
10. [ADR E7 traceability](#10-adr-e7-traceability)
11. [Open questions](#11-open-questions)

---

## 1. Summary

Yappr Mobile 1.0 is a native iOS and Android client for Yappr, the social app on Dash Platform. It reads and writes the same documents as the web app, through a headless engine that runs the web's own `lib/` (ADR E1). The UI is native React Native (Expo) with the web's design tokens (ADR E3), a five-tab layout (ADR E4), and wallet-first sign-in (ADR E5).

1.0 ships as signed builds on TestFlight and the Play internal or closed track, in two variants: **devnet** (sakura) and **testnet** (the production yap.pr contracts). There is no store listing in 1.0; a public store release also needs account deletion, profile and DM reports and the moderation work in [COMPLIANCE.md](COMPLIANCE.md).

## 2. Goals and non-goals

### Goals

| # | Goal | How we know |
| --- | --- | --- |
| G1 | A web Yappr user can do everything they do daily on web, on their phone: read, post, reply, quote, like, repost, bookmark, follow, message, block and report | Every P0 story in section 8 passes with evidence on both platforms |
| G2 | It feels like a native app, not a website | Native tabs, stacks, sheets, gestures, haptics, share sheet, pull to refresh, Dynamic Type; App Review guideline 4.2 risk is nil |
| G3 | Dash Platform's realities are handled honestly | Every write shows its real state (posting, not confirmed, failed); no write is replayed blindly; every error says what happened and whether anything was charged |
| G4 | Contract churn costs mobile nothing but a rebuild | No screen checks a build variant or a topology name; screens read capabilities from the engine (section 3) |
| G5 | Agents and QA can test everything without a human wallet | The test-wallet responder drives key exchange; Maestro covers the ADR E8 flows |

### Non-goals for 1.0

- A wallet, an exchange, or any purchase of DASH, credits or YAPP.
- Hiding that identities and writes cost credits.
- Push notifications, background sync, widgets, share extension (ADR E7 deferred list).
- Feature parity with web for storefront, blog, private feeds, tips, poll voting, DPNS registration, image upload, moderator tools.
- iPad and tablet layouts, localization. The app chrome is English only; user content in any script renders correctly.
- Analytics or crash-reporting SDKs (ADR "these stand"; README D14).

## 3. Builds, networks and topology gating

### Builds

| Variant | Bundle id | Network | Social topology | DM | Profile shape |
| --- | --- | --- | --- | --- | --- |
| `devnet` | `pr.yap.app.dev` | sakura (Platform 5.0.0-beta.1) | the dev cut set in `.env.devnet`: v10 today, v11 once `docs/SOCIAL_V11.md` merges | DM v5 | DashPay `profile` + `yapprProfile` |
| `testnet` | `pr.yap.app.beta` | testnet, production yap.pr contracts | v2 | DM v3 (legacy) | profile contract `profile` |

### Capability flags

**Rule:** the UI never branches on the variant or on a topology name. `engine.info()` returns a `capabilities` object that the engine computes from the `lib/contract-topology.ts` predicates and the `lib/compose/limits.ts` limits. The React Native side does **not** import those modules at runtime (ADR E2 as amended); every limit and flag below reaches the UI through `engine.info()`. The last known value is persisted, so a cold start renders correctly before the engine is up. Stories below name the flag in their **Gating** line.

| Flag | Computed in the engine from | v2 (testnet) | dev (v10/v11) |
| --- | --- | --- | --- |
| `contentLimits` | `contentLimits()` | 500 characters, no byte limit | 1000 characters **and** 2000 UTF-8 bytes |
| `topSort` | `windowedRankingsAvailable()` | no | yes; windows "3 days" (posts) and "24h" (hashtags), plus All time |
| `topCreators` | `prefixRankingsAvailable()` | no | yes (all-time only) |
| `repostsAreQuotes` | `repostsAreQuotes()` | no: a `repost` document | yes: a content-less quote post, one quote-or-repost per author and target |
| `canRepost(kind)` | `canRepost()` | post and reply | post and reply |
| `canBookmark(kind)` | `canBookmark()` | post and reply | post only |
| `reports` | `contractTakesReports()` | no | yes |
| `reportsResolved` | `reportsAreResolved()` | no | yes (v10+) |
| `moderated` | `contractIsModerated()` | no | yes (removed-by-moderator stubs) |
| `deletesLeaveHoles` | `authorDeletesLeaveHoles()` | no | yes ("deleted by its author" stubs) |
| `removalKeepsFields` | `removalKeptFieldsFor()` (v11) | no | v11 only |
| `hashtagsInline` | `hashtagsAreInline()` | no: every tag indexed, max 63 | yes: only the first tag indexed, max 61 (`HASHTAG_MAX_LENGTH`) |
| `mentionsInline` | `mentionsAreInline()` | no: every mention indexed | yes: only the first mention indexed and notified |
| `feedLanguage` | `postsHaveLanguage()` | yes (For You is per language) | no |
| `notificationsWindowed` | `notificationsAreWindowed()` | no | yes (reply and quote sources are 3.5-day windows) |
| `likeNotificationsTimeless` | `likeNotificationsAreTimeless()` (v11) | no | v11 only |
| `profileExtension` | `dashpayProfileExtension()` | no; name 50, bio 160 | yes; name 25, bio 140 (`DASHPAY_PROFILE_LIMITS`) |
| `mediaHashes` | `mediaCarriesHashes()` | no | yes ("Media changed since posting") |
| `yapp` | `tokenCostFor()`, `yappIsLocked()` | YAPP **required**: post 10, reply 3, like 1, repost 1 | YAPP optional and locked; credits always work |
| `dmVersion` | `dmIsV5()` | `v3` (1:1 only, read receipts) | `v5` (1:1 and groups, no read receipts) |

In story **Gating** lines: `all` = every build; `v2` = testnet build; `dev` = devnet build (v10 or v11); `v11` = v11 only. A gated-off feature is **absent**, never shown disabled and never "coming soon".

## 4. Personas

### P-A. Dana, new to Yappr, arriving from a Dash wallet

- **Situation.** Has a Dash wallet with an identity and maybe a username. Heard about Yappr in the Dash community. Has never used the web app.
- **Wants.** To sign in with one approval in the wallet, see a lively feed straight away, and post without learning about keys.
- **Fears.** Pasting secrets; losing money by accident; not knowing whether a post "worked".
- **1.0 must:** make wallet sign-in the default and obvious (AUTH-03, AUTH-04); never require a profile step (AUTH-15); explain fees in plain words when they bite (G-5); show honest write status (COMP-10).

### P-B. Sam, an existing web Yappr user

- **Situation.** Posts from desktop on yap.pr; signs in with the wallet QR; has followers, DMs and bookmarks.
- **Wants.** The same identity, feed, DMs and bookmarks on the phone, with notifications in a tab instead of a menu.
- **Fears.** Things that work on web missing or behaving differently; a second account; duplicate posts.
- **1.0 must:** sync everything through the same documents (all of section 8); keep web's copy and limits; show web-only features (blog, store, private feeds) as links out, never as broken screens.

### P-C. Lee, a lurker who browses signed out

- **Situation.** Curious; no identity yet or doesn't want to sign in on this phone.
- **Wants.** To read the public feed, profiles, threads, hashtags and search without an account.
- **1.0 must:** open Home without sign-in (AUTH-02); gate every write behind a sign-in sheet that returns to the same place (G-8); never fetch remote media from strangers without a tap (SAFE-07).

### P-D. Quinn, QA engineer or test agent

- **Situation.** Runs Maestro flows and agent QA on simulators and emulators against sakura pool identities. Has no human wallet.
- **Wants.** Deterministic sign-in, visible engine state, a way to export diagnostics, and stable accessibility identifiers.
- **1.0 must:** support key-exchange through the Node test-wallet responder and private key entry (AUTH-03, AUTH-08); expose Troubleshooting (diagnostics, SET-08); give every interactive element a stable `testID` (A11Y-08).

## 5. Success metrics

There is no analytics or crash SDK. Every metric is measured from the stores, CI, the engine contract tests, or voluntary feedback.

| # | Metric | 1.0 target | How it is measured |
| --- | --- | --- | --- |
| M1 | Crash rate (iOS) | ≤ 1 crash per 100 tester sessions; no crash signature from 3 or more testers | TestFlight crash reports, Xcode Organizer |
| M2 | Crash rate (Android) | Pre-launch report clean on the device matrix; no crash cluster in closed-track vitals | Play Console pre-launch report and Android vitals |
| M3 | P0 story pass rate | 100% of P0 stories pass on iOS and Android, light and dark, with screenshot evidence | Agentic QA story matrix; Maestro |
| M4 | ADR E8 flows | Signed-out browse, key sign-in, key exchange, post, like, reply, follow, DM round trip, block and report all green on iOS and Android on every release candidate. Read flows run on both variants; write flows run on the devnet build only, with sakura pool identities (ADR E6). Until sakura has a seated moderation team or an interim owner, the report flow accepts the email path (SAFE-05) in place of the form. | Maestro on CI (smoke on every PR, write flows nightly) |
| M5 | Write reliability | ≥ 99% of engine contract-test writes become visible within 2 minutes on sakura; zero duplicate documents from any retry path | Engine contract tests (ADR E8), run serially with retries |
| M6 | Cold start | Cached feed visible ≤ 1.5 s; fresh feed ≤ 3.0 s p75 on 4G | Manual perf harness on the mid-tier device, timings read from Troubleshooting (SET-08) |
| M7 | Engine boot | Reported per build; budget set by the engine PR (ADR E1) | Troubleshooting (SET-08) "boot" field |
| M8 | Scroll | ≥ 58 fps p95 on Home; no frame over 50 ms | Perf monitor on the mid-tier device, per QA_RELEASE budgets |
| M9 | Sign-in success | ≥ 90% of beta testers who try wallet sign-in succeed on the first attempt | One question in the beta feedback form; support reports |
| M10 | Beta satisfaction | Median ≥ 4 of 5 on "How native does Yappr feel?" and "Did you trust that your posts went through?" | Beta feedback form (GitHub Discussions + TestFlight feedback) |
| M11 | Accessibility | Zero open P0 accessibility defects; every screen usable at the largest text size and with VoiceOver and TalkBack | QA accessibility audit per release candidate |
| M12 | Size | iOS download ≤ 60 MB; Android ≤ 45 MB per ABI split | App Store Connect and Play Console size reports |

## 6. Product decisions made in this PRD

These fill gaps the ADR leaves open. Each can be overturned by the product owner; section 11 lists the ones that most need a look.

| # | Decision | Why |
| --- | --- | --- |
| PD-1 | The EULA / community-rules gate is shown once per identity per network, at the end of sign-in, and must be accepted to finish signing in. Declining signs that account out. It is shown again when the terms version changes. | COMPLIANCE C4 asks for acceptance before the first post; doing it at sign-in is simpler than gating each write and covers DMs too. |
| PD-2 | A DPNS username is **not** required. An identity without one uses the app normally, shown by its truncated ID, with a dismissible "Get a username" card that opens yap.pr. | Web forces `/dpns/register`, but registration is deferred on mobile (ADR E7); forcing it would lock Dana out. |
| PD-3 | Compose closes on Post. The post appears at once at the top of the list it belongs to, with an inline write status. There is no offline write queue: drafts persist instead. | Native convention; and a queued write that fires hours later with a stale nonce or a changed balance is worse than a saved draft. |
| PD-4 | Closing a non-empty composer asks "Save draft / Delete draft / Cancel". Drafts are per account and per context (new post, reply to X, quote of X), restored after a kill or crash. | ADR E4 "drafts persist". |
| PD-5 | Blocking asks for confirmation in a sheet that explains the effect and offers the optional block note (≤ 280). Web blocks in one tap. | A block is a public on-chain document that costs credits; confirm before writing. |
| PD-6 | Unfollow from the profile button asks for confirmation (action sheet). Follow does not. | Native convention; unfollow is a paid delete. |
| PD-7 | After a signed-out user signs in from a write action, they return to the same screen and scroll position, and the action is **not** performed automatically. Compose is the exception: it opens with their text. | A paid write should never happen without a tap the user can see. |
| PD-8 | NSFW mode defaults to **Warn first**, as on web. The cover is opaque, so nothing flagged is shown before the user asks. | Matches web; satisfies "hidden until consent". |
| PD-9 | Link previews are fetched by the engine directly from the linked site (no third-party CORS proxy is needed outside a browser). The privacy disclosure says the linked site can see the request. YouTube links show a thumbnail that opens YouTube; there are no in-app web embeds. | The UI never renders web content (ADR E1 host rules, guideline 4.2). |
| PD-10 | Post search is a substring match over the most recent 100 posts, as on web, and the UI labels it "Recent posts" so nobody expects full-text search. | Web behaviour (`app/explore/page.tsx`); there is no full-text index on chain. |
| PD-11 | YAPP: no purchase, no starter-grant claim, no "pay with" setting in 1.0. Writes use web's default plan ("YAPP when I have enough, else credits"). On v2, where YAPP is required, a shortfall shows a message linking to yap.pr. The YAPP balance is shown read-only in Settings → Account where the contract has a token. | ADR E7 defers tips and has no token scope; v2 still needs YAPP to write (`contracts/yappr-social-contract-v2.json` `tokenCost`). |
| PD-12 | Settings are device-wide, as on web (theme, NSFW mode, media gate, link previews, notification types). Per account: drafts, notification read state, last feed tab and sort, the EULA acceptance, DM state. | Matches web's settings store; avoids surprising per-account toggles. |
| PD-13 | On v2, where the contract takes no reports, "Report" opens an email to the Yappr support address with the post link prefilled. | COMPLIANCE's out-of-band channel; keeps a report path in every build. |
| PD-14 | Images open in a native full-screen viewer with pinch-zoom, swipe-to-dismiss and Save / Share. | Native convention; web has no viewer. |
| PD-15 | Light-mode text links, hashtags, mentions and active action counts use darker shades than web (`yappr-700`, `red-600`, `green-700`) so text meets WCAG AA. Dark mode keeps web's shades. Filled primary buttons keep web's `yappr-500`. | AA is a release bar (PRODUCT_UX); `#0ea5e9` on white is 2.77:1. See OQ-2 for buttons. |
| PD-16 | The engagements screen (likes, quotes, reposts) is readable signed out. Web requires sign-in. | All three lists are public reads; the follow buttons on it gate on sign-in as usual. |
| PD-17 | Under iOS Lockdown Mode the app shows the explanation screen and lets the user browse the cached feed read-only. | ADR E1 accepted cost; the cache is still useful. |
| PD-18 | "Mute" does not exist; block covers it, as on web. | Web parity; muted words are 1.1. |

## 7. Global acceptance rules

Every story inherits these rules. A story repeats one only to add something specific.

| Rule | Applies to | Acceptance |
| --- | --- | --- |
| **G-1 Offline** | Every screen | Given the OS reports no connectivity, the screen shows its persisted cache and the offline banner "You're offline. Showing saved posts." A write tap makes no optimistic change and shows the toast "You're offline. Try again when you're connected." (nothing is sent) Compose stays usable and its Post button is disabled with the hint "You're offline". When connectivity returns the banner hides, and visible lists refresh once. |
| **G-2 Engine booting** | Every screen | While the engine boots, cached content renders at once and a "Connecting to Dash Platform…" state shows only where there is no cache. Reads issued during boot are queued and resolve after boot. A write issued during boot is queued, shown optimistically, and resolves like any other write. |
| **G-3 Unconfirmed write** | Every write | When the broadcast succeeds but the confirmation wait times out (the DAPI 504 in the root CLAUDE.md), or an engine restart cuts the call short, the write counts as done: no toast, and the optimistic state stays. The app re-checks it by itself 5, 20, 80 and 130 s after, when the app returns to the foreground, and when a feed, profile, thread or conversation read shows it; nobody is asked to check. A check proves a write absent only 2 minutes after it stopped (it may still be on its way before then); a proved absence rolls it back with its failure sentence (G-4). Posts keep "Posting…" (COMP-10) and messages "Sending…" (DM-04) while the checks run. A write that may have landed is never resent, automatically or by a blind Retry. |
| **G-4 Failed write** | Every write | The optimistic change rolls back, a toast shows one sentence (6 s for messages over 80 characters, else 3 s), and a haptic error fires: the mobile copy for its engine code where the user can act on it (out of credits or YAPP, not allowed from this account, the post no longer exists, update the app, a defect), otherwise the write's own failure sentence ("Couldn't like this post. Try again."), the same for a refusal and a write a check proved absent (UX_SPEC §5.4.1). `categorizeError`'s text goes to diagnostics only. A refusal for a passing reason (a parent too young to reference, a fee multiplier that moved) is sent again by the engine after 2, 5 and 15 s before it is reported. Composer text is never lost: it returns to the draft. |
| **G-5 Insufficient credits** | Every paid write | When the identity's credit balance cannot cover the write: toast "You don't have enough credits for this. Top up from your Dash wallet." When YAPP is short: "You need YAPP for this." with a "Get YAPP" action (yap.pr). Nothing is retried. |
| **G-6 Blocked authors** | Every list and thread | Content whose author the viewer blocks (own block or a followed block list) is removed from feeds, search, hashtag pages, profiles' lists, engagements lists and notifications as soon as the block is known, including from caches. In a thread, a reply by a blocked author collapses to "Reply from an account you blocked" with no content. Quote embeds of blocked authors show "Post from an account you blocked". |
| **G-7 Missing documents** | Every post reference | A post or reply that is gone renders the stub from POST-04, never a blank space or an infinite skeleton. |
| **G-8 Signed out** | Every write control | Write controls stay visible. A tap opens the sign-in sheet; after sign-in the user returns to the same screen and position and the action is not performed (PD-7), except compose, which reopens with its text. |
| **G-9 Text** | Every user-content text | Text renders with `whitespace-pre-wrap` semantics (line breaks kept), long unbroken strings wrap, and each paragraph takes its natural direction (Arabic and Hebrew right-aligned). Emoji, ZWJ sequences and combining marks render intact and are never cut mid-grapheme by truncation. Links, `@mentions`, `#hashtags` and `$cashtags` are tappable. The Markdown subset web renders (`**bold**`, `*italic*`, `` `code` ``) renders the same. |
| **G-10 Gating** | Every gated feature | A feature whose capability flag is off is absent from the UI. |
| **G-11 Read errors** | Every list and detail | A failed read shows an inline error state with the categorized message and "Try again". A failed page in an infinite list shows a "Load more" footer instead. "Dash Platform is temporarily unavailable. Please try again in a few moments." is used for DAPI unavailability. |
| **G-12 Theme and type** | Every screen | Correct in light and dark mode, and at every text size from the smallest to AX5 (iOS) / 200% (Android), with no clipped or overlapping text. |
| **G-13 Formatting** | Every time and count | Times use `formatTimeCompact` (`30s`, `2m`, `3h`, `4d`, then `Mar 4`, with the year when not the current one). Counts use `formatNumber` (`1.2K`, `3.4M`); a zero count is blank. |
| **G-14 Content gates** | Every post surface | The NSFW gate (SAFE-06) and the media gate (SAFE-07) apply on every surface that shows a post: feeds, threads, profiles, search, hashtags, bookmarks, quotes and notifications. |
| **G-15 Private posts** | Every post surface | An encrypted private-feed post renders the "Private post" placeholder (POST-08). |
| **G-16 Accessibility** | Every control | A screen-reader label, a role, a hit target of at least 44 pt / 48 dp, and a stable `testID`. |

---

## 8. User story catalogue

Priorities: **P0** must ship, **P1** should ship, **P2** nice to have. Gating values are defined in [section 3](#capability-flags).

### 8.1 Onboarding and auth (AUTH)

#### AUTH-01 · Welcome · P0 · all
As a first-time user, I want a short welcome that tells me what Yappr is, so that I can choose to sign in or just look around.
- Given a fresh install, when the app opens, then the Welcome screen shows the Yappr wordmark, the line "The decentralized social platform where you own your data, your identity, and your voice.", the network chip, a primary "Sign in" button and a secondary "Browse without signing in" button.
- "Sign in" opens the sign-in screen (AUTH-03). "Browse without signing in" opens Home, For You, signed out.
- After either choice, later launches go straight to Home. Welcome shows again only after the last account signs out.
- The Welcome screen makes no network call; it renders offline.

#### AUTH-02 · Browse signed out · P0 · all
As a lurker, I want to read Yappr without an account, so that I can decide whether it is worth joining.
- Home shows For You. The Following tab shows "See posts from people you follow / Sign in to see posts from people you follow." with a "Sign in" button.
- Explore, search, hashtag pages, profiles, followers and following lists, post details and engagements all work signed out.
- The Notifications and Messages tabs show a signed-out placeholder with a "Sign in" button and no data.
- The Profile tab shows a signed-out screen with "Sign in" and links to Settings sections that need no account: Appearance, Privacy & Safety (content settings only) and About. Troubleshooting (SET-08) stays reachable signed out, from the bottom of About.
- All media is gated while signed out unless the media-gate setting is off (SAFE-07), as on web.
- Every write control follows G-8.

#### AUTH-03 · Sign in with a wallet on this phone · P0 · all
As Dana, I want to sign in by approving a request in my Dash wallet on the same phone, so that I never handle a key.
- The sign-in screen leads with "Sign in with your Dash wallet". Tapping "Open wallet" creates a `dash-key:` request through `vendor/platform-auth` and opens it with the OS URL handler.
- While waiting, the screen shows "Waiting for your wallet…", the wallet hint "Approve the request in your wallet, then come back here", a "Cancel" button and an "Open wallet again" button. There is no visible countdown.
- The app polls for the response while in the foreground and polls again immediately each time it returns to the foreground.
- On a response, the screen shows "Wallet approved. Unlocking your keys", then "Checking your identity", then continues to key registration if needed (AUTH-06), then the EULA (AUTH-09), then Home.
- Each polling run lasts the platform-auth timeout (`DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.timeoutMs`, 120 s), as web. When it ends without a response, the screen shows "No response from your wallet yet / Approve the request in your wallet, then check again for a fresh code." with "Check again".
- "Check again" polls the same request once more while it is less than 10 minutes old, and otherwise creates a fresh request. Returning to the foreground does the same. The 10-minute window is a mobile decision (OQ-11).
- If the app is killed while waiting, reopening it within the 10 minutes resumes the same request; after that, it returns to the sign-in screen.
- "Cancel" abandons the request and returns to the sign-in screen with no error.
- With the test-wallet responder (ADR E5.4), the whole flow completes without a human on both platforms.

#### AUTH-04 · Sign in with a wallet on another device · P0 · all
As Sam, whose wallet is on another phone, I want to scan a QR code, so that I can sign in here.
- The sign-in screen has "Use a wallet on another device", which shows the request as a QR code (at least 240 × 240 pt, white quiet zone, readable in dark mode) and a "Copy link" button that shows "Copied" for 2 s.
- Polling, "Check again", the 10-minute window and cancel behave as AUTH-03.
- The QR screen keeps the display awake (idle timer off) while shown.

#### AUTH-05 · No wallet installed · P0 · all
As Dana, if I have no Dash wallet on this phone, I want to be told what to do, so that I'm not stuck.
- When no app handles `dash-key:` (iOS `canOpenURL` with the scheme declared in `LSApplicationQueriesSchemes`; Android `queryIntentActivities`), "Open wallet" is replaced by the explanation "Yappr uses a Dash wallet for your identity. No wallet on this phone handles Dash sign-in links." with "Get a Dash wallet" (store link) and "Use a wallet on another device" (AUTH-04).
- If the open attempt fails anyway, the same explanation appears, with the web copy "Nothing opened? No wallet app on this device handles Dash links. Scan the QR code with a wallet on another device, or copy the link into your wallet."
- A "New to Dash?" link opens the identity bridge (testnet, devnet) in the in-app browser.

#### AUTH-06 · First-time key registration · P0 · all
As a user whose identity has never used Yappr, I want the app to add its keys in one more wallet step, so that I can sign in.
- When the identity lacks the keys Yappr needs, the app shows "First time login" with "Keys to be added:" listing each key's purpose, and "Continue in wallet", which opens the unsigned `dash-st:` IdentityUpdate.
- After the wallet signs and broadcasts, the screen shows "Finishing setup… This can take up to a minute." and polls the identity until the keys are on chain.
- After 60 s without the keys, it shows "Still confirming. We'll keep checking." and keeps polling in the foreground for up to 10 minutes, with a "Check now" button.
- If the wallet reports an error or the user cancels, the screen returns to the sign-in screen with "Sign-in failed" and the categorized reason.

#### AUTH-07 · Sign-in failures · P0 · all
As any user, I want a clear message when sign-in fails, so that I know what to fix.
- Wrong network (the wallet answered for another network): "This wallet is on a different network. Switch your wallet to {Devnet|Testnet} and try again."
- Identity not found on this network: "No identity was found for this wallet on {network}."
- The request could not be created: "Couldn't reach your wallet / Something went wrong while creating the sign-in request." with "Try again".
- DAPI unavailable during "Checking your identity": the G-11 message with "Try again"; the wallet approval is kept and reused.
- Each failure state has exactly one primary action.

#### AUTH-08 · Sign in with a private key · P0 · all
As Quinn, I want to paste a private key, so that I can sign in pool identities without a wallet.
- Under "Other ways to sign in", "Sign in with a private key" opens a screen with one secure field, placeholder "WIF or hex private key", a show/hide toggle ("Show key" / "Hide key"), and the note "Your key stays on this device. Every signature happens locally."
- On input, the app finds the identity by `identities.byPublicKeyHash` and shows "Identity found" with its name or truncated ID, or an error: "Invalid private key", "This key is for a different network", "No identity uses this key".
- The key must match an AUTHENTICATION key of security level HIGH or CRITICAL on that identity; otherwise "Private key does not match this identity".
- "Sign in" stores the key in the Keychain / Keystore under that identity and network, then continues to the EULA (AUTH-09).
- The field has autocorrect and autofill suggestions off. The value is never logged, crosses the bridge only to the engine's signer, and is cleared when the screen closes.
- Passwords and passkeys are not offered (ADR E5).

#### AUTH-09 · Accept the terms and community rules · P0 · all
As the operator, I need every signed-in identity to accept the terms with a zero-tolerance clause, so that the apps meet UGC policy.
- After the first successful sign-in of an identity on this device and network, a full-screen "Before you start" screen shows the community-rules summary (UX_SPEC copy deck), links to Terms of Use, Privacy Policy and Community rules (in-app browser), and "Agree and continue".
- "Agree and continue" records acceptance (identity, network, terms version, time) locally and opens Home.
- "Not now" signs that account out and returns to the previous screen.
- When the terms version bundled in the app changes, the screen shows again on the next launch for each signed-in account, before any content.
- Signed-out browsing never shows this screen.

#### AUTH-10 · Multiple accounts · P0 · all
As Sam, who has a personal and a test identity, I want to add and switch accounts, so that I don't have to sign out.
- Settings → Account → "Accounts" lists each signed-in identity with avatar, name or truncated ID, and network. The current one has a check mark.
- "Add account" runs the sign-in flow; an identity already signed in on this network switches to it instead.
- Long-press on the Profile tab (iOS and Android) opens the account switcher sheet with the same list.
- Switching reloads all screens for the new identity: feeds, notifications, badges, messages, drafts and read state are per account. The switch completes with no stale data from the previous account visible.
- Accounts are scoped by network: a devnet build never lists testnet identities.

#### AUTH-11 · Sign out · P0 · all
As any user, I want to sign out of an account, so that its keys leave this phone.
- Settings → Account → "Sign out" asks "Sign out of @name? / Your keys for this account are removed from this phone. Your posts and data stay on Dash Platform." with "Sign out" (destructive) and "Cancel".
- Signing out deletes that identity's secrets from the Keychain / Keystore, its drafts, caches, notification read state and DM state, and switches to another account if one exists, else to Home signed out.
- No network call is needed; it works offline.

#### AUTH-12 · Biometric app lock · P0 · all
As a user with a shared phone, I want Face ID or fingerprint before Yappr opens, so that others can't post as me.
- Settings → Account → "App lock" toggle ("Require Face ID" / "Require Touch ID" / "Require fingerprint or device PIN", by device) with a timeout: Immediately, After 1 minute, After 5 minutes, After 15 minutes.
- When on, launching or resuming after the timeout shows a lock screen with the app icon and "Unlock". The OS prompt allows the device passcode fallback.
- While locked, the app switcher snapshot shows the lock screen, not content.
- Turning it on requires one successful biometric check.

#### AUTH-13 · App Connect (flagged off) · P2 · all
As the team, we want App Connect implemented behind `FEATURE_APP_CONNECT`, so that we can turn it on when a wallet ships it.
- With the flag off (every 1.0 build), no App Connect UI appears anywhere.
- With the flag on in a dev build, a third method "Connect with App Connect" follows `platform/docs/protocol/app-connect.md`, and the `https://yap.pr/app/connect?r=` return route resumes the waiting screen.

#### AUTH-14 · Session expired or key revoked · P1 · all
As any user, I want to be told when my stored key no longer works, so that I can sign in again.
- When a write fails with an expired session or a disabled or unknown key, the toast reads "Your session has expired. Please sign in again." and the account is marked "Sign in again" in the account list.
- Reads keep working for that account. Write controls open the "Sign in again" sheet ("Sign in again to keep posting as @x. You can keep browsing in the meantime."), whose button opens the sign-in flow for the same identity ("Sign in again as @x with its wallet or key."). The engine restarts before and after that sign-in under one progress label, "Signing in as @x…".
- A wallet whose Yappr key was disabled on the identity can't sign in: "This wallet's Yappr key was turned off, so it can't sign in. Add a new key from your wallet, or sign in with a private key." (A disabled key can't be re-enabled.)

#### AUTH-15 · No profile, no username · P1 · all
As Dana, who has no username and no Yappr profile, I want to use the app anyway, so that I'm not forced through setup.
- There is no profile step after sign-in (README D15).
- Display fallback everywhere: profile display name → DPNS label → truncated identity ID (`xxxxxxxx…yyyyyy`, monospace, tap to copy with toast "Identity ID copied").
- Home shows a dismissible card "Get a username / Usernames make you easy to find. Register one on yap.pr." with "Open yap.pr" (in-app browser to `/dpns/register`). Dismissal is remembered per account.
- The first profile save from Edit profile creates the profile (PROF-07, PROF-08).

### 8.2 Home feed (FEED)

#### FEED-01 · For You · P0 · all
As any user, I want a feed of everyone's recent posts, so that I can see what's happening.
- Home opens on the last used tab (FEED-03), else For You.
- For You lists posts newest first: on v2 the global timeline in the feed language (FEED-10), on dev one global timeline. Reposts and quotes appear as on web (FEED-08).
- First load with no cache shows 4 post skeletons and "Connecting to Dash Platform…" under them while the engine boots.
- Empty: "No posts yet / Be the first to share something!".
- End of list: "You've reached the end." On testnet only, it is followed by "Looking for older posts? Open Yappr classic ↗" (opens the legacy link web shows, in the in-app browser). Empty states never show that link, and mainnet and devnet builds never show it.
- Private, NSFW-hidden and blocked content follows G-6, G-14, G-15.

#### FEED-02 · Following · P0 · all
As Sam, I want a feed of only the people I follow, so that I don't miss them.
- The Following tab lists posts and reposts from followed identities, newest first.
- Empty: "Your following feed is empty / Follow some people to see their posts here!" with an "Explore" button that opens the Explore tab.
- Signed out: the prompt in AUTH-02.

#### FEED-03 · Remember tab and sort · P1 · all
As a user, I want Home to open where I left it, so that I don't re-pick each time.
- The tab (For You / Following) and sort (Recent / Top, with window) are saved per account and restored on launch and after an account switch.

#### FEED-04 · Top sort · P0 · dev (`topSort`)
As a user, I want to see the most-liked posts, so that I can catch up on what matters.
- Under the For You / Following tabs, a segmented control "Recent / Top" shows. When Top is selected, a second control shows the windows: "3 days" and "All time".
- For You Top lists the most-liked posts in the window; Following Top lists the most-liked posts from followed identities.
- Posts removed by moderators are filtered out of Top. On v11 a like that was undone keeps counting until its window passes; the UI shows whatever the engine returns and does not recompute.
- Empty: "No liked posts yet / The most-liked posts will appear here" (Following: "The most-liked posts from people you follow will appear here").
- The new-posts pill (FEED-05) does not run in Top.
- On v2 neither control exists.

#### FEED-05 · New posts pill · P0 · all
As a reader, I want to know when new posts arrive without losing my place, so that the feed never jumps.
- While Home is visible, the app is in the foreground and the sort is Recent, the engine checks for newer posts every 15 s.
- When there are N > 0 newer posts, a pill "Show N new posts" ("Show 1 new post") floats below the header. The list does not move.
- Tapping the pill inserts the posts at the top, scrolls to the top with animation (instant with Reduce Motion), and hides the pill.
- Tapping the Home tab while on Home scrolls to the top; if the pill is visible it also loads the new posts.
- Polling stops when Home is not visible or the app is in the background, and runs once immediately on return.

#### FEED-06 · Pull to refresh · P0 · all
As a reader, I want to pull down to refresh, so that I get the latest.
- Native pull-to-refresh (iOS `UIRefreshControl`, Android `SwipeRefreshLayout` look) tinted `yappr-500`.
- Refresh reloads the first page, merges any new posts at the top, clears the pill and keeps the reading position when the user was not at the top.
- Refresh while offline ends immediately with the G-1 toast.

#### FEED-07 · Infinite scroll · P0 · all
As a reader, I want the feed to keep loading as I scroll, so that I never hit a wall.
- The next page is requested when the user is within 1.5 screen heights of the end.
- While loading, a footer spinner shows. A failed page shows a "Load more" pill (`yappr-500`) that retries.
- No more than 3 pages load automatically without a new user scroll; after that the "Load more" pill shows, as web.
- Scrolling 500 posts keeps memory flat (the QA_RELEASE memory budget: no growth over a 500-post scroll).

#### FEED-08 · Reposts and quotes in feeds · P0 · all
As a reader, I want to see who reposted something and what a quote quotes, so that I understand why a post is in my feed.
- A repost renders the original post with a banner "↻ {name} reposted" above the header ("You reposted" for the viewer). Tapping the banner opens the reposter's profile.
- On dev a bare repost (a quote post with no content) renders exactly like a repost. A quote with content renders the quoting post with the quoted post embedded.
- The same original reposted by several followed identities appears once, with the most recent reposter.
- A quote of a missing post shows the embed stub (POST-04).

#### FEED-09 · Post card interactions · P0 · all
As a reader, I want each part of a post to do the obvious thing, so that I can move around quickly.
- Tap the card body → post detail (POST-01), rendering instantly from the card's data.
- Tap avatar or name → profile. Tap `@mention` → that profile. Tap `#tag` / `$tag` → hashtag page. Tap a link → in-app browser (`SFSafariViewController` / Custom Tabs); a `yap.pr/post?id=` link opens in-app.
- Tap an image → full-screen viewer (PD-14). Tap a quote embed → the quoted post.
- Long-press the card → the context menu (ENG-08). Tap "⋯" → the same menu.
- Tap the truncated identity ID of a nameless author → copies it, toast "Identity ID copied".

#### FEED-10 · Feed language · P2 · v2 (`feedLanguage`)
As a testnet user who posts in Portuguese, I want For You in my language, so that I see posts I can read.
- Settings → Appearance → "Feed language" lists the languages web offers. The default is English.
- Changing it reloads For You.
- New posts are written as `en` whatever the setting, as web writes them today (`post-service.ts` defaults `language` to `en`, and web passes no language). Writing posts in the feed language is a follow-up shared with web.
- Absent on dev.

#### FEED-11 · Cache-first launch · P0 · all
As a returning user, I want the app to open on content instantly, so that it doesn't feel slow.
- On cold start, Home renders the last persisted first page of the saved tab within the M6 budget, before the engine is up.
- Cached content shows normally (no "stale" label). When fresh data arrives, new items appear through the pill (FEED-05) rather than reshuffling the list under the user's finger.
- The cache is per account and per network and holds at most 200 posts per feed.

#### FEED-12 · Media and link previews · P0 · all
As a reader, I want images and links in posts to show properly, so that posts read as their authors meant.
- Post media (one `mediaUrl` per post in 1.0; the grid in UX_SPEC 2.4.6 is built for arrays) loads through `expo-image` with a disk cache. `ipfs://` and gateway URLs are tried through the gateway list `engine.info()` reports (the `lib/utils/ipfs-gateway` order); a gateway that errors or takes over 8 s is skipped. When every gateway fails, the cell shows "Image unavailable" and the rest of the card works.
- The media gate (SAFE-07) and the NSFW gate (SAFE-06) decide whether media is fetched at all.
- With Link previews on (SET-04), the first http(s) link in a post gets a preview card (image, domain, title, description) fetched by the engine (PD-9). No metadata, a fetch error, or a timeout means no card, never an error.
- A YouTube link shows its thumbnail with a play badge and opens YouTube; nothing plays inline.
- A `yap.pr/post?id=` link renders as an embedded post card (quote embed) instead of a preview.
- With Link previews off, nothing is fetched for links and they render as plain links.

### 8.3 Post detail and thread (POST)

#### POST-01 · Open a post · P0 · all
As a reader, I want to open a post and see it in full with its replies, so that I can follow the conversation.
- The detail screen shows the post as a large card (full text, never truncated; full-width media), its absolute time ("3:42 PM · Oct 1, 2026"), counts, and the action bar.
- Opened from a list, it renders the card's data instantly and refreshes in the background.
- Opened by deep link with no data, it shows a post skeleton, then the post, or "Post not found" with "Go back" when the id resolves to nothing and no removal record exists.
- The header title is "Post" (or "Reply" when the target is a reply).

#### POST-02 · Replies · P0 · all
As a reader, I want to see replies under a post, so that I can read the discussion.
- Below the post, replies are listed oldest first with infinite scroll ("Loading replies…" at first).
- Replies are flattened to one indent level, as web (`components/post/reply-thread.tsx`): direct replies at level 0, replies to replies indented once, with "Replying to @x" when the parent is not the row above.
- The post author's own consecutive replies are joined by a thread line.
- A branch deeper than the flattening shows "Continue thread" which opens that reply as the focus of a new detail screen.
- Empty: "No replies yet. Be the first to reply!".
- On dev a reply page loads one branch at a time; the UI does not promise a global newest-first order.

#### POST-03 · Reply context · P0 · all
As a reader who opens a reply, I want to see what it answers, so that it makes sense.
- When the focused item is a reply, its parent (and on dev the thread root) is shown above it as a compact card with a thread line, and "Replying to @x" under the focused reply's header.
- Tapping the parent opens it.

#### POST-04 · Removed and deleted stubs · P0 · all
As a reader, I want a clear note where a post used to be, so that a thread still makes sense.
- A missing post or reply renders a stub with an icon and one sentence, in card or embed form (`components/moderation/removed-post-stub.tsx`):
  - removed by moderators (`moderated`): "This post was removed by community moderators." plus "Reason: …" when the removal record has one;
  - deleted by the author (`deletesLeaveHoles`, proven absent with no removal record): "This post was deleted by its author.";
  - read failed: "This post could not be loaded. Try again later.";
  - otherwise: "This post is unavailable."
- "post" reads "reply" for replies.
- The stub never asserts "removed" or "deleted" before the engine proves it; until then it shows "unavailable".
- Nothing else of what a removal record keeps (v11's tag and date) is shown, on mobile or web.
- Stubs have no action bar and no menu.

#### POST-05 · Thread whose root is gone · P0 · dev (`deletesLeaveHoles`, `moderated`)
As a reader, I want to read replies even when the original post is gone, so that the conversation isn't lost.
- When the root is missing, the detail screen shows the stub in its place and still lists the replies.
- The reply bar is replaced by "This post was deleted, so it can't be replied to." (or "…was removed…" for a moderator removal).

#### POST-06 · Engagements · P0 · all (PD-16)
As an author, I want to see who liked, reposted and quoted a post, so that I know who engaged.
- From the context menu "View post engagements", a screen with tabs "Quotes", "Reposts", "Likes", each with its count in the tab label when known.
- The Reposts tab is absent when `canRepost(kind)` is false.
- Quotes lists the quoting posts as post cards. Reposts and Likes list user rows with a follow button (PROF-04 rules).
- Empty per tab: "No quotes yet / When people quote this post, they'll appear here.", "No reposts yet / When people repost this post, they'll appear here.", "No likes yet / When people like this post, they'll appear here.".
- Infinite scroll on each tab.

#### POST-07 · Open posts from links · P0 · all
As anyone, I want a yap.pr post link to open in the app, so that sharing works.
- `yappr://post?id=X` and `https://yap.pr/post?id=X` open post X. `&reply=Y` opens reply Y in the context of post X.
- Universal links work once the association files are served (NET-11).

#### POST-08 · Private post placeholder · P0 · all
As a reader, I want to know a private-feed post exists without seeing broken ciphertext, so that the feed is clean.
- An encrypted post renders its header and action bar normally and, in place of the body, a muted panel with a lock icon: "Private post / Only {name}'s private followers can read this. Private feeds aren't in the app yet." and "Open on yap.pr" (in-app browser to the post).
- A private post with a public teaser shows the teaser text above the panel.
- Replying to or quoting a private post is not offered (the menu and action bar hide Reply and Quote); liking and bookmarking are allowed.

#### POST-09 · Polls (read-only) · P0 · all
As a reader, I want to see a poll and its results, so that I'm not missing part of the post.
- A post that embeds a Pollr poll shows the question, each option with its share as a bar and percentage, the total votes, and the state: "Ends in 2d", "Ended", or "No end date".
- "Vote on yap.pr" opens the post on yap.pr in the in-app browser.
- A poll that fails to load shows "Poll unavailable".

#### POST-10 · Reply from the detail screen · P1 · all
As a reader, I want a reply field right on the post, so that replying is quick.
- A docked bar at the bottom reads "Post your reply" with the viewer's avatar. Tapping it opens compose in reply mode (COMP-03) for the focused item.
- Signed out it reads "Sign in to reply" (G-8).

### 8.4 Compose (COMP)

#### COMP-01 · Write a post · P0 · all
As a user, I want to write and publish a post, so that people can read it.
- The compose button (FAB) on Home, Explore and Profile opens compose as a full-screen modal with the keyboard up and the cursor in the editor.
- The editor placeholder is "What's on your mind?". The header has "Cancel" (iOS) / close × (Android), the NSFW toggle, and the "Post" button.
- "Post" is disabled until the text has visible content (the rule of `hasVisibleContent` in `lib/compose/limits.ts`: whitespace and default-ignorable code points alone do not count) and while the text is over a limit.
- Posting follows COMP-10.

#### COMP-02 · Character and byte counter · P0 · all (`contentLimits`)
As a user, I want to know how much room I have, so that my post isn't rejected.
- The limits come from `engine.info()` (`contentLimits`). Counting runs in the UI on every keystroke and mirrors `lib/compose/limits.ts` exactly: characters are Unicode code points (`Array.from(text).length`, so one emoji is one character) and bytes are the UTF-8 length. A Jest test pins the RN counter against the `lib` functions on shared fixtures (emoji, ZWJ sequences, CJK, Arabic, combining marks).
- The counter shows "current / limit" in characters.
- It is gray, turns amber at 50 or fewer characters left, and red when over.
- On dev, when the UTF-8 size is over 2000 bytes, a red line under the editor reads "{N} bytes over the size limit. Emoji and non-Latin text count extra." This can happen with fewer than 1000 characters.
- Over either limit, "Post" is disabled and the overflowing text is highlighted with a red background from the first character past the limit.
- The counter's screen-reader label is "{current} of {limit} characters" plus ", {N} over limit" when over; it is not announced on every keystroke.
- Each post in a thread has its own counter.

#### COMP-03 · Reply · P0 · all
As a reader, I want to reply to a post or reply, so that I can join the conversation.
- Reply opens compose with a "Replying to @x" header and a compact preview of the target above the editor. The placeholder is "Post your reply". The button reads "Reply".
- Threads are not available in reply mode.
- If the target is gone, posting fails with "This post was deleted, so it can't be replied to." and the draft is kept.
- The reply appears at once in the thread (COMP-10). The target's reply count goes up optimistically.

#### COMP-04 · Quote · P0 · all
As a reader, I want to quote a post with my comment, so that I can share it with context.
- "Quote" in the repost menu opens compose with the quoted post embedded below the editor. Placeholder "Add a comment".
- On dev (`repostsAreQuotes`) one quote or repost per author and target is allowed (ENG-02): when the viewer's slot holds a quote with text, the menu offers "View your quote" instead of "Quote"; when it holds a bare repost, "Quote" is hidden. A refused second quote reads "You have already quoted this."
- Threads are not available in quote mode.

#### COMP-05 · Threads · P0 · all
As a writer, I want to post several connected posts at once, so that I can say more than one post holds.
- "Add to thread" under the last post adds a new editor (placeholder "Continue your thread..."), up to 10 in total. Each item has its own counter and a remove button ("Remove this post") once there are two or more.
- With 2 or more items the button reads "Post all (N)".
- Posting publishes the items in order. Progress shows on the optimistic thread as "Posting 2 of 5…".
- If an item fails, the posted ones stay posted and are marked "Posted" in the draft, and the status reads "Posted 2 of 5 · Retry the rest". Retry resumes from the first unposted item and never reposts a posted one. The failure toast reads "Thread partly posted. Post {n} didn't go through." (a mobile string; the engine's reason goes to diagnostics).
- On success with N > 1, the toast is "Thread posted".
- Threads are unavailable for replies and quotes.

#### COMP-06 · Mention autocomplete · P0 · all
As a writer, I want suggestions when I type @, so that I tag the right person.
- After `@` and 3 or more characters, a suggestion list appears above the keyboard with up to 8 matches by DPNS prefix: avatar, display name, `@username`.
- Selecting inserts `@username ` (with a trailing space) in place of the typed fragment. Dismissing (typing a space, Escape, tapping outside) closes it.
- On dev (`mentionsInline`), when a second `@mention` is typed, a hint under the editor reads "Only the first @mention notifies the person." (P1).
- Mentions of names that do not resolve stay plain text; the post still publishes.

#### COMP-07 · Hashtags and cashtags · P0 · all
As a writer, I want my #tags to work, so that my post shows up on tag pages.
- `#tag` and `$tag` are highlighted in the editor in the link color.
- A tag longer than the limit (63 on v2, 61 on dev) is shown with a red underline and the hint "Tags can be up to {N} characters". Posting is allowed; the over-long tag is not indexed (as web).
- On dev (`hashtagsInline`), when a second tag is typed, a hint reads "Only the first #tag puts this post on a tag page." (P1).
- There is no hashtag autocomplete in 1.0.

#### COMP-08 · NSFW flag · P0 · all
As a writer, I want to mark my post NSFW, so that readers get a warning.
- The NSFW toggle in the compose header (label "NSFW", amber when on, screen-reader label "Mark this post as NSFW", state on/off) sets `sensitive` on the post, or on every item of a thread.
- The flag is part of the draft.

#### COMP-09 · Drafts persist · P0 · all (PD-4)
As a writer, I want my unfinished text kept, so that an interruption doesn't lose it.
- The draft (all thread items, the NSFW flag, the context) is saved per account and context 500 ms after each change and when the app goes to the background.
- Reopening compose in the same context restores it with the cursor at the end. After a crash or kill, it is restored the next time that context opens.
- Closing with visible content shows an action sheet: "Save draft", "Delete draft" (destructive), "Cancel". Closing an empty composer closes immediately.
- A successful post deletes its draft. A failed or partly failed post keeps it (COMP-05, COMP-10).
- At most one new-post draft and 20 reply or quote drafts per account are kept; the oldest reply or quote draft is dropped first. Drafts older than 30 days are deleted.
- Drafts never leave the device.

#### COMP-10 · Write status · P0 · all (PD-3)
As a writer, I want to see whether my post went through, so that I neither lose it nor post it twice.
- Tapping Post closes the sheet, fires a success haptic, and inserts the post optimistically: new posts at the top of the active Home list and of the author's profile; replies in the thread under their parent.
- The optimistic card shows the write-status row "Posting…" with a small spinner and no action bar.
- When the engine reports the broadcast accepted and the document readable, the row disappears and the card becomes normal. The toast reads "Posted" (a reply: "Reply posted"; a quote: "Quote posted").
- Broadcast accepted but not readable (the wait timed out, 60 s without an answer, or an engine restart): the row keeps "Posting…" while the app checks it (G-3). The card never offers a manual check or a blind resend.
- Failed (the broadcast was refused, or a check proved it absent): the row reads "Couldn't post · Retry · Edit". "Retry" resends the same content as a new write only after the engine has proved the original absent. "Edit" reopens compose with the draft. The error toast follows G-4.
- Checks used up without proof either way: the row reads "Couldn't confirm · Edit", once, with the toast "We couldn't confirm your post. Check your profile before posting it again." Never Retry. Checks go on (foreground, reads).
- A card whose post later appears on chain becomes normal without user action on the next refresh.
- Leaving the screen does not cancel the write. The status follows the card wherever it is shown.
- Unsent drafts and in-flight writes survive an engine restart; an in-flight write after a restart keeps "Posting…" while it is checked (NET-04).

#### COMP-11 · Disabled reasons · P0 · all
As a writer, I want to know why I can't post, so that I can fix it.
- Offline: Post disabled, hint "You're offline" (G-1).
- Signed out: compose opens the sign-in sheet first (G-8).
- Over a limit: Post disabled (COMP-02).
- A refusal shows G-4's sentence for its code (UX_SPEC §5.4.1): "You can't do this from this account." for a moderation bar, otherwise "Couldn't post. Try again."; the categorized text goes to diagnostics. A nonce clash is checked like any unknown outcome, never resent.

#### COMP-12 · Keyboard and input · P1 · all
As a writer, I want the editor to behave like a native text field, so that typing is comfortable.
- The editor grows with its content, scrolls when taller than the space above the keyboard, and the header and the counter stay visible.
- System emoji keyboard, dictation, text replacement and paste work. Pasted text keeps its line breaks.
- A hardware keyboard posts with ⌘↩ (iPhone) / Ctrl+Enter (Android).
- The editor uses the body-large type token and follows Dynamic Type.

#### COMP-13 · Cost hint · P2 · all
As a writer, I want to see roughly what a post costs, so that fees never surprise me.
- Under the editor, a muted line from `planPayment` shows the cost: in YAPP where the plan pays YAPP ("Costs 10 YAPP"), else "Network fee ~{x} DASH". It is hidden when the engine cannot estimate.

### 8.5 Engagement (ENG)

#### ENG-01 · Like · P0 · all
As a reader, I want to like a post or reply, so that I can show appreciation.
- Tapping the heart fills it (`red-600` light / `red-500` dark), plays the spring scale, fires a light haptic and adds one to the count, immediately.
- Tapping again unlikes: outline heart, count minus one, no haptic.
- Double-tap on a post's media also likes it (never unlikes), with a heart burst over the image. Reduce Motion replaces the burst with a fade.
- If the target is not readable yet (just posted by this device, not confirmed): the like shows at once and is sent once the post is readable (up to about two minutes); no toast.
- While a bare repost's marks load, its like, repost and bookmark buttons show a spinner and take no taps.
- Failure follows G-4 with "Couldn't like this post. Try again." unless a code has its own copy (G-5 for YAPP or credits).
- Screen-reader label: "Like, {N} likes" / "Unlike, {N} likes", toggle trait.

#### ENG-02 · Repost and quote menu · P0 · all
As a reader, I want to repost or quote, so that I can share posts with my followers.
- Tapping the repost icon opens an action sheet (iOS) / bottom sheet (Android). Its items follow web (`components/post/post-action-bar.tsx`):

  | Viewer's state | Items |
  | --- | --- |
  | Not reposted, no quote | "Repost", "Quote" |
  | Reposted (v2 `repost` document, or a bare repost on dev) | "Undo repost" (no "Quote" on dev: the one slot is taken) |
  | Dev, the slot holds a quote with text | "Delete your quote", "View your quote" |

- Repost: icon turns `green-700` light / `green-500` dark, count +1, medium haptic, toast "Reposted!".
- Undo repost: icon back to gray, count −1, toast "Removed repost". On dev this deletes the bare quote post.
- "Delete your quote" asks for the ENG-06 confirmation (the quote is shown in it), then deletes the quote post; toast "Quote deleted".
- `canRepost(kind)` false hides the icon.
- Replies can be reposted on every topology.

#### ENG-03 · Bookmark · P0 · all (`canBookmark`)
As a reader, I want to save a post, so that I can find it later.
- The bookmark icon toggles; filled `yappr` when saved. Toasts "Added to bookmarks" / "Removed from bookmarks".
- On dev the bookmark icon is absent on replies.

#### ENG-04 · Bookmarks screen · P0 · all
As a reader, I want to see my saved posts, so that I can read them later.
- Reached from Profile (own) → "Bookmarks", the header menu of the own profile, and `yappr://bookmarks`.
- Lists bookmarked posts newest-bookmarked first, with a search field "Search bookmarks" that filters loaded posts by text and author.
- Swipe left on a row (iOS) / the row menu (Android and iOS) → "Remove bookmark".
- The header menu has "Clear all bookmarks", confirmed by "Clear all bookmarks? / This removes every saved post. It can't be undone." Partial failure: "Some bookmarks could not be removed".
- Empty: "Save posts for later / Don't let the good ones fly away! Bookmark posts to easily find them again."
- Removed or deleted bookmarked posts show stubs (POST-04) with "Remove bookmark" still available.

#### ENG-05 · Share · P0 · all
As a reader, I want to share a post outside Yappr, so that friends can see it.
- The share icon opens the native share sheet with the URL `https://yap.pr/post?id={rootId}` (a reply: `…&reply={replyId}`) and the text "{name} on Yappr".
- The context menu also has "Copy link", toast "Link copied to clipboard".

#### ENG-06 · Delete my post or reply · P0 · all
As an author, I want to delete my post, so that it's gone from Yappr.
- The context menu of the viewer's own item has "Delete post" / "Delete reply" in red.
- Confirmation: "Delete post?" / "Delete reply?" with one body on every contract, the same as web: "This can't be undone. Replies and quotes will show that it was deleted.", "Delete" (destructive) and "Cancel".
- On confirm the item disappears from every list at once (optimistic), toast "Post deleted" / "Reply deleted". On failure it comes back (G-4).
- A bare repost and the viewer's quote (dev) are undone through the repost menu (ENG-02); a quote post also shows "Delete post" here when opened as its own card.

#### ENG-07 · Counts and action bar · P0 · all
As a reader, I want to see engagement at a glance, so that I know what's popular.
- The action bar shows Reply (count), Repost (count), Like (count), then Bookmark and Share grouped on the right. There is no Tip button in 1.0.
- Counts follow G-13. Optimistic changes update every visible card of the same post.
- Disabled actions on stubs and private posts follow POST-04 and POST-08.

#### ENG-08 · Context menu · P0 · all
As a reader, I want more actions on a post, so that I can manage what I see.
- Long-press on a card (native context menu with a preview on iOS; a bottom sheet on Android) or "⋯" shows, in order:
  1. "Follow @x" / "Unfollow @x" (not own)
  2. "View post engagements"
  3. "Copy link"
  4. "Share…"
  5. "Delete post" / "Delete reply" (own, red)
  6. "Block @x" (not own, red)
  7. "Report post" / "Report reply" (not own; SAFE-04, or the email path on v2, PD-13)
- Items that don't apply are absent. The menu never contains moderator actions in 1.0.

### 8.6 Profiles and social graph (PROF)

#### PROF-01 · View a profile · P0 · all
As anyone, I want to see who someone is, so that I can decide whether to follow them.
- Header: banner (image, else the `gradient-yappr` default), avatar 88 pt ringed, display name (fallback chain AUTH-15), `@username` (or the truncated ID), pronouns, bio, location, website (tappable), social links, joined date, Following and Followers counts (tappable).
- When the user has several DPNS names, "Also known as @a, @b" (P2).
- Loading shows skeleton bars for name and handle; the header never jumps when they resolve.
- An unknown identity shows "User not found"; an invalid id shows "Invalid identity ID".

#### PROF-02 · Profile tabs · P0 · all
As anyone, I want to browse someone's posts, replies, top posts and mentions, so that I can get a sense of them.
- Tabs: "Posts", "Replies", "Top" (`topSort` only), "Mentions". No Blog tab in 1.0.
- Each tab is an infinite list with pull to refresh and its own empty state: "No original posts yet", "No replies yet", "No liked posts yet", "No mentions yet / Posts that mention this user will appear here".
- Posts includes the user's reposts with the repost banner, as web.
- The tab bar sticks under the navigation bar when scrolled.

#### PROF-03 · Follow and unfollow · P0 · all
As a reader, I want to follow someone, so that their posts show in my Following feed.
- "Follow" (filled `yappr-500`) follows at once: the button becomes "Following" (outline), the Followers count +1, light haptic, toast "Following!".
- Tapping "Following" asks "Unfollow @x?" (action sheet) with "Unfollow" (destructive). Confirmed: "Follow", count −1, toast "Unfollowed" (PD-6).
- The own profile has no follow button. Following yourself is impossible ("You cannot follow yourself").
- The new follow state shows on every visible surface for that user (cards' menus, user rows) and lifts the media gate for that author.
- Failure: G-4 with "Couldn't follow this account. Try again." ("unfollow" for an unfollow).

#### PROF-04 · Followers and following lists · P0 · all
As anyone, I want to see who follows whom, so that I can find people.
- Tapping a count opens "Followers" or "Following" for that profile: user rows with avatar, name, `@username`, a two-line bio and a follow button ("Follow", "Following", or "Follow back" when they follow the viewer).
- A search field filters by username (3 characters or more; DPNS prefix) and shows "No users found with that name".
- Empty: "No followers yet / Share interesting content to gain followers"; "Not following anyone yet / Find interesting people to follow on Yappr".
- Load error: "Could not load followers. Check your connection and try again." with "Try again".

#### PROF-05 · My profile · P0 · all
As a user, I want my own profile to be my hub, so that I can reach my things.
- The Profile tab shows the viewer's profile with "Edit profile" (outline) and a header menu: "Bookmarks", "Blocked accounts", "Settings", "Share profile", "Switch account" (when more than one).
- iOS: a gear button in the navigation bar opens Settings. Android: the overflow menu.

#### PROF-06 · Edit profile (v2) · P0 · v2 (`profileExtension` off)
As a testnet user, I want to edit my profile, so that people know who I am.
- "Edit profile" opens a modal form: Name (required, 1–50), Bio (160), Pronouns (20), Location (50), Website (200), "NSFW Content / Mark your profile as containing adult content" toggle, Avatar (PROF-08), Banner image URL (512).
- Each field shows a counter when within 20 of its limit. "Save" is disabled while invalid or unchanged.
- Save writes the profile document, then closes with the toast "Profile updated!". The first save creates the profile (#605 behaviour; a failed read never counts as "no profile").
- "Cancel" with changes asks "Discard changes?".

#### PROF-07 · Edit profile (dev) · P0 · dev (`profileExtension`)
As a devnet user, I want to edit my profile, knowing that some fields are my DashPay profile, so that nothing surprises me.
- The form has two groups. "DashPay profile": Name (25), Bio (140), Avatar; with the note "This also updates your DashPay profile, which other Dash apps show." "Yappr profile": Pronouns (20), Location (50), Website (200), Banner image URL (512), NSFW toggle.
- Save writes the DashPay profile first (only if it changed or is missing), waits until it is readable, then the `yapprProfile` (only if it changed or is missing), as `lib/services/unified-profile-service.ts` does. Progress shows "Saving… (1 of 2)".
- If the first write lands and the second fails, the toast says "Your DashPay profile was saved, but your Yappr profile wasn't. Try again." and the form stays open with the second group's values.
- An image-URL avatar is fetched once to hash and fingerprint it for DashPay; if that fails it is kept in the Yappr profile only (web behaviour), with no error to the user.

#### PROF-08 · Avatar · P0 · all
As a user, I want to choose an avatar, so that my posts are recognizable.
- "Change avatar" opens a sheet with two modes: "Generated" and "Image link".
- Generated: a grid of the 28 DiceBear styles previewed with the current seed, a seed field, and "Randomize". The style list and labels (`DICEBEAR_STYLES`, `DICEBEAR_STYLE_LABELS`) and the seed's maximum length (`avatarSeedMaxLength()`) come from `engine.info()`; the engine renders each preview to an SVG data URI. Nothing is fetched from the network.
- Image link: a URL field (https or ipfs) with a live preview; an invalid or unreachable image shows "Couldn't load this image".
- The default for every identity with no avatar is DiceBear `thumbs` seeded by the identity ID.
- Image upload is not in 1.0.

#### PROF-09 · Message from a profile · P0 · all
As a reader, I want to message someone from their profile, so that I can talk privately.
- Other users' profiles show a "Message" button (icon, label "Message {name}") that opens the existing conversation or a new one (DM-05).
- Hidden when the viewer blocks the user.

#### PROF-10 · NSFW profile interstitial · P1 · all
As a reader, I want a warning before a profile marked adult opens, so that I'm not surprised.
- A profile with `nsfw` true opens on "This profile may contain adult content / {name} marked their profile as NSFW." with "Go back" and "View profile", unless NSFW mode is "Always show" or it is the viewer's own profile.
- The acknowledgement lasts for the session.

#### PROF-11 · Blocked profile · P0 · all
As a user who blocked someone, I want their profile to say so, so that I remember why I see nothing.
- The header renders, and in place of the tabs: "You blocked this user / You won't see their posts in your feeds" with "Unblock".
- For a block inherited from a followed block list: "This user is blocked / Blocked by a block list you follow. You won't see their posts in your feeds", with no button (block lists are managed on web in 1.0).

#### PROF-12 · Share a profile · P1 · all
As a user, I want to share a profile, so that friends can follow them.
- "Share profile" opens the share sheet with `https://yap.pr/user?id={identityId}`. The context menu also has "Copy profile link", toast "Profile link copied!".

#### PROF-13 · Profile menu (others) · P0 · all
As a reader, I want profile actions in one place, so that I can manage this person.
- "⋯" on another user's profile: "Share profile", "Copy profile link", "Block @x" / "Unblock @x". Profile reports are deferred (section 9).

### 8.7 Explore and search (EXPL)

#### EXPL-01 · Explore tab · P0 · all
As a reader, I want one place to discover posts, people and tags, so that I find new things.
- The Explore tab has a search field ("Search Yappr") at the top and, below it, segments "Trending", "Top" (`topSort`), "Creators" (`topCreators`). On v2 only Trending shows and the segmented control is hidden.
- The last segment is remembered for the session.

#### EXPL-02 · Trending hashtags · P0 · all
As a reader, I want to see which tags are active, so that I can join popular conversations.
- A ranked list of tags: rank, `#tag` or `$tag`, and a count. On dev the count is likes in the last 24h ("128 likes"), as web's proved ranking; on v2 it is posts among recent posts ("12 posts").
- Tapping a row opens the hashtag page.
- Loading: "Loading trending hashtags…". Empty: "No trending tags yet / Post with #hashtags or $cashtags to see them here!".

#### EXPL-03 · Top posts · P0 · dev (`topSort`)
As a reader, I want the most-liked posts, so that I see the best of Yappr.
- Window control "3 days / All time". Same list rules as FEED-04.

#### EXPL-04 · Top creators · P0 · dev (`topCreators`)
As a reader, I want to see the most-liked creators, so that I find people worth following.
- A ranked list of user rows (rank, avatar, name, `@username`, total likes "2.4K likes") with follow buttons. All time only.

#### EXPL-05 · Search · P0 · all
As a reader, I want to search people, tags and posts, so that I find something specific.
- Focusing the field shows recent searches (EXPL-08) and a "Cancel" button. Typing searches after 300 ms of no input.
- Results are grouped: "People" (DPNS prefix match from 3 characters; an exact name and a pasted 44-character identity ID also resolve), "Hashtags" (tags matching the text, with or without `#`), "Recent posts" (posts among the latest 100 that contain the text, PD-10).
- Each group shows up to 3 rows and "See all" (EXPL-06). While searching: "Searching…". No result in any group: "No results for "{q}" / Try searching for something else".
- Fewer than 3 characters searches hashtags and posts only, with the hint "Type at least 3 characters to search for people".
- Blocked authors are excluded (G-6).

#### EXPL-06 · Search results lists · P1 · all
As a reader, I want to see all results of one kind, so that I can find the right one.
- "See all" opens a stacked screen titled "People", "Hashtags" or "Recent posts" for the query, with the full list.

#### EXPL-07 · Hashtag page · P0 · all
As a reader, I want all posts with a tag, so that I can follow a topic.
- Title `#tag` (or `$tag`). Segments "Latest" and "Top" (`topSort`; Top with "24h / All time").
- Infinite scroll, pull to refresh. Loading "Loading posts with #tag…". Empty "No posts yet" (Top: "No liked posts yet").
- On dev, only posts whose first tag is this tag are listed (as indexed); the page says nothing about it.
- Reached from tags in posts, trending, search, and `yappr://hashtag?tag=`.
- "Load more posts" when automatic paging pauses (FEED-07 rules).

#### EXPL-08 · Recent searches · P2 · all
As a reader, I want my recent searches, so that I can repeat them.
- The last 10 submitted queries and opened people or tags are stored on the device per account, shown when the field is focused and empty, each removable, with "Clear".

### 8.8 Notifications (NOTIF)

#### NOTIF-01 · Notification list · P0 · all
As a user, I want to see who interacted with me, so that I can respond.
- The Notifications tab lists items newest first: an icon for the type (follow, mention, like, repost, quote, reply), the actor's avatar and name, the phrase ("started following you", "mentioned you in a post", "liked your post", "reposted your post", "quoted your post", "replied to your post"), the time, and for post types a two-line snippet of the post ("NSFW content" when the post is flagged and NSFW mode is not "Always show").
- Unread items have a tinted background and a dot. Opening an item marks it read and goes to the post (likes, reposts: the liked post; replies, quotes, mentions: the new post) or the profile (follows).
- Loading: "Loading notifications…". Empty per filter: "When someone interacts with you, you'll see it here" (All), "When someone likes your post, you'll see it here", and so on for each filter.
- Actor names without a profile follow the fallback chain; "Unknown user" only when nothing resolves.

#### NOTIF-02 · Filters · P0 · all
As a user, I want to filter notifications, so that I can find replies quickly.
- A horizontally scrolling chip row: "All", "Likes", "Reposts" (includes quotes), "Replies", "Follows", "Mentions". Blog and Private filters are absent in 1.0.
- Filters disabled in Settings (NOTIF-05) are absent from the row.

#### NOTIF-03 · Polling and badge · P0 · all
As a user, I want the Notifications tab to show how many new things there are, so that I know when to look.
- While the app is in the foreground and signed in, the engine polls every 30 s and immediately on launch, on return to the foreground and on pull to refresh.
- The tab badge shows the number of unread items of enabled types, capped "99+". It is hidden at 0.
- Nothing runs in the background (NET-08).

#### NOTIF-04 · Mark visible read · P0 · all
As a user, I want to clear my unread items, so that the badge means something.
- "Mark all as read" (header button) marks read only the items of enabled types (as web): disabled types stay unread.
- Read state is stored per account on the device and does not sync between devices. On v11 a new device starts like notifications from a silent baseline, so it shows no backlog of old likes.

#### NOTIF-05 · Per-type toggles · P0 · all
As a user, I want to turn off notification types, so that I only see what I care about.
- Settings → Notifications lists "Likes / When someone likes your posts", "Reposts / When someone reposts your content", "Replies / When someone replies to you", "Follows / When someone follows you", "Mentions / When someone mentions you", each a switch, all on by default.
- Turning a type off hides its items from the list and the badge at once; turning it back on shows them again with their read state.
- A link from the Notifications header (gear icon, label "Notification settings") opens this section.

#### NOTIF-06 · Grouped like notifications · P1 · v11 (`likeNotificationsTimeless`)
As a user with a popular post, I want likes grouped, so that the list stays readable.
- On v11 the engine returns like notifications grouped per post: "Alice and 3 others liked your post", with up to 3 stacked avatars.
- They carry no like time; the time shown is when this device first noticed them ("Noticed 2h ago").

#### NOTIF-07 · Windowed history · P1 · dev (`notificationsWindowed`)
As a user who was away for a week, I want to know older activity may be missing, so that I'm not misled.
- On dev, the end of the list reads "Older replies and quotes may not appear here." Nothing is shown on v2.

#### NOTIF-08 · Blocked actors · P0 · all
As a user, I want no notifications from people I block, so that blocking works.
- Items whose actor the viewer blocks are dropped from the list and the badge (G-6).

#### NOTIF-09 · Signed out · P0 · all
As a lurker, I want the Notifications tab to tell me what it's for, so that I know signing in unlocks it.
- The tab shows "Sign in to see your notifications" with a "Sign in" button and no badge.

### 8.9 Messages (DM)

#### DM-01 · Inbox · P0 · all
As a user, I want my conversations in one list, so that I can pick up where I left off.
- The Messages tab lists conversations by last activity: avatar (a group icon with the group name for groups), name, a one-line preview ("You: " prefix for own messages), time, unread dot.
- The header has "New message" (compose icon) with a menu "New message" / "New group" (`dmVersion` v5 only), and "Message settings" (DM-12, v5).
- While restoring state on a new device, a notice shows "Restoring your messages" with the current step ("Finding conversations people started with you", "Checking recent chats with people you follow", "Finding your groups", "Checking older chats with people you follow").
- Empty: "Welcome to Messages / Private 1-on-1 and group conversations. Messages are encrypted, and nobody watching Dash Platform can tell who you talk to." (v3: "Private 1-on-1 conversations. Messages are encrypted.") with "New message".
- A search field "Search messages" filters conversations by name and loaded preview text (P2); "No conversations match your search".
- Signed out: "Sign in to read your messages" with "Sign in".

#### DM-02 · Unlock messages · P0 · all
As a user who signed in with a private key, I want to unlock my messages, so that I can read them.
- When no encryption key for the identity is on the device, the Messages tab shows "Unlock your messages / Messages are encrypted with your encryption key. Enter it on this device to read and send them." with "Enter encryption key".
- The sheet first tries automatic recovery ("Attempting to automatically recover your encryption key…"); on success "Your encryption key was automatically recovered." and the inbox opens.
- Otherwise a secure field "WIF (cXyz...) or hex (64 chars)" validates against the identity's encryption key: "Invalid key" on mismatch; "Encryption key saved" on success.
- Wallet sign-in derives the key, so wallet users never see this.

#### DM-03 · Read a conversation · P0 · all
As a user, I want to read a conversation, so that I know what was said.
- Messages render as bubbles: own on the right (`yappr-500` fill, white text), others on the left (`gray-100` / `gray-800`); day separators ("Today", "Yesterday", "Mon, Sep 29"); in groups, the sender's name above the first bubble of a run.
- The view opens at the newest message; older messages load when scrolling up.
- Long-press a message: "Copy". (Report and delete-for-me are deferred.)
- Links in messages are tappable. Media URLs are shown as links, not fetched.
- Empty: "No messages yet. Start the conversation!".

#### DM-04 · Send a message · P0 · all
As a user, I want to send a message, so that I can talk privately.
- Composer: "Type a message..." multiline, grows to 5 lines; a send button ("Send message") enabled when there is visible text.
- Sending: the bubble appears at once with "Sending…"; then "Sent" (shown under the last own bubble only); or "Not delivered · Tap to retry" in red. Retry sends the same content only after the engine reports it absent. A refusal the engine won't retry reads "Not delivered · Tap to edit" (the text goes back to the composer).
- An unknown outcome (G-3) keeps "Sending…" while the app checks it. Only once the checks ran out does it read "Couldn't confirm · Tap to check"; a tap checks again, with a spinner on the bubble, and no toast. A send the engine never took goes back to the composer with "Message not sent. It's back in the message box."
- On v5, text over 4081 UTF-8 bytes (`MAX_TEXT_BYTES`) is sent as several messages, in order, and shown as one bubble per part.
- A light haptic on send. Offline follows G-1 (the text stays in the composer).
- The unsent composer text is kept per conversation on the device.

#### DM-05 · Start a 1:1 conversation · P0 · all
As a user, I want to start a chat with someone, so that we can talk.
- "New message" opens a picker: "Choose a person to start an encrypted conversation." with a search field "Search by username..." (3+ characters, or a pasted identity ID) and, before typing, the viewer's followers ("Loading followers…").
- Hints: "Type at least 3 characters to search, or paste a full identity ID"; "No user found with this identity ID"; "No followers yet — search for a username above."
- Picking a person opens the conversation (existing or new). Starting a chat with yourself shows "You can't message yourself".
- `yappr://messages?startConversation={id}` and the profile Message button do the same.

#### DM-06 · Create a group · P0 · dev (`dmVersion` v5)
As a user, I want to create a group chat, so that several of us can talk.
- "New group": "Name the group and pick its members." with "Group name" (1–100 characters) and a member picker (same search as DM-05) showing selected members as removable chips ("Remove {name}").
- At most 100 members including the creator; adding more shows "A group can have at most 100 members."
- "Create group" opens the new group conversation; failure: "Could not create the group" plus the categorized reason.

#### DM-07 · Group info · P0 · dev (v5)
As a group member or owner, I want to see and manage the group, so that it stays useful.
- Tapping the group header opens "Group info": name, member list with avatars and an "Owner" badge, and actions by role.
- Owner: "Rename" (toast "Group renamed"), "Add members" (picker, note "New members can read messages sent after they join."), remove a member via the row menu ("Remove member?" → "Remove", toast "Member removed"), "Resend keys" (toast "Keys sent"), "End group" ("End this group? / Nobody will be able to send messages to it any more. This cannot be undone." → "End group", toast "Group ended").
- Member: "Leave group" ("Leave this group? / The owner removes you the next time they open the app. Until then you can still read new messages." → "Leave", toast "You left the group").

#### DM-08 · Group states · P0 · dev (v5)
As a member, I want to know when I can't send to a group, so that I'm not confused.
- Ended: a banner "This group has ended." and no composer.
- Removed or left: "You are no longer a member of this group." and no composer.
- Keys missing: "You cannot read this group yet. Ask the owner to resend your keys: they can do it from the group settings."

#### DM-09 · Delete a conversation · P1 · dev (v5)
As a user, I want to remove a conversation from my list, so that the inbox stays tidy.
- Swipe left (iOS) / the row menu: "Delete conversation", confirmed. Toast "Conversation deleted. It comes back if a new message arrives."
- The list footer shows "Show {N} deleted conversations" / "Hide deleted conversations".

#### DM-10 · Block from a conversation · P0 · all
As a user, I want to block someone from the chat, so that they stop messaging me.
- The conversation menu has "Block" / "Unblock" (1:1 only). "Block" opens the SAFE-01 sheet, the same Block as everywhere: on v5 it also blocks them in Messages. On v5, someone the account already blocks (a block made on web, or before Block covered Messages) is blocked in Messages at once, toast "Blocked @x". On v5 "Unblock" lifts the block in Messages and the account's own block, if there is one; toast "Unblocked @x". When the account's block can't be read (and this device hasn't just changed it), nothing changes: "Couldn't unblock @x. Try again." A repeat tap while that read runs does nothing.
- After blocking, the composer is replaced by "You blocked this person. Unblock them to send messages." and their new messages and group invitations are ignored.

#### DM-11 · Legacy DMs on testnet · P0 · v2 (`dmVersion` v3)
As a testnet user, I want my existing web DMs on the phone, so that conversations continue.
- 1:1 conversations use the same inbox and conversation UI. There is no "New group", no Group info, no Message settings.
- Read receipts follow the "Read receipts" setting (SET-04): when on, the other person's read state shows as "Read" under the last own message.

#### DM-12 · Message settings · P1 · dev (v5)
As a user, I want to reclaim message fees, so that storage doesn't cost me forever.
- "Message settings": "Reclaim message fees" with options "Never (keep paying for storage)", "After 30 days", "After 90 days", "After 1 year", and the web explanation ("Your sent messages stay on Dash Platform and you keep paying for their storage. Choose a period below to delete them once they are that old and get most of their storage fee back. This saves money. It does not make old messages private: copies remain in the blockchain's history, and the people you messaged keep what they have.").
- "Blocked": people blocked in Messages with "Unblock"; empty "Nobody. Blocked people's messages and group invitations are ignored."

#### DM-13 · Messages badge · P0 · all
As a user, I want to know I have unread messages, so that I reply in time.
- The Messages tab badge shows the number of conversations with unread messages (99+), updated with the notifications poll (30 s, foreground only).

#### DM-14 · State survives backgrounding · P0 · dev (v5)
As a user, I want what I sent to stay sent when I switch apps, so that nothing is lost.
- When the app goes to the background, the engine receives the synthetic `visibilitychange` / `pagehide` events (ADR E1) and flushes DM v5 state. Killing the app right after a message shows "Sent" loses nothing on the next launch.

### 8.10 Safety and moderation (SAFE)

#### SAFE-01 · Block someone · P0 · all
As a user, I want to block an account, so that I stop seeing it.
- "Block @x" (post menu, profile menu, conversation menu) opens a confirmation sheet: "Block @x?" with a body that promises only what the block enforces on that network's Messages (UX_SPEC §5.9 `block.body*`), an "Add a note" link that opens the optional public note (≤ 280 characters, hint "Anyone can see this note."), "Block" (destructive) and "Cancel" (PD-5).
- On DM v5 the Block also blocks them in Messages (DM-10), so one Block covers everything and the body says "They won't be able to message you". The engine writes nothing in Messages when that block already stands. Where Messages are locked on this device (no encryption key here yet), the engine keeps the choice on the device, with when it was made, and applies it once they unlock here unless a newer choice from another device is saved by then; sign-out drops it (AUTH-11). Until then the body promises nothing about messages: it is the plain "You won't see their posts or replies. Blocks are public on Dash Platform." On legacy DMs (testnet) the body keeps the caveat that they can still message you.
- On confirm: the author's content disappears from every list, thread, notification and cache at once (G-6); toast "Blocked @x".
- Blocking yourself is impossible ("You cannot block yourself").

#### SAFE-02 · Unblock · P0 · all
As a user, I want to unblock, so that I see someone again.
- "Unblock @x" (menus, the blocked profile, the blocked list) unblocks without confirmation; toast "Unblocked @x". On DM v5 it lifts the block in Messages too.
- When a followed block list still blocks them: "Unblocked, but a block list you follow still hides them.".

#### SAFE-03 · Blocked accounts list · P0 · all
As a user, I want to see everyone I blocked, so that I can review my blocks.
- Settings → Privacy & Safety → "Blocked accounts" (also from the own profile menu): user rows with the block note (if any) and "Unblock".
- Empty: "You haven't blocked anyone".
- Only for someone who follows at least one block list (set up on web), a footer notes "Also hidden by {N} block list(s) you follow · Manage on yap.pr", the link opening the in-app browser. Nobody else hears about block lists.

#### SAFE-04 · Report a post or reply · P0 · dev (`reports`)
As a reader, I want to report harmful content, so that moderators can act.
- "Report post" / "Report reply" opens a sheet with the form at once:
  - the one required disclosure: "Reports are public. Anyone, including the author, can see that you reported this, your reason and any details.";
  - "What is wrong with it?" with the reasons of `lib/reports.ts` (label and hint): Spam or scam; Harassment or bullying; Hate; Violence or threats; Sexual content; Self-harm; Illegal goods or activity; Impersonation; Something else;
  - "Details (optional)" ("Details (required)" for Something else), placeholder "Anything the moderators should know", max 500 with a counter;
  - "Report post" (disabled until valid); "Reporting…" while the engine takes it.
- The viewer's existing report is read beside the form, never in front of it, and a failed read never blocks reporting. A `DUPLICATE` refusal says "You already reported this." and shows the report.
- Sent (confirmed, or not confirmed yet): "Report sent" / "Thanks for letting us know.", with "Also block @x" (P1) and "Done". A sheet dismissed before it could say so (while the report is still on its way) leaves the toast "Report sent", once. The network's answer is reconciled in the background; only a report proven not to have landed brings the form back, with "Couldn't send your report. Try again."
- Reporting again shows the existing report: "You reported this on {date} for {reason} · Under review" (or "· Resolved: {No action taken | Content removed | Author actioned}" where `reportsResolved`), the note, the muted line "Reports close after 90 days.", "Withdraw report" and "Done".
- "Withdraw report" asks first, then is optimistic: toast "Report withdrawn" and the sheet closes. Only a withdrawal proven not to have landed brings the report back ("Couldn't withdraw your report. Try again."); a report already gone says "This report was already closed."
- Where the contract waits for an elected moderation team that isn't seated, the sheet decides before the form (`safety.reportsOpen`) and opens the email path (SAFE-05) directly. A late refusal reads "Your report wasn't sent. Send it by email instead." above the email path, keeping the reason chosen.
- A post that can't be read says "Couldn't load this post. Try again."

#### SAFE-05 · Report by email · P1 · all (v2 always; dev as fallback)
As a reader on testnet, I want a way to report content, so that abuse doesn't go unanswered.
- Where `reports` is off, "Report post" opens the email sheet: "Report by email", "Reports go to the Yappr team by email for now. Your email app opens with a link to the post and the reason you chose.", the same reasons and details as SAFE-04, and "Email the Yappr team".
- It opens the mail composer to the Yappr support address with subject "Report: post {id}" and a body prefilled with the post link, "Reason: {reason}" and the details (PD-13). The link stays inside the email; the sheet never shows it.
- With no mail app configured, the address and link are copied, toast "Report address copied. Send it from any email app."

#### SAFE-06 · NSFW gate · P0 · all
As a reader, I want posts flagged NSFW covered until I choose, so that I'm not surprised.
- Settings → Privacy & Safety → "NSFW content": "Warn first / Cover NSFW posts until you choose to show them" (default), "Always show / Show NSFW posts without a warning", "Hide / Remove NSFW posts from your feeds".
- Warn first: a flagged post's body, media and quote are covered by an opaque panel "NSFW · The author flagged this post" with "Show" (label "Show post flagged as NSFW"). The header and the action bar stay visible. Revealing does not change the card's height.
- A reveal lasts for the session (until the app process ends) and opens every card of that post.
- Hide: flagged posts are removed from browsing lists (feeds, hashtags, search, profiles). Post detail, threads and bookmarks still show the cover instead of a hole. The viewer's own flagged posts are never hidden from them.
- A bare repost (dev) is judged by its target's flag. A quote embed uses the compact cover.

#### SAFE-07 · Media from people you don't follow · P0 · all
As a reader, I want media from strangers held back, so that I'm not shown or tracked by unexpected images.
- Settings → Privacy & Safety → "Blur media from people you don't follow / Images and link previews from accounts you don't follow stay hidden behind a blurred placeholder until you tap to reveal them". On by default.
- When on, media and link-preview images of authors the viewer does not follow are not fetched. A frosted placeholder shows "Media from someone you don't follow" with "Show"; tapping fetches and shows all media of that post card.
- Signed out, every author counts as not followed. The viewer's own media is never gated. Following an author lifts the gate on all their cards at once; unfollowing re-gates them.
- When off, everything loads normally.

#### SAFE-08 · Removed content in rankings · P0 · dev (`moderated`)
As a reader, I want removed posts never ranked, so that takedowns stick.
- Top posts, hashtag Top and the trending lists never show a post or reply that has a removal record; stubs are not shown in ranked lists (the item is dropped).

#### SAFE-09 · Moderation notices for my account · P1 · dev
As a user who was warned, banned or suspended, I want to be told, so that I understand why writes fail.
- A write refused for a ban or suspension shows the categorized message (COMP-11) and, in Settings → Account, a red notice "Your account has been banned or suspended here by a moderator." with the reason when the engine has it.

#### SAFE-10 · Media changed since posting · P2 · dev (`mediaHashes`)
As a reader, I want to know if an image was swapped after posting, so that I'm not misled.
- When the served image doesn't match the post's hashes, the image shows a badge "Media changed since posting" (screen-reader hint "The image at this link no longer matches the one the author posted.").

### 8.11 Settings (SET)

#### SET-01 · Settings root · P0 · all
As a user, I want my settings in one place, so that I can find each option.
- Sections, in order: "Account", "Notifications", "Privacy & Safety", "Messages" (v5 only, DM-12), "Appearance", "About".
- The account row shows the avatar, the display name and the @handle; the balance is on Account (SET-02).
- The network chip and the app version ("Yappr 1.0.0 (123)") are shown at the bottom; the chip names the network.
- Signed out: Appearance, Privacy & Safety (content settings only) and About.

#### SET-02 · Account · P0 · all
As a user, I want to see my identity and balance, so that I know what I'm using.
- In order: "Usernames" (the DPNS names, then "Register a username on yap.pr ↗", or "Register another username on yap.pr ↗" when there is one), "Balance" (DASH cut to 4 decimals, "< 0.0001 DASH" below that, with the raw credits in a muted caption; read again when the screen opens and on pull to refresh), "YAPP" (read-only balance, only where the contract has a token, PD-11), "Account created" (date), and last "Copy account ID" (the id middle-truncated, toast "Account ID copied").
- "Accounts" (AUTH-10), "App lock" (AUTH-12), "Sign out" (AUTH-11).

#### SET-03 · Notifications · P0 · all
As a user, I want to choose which notification types I see, so that the tab shows what I care about.
- The per-type switches in NOTIF-05, under the heading "In-app notifications" and the note "Yappr checks for new activity while the app is open."

#### SET-04 · Privacy & Safety · P0 · all
As a user, I want to control what loads and what I see, so that I'm comfortable.
- "Link previews / Show previews with titles, descriptions, and images for links" (on by default) with the disclosure "Previews are fetched from the linked website, which can see that your device requested it." (PD-9).
- "Blur media from people you don't follow" (SAFE-07).
- "NSFW content" (SAFE-06).
- "Blocked accounts" (SAFE-03).
- "Read receipts / Let others see when you've read their messages" (v3 only; on by default).

#### SET-05 · Appearance · P0 · all
As a user, I want light, dark or system appearance, so that the app is comfortable to read.
- "Theme": "System" (default), "Light", "Dark"; applies at once without restart.
- "Feed language" (FEED-10, v2, P2).

#### SET-06 · About · P0 · all
As a user, I want to know which version I run and where to get help, so that I can report problems.
- "Yappr / Decentralized social media on Dash Platform", "Version" with the version and build. A long press on Version copies the build details ("Yappr 1.0.0 (123) · 9f8e7d6c · evo-sdk 3.0.0 · testnet", toast "Version info copied"); the commit, engine and network are not rows.
- Links: "Terms of Use", "Privacy Policy", "Community rules", "Support" (mail), "Send diagnostics" (a mail to the support address with the redacted SET-08 text, sized for a mail link: newest 10 errors, last 40 log lines, at most 5,000 characters; with no mail app, the native share sheet with the same text, led by the support address), "Open-source licenses" (a native list generated at build time), "Yappr on the web" (yap.pr).
- A muted last row, "Troubleshooting", opens SET-08, signed in or out.

#### SET-07 · Terms and privacy · P0 · all
As a user, I want to read the terms and privacy policy, so that I know what I agreed to.
- Terms and Privacy open in the in-app browser at yap.pr. "Community rules" opens one bundled sheet, readable offline: the EULA summary (AUTH-09) first, then the full rules.

#### SET-08 · Troubleshooting (diagnostics) · P0 · all
As Quinn (and any user reporting a bug), I want to see the engine's state, so that problems can be diagnosed.
- Reached from About's last row, "Troubleshooting", in every build (release and beta included) and signed out. Nothing else links it: not the Settings root, the signed-out Profile tab or the network sheet.
- Fields: engine state (Booting / Ready / Restarting / Unavailable), boot time (ms) and WASM compile time, restarts this session, evo-sdk version, engine bundle hash, network, DAPI endpoints with last success, topology and capability flags, contract ids (social, DM, profile, Pollr) with copy, WebAssembly available, cache size, last 50 engine errors (time, operation, message).
- Actions: "Copy diagnostics" first, at the top (toast "Diagnostics copied"), and "Share diagnostics" (a text bundle with no keys, no identity secrets, no message contents), "Reconnect" (confirmed: "Reconnect to Dash Platform? Lists reload; nothing you posted is lost."; restarts the engine), "Clear cache" (confirmed; keeps accounts, keys and drafts).
- Available signed out.

#### SET-09 · Settings persistence · P0 · all (PD-12)
As a user with several accounts, I want my content settings to stay the same when I switch, so that I set them once.
- Theme, NSFW mode, media gate, link previews, notification types, read receipts and feed language are device-wide and survive account switches and sign-out.

### 8.12 Network and engine states (NET)

#### NET-01 · Engine boot · P0 · all
As a user, I want the app usable while it connects, so that the start never feels stuck.
- The engine boots in the background on launch. Screens follow G-2.
- The network chip shows a subtle pulsing dot while booting and a steady one when ready.
- Boot failure (not Lockdown) shows a banner "Couldn't connect to Dash Platform." with "Try again", and the cache stays browsable.

#### NET-02 · Offline · P0 · all
As a user on a train, I want to keep reading when the connection drops, so that the app stays useful.
- The offline banner and the rules of G-1. The banner sits below the navigation bar of the current screen, `amber-50` / `amber-950` background, text "You're offline. Showing saved posts."

#### NET-03 · Dash Platform unavailable · P0 · all
As a user, I want an honest message when Dash Platform is down, so that I don't blame my phone.
- When reads fail with the "temporarily unavailable" category, lists show G-11 inline errors. The engine retries with backoff (2 s, 4 s, 8 s, then every 30 s) while the screen is visible and the app is in the foreground.
- The error stays visible while a retry runs, with "Retrying…" under it; the list's loading state is not shown again for an automatic retry.
- 1.0 note: the retry runs for every screen mounted in the tab stacks, not only the visible one (a screen kept behind the current one, another tab's stack, Home's other feed page). Native stacks keep those screens and their reads alive, and telling them apart would need focus tracking in every screen's reads. Only a list's own read is retried, not a poll or a card's embedded read, so the extra cost during an outage is one read per hidden failed list every 30 s.

#### NET-04 · Engine restart · P0 · all
As a user, I want a crash in the engine to be invisible, so that I can keep going.
- When the WebView process dies (`onContentProcessDidTerminate` / `onRenderProcessGone`), the supervisor restarts it; visible reads resume without user action and lists keep their content.
- Writes in flight at the crash keep "Posting…" / "Sending…" while the app checks them (COMP-10, DM-04); none is resent.
- After 3 restarts within 2 minutes, the "Couldn't connect" banner shows instead of looping.

#### NET-05 · Unconfirmed writes · P0 · all
As a user, I want likes and follows that timed out to settle to the truth, so that what I see matches the chain.
- G-3 for every write. A like, follow, bookmark, block or repost whose confirmation timed out keeps its optimistic state; the app checks it by itself (G-3), and if the write is absent the state reverts with its failure sentence ("Couldn't like this post. Try again.", UX_SPEC §5.4.1).

#### NET-06 · Lockdown Mode · P0 · iOS (PD-17)
As an iPhone user with Lockdown Mode on, I want to know why Yappr can't connect, so that I can fix it.
- When WebAssembly is unavailable in the engine, the app shows a full-screen "Lockdown Mode is blocking Yappr" with: "Yappr needs WebAssembly to verify Dash Platform data, and Lockdown Mode turns it off for apps. You can exclude Yappr: open Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing, and turn Yappr off." Buttons: "Open Settings" and "Browse saved posts" (cached content, read-only, every write disabled with "Unavailable in Lockdown Mode").
- On return to the foreground the engine retries; when it boots, the screen goes away.

#### NET-07 · Network chip · P0 · all
As a user, I want to know I'm on a test network, so that I don't treat it as real.
- A compact amber chip "DEVNET" or "TESTNET" in the Home header and at the bottom of Settings. Tapping it opens a sheet: "Yappr is running on a Dash Platform devnet. Posts and accounts may be reset." (testnet: "Yappr is running on Dash Platform Testnet. Posts and accounts may be reset."), and the connection state: "Connected", "Connecting…" (booting or restarting) or "Can't connect right now".
- The chip's accessibility label carries the same state: "Testnet. Data may be reset. Connected." / "… Connecting." / "… Can't connect."
- No full-width banner anywhere.

#### NET-08 · Foreground only · P0 · all
As a user, I want the app to do nothing in the background, so that it costs no battery or data when closed.
- No polling, refresh or network activity while the app is in the background, except the DM flush (DM-14). On return to the foreground: notifications poll, the new-posts check and the visible list refresh once.

#### NET-09 · Capabilities · P0 · all
As a user, I want screens to match what the network supports, so that I never tap a feature that can't work.
- At boot `engine.info()` returns the capabilities (section 3); the UI uses the last persisted set until then. If the set changes (a new engine bundle), caches for affected lists are dropped and the screens re-render.

#### NET-10 · App out of date · P1 · all
As a user on an old build, I want to be told to update, so that I don't retry a write that can never work.
- When a write is refused because the app is behind the network's rules ("This app is out of date with the network's fee rules…"), the toast reads "This version of Yappr is out of date with the network. Update the app to keep posting." with no retry.

#### NET-11 · Deep links · P0 · all
As anyone, I want Yappr links to open the right screen, so that sharing works.
- The `yappr://` scheme opens every route in UX_SPEC "Deep links". A link to a web-only route (store, blog, DPNS registration, embed, contract, about pages) opens in the in-app browser.
- An unknown route opens Home with the toast "This link isn't supported in the app" and "Open in browser".
- Universal links / App Links for `https://yap.pr` (testnet build) and `https://yap.pr/devnet/` (devnet build) work once the association files are served (P1; needs a static web change, OQ-8).

### 8.13 Accessibility (A11Y)

#### A11Y-01 · Text size · P0 · all
As a user with low vision, I want text to follow my system size, so that I can read everything.
- All text scales with Dynamic Type (iOS, up to AX5) and font scale (Android, up to 200%). At the largest sizes the action bar hides counts beside icons and shows them in the screen-reader label only; nothing is truncated that carries meaning (names may truncate with an ellipsis, post text never does).

#### A11Y-02 · Screen readers · P0 · all
As a VoiceOver or TalkBack user, I want every post and control announced clearly, so that I can use Yappr without seeing it.
- VoiceOver and TalkBack read a post card as one element: "{name}, @{handle}, {time}. {text}. {N} replies, {N} reposts, {N} likes." with custom actions (iOS rotor / Android accessibility actions): Reply, Repost, Like, Bookmark, Share, Open profile, More.
- Every icon button has a label (UX_SPEC copy deck). Decorative images are hidden. Avatars are labelled "{name}'s profile" only when tappable on their own.
- Reading order follows the visual order; headers are marked as headings.

#### A11Y-03 · Hit targets · P0 · all
As a user with limited dexterity, I want large touch targets, so that I hit what I mean to.
- Every tappable element is at least 44 × 44 pt (iOS) / 48 × 48 dp (Android), using hit slop where the visual is smaller (action bar icons are 20 pt visuals).

#### A11Y-04 · Contrast · P0 · all
As a user with low contrast sensitivity, I want readable colors in both themes, so that nothing fades out.
- Text meets WCAG AA (4.5:1; 3:1 for 18 pt+ or 14 pt bold) and non-text UI 3:1 with the UX_SPEC tokens in both themes, except the documented exception in UX_SPEC (OQ-2).

#### A11Y-05 · Reduce Motion · P0 · all
As a user sensitive to motion, I want animations reduced when I ask, so that the app doesn't make me unwell.
- With Reduce Motion on: no springs or scale effects, no heart burst, crossfades instead of slides for custom transitions, and no auto-scrolling animations (jumps instead). Skeleton pulses become static.

#### A11Y-06 · Announcements · P1 · all
As a screen-reader user, I want to hear when something I did succeeds or fails, so that I'm not left guessing.
- Toasts are announced. Write status changes ("Posting…", "Couldn't confirm", "Couldn't post") are announced once. The new-posts pill is announced when it first appears.

#### A11Y-07 · Right-to-left content · P0 · all
As a reader of Arabic or Hebrew posts, I want them laid out right to left, so that they read naturally.
- App chrome stays left-to-right (English only in 1.0). User content follows G-9: each text block takes the direction of its first strong character; names and handles in mixed direction are isolated so `@handle` and the time don't reorder.

#### A11Y-08 · Test identifiers · P0 · all
As Quinn, I want stable identifiers on every control, so that automated flows don't break with copy changes.
- Every interactive element and every list item has a stable `testID` matching web's `data-testid` names where one exists (for example `sensitive-show-btn`, `more-btn-{postId}`, `report-{postId}`), so Maestro flows and agents can address them.

#### A11Y-09 · Bold text and increased contrast · P2 · all
As a user who turns on Bold Text or Increase Contrast, I want the app to honour it, so that it stays legible.
- With iOS Bold Text, weights step up one level. With Increase Contrast (iOS) / high-contrast text (Android), secondary text uses the primary text color and borders use the strong border token.

---

## 9. Deferred (post-1.0)

| Feature | Web has it? | Why it waits | Earliest |
| --- | --- | --- | --- |
| Push notifications, relay, NSE, background polling | No (web polls in a tab) | ADR E7; needs the relay and the WebView can't run in the background | 1.1 |
| Background sync | No | ADR E1: foreground only until the Rust engine | Rust engine |
| Private feeds (post privately, request access, approve, decrypt, reset) | Yes | ADR E7; 3.4k lines of crypto surface, needs encryption-key UX | 1.x |
| Tips (posts and profiles), payment-URI QR codes | Yes | ADR E7; App Review 3.1.1 constraints on iOS | 1.x |
| Storefront, cart, orders | Yes | ADR E7; links out to yap.pr | 1.x reader |
| Blog (read, write, comments; Explore Blogs tab; profile Blog tab; blog notifications) | Yes | ADR E7; links out | 1.x reader |
| Poll creation and voting | Yes | ADR E7; read-only display in 1.0 (POST-09) | 1.1 |
| DPNS username registration | Yes | ADR E7; wallet-signed contested flow; links out (AUTH-15) | 1.x |
| Image and media upload (Storacha, Pinata), media arrays | Yes (one image) | ADR E7; provider credentials and EXIF handling | 1.1 |
| Profile reports and DM reports | No | ADR E7; waits for the contract cut with identity targets (COMPLIANCE D7) | Next social cut |
| Account deletion | No | ADR E7; required before a public store release (COMPLIANCE C5) | Before store |
| Moderation denylist enforcement | No | COMPLIANCE Y7; store blocker, not a beta blocker | Before store |
| Moderator tools: remove, restore, report queue, elections, bans, warnings | Yes | ADR E7 | Web only for now |
| Passkey and password-vault sign-in, key backup | Yes | ADR E5; devnet/testnet artefact (README D9) | Never on mobile |
| App Connect enabled | No | No wallet ships it yet (ADR E5) | When a wallet does |
| Following other users' block lists (management UI) | Yes | Inherited blocks are honoured; management stays on web | 1.1 |
| DashPay contacts import | Yes | Not in E7 | 1.1 |
| YAPP purchase, starter-grant claim, "Pay with" setting | Yes | PD-11; App Review 3.1.1; YAPP locked on dev | Not planned on iOS |
| Hashtag and mention index recovery ("Hashtag Not Registered") | Yes | Rare repair flow; stays on web | 1.1 |
| Compose formatting toolbar, Markdown preview, emoji picker | Yes | System keyboard covers emoji; rendering of Markdown is in 1.0 | 1.1 |
| Hashtag autocomplete | No | PRODUCT_UX wanted it; not in E7 | 1.1 |
| DM requests inbox, DM report, delete-for-me, reactions | No | Not in E7; DM reports wait for the cut | 1.1+ |
| Muted words | No | 1.1 per PRODUCT_UX | 1.1 |
| Share extension, widgets | No | Native extension targets | 1.1 |
| Query inspector / developer settings | Yes | Troubleshooting (SET-08) replaces it on mobile | Not planned |
| Storage provider settings | Yes | No upload in 1.0 | With upload |
| iPad, foldable layouts | Yes (responsive web) | ADR E7 | 1.x |
| Localization | No | ADR E7 | 1.1 |
| The Rust engine, native signer | n/a | ADR E1 post-1.0 track; required before mainnet | Before mainnet |

## 10. ADR E7 traceability

| ADR E7 item | Stories |
| --- | --- |
| Onboarding: welcome, sign-in, EULA / community-rules gate, signed-out browsing | AUTH-01 – AUTH-15 |
| Home: For You and Following, Top where supported, new-posts pill, pull-to-refresh, infinite scroll | FEED-01, FEED-02, FEED-04, FEED-05, FEED-06, FEED-07 |
| Post detail: thread with replies, removed and deleted stubs, engagements | POST-01 – POST-06 |
| Compose: post, reply, quote, threads, mentions with autocomplete, hashtags, NSFW flag, counter, persisted drafts, write-status UI | COMP-01 – COMP-11 |
| Engagement: like, repost, bookmark (with Bookmarks screen), share, delete own post | ENG-01 – ENG-08 |
| Profiles: posts, replies, top, mentions tabs; follow; followers and following; edit profile (DashPay + `yapprProfile` on v10/v11, v2 profile on testnet), avatar by URL or DiceBear | PROF-01 – PROF-08 |
| Explore: users, hashtags, posts search; trending; top posts and creators; hashtag pages | EXPL-01 – EXPL-07 |
| Notifications: in-app, foreground polling, filters, mark-visible-read, per-type toggles | NOTIF-01 – NOTIF-05 |
| Messages: DM v5 1:1 and groups (create, rename, members, leave); legacy 1:1 on testnet | DM-01 – DM-14 |
| Safety: block, unblock, blocked list, block messages; report posts and replies; NSFW gate; media gate; removed stubs | SAFE-01 – SAFE-08, DM-10, POST-04 |
| Settings: account, notifications, privacy, appearance, about, terms and privacy, engine diagnostics | SET-01 – SET-09 |
| Display: IPFS media with gateway fallback, link previews, polls (read-only) | FEED-12, POST-09, SET-04 |
| E4 navigation: five tabs, FAB, network chip, native conventions | UX_SPEC navigation; NET-07 |
| E5: multiple accounts, biometric unlock, test-wallet responder | AUTH-10, AUTH-12, AUTH-03 |
| E1: Lockdown Mode, engine restart, cache-first boot | NET-06, NET-04, FEED-11 |

## 11. Open questions

| # | Question | Default until answered |
| --- | --- | --- |
| OQ-1 | What support email and URL do "Report by email" (SAFE-05) and About → Support use? | Placeholder `support@yap.pr`; the build fails a release check while it's a placeholder |
| OQ-2 | White text on `yappr-500` buttons is 2.77:1, below AA. Darken the fill to `yappr-600` (4.1:1) or `yappr-700` (5.9:1), or accept the exception? | Keep `yappr-500` for fidelity, logged as an AA exception |
| OQ-3 | Should mobile require a DPNS name like web does? | No (PD-2) |
| OQ-4 | Is it acceptable that the testnet build can't post without YAPP bought on yap.pr? | Yes: testnet is a read-heavy dogfooding build (ADR E6) |
| OQ-5 | Who writes the community-rules summary and the zero-tolerance clause, and where is the terms version number kept? | UX_SPEC carries a draft; the version is a constant in the app until web publishes one |
| OQ-6 | ADR E2 was amended so RN imports no `lib/` code at runtime for limits and topology. Do the formatting helpers (`formatTimeCompact`, `formatNumber`, in `lib/utils/common.ts`) stay importable, or does RN port them? | RN ports them with the same outputs, pinned by a shared-fixture test |
| OQ-7 | The devnet topology on sakura: v10 or v11? `docs/SOCIAL_V11.md` is on branch `v5b1/social-v11`, not yet merged. | Both are supported through capability flags; v11-only stories are P1 |
| OQ-8 | Universal links need `apple-app-site-association` and `assetlinks.json` under `public/.well-known/`, a static web change outside the ADR E2 list. Who lands it? | `yappr://` links in 1.0; universal links when the files ship |
| OQ-9 | Link previews fetched directly from the device (PD-9) reveal the user's IP to the linked site. Keep, or route through the same proxies as web? | Direct, with the disclosure |
| OQ-10 | Should the engagements screen stay readable signed out (PD-16)? | Yes |
| OQ-11 | Can a wallet response published after the 120 s poll still be read when the user taps "Check again" within 10 minutes (AUTH-03)? Confirm against `vendor/platform-auth` and the wallets. | Yes; if not, "Check again" always creates a fresh request |

### 11.1 Lead decisions (2026-10-01)

| OQ | Decision |
| --- | --- |
| 1 | Support address: `support@yap.pr`, already used on web. About → Support links to it. "Report by email" on testnet also uses it. |
| 2 | **Darken.** In light mode, every `accent` fill that carries white text or icons uses `yappr-600` (`#0284c7`): primary buttons, the FAB, count badges, the new-posts pill and own DM bubbles. White on `#0284c7` passes AA for large or bold text and for icons, at 3:1 or better. Dark mode keeps `yappr-500`. Links and other text accents use the darker shades UX_SPEC already lists. |
| 3 | No forced username. An identity without one uses the app normally and gets the dismissible "Get a username" card, in line with #605 (the profile is optional). |
| 4 | Accepted. The testnet build is for dogfooding real data with mostly reading. A YAPP shortfall links to yap.pr. |
| 5 | Mobile drafts the community-rules text from COMPLIANCE.md in the onboarding PR. The terms version is a constant in the app; bumping it re-shows the gate. |
| 6 | No app decision is needed. The engine takes the topology from the variant env (`.env.devnet`), so mobile follows whatever cut `/devnet` runs. |
| 7 | Mobile lands the two app-link files under `public/.well-known/` in a separate small web PR (ADR E2 amended). |
| 8 | Keep web behavior. The engine runs `lib/link-preview` unchanged, including its proxy rules, so mobile and web disclose the same thing. Update the privacy note to match. |
| 9 | The sign-in PR (S1) verifies this against the key-exchange contract and documents the result. |
| 10 | `lib/utils/common.ts` is env-free and goes on the allowlist. |

