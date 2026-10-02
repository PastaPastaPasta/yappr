# Yappr web: inventory for the native iOS/Android PRD and UX spec

All paths below are relative to the repo root, `/Users/pasta/.t3/worktrees/yappr/t3code-1b9cd312/`. The app is a Next 14.1 static export. There are no dynamic segments, so every entity is addressed with a query parameter.

**Before you start:**
- **There is no v11 topology.** `lib/constants.ts` has `CONTRACT_TOPOLOGIES = ['v2','v9','v10']`, and nothing in `app/`, `lib/` or `contracts/` mentions v11. v2 is what testnet, staging, production and `/testing` run (`.env.testing` sets no topology, so it defaults to v2). v10 is the bonsia devnet (`.env.devnet`: `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v10`, DM v5, storefront/blog v5, Pollr v4). v9 (moutai) is retired, but its code paths are still in the tree.
- **`docs/mobile/` already has a roadmap.** It includes `PRODUCT_UX.md` and `ARCHITECTURE.md`. In places that doc describes behaviour the web doesn't have; see the end of section D.

---

## A. Routes

Wrapper legend: **R** = `withAuth(Page)` (a sign-in is required, and a user with no DPNS name is redirected to `/dpns/register?next=…`). **O** = `withAuth(…, {optional:true})`. **P** = public, no wrapper. The shell is `components/layout/app-shell.tsx`: the network banner, `MobileBottomNav`, the global `LoginModal` and `ComposeModal`, and the link-preview provider. `/embed` skips the shell. Most pages use `components/layout/page-shell.tsx` (`PageShell` + `PageHeader`).

### Auth and onboarding

| Path | Auth | Purpose and key components | Params |
|---|---|---|---|
| `/` | P | `WelcomePageContent redirectAuthenticated`: landing page that redirects signed-in users | — |
| `/welcome` | P | The same landing without the redirect: hero "Welcome to Yappr", Powered-by-Dash image, `PlatformStats`, `TopUsersSection`, `FeaturedPosts`, CTA (`components/home/*`) | — |
| `/login` | P | Gradient "Yappr" backdrop; opens the global `LoginModal` and sends you to `/feed` once signed in | — |
| `/dpns/register` | P | `UsernameModal` / `components/dpns/registration-wizard.tsx`, steps in `components/dpns/steps/*` (entry → checking → review → registering → complete) | `next` (return-to, sanitized in `lib/auth/return-to.ts`) |

`LoginModal` (`components/auth/login-modal.tsx`) leads with a wallet sign-in: a `dash-key:` QR in `wallet-login-panel.tsx` / `key-exchange-qr.tsx`, which on touch devices becomes an "open in wallet" link plus "Copy link". Below it are "Sign in with a passkey" and a collapsible "Sign in with a password or private key" (`key-login-form.tsx`). First-time key registration is `key-registration-flow.tsx`. The "New to Dash?" link points to the identity bridge, or to the wallet download on mainnet.

### Feed and home

| `/feed` | O | `FeedHeader` (Home title, refresh button, For You / Following tabs) → `FeedSortToggle` (Recent/Top, **v9/v10 only**) → `FeedComposeBox` → `FeedPostList`, or `FeedTopList` / `FeedLoginPrompt` | none. The last tab and sort are saved to scoped localStorage (`feed-tab`, `feed-sort`) |

### Explore, search, hashtags, mentions

| Path | Auth | Purpose | Params |
|---|---|---|---|
| `/explore` | P | Tabs: Trending (hashtags and $cashtags), Top (most-liked, **v9/v10**), Creators (**v9/v10**, `TopCreators`), Blogs (`BlogPostCard`). Has its own search box ("Search posts and blog articles") and a `RankingWindowToggle` | — |
| `/search` | P | Results for users (DPNS prefix), hashtags and blog posts | `q` |
| `/hashtag` | P | Posts for one tag, Latest/Top (Top **v9/v10**), infinite scroll, `LegacyYapprLink` | `tag` |
| `/mentions` | P | Posts mentioning a user | `user` |

### Post detail and thread

