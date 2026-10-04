# Product and UX

> **For 1.0, [PRD.md](PRD.md) and [UX_SPEC.md](UX_SPEC.md) are the source of
> truth** for scope, behaviour, navigation, screens and copy. This document
> keeps the product principles, the personas and the copy rules, and describes
> the longer-term product. Where it disagrees with
> [ADR-001](ADR-001-mobile-1.0.md) E4 (navigation) or E7 (1.0 scope), the ADR
> wins; the sections below are annotated "**1.0:**" where that happens.

## Who it's for

| Persona | Situation | What they need from mobile |
| --- | --- | --- |
| **Dash holder (launch core)** | Has DashPay on their phone and maybe a username; curious about Platform apps | Sign in with one tap from DashPay, see Yappr as "the social side of my Dash identity" (their DashPay name and avatar appear at once), tip friends |
| **Existing Yappr web user** | Posts from desktop; logged in with the wallet QR | The same identity, feed, DMs and private feeds on their phone, plus notifications they don't get on web |
| **Crypto-curious newcomer** | Heard about Yappr, has no DashPay | A clear path: install DashPay, create a username (costs a little DASH), come back. They can browse read-only meanwhile. |
| **Creator** | Posts often, runs a private feed, gets tips | Fast compose with media, manage private-feed requests on the go |

Anti-goal: we don't build a wallet, exchange, or onboarding that hides the fact
that identities cost DASH.

## Information architecture

Tab bar with five tabs (ADR E4); iPhone and Android phones share the same
layout. Compose is a floating button, not a tab:

```
┌─────────────────────────────────────────────────────┐
│                                              ( ✎ )  │  compose FAB on Home,
├─────────────────────────────────────────────────────┤  Explore and Profile
│ Home     Explore    Notifications   Messages   Profile │
└─────────────────────────────────────────────────────┘
```

- **Home.** Tabs For You / Following, in web order, with a Recent / Top sort
  where the topology supports it (Top ranks the rolling 3-day window of likes,
  `like.byTrendPost`, or all time). Pull to refresh. New posts arrive as a
  "Show N new posts" pill, polled every 15 s in the foreground, never by
  jumping the scroll position.
- **Explore.** Search (users by username prefix, hashtags, recent posts),
  trending hashtags (rolling 24 h on dev), top posts and top creators
  (all-time) where the topology supports them. **1.0:** no suggested follows.
- **Compose (FAB).** A full-screen modal sheet, not a tab destination.
  **1.0:** no private posts, so no long-press menu.
- **Notifications.** A primary tab (the web hides them under "Menu").
  Filters: All, Likes, Reposts, Replies, Follows, Mentions. **1.0:** no
  Requests filter (private feeds are deferred).
- **Messages.** Conversations sorted by last activity and a new-chat button.
  **1.0:** no separate requests inbox.
- **Profile.** Your own profile is a tab; others open from any name or avatar.
  Your own profile holds Settings, Bookmarks, Blocked accounts and Switch
  account (also a long-press on the tab).

Stacks push over tabs: post thread, profile, followers and following, hashtag,
engagements, settings screens. Deep links and universal links resolve to the
same routes as web query URLs:

