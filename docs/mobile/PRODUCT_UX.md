# Product and UX

## Who it's for

| Persona | Situation | What they need from mobile |
| --- | --- | --- |
| **Dash holder (launch core)** | Has DashPay on their phone and maybe a username; curious about Platform apps | Sign in with one tap from DashPay, see Yappr as "the social side of my Dash identity", tip friends |
| **Existing Yappr web user** | Posts from desktop; logged in with the wallet QR or a passkey | The same identity, feed, DMs and private feeds on their phone, plus notifications they don't get on web |
| **Crypto-curious newcomer** | Heard about Yappr, has no DashPay | A clear path: install DashPay, create a username (costs a little DASH), come back. They can browse read-only meanwhile. |
| **Creator** | Posts often, runs a private feed, gets tips | Fast compose with media, manage private-feed requests on the go, see who tipped |

Anti-goal: we don't build a wallet, exchange, or onboarding that hides the fact
that identities cost DASH.

## Information architecture

Tab bar with five tabs; iPhone and Android phones share the same layout:

```
┌───────────────────────────────────────────────┐
│ Home        Explore      ✚      Alerts   Chats │
│ (feed)      (search,   (compose (notif.) (DMs) │
│             trending)   sheet)                 │
└───────────────────────────────────────────────┘
```

- **Home.** Segmented Following / For you / Top (Top on v9 only). Pull to
  refresh. New posts arrive as a "↑ 12 new posts" pill, never by jumping the
  scroll position.
- **Explore.** Search (users by username prefix, posts, hashtags), trending
  hashtags, suggested follows (DashPay contacts first), top creators.
- **Compose (✚).** A modal sheet, not a tab destination. A long press offers
  "New post" or "New private post".
- **Alerts.** Filters: All, Mentions, and Requests (private feed).
- **Chats.** Conversations sorted by last activity, requests from people you
  don't follow in a separate inbox, and a new-chat button.
- **Profile.** Opened from the avatar in the Home header (left) and from any
  username. Your own profile holds Settings, Bookmarks, Private feed and
  Switch account.

Stacks push over tabs: post thread, profile, followers and following, hashtag,
engagements, settings screens. Deep links and universal links resolve to the
same routes as web query URLs:

| Web | Mobile route |
| --- | --- |
| `https://yap.pr/post?id=X` | `yappr://post/X` and universal link → Thread |
| `/user?id=X`, `/user?id=X&tip=…` | Profile (with tip sheet) |
| `/hashtag?tag=T` | Hashtag |
| `/messages?…` | Chat |
| `/app/connect?r=…` | Sign-in return ([WALLET_INTEGRATION.md](WALLET_INTEGRATION.md#request-format-and-return-path)) |

The universal link config (`apple-app-site-association`, `assetlinks.json`)
is served from `yap.pr/.well-known/`. This is a small web change on the Y2
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

```
[Welcome]                     [How Yappr works]              [Sign in]
 Yappr logo                    • Your identity lives on       ┌──────────────────────┐
 "Social, owned by you."         Dash Platform, not our       │  Continue with       │
                                 servers                      │  DashPay     (icon)  │
 (Browse without signing in)   • DashPay holds your keys      └──────────────────────┘
 [ Get started ]               • Posting costs tiny network    No DashPay? Get it ↗
                                 fees                          Terms · Privacy
                               [ Continue ]                   (EULA checkbox ✔ first time)
        │
        ▼ opens DashPay → user approves → returns (cb or manual)
[Setting up…]  →  [Create profile] (name, avatar, bio; prefilled from DashPay profile if present)
               →  [Pick interests / follow suggestions] (DashPay contacts on Yappr, top creators)
               →  [Notifications: Private or Instant?] → OS permission prompt (only if user chose)
               →  Home
```

- **Browse without signing in.** Available straight from Welcome: Home falls
  back to For you, and Explore, profiles and threads are viewable. Any write
  action opens the sign-in sheet, which comes back to the action afterwards.
  This is also what App Review sees first.
- **Prefill from DashPay profile.** Read the DashPay `profile` document
  (`displayName`, `avatarUrl`, `publicMessage`) as suggestions only; the user
  confirms.
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

- **Sheet.** Text up to 500 characters, with a counter ring that appears from
  450. Attachments (up to 4 images, or 1 video, or 1 GIF), quote card when
  quoting, and a reply context header.
- **Autocomplete.** Mentions use DPNS prefix search. Hashtags complete from
  recent and trending tags.
- **Visibility.** Public, or Private feed (visible only when the user has a
  private feed). Also a sensitive-content toggle and a language chip.
- **Threads.** "Add to thread" (+) builds multi-post threads, reusing
  `lib/compose/publish-thread.ts`.
- **Cost line**
  - It shows what the post will cost before sending, using
    `lib/payment-preference.ts` `planPayment`. Each part is named honestly: a
    "Network fee ~0.0000x DASH" line for processing, and any contract action
    fee on its own line with where it goes. On the launch contract that line
    should not exist; see [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping).
  - No YAPP in 1.0 on either OS. YAPP is an Android 1.1 option.
  - If credits are too low, it offers "Top up in DashPay" and posting stays
    disabled.
- **Posting.** Optimistic: the post appears at the top with a "Posting…"
  state; see "Unconfirmed writes" below.
- **Drafts.** Autosaved per account, and restored after a crash or kill.
- **Share extension (1.1).** Text, URL or images from other apps open the same
  compose UI.

### 3. Reading and engaging

- **Post cells.** Avatar, name, @username, time, text with links, mentions and
  hashtags, media grid, link preview, quote card, and an action row.
- **Action row.** Reply, Repost / Quote (menu), Like with a haptic, Share
  (system share sheet with the `yap.pr` universal link), and a **⋯ menu**:
  Bookmark, Copy link, Mute thread, **Report**, **Block @user**. The report
  and block entries are the App Review 1.2 surface.
- **Sensitive content.** Blurred with "Show" until the user opts in under
  Settings → Content. The default is on (hide) for everyone, and the setting is
  per account. It reuses `lib/sensitive-content.ts`.
- **Blocked users.**
  - Content disappears immediately, locally and in all caches.
  - Blocks write the existing `block` document, so they sync with web.
  - Replies from blocked users collapse to "Reply from a blocked account".
- **Thread view.** Ancestors are collapsed above the focused post, then
  replies. Private posts show a locked card: "Request access to @x's private
  feed".

### 4. Profiles

- **Header.** Banner, avatar, display name, @username with a DashPay-contact
  badge when both of you are contacts, bio, links (validated with
  `lib/social-link-validation.ts`), and follower / following counts.
- **Buttons.** Follow / Following, Message, a **Tip** button when the profile
  has payment URIs, and the ⋯ menu (share, report, block, add as DashPay
  contact).
- **Tabs.** Posts, Replies, Media, Likes (own only). "Tips received" is
  Android 1.1+ only: YAPP tips on posts are hidden on iOS, and so is their
  history.
- **Edit profile.** Name, bio, avatar, banner, links and payment URIs.
  Username registration opens `dpns/register` natively.

### 5. Messages

- **List.** Unread dot and a line of preview text, decrypted on the device.
  Requests from people you don't follow go to a separate "Requests" inbox
  until the user accepts. There are no read receipts: DM v5 deliberately
  omits them (DM_V5 §12.3).
- **Conversation.** Bubbles, day separators, a "Sending / Sent / Failed"
  state, long press for Copy, Report, Delete for me.
- **Groups (DM v5).** Group name, member list, invite, leave.
- **Key missing.** If the user has no encryption key on the identity, show a
  one-time explainer: "To use messages, DashPay needs to add an encryption key
  to your identity". Then hand off to the wallet (a MASTER-signed
  `IdentityUpdate`). The App Connect sign-in normally provisions it up front.
- **Legacy threads.** v3/v4 threads read inline. New messages go out on the
  network's active DM version.

### 6. Tips (profile level)

- **Where tips live.** Profile → Tip opens a sheet listing the recipient's
  payment URIs (DASH first). Pick an amount (suggested chips of $1, $5, $10 in
  the local currency via `crypto-price-service`, or custom), then "Open in
  DashPay" builds a `dash:` URI with `amount`.
- **Coming back.** When the user returns, the sheet shows "Did it go through?".
  It watches the address via Insight for 2 minutes, then shows a "Tip sent"
  toast or "We couldn't confirm; check DashPay".
- **No tips on posts on iOS** (App Review 3.1.1). On Android and web, post tips
  (YAPP / credit) stay as they are on web. Mobile Android gets them in 1.1, not
  1.0, to keep scope and policy review simple.
- **YAPP.** YAPP balance and purchase aren't shown on iOS. On Android they are
  deferred to 1.1 pending Play's tokenized-asset declaration.

### 7. Notifications

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

- **Owner.** Settings → Private feed: enable it (creates the feed seed; the
  UI explains the cost), see requests with approve and decline, followers with
  revoke, and capacity (x of 1024).
- **Follower.** "Request access" on the profile; a pending state; a
  notification on approval. Private posts then decrypt inline.

### 9. Settings

| Section | Contents |
| --- | --- |
| Account | Identity ID (copy), username, balance (credits in DASH, read-only), "Manage in DashPay", Switch account, Sign out |
| Notifications | Mode, per-type toggles, quiet hours, previews, diagnostics |
| Privacy & safety | Blocked accounts, muted words (local, 1.1), sensitive content, DM requests, instant DM alerts (opt-in; see NOTIFICATIONS) |
| Security | App lock (Face ID / Touch ID / biometric / device PIN, with a timeout), devices signed in (links to DashPay → Connections), count of retired keys, sign out everywhere (opens the wallet) |
| Media & storage | Upload provider (Pinata / Storacha), data saver (no autoplay, low-res on cellular), clear cache |
| Appearance | System / Light / Dark, text size follows the system |
| About & legal | Terms (EULA), Privacy, Community guidelines, contact & support, licenses, version, send diagnostics (opt-in) |
| Delete account | See [COMPLIANCE.md](COMPLIANCE.md#account-deletion) |

## Scope by release

| Area | 1.0 (both platforms) | 1.1–1.3 | Web only (foreseeable) |
| --- | --- | --- | --- |
| Identity | DashPay sign-in (per-device keys), multiple accounts, profile create/edit, DPNS register, app lock, web-user messaging-key migration | Limited-key sessions (W7), invites, messaging-key reset (Y6) | Passkey/password vault login, key paste |
| Feed | Following / For you / Top, threads, quotes, reposts, bookmarks, hashtags, search, explore | Lists, muted words | Query inspector |
| Compose | Text, images, GIF, 1 video, threads, private posts, sensitive flag, drafts, offline queue | Share extension, polls (Pollr) | — |
| Messages | 1:1 and group DMs (v5 where live), legacy read, requests inbox | Voice notes? (evaluate), reactions | — |
| Notifications | Private polling, Instant relay/UnifiedPush, actions, communication notifications | Watcher relay, synced read state, widgets | — |
| Safety | Report, block, sensitive filter, moderation denylist, EULA, account deletion | Muted words, trust-level filters | Moderator tools, elections, report queue |
| Money | Profile tips via DashPay (`dash:`); credit balance display | Android post tips (YAPP/credit via `dash-st:`), YAPP balance and purchase on Android, top-up deep link | YAPP and post tips on iOS (policy) |
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