| Path | Auth | Purpose | Params |
|---|---|---|---|
| `/post` | O | Main `PostCard`, then `PostTips`, then a flattened reply tree (`components/post/reply-thread.tsx`: one indent level, a thread line for the author's own posts) with infinite scroll. Also renders `RemovedPostStub` | `id`, `reply` |
| `/post/engagements` | R | Quotes / Reposts / Likes tabs (no Reposts tab when the target can't be reposted), with follow buttons on each user row | `id`, `kind` (`post`\|`reply`) |

### Compose

There is no route. Compose is the global `components/compose/compose-modal.tsx`, opened with `useAppStore.setComposeOpen(true)` from the sidebar Post button, the mobile FAB, the feed compose box, reply, and quote.

### Profile, user, and follow lists

| Path | Auth | Purpose | Params |
|---|---|---|---|
| `/user` | P | `ProfileHeader` + `ProfileTabs` (Posts, Replies, Top **v9/v10**, Mentions, Blog when the user has one). Own profile: inline edit, `AvatarCustomization`, `BannerCustomization`, `YappFlow`, `PaymentQRCodeDialog` | `id`, `edit=true` (opens the editor), `tip=<payment uri>` (opens that payment's QR) |
| `/following`, `/followers` | O | `components/profile/connection-list-page.tsx`, with search inside the list and "Follow back" | `id` (defaults to you) |

### Notifications

| `/notifications` | R | Filter tabs on desktop, a dropdown on mobile: All, Likes, Reposts (includes quotes), Replies, Follows, Mentions, Blog, Private. "Mark all as read" and a settings cog linking to `/settings?section=notifications` | — |

### Messages (DM)

| `/messages` | R | `dmIsV5()` (devnet) renders `components/messages/messages-v5.tsx` (1:1 and groups); otherwise `legacy-messages.tsx` (testnet DM v3). Both are single-pane on mobile, with "Back to conversations" | `startConversation=<identityId>` (from the profile Message button) |

### Bookmarks

| `/bookmarks` | R | Bookmarked `PostCard`s with search, remove, "clear all" and copy link | — |

### Settings

`/settings` is **R**. Sub-pages are `?section=…`, plus `?action=reset` (opens the private-feed reset dialog). The page is `app/settings/page.tsx`. Sections:

- **account**: identity ID, balance, created date; "Pay for posts with" (YAPP or credits); registered DPNS usernames with register-more; account actions.
- **contacts**: Dash Pay contacts import (`components/contacts/dashpay-contacts-modal.tsx`).
- **notifications**: per-type in-app switches for likes, reposts, replies, follows, mentions and blog posts.
- **privacy**: Link Previews (with a disclosure about third-party CORS proxies), "Blur Media From People You Don't Follow", DM Read Receipts, the NSFW mode radio (Warn first / Always show / Hide), `KeyBackupSettings`, `BlockListSettings`, `BlockedUsersSettings`, `SavedAddressesSettings`.
- **privateFeed**: `PrivateFeedSettings`, `PrivateFeedDashboard`, `PrivateFeedFollowRequests`, `PrivateFeedFollowers`, `ResetPrivateFeedDialog`.
- **storage**: `StorachaSettings`, `PinataSettings`.
- **appearance**: Theme (Light, Dark, System via next-themes), Potato Mode, Feed Language (hidden on v10, which has no `language` field).
- **developer**: the query inspector toggle (`DeveloperSettings`, also Ctrl+Shift+Y).
- **about**: links.
- **moderation**: shown only to moderators or the token authority. `ContractModerationSettings` (v9/v10) and `ModerationSettings` (YAPP freeze/slash). `OwnWarningsNotice` appears at the top for warned users.

### Moderation and reports

There is no dedicated route. Everything lives in the post "⋯" menu and in Settings → Moderation:
- `components/moderation/report-post-modal.tsx`
- `moderator-remove-modal.tsx`
- `charter-reason-picker.tsx`
- `report-queue.tsx`
- `election-status-panel.tsx`, also shown on `/contract`
- `removed-post-stub.tsx`

### Storefront

| Path | Auth | Params |
|---|---|---|
| `/store` (browse stores; "Manage Store" for owners) | P | — |
| `/store/view` (shop page with categories, Newest/Top rated, reviews, policies) | P | `id` |
| `/item` (product page with gallery, quantity, reviews) | P | `id` |
| `/cart` | P | — |
| `/checkout` (address, payment selector, policy agreement, order review) | R | `storeId` |
| `/orders` (buyer orders, `ReviewModal`) | R | — |
| `/orders/seller` | R | — |
| `/store/create` (create or edit a store) | R | `id` |
| `/store/manage` (status, shipping zones, payment methods, encryption key) | R | `id` |
| `/store/inventory` (CSV upload, table) | R | `storeId` |
| `/store/item/add` (product with up to 4 images and variants) | R | `storeId`, `itemId` |

`MobileCartFab` sits at `fixed bottom-20 right-4 md:hidden`.

### Blog

| Path | Auth | Purpose | Params |
|---|---|---|---|
| `/blog` | O | No params: discovery plus My Blogs; the owner tabs are Posts (n), New/Edit Post (BlockNote editor), Settings, Theme. `?blog=` shows `BlogHome`; `?blog=&post=` shows `BlogPostView` with comments | `blog`, `post` |
| `/embed` | P | Bare blog-post embed (`public/embed.js` plus snippets) | `post`, `owner`, `theme=light\|dark` |

### Polls, private feeds, wallet and tips

None of these has its own route. Polls are attached in compose and rendered by `components/poll/poll-card.tsx`. Tips use the global `TipModal` (`components/post/tip-modal.tsx`), opened from the action bar or the profile tip button. YAPP lives in the sidebar user menu (`components/token/yapp-balance-item.tsx`), the `BuyYappModal` (only when YAPP isn't locked) and the `StarterGrantModal`.

### About and legal

`/about`, `/about/private-feeds` (a long explainer), `/terms`, `/privacy`, `/cookies`, all using `components/layout/info-page.tsx` (`TestnetNotice` appears on terms and privacy). `/contract` shows the social contract definition, document types, a "Copy Contract" button and the `ElectionStatusPanel`. It resolves the topology at module scope, which is the build-time guard.

### Testing and devnet tools

- **Query inspector**: `components/query-inspector/*`, gated by Settings → Developer. It's a floating pill at `bottom-20 md:bottom-4` and shows every DAPI request, its response and its proof.
- **`/contract`**: as above.
- **`/testing` build**: the same app built against the `.env.testing` contracts, with storage namespaced under `testing:` (`lib/storage-scope.ts`).
- **Devnet build**: `.env.devnet`.
- **Network banner**: `components/ui/development-banner.tsx` is always visible.

---

## B. Feature-level user stories

Gating key: **v2** = testnet/production; **dev** = the v9/v10 devnet cut (`isDevnetCut()`); **v10** = `isV10()` only. Sources are `lib/contract-topology.ts` and `lib/constants.ts`.

### Identity and auth

- **Sign in with a Dash wallet QR (key exchange); passkey sign-in (PRF); password or WIF sign-in.** Files: `contexts/auth-context.tsx`, `vendor/platform-auth`, `lib/auth/platform-auth-adapters.ts`, `lib/webauthn/passkey-prf.ts`, `lib/secure-storage.ts`; UI in `components/auth/*`.
- **Encrypted auth vault / key backup**, protected by a password or passkey (a "1s faster / 30s stronger" KDF choice). Files: `lib/services/auth-vault-service.ts`, `encrypted-key-service.ts`, `components/auth/key-backup-modal.tsx`, `components/settings/key-backup-settings.tsx`.
- **Encryption key management** for private feeds, DMs and store orders. Files: `components/auth/encryption-key-modal.tsx`, `add-encryption-key-modal.tsx`, `lost-encryption-key-modal.tsx`.
- **Register one or more DPNS usernames.** Each is validated (3–63 chars, `[a-zA-Z0-9-]`, no leading, trailing or double hyphen) and checked for availability and contested status. A contested name reads "Available (contested)", then "Registered (awaiting voting)" with "Until voting completes, your username will not appear on Yappr". Files: `lib/services/dpns-service.ts`, `hooks/use-dpns-registration.ts`, `components/dpns/*`. Multiple names show through `UsernameDropdown` and `components/ui/also-known-as.tsx`.
- **The profile is optional.** A profile-less user shows the DPNS label or a truncated identity ID that copies on click (commit 74a68b46).

### Posting

- **Compose a post** with Markdown (`**bold**`, `*italic*`, `` `code` `` plus Ctrl+B/I), an Edit/Preview toggle, Ctrl/Cmd+Enter to post, and a character counter that turns amber at ≤50 left and red when over. Files: `components/compose/compose-modal.tsx`, `thread-post-editor.tsx`, `compose-sub-components.tsx`, `lib/compose/limits.ts`.
- **Threads of up to 10 posts.** "Add to thread", posted in sequence. A partial failure keeps the posted items marked and the button resumes from there. Threads are disabled for replies, quotes, encrypted posts and polls. File: `lib/compose/publish-thread.ts`.
- **Drafts are not persisted for social posts.** `setComposeOpen` resets thread drafts on both open and close (`lib/store.ts`), and closing doesn't ask "discard?". Blog drafts are persisted (`yappr:blog-draft:<id>:<blog>:new` in `components/blog/compose-post.tsx`), and DM drafts live only in component state.
- **Reply and quote.** Quote is reached from the repost menu. On v10 a repost is a content-less quote, with one quote-or-repost slot per author and target; a second shows "View your quote". Files: `lib/feed/quote-reposts.ts`, `components/post/post-card.tsx`.
- **Attach one image** by picker, paste, or drag (`hooks/use-file-drop.ts`). The post holds a single `mediaUrl`. On v10 posts also carry a sha256 and a dHash (`lib/media/*`, `mediaCarriesHashes()`). Upload providers are **Storacha** and **Pinata** (`lib/upload/providers/*`, `components/compose/storage-provider-modal.tsx`), and images display through IPFS gateways with fallback (`components/ui/ipfs-image.tsx`).
- **Emoji picker** (emoji-mart): `components/compose/emoji-picker.tsx`.
- **Mention autocomplete** starts after 3 typed characters (`MIN_SEARCH_LENGTH`): `components/compose/mention-autocomplete.tsx`, `lib/compose/mention-query.ts`. There is no hashtag autocomplete.
- **Hashtags and $cashtags.** On v2 every tag is indexed via `postHashtag`. On dev only the first tag is indexed (inline `post.hashtag`, max 61), and on v10 only the first mention (`mentionedUserId`). A failed hashtag or mention index can be recovered from a warning icon ("Hashtag Not Registered" / "Mention Not Registered"). Files: `lib/services/hashtag-service.ts`, `mention-service.ts`, `components/post/recovery-modal.tsx`, `hooks/use-post-field-validation.ts`.
- **Mark a post NSFW** with the amber "NSFW" toggle in the compose header: `lib/sensitive-content.ts`.
- **Polls** via Pollr, an external contract: 2–10 options, option ≤100 chars, question ≤512, single or multiple choice, duration none/1/3/7 days. Polls are only allowed on a single public, non-reply post, and the poll is embedded through `embedContractId/DocType/Id`. Files: `components/compose/poll-editor.tsx`, `hooks/use-compose-poll.ts`, `lib/services/pollr-poll-service.ts`, `pollr-vote-service.ts`, `lib/poll-embed.ts`.
- **Pay per action in YAPP or credits.** Costs: post 10, reply 3, like 1, repost 1. The compose `PaymentHint` has a toggle. On v10 YAPP is locked and can't be transferred or bought, so the **starter grant** (100 YAPP, **dev**) is the way in. Files: `lib/payment-preference.ts`, `lib/transition-agreements.ts`, `components/compose/payment-hint.tsx`, `components/token/*`, `lib/starter-grant.ts`.
- **Unconfirmed writes.** If a broadcast succeeds but the confirmation times out, the write is treated as success. On dev, dependent writes wait for the parent document to appear (`lib/unconfirmed-writes.ts`).

### Reading and engaging

- **Feed.** For You is a global, per-language timeline on v2 (`settings.feedLanguage`) and one global timeline on v10. Following is a time-windowed merge. New posts are checked every **15 s** and shown as a "Show N new posts" bar. Recent/Top sort with a 24h/today/all-time window is **dev**. Files: `hooks/use-feed-data.ts`, `lib/feed/*`, `hooks/use-top-feed.ts`, `lib/services/ranked-likes.ts`.
- **Like, repost, bookmark, share (copy link), tip; view engagements.** Optimistic toggles. On dev likes are index-only and bookmarking or reposting a reply depends on topology (`canRepost` / `canBookmark`). Files: `hooks/use-post-engagement.ts`, `like-service.ts`, `repost-service.ts`, `bookmark-service.ts`.
- **Delete your post.** Real delete on v2 and v10; a tombstone on v9 ("This post was deleted."). File: `lib/services/tombstone-helpers.ts`.
- **Link previews** are on by default. They're fetched through `allorigins.win` / `corsproxy.io`, except for an allow-list and IPFS. YouTube embeds inline (youtube-nocookie). An internal `/post?id=` link renders as an embedded post card. Files: `lib/link-preview/*`, `components/post/link-preview.tsx`, `hooks/use-link-preview.ts`, `use-yappr-post-reference.ts`.
- **NSFW reveal, per post, for the session.** A solid cover reading "NSFW · The author flagged this post" with a Show button. The reveal is kept in a module-level `Set`, so it survives remounts but not a reload. The setting can be blur, show or hide; hide filters at render time. Files: `components/post/sensitive-content-gate.tsx`, `lib/sensitive-content.ts`.
- **Media gate for non-followed authors.** A frosted placeholder, "Media from someone you don't follow", with Show. Remote media isn't fetched until revealed. Files: `hooks/use-media-gate.ts`, `components/post/gated-media.tsx`.
- **Profile hover card** after 300 ms, ignored on touch: `components/profile/profile-hover-card.tsx`.

### Social graph and safety

- **Follow and unfollow**: `follow-service.ts`, `hooks/use-follow.ts`.
- **Block users.** Blocking also covers muting; there is no separate mute. A block can carry a message of up to 280 chars. Blocks are cached in a merged bloom filter (`blockFilter`).
- **Follow other users' block lists**, up to 100. Anyone they block is hidden from you. Files: `lib/services/block-service.ts`, `lib/bloom-filter.ts`, `lib/caches/block-cache.ts`, `components/settings/block-list-settings.tsx`, `blocked-users.tsx`, `hooks/use-block.ts`.
- **Report a post** with a reason picker and a note of up to 500 chars. Moderators remove the content, and on v10 resolve the report with a status and a resolution of up to 200 chars. **dev only** (`contractTakesReports()`).
- **Bans, suspensions, warnings, elected moderation team**: **dev**.

### Notifications

Notifications are derived on the client by polling every **30 s**, driven by the hidden-on-mobile Sidebar, and skipped while the tab is hidden. Read IDs are stored locally. "Mark all as read" marks only the *visible*, enabled types read, so disabled types stay unread. Per-type in-app toggles exist. Windowed queries are **dev**. Files: `lib/services/notification-service.ts`, `notification-windows.ts`, `lib/stores/notification-store.ts`, `lib/notification-preferences.ts`, `hooks/use-visible-unread-notification-count.ts`.

### Private feeds

- **Enable a private feed**: up to 1024 followers (`TREE_CAPACITY`) and 2000 key generations.
- **Post with Public, Private ("Only private followers") or Private with Teaser visibility.** Encrypted posts can't be threads and can't carry polls. Replies inherit encryption, with a purple banner.
- **Request access from a profile; the owner approves or revokes.** On dev, writes are gated by consensus: approving needs a `followRequest`.
- **Reset the feed.**

Files: `lib/services/private-feed-service.ts`, `private-feed-crypto-service.ts`, `private-feed-follower-service.ts`, `private-feed-key-store.ts`, `components/compose/visibility-selector.tsx`, `components/post/private-post-content.tsx`, `components/profile/private-feed-access-button.tsx`, `components/settings/private-feed-*.tsx`. Spec: `docs/YAPPR_PRIVATE_FEED_SPEC.md`.

### Messages

- **Testnet (DM v3):** 1:1 encrypted chats, read receipts (a setting), unread badge. Files: `lib/services/direct-message-service.ts`, `components/messages/legacy-messages.tsx`.
- **Devnet (DM v5):** unlinkable 1:1 chats and **groups** of up to 100 members. Groups can be created, renamed, and have members removed; there's "Resend keys", leave, and end ("Nobody will be able to send messages to it any more"). Also message retention ("Reclaim message fees": 30d / 90d / 1y / never), conversation search, delete conversation, a blocked list, and cross-device self-state. Files: `lib/services/dm-v5/*`, `lib/dm/*`, `components/messages/{messages-v5,thread-view,conversation-list,new-group-dialog,group-settings-dialog,dm-settings-dialog}.tsx`. Spec: `docs/DM_V5.md`.
- The presence indicator is a stub (`components/ui/presence-indicator.tsx` notes "not yet implemented").

### Tips and wallet

- **Tip a post or reply** in YAPP (presets 1/5/25/100, minimum 1) or credits (presets 0.001/0.005/0.01/0.05 DASH, minimum 0.001). An optional message of up to 280 chars is stored as a token-history `publicNote`. The modal can sign through a wallet QR (`dash-st:`) and has a "Checking whether your tip landed…" reconciliation state. On v10 there are credit tips only. Files: `lib/services/tip-service.ts`, `tip-history-service.ts`, `lib/tip-note.ts`, `components/post/tip-modal.tsx`, `post-tips.tsx`.
- **Profile payment URIs** (dash, bitcoin, lightning, …, up to 16) with QR codes, plus social links (up to 16). Files: `components/profile/payment-uri-input.tsx`, `components/ui/payment-qr-*.tsx`, `lib/utils/payment-uri.ts`.
- **Buy YAPP** (testnet only, since YAPP isn't locked there): `components/token/buy-yapp-modal.tsx`, `lib/services/token-service.ts`.

### Other

- **Blog**: BlockNote editor, themes (Minimal, Dark Mode, Magazine, Tech…, each with Google fonts), comments, follows, reader preferences, embeds. Content limit is 16 KiB compressed in 4 × 5 KiB chunks. Files: `components/blog/*`, `lib/services/blog-*.ts`.
- **Storefront**: stores, items with variants, cart, encrypted orders, shipping zones, policies, reviews priced in YAPP, saved addresses, order status. Files: `lib/services/store-*.ts`, `cart-service.ts`, `shipping-zone-service.ts`, `components/store/*`, `components/checkout/*`.

---

## C. Design system

### `tailwind.config.js` (Tailwind ^3.3)

- **Dark mode**: `darkMode: 'class'`, toggled by next-themes (`attribute="class"`, `defaultTheme="system"`, `enableSystem`) in `components/providers.tsx`.
- **Brand palette `yappr`** (the Tailwind sky ramp):
  - 50 `#f0f9ff`, 100 `#e0f2fe`, 200 `#bae6fd`, 300 `#7dd3fc`, 400 `#38bdf8`
  - **500 `#0ea5e9`** (primary), 600 `#0284c7` (hover), 700 `#0369a1`, 800 `#075985`, 900 `#0c4a6e`, 950 `#082f49`
- **Extra neutrals**: `neutral-750 #323232`, `neutral-850 #1a1a1a`.
- **Font**: `sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`. That's the system stack, so native SF Pro / Roboto is a faithful match. Monospace is Tailwind's default `font-mono`, used for identity IDs and balances.
- **Gradients**: `bg-gradient-yappr` = `linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)`, used as the default profile banner. `bg-gradient-dark` = `linear-gradient(135deg, #1e293b 0%, #0f172a 100%)`.
- **Shadows**: `shadow-yappr` = `0 4px 20px -4px rgba(14,165,233,0.5)` (default buttons). `shadow-yappr-lg` = `0 10px 40px -10px rgba(14,165,233,0.4)` (FAB, Post button, CTAs).
- **Animations**:
  - `slide-up` / `slide-down`: 0.3s ease-out, translateY ±10px
  - `fade-in`: 0.2s
  - `scale-in`: 0.2s, from 0.95
  - `pulse-soft`: 2s
- **Radii**: no custom radii. Measured usage: `rounded-lg` 429, `rounded-full` 301 (buttons, pills, avatars, icon buttons), `rounded-xl` 100 (cards, menus, media grid, embeds), `rounded-2xl` 18 (modals, bottom sheet).
- **Spacing**: no custom scale. The quirks are layout constants:
  - fixed banner height of 32px on mobile and 40px at sm and up (the `top-[32px] sm:top-[40px]` offsets)
  - centre column `max-w-[700px]`
  - left sidebar `w-[275px]`, right sidebar `w-[350px]`
  - action bar `max-w-[485px]`
  - a `h-16` spacer for the mobile nav

### `app/globals.css`

- **CSS variables**: `--background` / `--foreground` are defined (light `0 0% 100%`; dark `0 0% 7%`) but not wired into Tailwind. `text-foreground` in `app/explore/page.tsx` is therefore a no-op.
- **Effective surfaces**: `<body>` is `bg-white dark:bg-neutral-900` (`#171717`). Borders are `gray-200 #e5e7eb` / `dark:gray-800 #1f2937`. Hover rows are `gray-50` / `dark:gray-950`. Secondary text is `gray-500 #6b7280`.
- **Utilities**: `.glass-effect` (backdrop-blur-xl, `bg-white/80` / `dark:bg-neutral-900/80`), `.glass-border`, `.interactive-scale` (active:scale-[0.98]), `.text-gradient` (yappr-500→600 clipped text, used for the "Yappr" wordmark), `.scrollbar-hide`, `.safe-area-inset-top/bottom` (`env(safe-area-inset-*)`).
- **BlockNote overrides** for the blog: dark menu `#1a1a2e`, hover `#2a2a3e`, selected `#3a3a5e`; compose and blog prose at 17px with line-height 1.7–1.75.

### Toasts

react-hot-toast in `app/layout.tsx`: `position: top-center`, 3000 ms, background `#1f2937`, text `#fff`, radius 8px, padding 12px 16px, font 14px. Long errors pass `duration: 6000`.

### `components/ui` primitives

- **Button** (`button.tsx`, cva): always `rounded-full`, focus ring yappr-500, `interactive-scale`.
  - Variants: default (`bg-yappr-500 hover:bg-yappr-600 shadow-yappr`, white text), destructive (red-500), outline, secondary (gray-100 / gray-900), ghost, link.
  - Sizes: default h-10 px-4, sm h-8 px-3 text-xs, lg h-12 px-6, icon 10×10.
- **IconButton**: 36px circle, with default, primary (yappr) and danger variants.
- **Modal** (`modal.tsx`, Radix Dialog + framer-motion) has two variants:
  - `card`: centred, `rounded-2xl p-6 shadow-xl`, `bg-black/50` overlay, scale 0.95→1.
  - `sheet`: full-width with overflow hidden, `bg-black/60` plus backdrop-blur-sm, slides up 20px in 0.2s.
  - `ConfirmDialog` is 400px wide with a warning-triangle chip and danger/warning/default variants.
- **Compose modal**: `max-w-2xl`, top-aligned (`pt-6 sm:pt-20`), body capped at `max-h-[60vh]`.
- **Switch**: Radix, 36×20, checked yappr-500, unchecked gray-200 / gray-800. Settings rows use `settings/settings-switch.tsx`.
- **Other primitives**: Card (`rounded-xl border shadow`); Tooltip (Radix; `bg-gray-800 text-xs rounded` inline, or `gray-900` in `tooltip.tsx`); dropdown menus (Radix, `min-w-[200px] rounded-xl shadow-lg border py-2`, items `px-4 py-2 text-sm`); Popover (hover card); RadioGroup (theme and NSFW cards with a `border-2`, selected `border-yappr-500 bg-yappr-50`); Tabs.
- **Spinner**: `border-b-2 border-yappr-500`, sizes 16/20/32/48.
- **`LoadingState`** is the generic loading/error/empty wrapper: a rotating ring, a "Something went wrong" triangle with "Try Again", and an inbox-icon empty state.

**Inconsistency to decide on:** `LoadingState`, `Input` and `Textarea` use **purple-600** for the spinner, retry button and focus ring instead of yappr. Purple is also the private-feed / encryption accent (`compose-modal.tsx` banners, `private-feed-dashboard.tsx`).

### Icons

**Heroicons v2** (`@heroicons/react/24/outline`, with `/24/solid` for active states) are used almost everywhere. lucide-react appears only in about 10 settings, auth and upload components (Eye/EyeOff and similar). Payment brand colours: Dash `#008DE4`, Bitcoin/Lightning `#F7931A` (`components/ui/payment-icons.tsx`).

### Avatars

`UserAvatar` (`components/ui/avatar-image.tsx`) is always round with `object-cover`. Sizes: xs 24, sm 32, md 40, lg 48 (post cards), xl 64, full; the profile avatar is 128. While loading it shows a `gray-200` / `gray-700` circle.

The default avatar is DiceBear **`thumbs`**, seeded by the identity ID and generated locally as an SVG data URI (`DEFAULT_AVATAR_STYLE`, `lib/services/unified-profile-service.ts:70`; `lib/services/avatar-generator.ts`). Users can pick any of 28 DiceBear styles plus a seed, or upload an image (5 MB cap in `profile-image-upload.tsx`).

The default banner is `bg-gradient-yappr`. The profile header is a 192px (`h-48`) banner, then a 128px avatar inside a 4px white/neutral-900 ring pulled up 64px. Beside it: name (`text-xl font-extrabold`), handle or ID, pills for "Register Username", the store, "Private Feed" and "Private Follower" (green), then bio and meta, and Followers/Following counts. Buttons: share, settings, Edit profile (outline), or tip, message, and Follow (filled) / Following (outline).

### Typography

Measured class usage: `text-sm` 943, `text-xs` 440, `text-lg` 73, `text-xl` 67, `text-2xl` 21.
- Page titles: `text-xl font-bold`.
- Post body: inherited base 16px with `whitespace-pre-wrap break-words`.
- Author line: `text-sm`, name `font-semibold`.
- Sidebar nav: `text-xl`, active `font-bold`.
- Inline code: `bg-gray-100 dark:bg-gray-800 text-pink-600 font-mono`.
- Links, hashtags and mentions: `text-yappr-500 hover:underline`.

### Post card anatomy (`components/post/post-card.tsx`)

- **Container**: `<article>` with `border-b`, `px-4 pt-3 pb-1`, hover `gray-50` / `gray-950`. Tapping the card opens `/post?id=`, and Cmd/Ctrl-click opens a new tab. The card hands its already-loaded data to the detail page through `setPendingPostNavigation`.
- **Repost banner**: optional, a ↻ icon and "X reposted" in gray-500, indented `ml-9`.
- **Header row**: a 48px avatar (opens the hover card), a `gap-3` column, then display name (semibold), a verified badge (yappr-500 SVG), `@handle` (or a truncated ID `xxxxxxxx...yyyyyy` in mono, tap to copy), `·`, and a compact relative time (`30s / 2m / 3h / 4d`, then "Mar 4", from `formatTimeCompact`). Pulse skeletons stand in while the name loads.
- **Right of the header**: a lock icon for private posts and a "⋯" menu with Follow/Unfollow @x, View post engagements, Delete (red; own posts), Block @x (red), Report (dev), and Remove (moderator).
- **Body**, wrapped in `SensitiveContentGate`, in this order:
  1. text (`PostContent`) or the private decrypt flow
  2. `PollCard`
  3. quoted post (`EmbeddedPostCard`: `mt-3 border rounded-xl p-3`), its skeleton, or an unavailable/removed stub
  4. media grid: `mt-3 grid gap-1 rounded-xl overflow-hidden`; 1 item = 1 column, otherwise 2 columns; cells are `aspect-video`; with 3 items the first spans two rows
  5. "Replying to @x" with the embedded parent
- **Action bar** (`components/post/post-action-bar.tsx`, `max-w-[485px]`, spread with `justify-between`):

  | Action | Hover / active colour | Count |
  |---|---|---|
  | Reply | yappr | count, or blank at 0 |
  | Repost menu (Repost/Undo, Quote) | green-500 | count |
  | Like (spring scale-0.8 on tap) | red-500 | count |
  | Tip ($) | amber | none; disabled on own posts |
  | Bookmark and Share | yappr | none; grouped at the right |

  Counts use `formatNumber` (1.2K, 3.4M). Every button is `p-2 rounded-full` with 20px icons.

### Navigation

- **Desktop, md and up**: left `Sidebar` (`components/layout/sidebar.tsx`), 275px and sticky.
  - Header: the "Yappr" gradient wordmark.
  - Items when signed in: Home(/feed), Following, Followers, Explore (hashtag icon), Store, Blog, Notifications, Messages, Bookmarks, Profile, Settings. Signed out: Home, Explore, Store, Blog.
  - Outline icons that switch to solid when active; yappr-500 count badges (99+).
  - A full-width "Post" button (`shadow-yappr-lg`).
  - Bottom: a user chip that opens a menu with the DASH balance and refresh, YAPP balance, and Log out.
- **Right sidebar**: lg (1024px) and up only, not even mounted below. Contains `SearchInput`, `TrendingHashtags`, `FeedStats`, the Powered-by-Dash badge, and Terms / Privacy / Cookies / About links.
- **Top bar**: an always-on amber-500 network banner reading "TESTNET | Running on Dash Platform Testnet. Data may be reset." (shortened to "Data may be reset" on mobile).

### Loading, empty states, sheets

- **Skeletons**: `EmbeddedPostSkeleton`, `LinkPreviewSkeleton`, `LandingSkeleton`, `PostSkeleton` and `UserSkeleton` on the home page, and pulse bars for names and handles (91 `animate-pulse` usages). There is no full feed-card skeleton; the feed shows `LoadingState` with "Connecting to Dash Platform...".
- **Empty states**: centred icon, title, description, plus `LegacyYapprLink` ("Looking for older posts? Browse the previous version of Yappr ↗") at feed ends.
- **Sheets**: the mobile "More" menu is the only real bottom sheet (`rounded-t-2xl`, a 4-column icon grid).

---

## D. Mobile-web behaviour already present

- **Breakpoints**: Tailwind defaults (sm 640, md 768, lg 1024, xl 1280). Measured usage: `sm:` 107, `md:` 66, `lg:` 8, `xl:` 8. **md is the phone/desktop switch**: the sidebar hides, the bottom nav shows, and the centre column loses its side borders. The JS checks are a `matchMedia('(min-width:1024px)')` gate for the right sidebar and `(pointer: coarse)` for wallet deep links.
- **Bottom nav** (`components/layout/mobile-bottom-nav.tsx`, `md:hidden`):
  - Fixed, h-14, with a safe-area bottom inset and a top border.
  - Five slots: Home, Explore (magnifier), a centre FAB, Messages (with unread badge), and Menu (☰, with a yappr dot when notifications are unread).
  - The FAB is a 56px yappr-500 circle raised 16px (`-mt-4`) with `shadow-yappr-lg`; it opens compose, or the login modal when signed out.
  - Icons are 28px: active black/white, inactive gray-500.
  - Menu opens a sheet over a `bg-black/50` overlay with Store, Blog, Profile, Notifications (badge), Following, Followers, Bookmarks and Settings in a 4-column grid, plus Log out (red) or Sign In. Escape and focus are managed, and the sheet closes on route change.
  - **Notifications aren't a primary tab on mobile.**
- **Other fixed elements**: a `h-16` page spacer, `MobileCartFab` and the inspector pill at `bottom-20`. Messages are sized with `100dvh-32px-56px`.
- **Pull-to-refresh: none.** No touch or overscroll handlers exist. Refresh is the ↻ button in the feed header plus the 15 s "Show N new posts" bar.
- **Infinite scroll** (`hooks/use-infinite-scroll.ts` + `components/ui/infinite-scroll-sentinel.tsx`):
  - An IntersectionObserver with a 600px rootMargin.
  - At most 3 automatic page loads per scroll gesture; any scroll refills the budget.
  - It falls back to a "Load More" pill (yappr-500) when paused or after a failure, and re-measures the sentinel before each load.
  - `resetKey` resets it per list or tab.
  - Used by the feed, hashtag, post replies, profile tabs and store view.
- **At narrow widths**:
  - Pages are a single full-width column with a sticky translucent header (`bg-white/80` + backdrop-blur-xl; potato mode turns blur off) under the 32px banner.
  - Compose sits near the top (`pt-6`) with `px-3`.
  - The NSFW cover hides its explanatory text below sm.
  - Notification filters become a dropdown.
  - Messages switch between list and thread.
  - Hover cards are suppressed on touch.
  - Tooltips are desktop-only in practice.
- **Gaps between `docs/mobile/PRODUCT_UX.md` and the web:**
  - It specifies pull-to-refresh; the web has none.
  - It specifies a five-tab bar with Alerts as a tab; the web has four icons plus a FAB, with notifications under Menu.
  - It specifies Following / For you / Top; the web order is For You / Following, with Top as a separate sort toggle on dev only.

---

## E. Copy, tone, and limits

**Tone.** Plain, second person, often blunt about Dash Platform realities: "Nothing was posted / Nothing was charged — try again". Exclamation marks are used for successes: "Post created successfully!", "Thread with N posts created!", "Reposted!", "Following!", "Tip sent successfully!", "Private feed enabled successfully!".

**Errors** are mapped from consensus codes in `lib/error-utils.ts` (`categorizeError`). Examples:
- "Dash Platform is temporarily unavailable. Please try again in a few moments."
- "Network error. Please check your connection and try again."
- "Your session has expired. Please log in again."
- "This is too long for the network once emoji and special characters are counted. Shorten it and try again."
- "Another write from your account went out at the same moment, so this one was not saved. Try again."
- "This opens once the community elects its moderation team. Nothing was posted."
- "Your account has been banned or suspended here by a moderator…"
- "You don't have enough YAPP. Switch to paying in credits in Settings."
- Thread partial failure: "Thread partially created: … Post N failed: …. Press Post to retry."

**Empty states:**
- Feed: "No posts yet / Be the first to share something!" and "Your following feed is empty / Follow some people to see their posts here!"; at the end, "You've reached the end."
- Notifications: "When someone likes your post, you'll see it here", one per filter.
- Post detail: "No replies yet. Be the first to reply!"
- Explore: "No trending tags yet / Post with #hashtags or $cashtags to see them here!"
- Lists: "Not following anyone yet / Find interesting people to follow on Yappr" and "No followers yet / Share interesting content to gain followers".
- Bookmarks: "Save posts for later".
- Messages: "Welcome to Messages", "No messages yet. Start the conversation!"
- Store: "Your cart is empty / Add some items to get started".

**Prompts and placeholders:**
- "What's happening?" (feed box), "What's on your mind?" / "Continue your thread...", "Write a teaser to entice others to request access...", "Login to share your thoughts", "Type a message...", "Search by username...".
- Stubs: "This post was deleted.", "This post was removed by the contract's moderators." plus "Reason: …".
- Gates: "NSFW · The author flagged this post" with "Show"; "Media from someone you don't follow" with "Show".
- Tagline: "Decentralized social media on Dash Platform · Own your data · No algorithms · Censorship resistant".

**Limits** (from the contracts unless noted):

| Item | v2 (testnet/prod) | v10 (devnet) |
|---|---|---|
| Post/reply text | 500 chars (code points) | 1000 chars **and** 2000 UTF-8 bytes ("N bytes over the size limit. Emoji and non-Latin text count extra.") |
| Encrypted payload | 1024 B | 2048 B |
| Media | 1 `mediaUrl` (≤512) per post or reply | the same, plus sha256 and dHash |
| Image upload | 10 MB in compose (`hooks/use-compose-image.ts`); Storacha 10 MB; Pinata 15 MB | same |
| Avatar/banner upload | 5 MB (`profile-image-upload.tsx`) | same |
| Display name / bio | 50 / 160 (profile contract) | 25 / 140 (DashPay profile) |
| Location / website / pronouns | 50 / 100 (social v2) or 200 (profile contract) / 20 | 50 / 200 / 20 |
| Payment URIs / social links | 16 / 16 | 16 / 16 |
| Hashtag | 63, multiple per post | 61, only the first is indexed; only the first mention is indexed |
| Block message | 280 | 280 |
| Report note / resolution | n/a | 500 / 200 |

Limits that apply everywhere:
- **Threads**: up to 10 posts.
- **Polls**: 2–10 options, option ≤100, question ≤512.
- **Tips**: message ≤280; minimum 1 YAPP or 0.001 DASH.
- **DM groups**: up to 100 members, group name up to 100.
- **Block-list follows**: 100.
- **Private feed**: 1024 followers.
- **DPNS names**: 3–63 chars.
- **Blog post**: 16 KiB compressed.
- **Store product images**: 4.

The counters live in `lib/compose/limits.ts` (`characterCount` uses `Array.from`, so an emoji counts as one character) and `components/compose/compose-sub-components.tsx` (`CharacterCounter`).