| Web | Mobile route |
| --- | --- |
| `https://yap.pr/post?id=X` | `yappr://post?id=X` and universal link → Thread |
| `/user?id=X`, `/user?id=X&tip=…` | Profile (**1.0:** `tip` is ignored; tips are deferred) |
| `/hashtag?tag=T` | Hashtag |
| `/messages?…` | Messages |
| `/app/connect?r=…` | Sign-in return ([WALLET_INTEGRATION.md](WALLET_INTEGRATION.md#request-format-and-return-path)), only with `FEATURE_APP_CONNECT` |

The `yappr://` scheme keeps web's paths and query parameters, so the mapping
is one to one. The full table is in [UX_SPEC.md](UX_SPEC.md#35-deep-links).

The universal link config (`apple-app-site-association`, `assetlinks.json`)
is served from `yap.pr/.well-known/`. This is a small web change on the Y7
list:

- Add both files under `public/.well-known/`. The Next static export copies
  them into the site root.
- The Pages deploy (`.github/workflows/deploy.yml`) uploads the artifact with
  `upload-pages-artifact@v3` and has no Jekyll step, so dot-directories should
  be served. Confirm with `curl` after the first deploy.
- If that action is upgraded to v4, set `include-hidden-files`.
- Apple requires the AASA file to be served as JSON without a redirect. Check
  this against GitHub Pages' content type.

## Key flows

### 1. First run and sign-in

> **1.0:** sign-in is the existing `dash-key:` key exchange (same-device deep
> link or QR), with private key entry under "Other ways to sign in"; App
> Connect is built but flagged off (ADR E5). After sign-in comes the terms /
> community-rules gate, then Home: there is no follow-suggestions step and no
> notification-mode choice (push is deferred). See PRD AUTH-01 – AUTH-15.

```
[Welcome]                     [How Yappr works]              [Sign in]
 Yappr logo                    • Your identity lives on       ┌──────────────────────┐
 "Social, owned by you."         Dash Platform, not our       │  Continue with       │
                                 servers                      │  DashPay     (icon)  │
 (Browse without signing in)   • DashPay holds your keys      └──────────────────────┘
 [ Get started ]               • Posting costs tiny fees       No DashPay? Get it ↗
                               [ Continue ]                   Terms · Privacy
                                                              (EULA checkbox ✔ first time)
        │
        ▼ opens DashPay → user approves → returns (cb or manual)
[Setting up…]  →  [Follow suggestions] (DashPay contacts on Yappr, top creators)
               →  [Notifications: Private or Instant?] → OS permission prompt (only if user chose)
               →  Home
```

- **No profile step** (D15). The user appears by their DashPay `displayName`
  and avatar, else their DPNS label, else `User <last6>`. Editing the profile
  is available any time from the profile screen.
- **Browse without signing in.** Available straight from Welcome: Home falls
  back to For you, and Explore, profiles and threads are viewable. Any write
  action opens the sign-in sheet, which comes back to the action afterwards.
  This is also what App Review sees first.
- **Error paths**
  - No wallet installed.
  - Wallet has no identity.
  - Wrong network.
  - Cancelled.
  - Timed out.
  - Keys not yet confirmed: wait up to 60 s with the progress state, then
    "Still confirming, we'll keep checking".

  Each has a screen with one primary action; see the WALLET_INTEGRATION table.

### 2. Compose

> **1.0:** text, replies, quotes, threads of up to 10, mention
> autocomplete, the NSFW flag, the character and byte counter, persisted
> drafts and the write-status states. Media is displayed but not uploaded;
> there is no private visibility, no hashtag autocomplete, and the cost line
> is a P2. The counter is web's always-visible "current / limit" text, not a
> ring. YAPP is not hidden: Settings shows the balance read-only where the
> contract has a token, and writes use web's default payment plan (PRD
> PD-11). Before a moderation team is seated, Post stays enabled and the
> refusal arrives as an error ("This opens once the community elects its
> moderation team. Nothing was posted."). See PRD COMP-01 – COMP-13.

- **Sheet.** Text up to 1,000 characters and 2,000 UTF-8 bytes (v10; bytes
  bind first for CJK and emoji). The counter ring tracks whichever limit is
  closer and appears at 90%.
- **Media.** On the Y1 cut (D8): up to 4 images, or 1 video, or 1 GIF, each
  item hashed (`sha256`) and, for images, fingerprinted (dHash). Before Y1 is
  live, one image. A quote card when quoting, and a reply context header.
- **Autocomplete.** Mentions use DPNS prefix search. Hashtags complete from
  recent and trending tags. Only the **first** #tag and the **first** @mention
  in the public text are indexed; only that mention notifies. The composer
  hints this when a second one is typed.
- **Visibility.** Public, or Private feed (visible only when the user has a
  private feed). Also a sensitive-content toggle. (v10 has no language field.)
- **Threads.** "Add to thread" (+) builds multi-post threads, reusing
  `lib/compose/publish-thread.ts`.
- **Cost line**
  - It shows what the post will cost before sending, using
    `lib/payment-preference.ts` `planPayment`. Each part is named honestly: a
    "Network fee ~0.0000x DASH" line for processing, and a "Moderation fee
    (goes to elected moderators)" line at the amount actually charged: the
    seated charter's share of the post or reply cap (at most 0.0008 / 0.00016
    DASH at a 1× multiplier). See [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping).
  - No YAPP in the UI on either OS. YAPP is optional on the social cut, cannot
    be bought, and the only source is a one-time grant.
  - If credits are too low, it offers "Top up in DashPay" and posting stays
    disabled.
  - Until the launch contract's first charter is seated, posting is closed
    (D5). The composer then shows "Posting opens once the community elects its
    moderation team" instead of the send button.
- **Posting.** Optimistic: the post appears at the top with a "Posting…"
  state; see "Unconfirmed writes" below.
- **Drafts.** Autosaved per account, and restored after a crash or kill.
- **Share extension (1.1).** Text, URL or images from other apps open the same
  compose UI.

### 3. Reading and engaging

> **1.0:** the action row is Reply, Repost / Quote, Like, Bookmark and Share.
> Long-press and "⋯" open one menu: Follow / Unfollow, View post engagements,
> Copy link, Share, Delete (own), Block, Report (where the contract takes
> reports; by email on testnet). There is no Mute thread. NSFW posts default
> to "Warn first" (an opaque cover), as on web, and the setting is
> device-wide, not per account. Replies from blocked accounts read "Reply
> from an account you blocked". Private posts render a "Private post"
> placeholder. See PRD ENG-*, SAFE-06, POST-08, G-6.

- **Post cells.** Avatar, name, @username, time, text with links, mentions and
  hashtags, media, link preview, quote card, and an action row.
- **Action row.** Reply, Repost / Quote (menu), Like with a haptic, Share
  (system share sheet with the `yap.pr` universal link), and a **⋯ menu**:
  Bookmark, Copy link, Mute thread, **Report**, **Block @user**. The report
  and block entries are the App Review 1.2 surface.
- **Reposts.** On v10 a repost is a quote with no content, priced as a post.
  One quote or repost per author per target; undo deletes it. Replies can be
  reposted too.
- **Sensitive content.** Blurred with "Show" until the user opts in under
  Settings → Content. The default is on (hide) for everyone, and the setting is
  per account. It reuses `lib/sensitive-content.ts`.
- **Blocked users.**
  - Content disappears immediately, locally and in all caches.
  - Blocks write the existing `block` document, so they sync with web.
  - Replies from blocked users collapse to "Reply from a blocked account".
- **Thread view.** Ancestors are collapsed above the focused post, then the
  direct replies, each branch expandable. v10 pages a thread one branch at a
  time; there is no global newest-first order across branches. Private posts
  show a locked card: "Request access to @x's private feed".

### 4. Profiles

> **1.0:** no Tip button, no profile reports, no DashPay-contact badge.
> Username registration links out to yap.pr. Edit profile follows the
> topology: the DashPay `profile` + `yapprProfile` on v10/v11, the profile
> contract on testnet (v2). See PRD PROF-*.

- **Header.** Banner, avatar, display name, @username with a DashPay-contact
  badge when both of you are contacts, bio, links (validated with
  `lib/social-link-validation.ts`), and follower / following counts.
- **Buttons.** Follow / Following, Message, a **Tip** button when the profile
  has payment URIs, and the ⋯ menu (share, report, block, add as DashPay
  contact).
- **Tabs.** Posts, Replies, Top, Mentions (as on web). v10 has no index by
  liker or by media, so there is no Likes or Media tab.
- **Edit profile.** Name, bio and avatar are the DashPay profile's fields
  (name ≤ 25, bio ≤ 140), and the screen says "This also updates your DashPay
  profile". Banner, links, payment URIs and the other Yappr-only fields live in
  `yapprProfile`. The first save creates whatever does not exist yet (the
  DashPay profile first, then the extension). Username registration hands off
  to DashPay.

### 5. Messages

> **1.0:** DM v5 1:1 and groups (create, rename, add and remove members,
> leave, end) on devnet; legacy 1:1 DMs (v3, with read receipts) on testnet.
> No requests inbox, no DM reports, no delete-for-me. A user without an
> encryption key on the device sees the "Unlock your messages" flow. See PRD
> DM-*.

- **List.** Unread dot and a line of preview text, decrypted on the device.
  Requests from people you don't follow go to a separate "Requests" inbox
  until the user accepts. There are no read receipts: DM v5 deliberately
  omits them (DM_V5 §12.3).
- **Conversation.** Bubbles, day separators, a "Sending / Sent / Failed"
  state, long press for Copy, Report, Delete for me.
- **Report.** Reporting a conversation files a DM report that carries that
  conversation's key for the moderators (D7). Before the user confirms, the
  sheet says "Moderators will be able to read this conversation, including
  messages sent after this report", and that the report is public. Until a
  charter is seated, the report goes by email instead.
- **Groups (DM v5).** Group name, member list, invite, leave.
- **Key missing.** If the user has no encryption key on the identity, show a
  one-time explainer: "To use messages, DashPay needs to add an encryption key
  to your identity". Then hand off to the wallet (a MASTER-signed
  `IdentityUpdate`). The App Connect sign-in normally provisions it up front.
- **Legacy threads.** v4 (bonsia) and v3 (testnet) threads read inline. New
  messages go out on the network's active DM version.

### 6. Tips (profile level)

> **1.0:** deferred (ADR E7). Nothing in this section ships in 1.0.

- **Where tips live.** Profile → Tip opens a sheet listing the recipient's
  payment URIs (DASH first). Pick an amount (suggested chips of $1, $5, $10 in
  the local currency via `crypto-price-service`, or custom), then "Open in
  DashPay" builds a `dash:` URI with `amount`.
- **Coming back.** When the user returns, the sheet shows "Did it go through?".
  It watches the address via Insight for 2 minutes, then shows a "Tip sent"
  toast or "We couldn't confirm; check DashPay".
- **No tips on posts on iOS** (App Review 3.1.1). Proved credit tips on posts
  (a tip document bound to a credit transfer) are a 1.x design for web and
  Android. There is no tip history until they exist.
- **YAPP.** No YAPP balance or purchase anywhere: YAPP is locked on v10.

### 7. Notifications

> **1.0:** in-app only, polled every 30 s while the app is in the foreground,
> with filters, mark-visible-read and per-type toggles. No pre-permission
> screen, no grouping except v11's timeless like groups, no delay banner. Push
> and background polling are 1.1 (ADR E7). See PRD NOTIF-*.

See [NOTIFICATIONS.md](NOTIFICATIONS.md). UX essentials:

- **Pre-permission screen.** Two cards: **Private** ("Checks for new activity
  now and then. No servers involved.") and **Instant** ("Get notified right
  away via a relay that can't read your notifications."). The OS prompt comes
  only after this screen.
- **Grouping.** The Alerts tab groups items ("@a, @b and 3 others liked…").
  Tapping deep-links to the thread with the item highlighted.
- **Delay banner.** If polling is delayed (Background App Refresh off or
  throttled), an inline card explains the delay and offers Instant.

### 8. Private feeds

> **1.0:** deferred (ADR E7). Encrypted posts render a "Private post"
> placeholder.

- **Owner.** Settings → Private feed: enable it (creates the feed seed; the
  UI explains the cost), see requests with approve and decline, followers with
  revoke, and capacity (x of 1024).
- **Follower.** "Request access" on the profile; a pending state; a
  notification on approval. Private posts then decrypt inline.

### 9. Settings

> **1.0:** Account (identity, balance, usernames, accounts, app lock, sign
> out), Notifications (per-type toggles), Privacy & Safety (link previews,
> media gate, NSFW mode, blocked accounts, read receipts on testnet), Messages
> (DM v5 fee reclaiming), Appearance (theme), About (terms, privacy, community
> rules, support, licenses, with Troubleshooting as its last row). No delete account, media
> and storage, or notification modes in 1.0. See PRD SET-*.

| Section | Contents |
| --- | --- |
| Account | Usernames, balance (DASH, read-only), accounts and app lock, created, "Copy account ID", Sign out (UX_SPEC §4.26) |
| Notifications | Mode, per-type toggles, quiet hours, previews, diagnostics |
| Privacy & safety | Blocked accounts, muted words (local, 1.1), sensitive content, DM requests, instant DM alerts (opt-in; see NOTIFICATIONS) |
| Security | App lock (Face ID / Touch ID / biometric / device PIN, with a timeout), devices signed in (links to DashPay → Connections), count of retired keys, sign out everywhere (opens the wallet) |
| Media & storage | Upload provider (Pinata / Storacha), data saver (no autoplay, low-res on cellular), clear cache |
| Appearance | System / Light / Dark, text size follows the system |
| About & legal | Terms (EULA), Privacy, Community guidelines, contact & support, licenses, version |
| Delete account | See [COMPLIANCE.md](COMPLIANCE.md#account-deletion) |

## Scope by release

| Area | 1.0 (both platforms) | 1.1–1.3 | Web only (foreseeable) |
| --- | --- | --- | --- |
| Identity | **1.0:** wallet key exchange (`dash-key:`) and private key entry, App Connect flagged off; multiple accounts; optional profile edit (DashPay profile + `yapprProfile`, or the v2 profile); app lock; DPNS registration links out. Later: App Connect with per-device keys, DPNS register via the wallet | Limited-key sessions (W7), invites, messaging-key reset (Y6) | Passkey/password vault login (**1.0:** private key entry is on mobile too, ADR E5) |
| Feed | For You / Following with Recent / Top, threads, quotes, reposts, bookmarks, hashtags, search, explore | Lists, muted words | Query inspector |
| Compose | **1.0:** text, replies, quotes, threads, mentions, sensitive flag, persisted drafts (no offline queue; media display only). Later: up to 4 images / 1 video / 1 GIF (Y1 cut), private posts | Share extension, polls (Pollr) | — |
| Messages | 1:1 and group DMs (v5); legacy 1:1 (v3) on testnet. Later: requests inbox | Voice notes? (evaluate), reactions | — |
| Notifications | **1.0:** in-app, foreground polling. 1.1: private background polling, Instant relay/UnifiedPush, actions, communication notifications | Watcher relay, synced read state, widgets | — |
| Safety | **1.0:** report posts and replies (where the topology takes reports), block, sensitive filter, media gate, EULA. Before a public store release: profile and DM reports, moderation denylist, account deletion | Muted words, trust-level filters | Moderator tools, elections, report queue |
| Money | **1.0:** credit balance display only. Later: profile tips via DashPay (`dash:`) | Proved credit tips on posts (Android), top-up deep link | Post tips on iOS are never offered (policy) |
| Other apps | — | Blog reader, storefront browse/buy + seller inbox | Blog editor, store management, CSV inventory |
| Platforms | iPhone, Android phones | iPad, foldables, localization | — |

## Design system

- **Tokens.** Color, type scale, radius and spacing are extracted from
  `tailwind.config.js` into `mobile/app/src/ui/tokens.ts`, so web and mobile
  share one source.
- **Components.** Native first: iOS system blur and sheets, and Material 3
  touches on Android for the top app bar, snackbars and ripples. The chrome is
  shared, while the controls follow each platform's conventions.
- **Motion.** Reanimated at 60/120 fps. Haptics on like, repost, pull to
  refresh and send. Reduce Motion is respected.
- **Accessibility.** Every control has a label. Dynamic Type goes up to AX5 in
  feed cells. Touch targets are at least 44 pt (iOS) and 48 dp (Android).
  Contrast is WCAG AA. VoiceOver and TalkBack reading order is tested in QA.
- **Empty and error states.** Written for Dash-specific failures, as in these
  examples:
  - DAPI timeouts: "Network is slow; your post is still being confirmed."
  - Low credits.
  - A key the wallet has revoked.
  - Posting closed until the moderation team is seated.

## Unconfirmed writes (UX contract)

Dash Platform often times out when confirming a write that actually succeeded
(see the known 504 issue in the root CLAUDE.md). The mobile UX mirrors web:

- **Posting state.** The item appears at once with "Posting…". After
  broadcast it turns normal, then gets reconciled against the chain in the
  background.
- **Not confirmed.** After 60 s it shows a subtle "Not confirmed yet" with
  Check again and Retry. Retry reuses the same document ID where possible, so
  it can't double-post.
- **Tips and payments are never auto-retried.** They always show "Check
  again".
