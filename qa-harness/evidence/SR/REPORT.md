# QA report: SR (static review, code only)

- **Agent / stream:** SR (static review), no device · **Theme:** n/a
- **Code ref:** `staging` at `c0f5e294`, read from the worktree `/Users/pasta/.t3/worktrees/yappr/mobile-golden` (detached at `origin/staging`). All file:line references are relative to that worktree.
- **Method:** five focused reviewers, one per risk area (keys and secrets, writes, DMs, engine supervisor and caches, UX/copy/compose/release). Each candidate finding then went to its own adversarial verifier, which tried to refute it from the code and either confirmed it (with a corrected severity and scenario where needed) or refuted it. This report uses the verifier's severity and corrected scenario throughout.
- **Specs used:** `docs/mobile/ADR-001-mobile-1.0.md`, `ENGINE.md`, `PRD.md` (stories and G-1..G-16), `UX_SPEC.md`, `mobile/RELEASE.md`, `docs/mobile/COMPLIANCE.md`.
- **Totals:** 49 candidates verified. 48 confirmed, 1 refuted. After merging duplicates the report has **47 findings**: **0 S1 · 8 S2 · 30 S3 · 9 S4**.
  - Merged: the keys reviewer and the DM reviewer both filed "sign-out leaves the DM v5 cache". That is now one finding, SR-10.
  - Split: the UX reviewer's "spec gaps" candidate had two parts. Part (a), the unknown-link toast, is folded into SR-13, which already covers it. Part (b), the hardware-keyboard shortcut, is SR-47.
  - Cross-referenced but kept separate: SR-15 and SR-31 share a root cause in `methods.ts` but produce different user-visible bugs. SR-19 and SR-30 both cover background DM v5 polling.
- **Confidence:** every finding below was confirmed in code by its verifier. Findings marked **(suspected)** depend on timing or OS behaviour that needs a device to prove; the code path itself is confirmed.
- **Severity scale:** QA-PLAN §5 (S1 exposure, loss or duplicate paid write; S2 user action to recover, wrong data or privacy leak; S3 flow bug with a workaround or misleading copy; S4 cosmetic).

## Findings (sorted by severity)

| ID | Sev | Area | Title | file:line | Shared with web? | Device repro hint |
| --- | --- | --- | --- | --- | --- | --- |
| SR-01 | S2 | keys | iOS app lock: a modal presented while the app is locked draws over the lock screen and takes touches. Terms gate "Not now" signs the account out with no biometric check | `mobile/app/src/features/auth/TopOverlay.tsx:22` | No (iOS only) | iOS sim, lock on (Immediately), background the app, `xcrun simctl openurl booted 'yappr-dev://login'`. The sign-in sheet covers testID `app-lock`. Terms path: bump TERMS_VERSION, relaunch, cancel Face ID, tap "Not now" |
| SR-02 | S2 | writes | Double-tap on Post/Reply publishes the same post twice (two paid documents) | `mobile/app/src/features/compose/ComposeScreen.tsx:329` | No | agent-device taps on testID `compose-post` twice within 50-100 ms. Expect two `post.publish` tickets and two posts |
| SR-03 | S2 | writes | A thread cut short by an engine restart or app kill forgets the parts already posted, so Edit then reposts them | `mobile/engine/src/writes/publish.ts:141` | No | 5-part thread, `bin/qa engine-kill` at "Posting 3 of 5". Card shows "Couldn't confirm · Edit"; Edit shows no parts posted; Post duplicates parts 1-2 |
| SR-04 | S2 | writes | Like/unlike/bookmark/repost/delete failures that lib reports as `false` become a silent "unconfirmed": no rollback, no G-4 toast, no key prompt | `mobile/engine/src/writes/tickets.ts:275` | No (web rolls back) | `network stall` during an unfollow broadcast, then like 3 posts within 15 min. Hearts stay filled, no toast; Diagnostics `unconfirmed (UNKNOWN)`; refresh reverts silently |
| SR-05 | S2 | writes | (suspected) A write queued behind a cut-short call is released into the next engine, which may run as a different account after a switch | `mobile/app/src/data/writes.ts:364` | No | v10, two accounts. Stall network, undo repost, repost again within 1 s, switch to B. B's profile shows a repost it never made |
| SR-06 | S2 | ux (compose) | A failed resumed thread's text goes back into the new-post draft slot, and an already-open composer then overwrites it (text lost) | `mobile/app/src/features/compose/pending-posts.ts:470` | No | Partial thread, "Post all" to resume, open an empty composer at once, make the resume fail, type "x" or Post. Parts 2-3 are gone with no card |
| SR-07 | S2 | dm | Manual unlock accepts any ENCRYPTION key on the identity, but the DM engine and peers use only the first one. A "successful" unlock leaves messages unreadable and outgoing messages undeliverable | `lib/crypto/key-validation.ts:117` | Yes | Devnet identity with two encryption keys. Enter the higher-id key's WIF: "Encryption key saved", then an empty inbox and sends the peer never sees |
| SR-08 | S2 | engine | The restart cap never trips for slow failures (hello timeout, boot deadline, hang): endless restart loop, queued calls hang, no "failed" state. The cap is also 5 where NET-04 says 3 | `mobile/app/src/engine/supervisor.ts:289` | No | Dev build whose engine throws at module scope or never says hello. Home for 5 min: restarts climb past 5, state never `failed`, "Connecting…" forever |
| SR-09 | S3 | keys | Signing out a non-active account leaves its compose drafts and pending posts in unencrypted MMKV (AUTH-11) | `mobile/app/src/features/compose/pending-posts.ts:819` | No | As B, save reply draft "SR-draft", switch to A, sign out B, relaunch, re-add B: the draft is back |
| SR-10 | S3 | keys / dm | Sign-out leaves the account's DM v5 local cache (`yappr_dm_v5:<id>`: conversation keys, blocked ids, read/hidden positions) in engine storage (AUTH-11 "DM state") | `mobile/engine/src/api/session.ts:295` | Yes | Devnet debug build. Use DMs, sign out, dump MMKV `yappr.engine.devnet-sakura`: the key is still there; Diagnostics "Plain keys" does not drop by it |
| SR-11 | S3 | keys | After the last account signs out, its private keys stay in the WebView DOM (inline bootstrap `<script>`) and in the RN heap until the engine restarts | `mobile/app/src/engine/page.ts:69` | No | Devnet dev client. Sign in, relaunch, sign out. Web Inspector: `[...document.scripts].some(s => s.textContent.includes('yappr_secure_'))` returns true |
| SR-12 | S3 | keys | (suspected) iOS app-switcher privacy relies on a JS re-render, so the lock cover can miss the switcher snapshot. The key-entry screen gets no switcher protection | `mobile/app/src/features/auth/AppLockOverlay.tsx:59` | No | Physical iPhone, lock on (Immediately). Swipe to the switcher while the JS thread is busy, 20 times; count cards that show the feed |
| SR-13 | S3 | keys / nav | Deep links: unknown and web-only links go Home with no toast or browser, `/login` opens sign-in while signed in, and `/user` self/edit and `/followers` with no id are unmapped (NET-11 P0) | `mobile/app/src/navigation/deep-links.ts:110` | No | Release-config build: `xcrun simctl openurl booted 'yappr-dev://dpns/register'` gives Home with no toast; `yappr-dev://login` while signed in opens the sign-in sheet |
| SR-14 | S3 | writes | Edit-profile double-tap queues a second `profile.update`, sent after the first confirms (a duplicate paid replace on v2) | `mobile/app/src/features/profile/profile-writes.ts:28` | No | Testnet build. Change bio, double-tap testID `edit-save`. Two `profile.update` sequences; balance drops by two fees |
| SR-15 | S3 | writes | `methods.ts` classes dm.*, safety.* reads, `engage.bookmarks` and `writes.check` as writes: 15 s deadline instead of 30 s and no replay after a restart | `mobile/app/src/engine/methods.ts:42` | No | Slow DAPI (`network stall`, high latency). Cold Bookmarks or a large DM shows an error after `timed out after 15000 ms`. "Check again" on a multi-part thread toasts "Couldn't check" while the probe still settles |
| SR-16 | S3 | writes / dm | A DM send cut short before its ticket existed leaves a permanent "Not confirmed" bubble whose text never returns to the composer | `mobile/app/src/features/messages/outbox.ts:187` | No | `network stall`, Send, `bin/qa engine-kill` within 2-5 s. Bubble `dm-outbox-unconfirmed` toasts "Still checking…" on every tap |
| SR-17 | S3 | dm | A DM send that fails before any broadcast gets stuck as "Not confirmed · Tap to check", can never be retried, and its text is not restored | `mobile/engine/src/api/dm.ts:237` | No | Devnet, `bin/qa network stall`, Send, wait 10 s, lift the stall, tap the bubble repeatedly: it never changes |
| SR-18 | S3 | dm | A multi-part v5 send that fails partway is retried (or re-edited) as the whole text, so parts already delivered are sent and paid for again | `mobile/engine/src/api/dm.ts:219` | No | Debug build: force the 2nd createMessage of a 3-part send to fail with PENDING_WRITE. Tap retry; the peer sees part 1 twice |
| SR-19 | S3 | dm | Android: the DM v5 engine keeps polling in the background (every 4 s with a conversation open) and silently marks incoming messages read (NET-08) | `mobile/engine/src/dm/v5.ts:149` | No | Android API 31 emulator, open a conversation, `bin/qa background`, send 2 messages from another identity, wait 60 s, foreground: no unread markers |
| SR-20 | S3 | dm | Blocking someone does not stop their DMs. On testnet (legacy DMs) the conversation keeps its composer and its menu still says "Block" | `mobile/engine/src/dm/legacy.ts:148` | Partly (block-sheet copy) | Testnet, block the peer from the conversation menu. Composer stays; the peer's next message raises the badge |
| SR-21 | S3 | dm | Testnet: a failed first conversation-list read shows the empty "Welcome to Messages" inbox, a known conversation shows "isn't available", and pull-to-refresh does nothing for 30 s | `mobile/engine/src/dm/legacy.ts:175` | Yes | Testnet, kill, `bin/qa network stall`, launch, open Messages (`messages-empty`), lift the stall, pull to refresh: still empty for about 30 s |
| SR-22 | S3 | dm | "Sent" is shown for a v5 message that was never read back from the chain (`MessageDTO.pending` ignored), so a send accepted on trust can vanish after a restart | `mobile/app/src/features/messages/dm-model.ts:171` | No (loss root cause is in shared lib) | Proxy drops the dmMessage broadcast twice, reads pass. "Sent" shows; `bin/qa kill` and relaunch: message gone |
| SR-23 | S3 | dm | A "Reclaim message fees" change is applied optimistically but not kept locally, so it silently reverts if the save fails and the app is killed | `lib/services/dm-v5/engine.ts:469` | Yes | Message settings, `bin/qa network stall`, pick "After 30 days", `bin/qa kill`, lift the stall, relaunch: shows "Never" |
| SR-24 | S3 | engine | A failed refetch or next page drops the Home feed (any persisted query) from the on-disk cache, so the next cold or offline launch has nothing to show | `mobile/app/src/state/query-client.ts:67` | No | Scroll until `feed-load-more` shows from a failed page, wait 2 s, force-kill, relaunch offline: skeletons, no cached posts |
| SR-25 | S3 | engine | Blocks and deletes are kept only in memory: after a relaunch the persisted Home feed shows the blocked author's posts (and unconfirmed deleted posts) again, and is never refetched | `mobile/app/src/features/home/use-home-feed.ts:54` | No | Block @X from Home, kill, relaunch: @X's post is back in For You until pull-to-refresh |
| SR-26 | S3 | engine | No 200-post cap per feed (FEED-11), and every loaded page is re-serialized to MMKV whole on each cache event | `mobile/app/src/state/query-client.ts:34` | No | Mid-range Android release build: scroll about 500 posts, log the `yappr-query-cache` size, trace stringify/MMKV spikes, compare cold-start time |
| SR-27 | S3 | engine | Lockdown / outdated-WebView "unsupported" state is never retried on return to foreground (NET-06) | `mobile/app/src/engine/supervisor.ts:303` | No | Diagnostics "simulate no-webassembly", background, foreground: still `unsupported`, epoch unchanged |
| SR-28 | S3 | engine | The "Couldn't connect to Dash Platform." banner with "Try again" (NET-01/NET-04) is not implemented; with a cached feed and a failed engine there is no banner and no retry | `mobile/app/src/features/home/FeedPage.tsx:238` | No | Cached Home, `engine-kill` 5 times within 2 min (state `failed`): no banner; pull-to-refresh only toasts |
| SR-29 | S3 | engine | (suspected) Hello and boot deadlines keep running while iOS suspends the app: returning more than 90 s after a mid-boot exit forces a spurious restart that kills an in-flight wallet sign-in | `mobile/app/src/engine/supervisor.ts:353` | No | iOS, stalled DAPI so boot is slow, start wallet sign-in while `booting`, background about 100 s, return: "no ready within 90 s", "Sign-in failed" |
| SR-30 | S3 | engine | Background activity breaks NET-08: DM v5 keeps polling and the auth balance refresh (every 5 min) keeps running while backgrounded | `mobile/app/src/engine/supervisor.ts:418` | Yes (lib timers) | Android 12/13 with no freezer, devnet, background for 2 min: DM v5 polls every 4 s or 30 s, balance query every 5 min |
| SR-31 | S3 | engine | `safety.isBlocked` failures are swallowed as "not blocked" (and the call is misclassed as a write), so quotes of blocked authors render after an offline launch or a restart | `mobile/app/src/engine/methods.ts:40` | No | Block @X, cached quote of @X in Home, airplane mode, cold launch: quoted content renders instead of the G-6 stub |
| SR-32 | S3 | ux (compose) | Replying to or quoting a post deleted on v10 shows "Couldn't load the post · Retry" forever, never the deleted/unavailable copy | `mobile/app/src/features/compose/ComposeScreen.tsx:219` | No | Devnet, B deletes a post A has cached, A taps Reply without refreshing: Retry never changes the state |
| SR-33 | S3 | ux | iOS: toasts raised while a page-sheet modal is open are hidden behind it (edit-profile, new-message, new-group failures) | `mobile/app/src/app/_layout.tsx:148` | No | iOS sim, Edit profile, stall the network, Save: spinner ends, no visible toast (VoiceOver announces it) |
| SR-34 | S3 | ux | G-5 insufficient-credits / YAPP copy is never shown; low-balance writes get generic "try again" or web-only advice | `mobile/app/src/data/writes.ts:177` | Yes (`categorizeError`) | Testnet identity with about 0 credits: Like and Post give "Failed to update like…" / "Couldn't post · Retry" |
| SR-35 | S3 | ux | G-1 offline rule missing for engagement, profile and safety writes: the optimistic change is applied, and no "Nothing was sent" toast appears | `mobile/app/src/data/writes.ts:326` | No | `network offline`, tap Like and Follow: both flip and stay that way silently; reconnect and refresh to see they were never written |
| SR-36 | S3 | ux | Lockdown "Browse saved posts" has no banner, no "Fix", and writes give generic failures instead of "Unavailable in Lockdown Mode" | `mobile/app/src/engine/ui.tsx:109` | No | iOS, Diagnostics "Simulate Lockdown Mode", Browse saved posts, Like and Post: generic toast and a failed card, no banner |
| SR-37 | S3 | ux (compose) | Compose accepts image URLs over the contract's 512-character `mediaUrl` limit; the post fails with a generic error and Retry repeats it | `mobile/app/src/features/compose/ComposeScreen.tsx:230` | No | v2 build, paste an https URL of 600+ characters, Post: "Couldn't post", Retry fails again |
| SR-38 | S3 | ux | Group names: the 200-byte engine limit is unchecked in the UI, so long CJK names fail with a generic "Could not create the group". Profile, report and block fields also cap in UTF-16 units | `mobile/app/src/ui/TextField.tsx:58` | Yes | Devnet, New group, name of 70 CJK characters, add a member, Create: generic toast; Diagnostics "Write refused: A group name is 1 to 100 characters" |
| SR-39 | S4 | keys | The app lock does not gate secret hydration: the engine loads keys and restores the session before unlock (ENGINE §9.2) | `mobile/app/src/engine/index.ts:33` | No | Lock on, kill, relaunch, do not unlock: Diagnostics "Engine ready" and session `restored` are timestamped before the unlock |
| SR-40 | S4 | dm | Starting a chat with a user who has no encryption key shows "No user found with this identity ID" | `mobile/app/src/features/messages/NewMessageScreen.tsx:43` | No | Devnet, New message, paste the id of an auth-key-only identity: wrong toast |
| SR-41 | S4 | dm | When every conversation is hidden, the inbox shows the first-run "Welcome to Messages" state above "Show N deleted conversations" | `mobile/app/src/features/messages/InboxScreen.tsx:250` | No | Devnet, delete each conversation: welcome state plus the deleted-conversations link |
| SR-42 | S4 | dm | Message settings: the "Blocked" section shows a skeleton forever while Messages are locked | `mobile/app/src/features/messages/MessageSettingsScreen.tsx:181` | No | Devnet, auth key only, Settings → Messages: Blocked section shimmers indefinitely |
| SR-43 | S4 | ux (compose) | The compose counter and red overflow count untrimmed text while Post and the engine trim: the counter says "over limit" while Post works | `mobile/app/src/features/compose/ComposeScreen.tsx:229` | No | Testnet, paste 500 "a", press Return twice: red "502 / 500", Post enabled and succeeds |
| SR-44 | S4 | ux (a11y) | The fixed-height compose header, NSFW chip and mention rows overflow and overlap text at accessibility sizes | `mobile/app/src/features/compose/ComposeScreen.tsx:404` | No | iOS AX5 / Android 200%: compose with "Post all (2)" and `@ali` suggestions; screenshot the overlap |
| SR-45 | S4 | ux (a11y) | Write-status actions (Check again / Retry / Edit / Retry the rest) have no testID, and their hit areas overlap | `mobile/app/src/ui/WriteStatus.tsx:124` | No | Failed post card: id selector for Retry finds nothing; a tap about 3 pt right of "Retry" opens Edit |
| SR-46 | S4 | release | iOS Release keeps ATS `NSAllowsLocalNetworking`, so cleartext http:// media from `.local` and unqualified hosts loads (RELEASE.md says otherwise) | `mobile/app/app.config.ts:104` | No | `plutil -p` the release .app Info.plist; a post with media `http://<laptop>.local:8000/t.png` renders on iOS, broken on Android |
| SR-47 | S4 | ux (compose) | Compose has no hardware-keyboard shortcut to post (COMP-12, P1) | `mobile/app/src/features/compose/ComposeScreen.tsx` (no key handler anywhere; spec gap) | No | iPhone sim with hardware keyboard, compose, type, press ⌘↩: a newline, not a post |

## Finding details

### SR-01 (S2, keys): iOS app lock: a modal presented while the app is locked draws over the lock screen and takes touches

- **File:** `mobile/app/src/features/auth/TopOverlay.tsx:22`. Also `features/auth/AuthGates.tsx:42-51`, `app/terms-gate.tsx:56-67`, `navigation/deep-links.ts:114,117-121`, `app/_layout.tsx:101-122`. **Shared with web:** no. iOS only; on Android the overlay is an RN Modal, a Dialog window above the activity.
- **Scenario (verifier-corrected):** iOS with App lock on.
  - **Case 1, cold launch.** The lock overlay is a `FullWindowOverlay`, added once as a subview of the app's own UIWindow, and it mounts on the first render. The engine then restores a signed-in session whose terms acceptance is older than the current `TERMS_VERSION` (any launch after an app update that bumps it). `useTermsGate` pushes `/terms-gate` as a transparentModal (`UIModalPresentationOverFullScreen`). UIKit adds the modal's transition view to the same window, above the lock container, so the opaque terms gate covers "Yappr is locked" and takes touches. The Face ID prompt can be cancelled. "Not now" then runs `signOutAccount` and engine `signOutNow`, which deletes all of that identity's keys from the device with no authentication. The owner has to sign in again to recover.
  - **Case 2, warm launch.** With the app locked, an inbound link (`<scheme>://login` → `/sign-in`, or `<scheme>://messages?startConversation=<id>` → `/messages/new`) presents an interactive page sheet over the lock. No owner content is shown, because the conversation it opens lands on a tab route that stays under the lock. Dismissing the modal shows the lock again.
- **Evidence:**
  - `TopOverlay.tsx:22` uses `FullWindowOverlay` on iOS.
  - `node_modules/react-native-screens/ios/RNSFullWindowOverlay.mm:150-162` (RNS 4.26.2): `maybeShow` calls `[window addSubview:_container]` on the app's own window. It creates no separate UIWindow, sets no windowLevel, and never brings the container back to the front.
  - Native-stack modals are presented with `presentViewController` (`RNSScreenStack.mm:484`; presentation mapping at `RNSScreen.mm:232-263`).
  - `useLockState` is read only in `AppLockOverlay.tsx` and `app-lock.ts`. `useTermsGate`, `useResumeWalletSignIn`, `+native-intent.tsx` and `toAppRoute` all ignore the lock.
  - The comment at `TopOverlay.tsx:9-11` ("the overlay lives in its own window") is wrong for this RNS version.
  - Jest tests cannot catch native z-order.
- **Verifier reasoning:**
  - Confirmed from the native code. The mount order makes it reachable: on a cold launch `locked` starts as `enabled` (`app-lock.ts:56-57`), so the overlay mounts before the terms push. On a warm launch the overlay mounts on `inactive`, before the deep link resolves.
  - Severity is S2, not S1: no private content or money is exposed. It is above S3 because a person holding the locked phone can complete a destructive sign-out.
  - The terms path needs a `TERMS_VERSION` bump, so it is uncommon.
- **Repro hint:** iOS simulator, devnet build, signed in. Settings → Account → App lock on, timeout Immediately. Background the app, then run `xcrun simctl openurl booted 'yappr-dev://login'` or `'yappr-dev://messages?startConversation=<other id>'`. Bug: the sheet draws over testID `app-lock` and is tappable. Terms path: set `TERMS_VERSION` ahead of the stored acceptance (or clear the terms store), relaunch, cancel Face ID. Terms-gate covers app-lock; "Not now" empties Accounts. Capture screenshots with both `app-lock` and the modal visible.

### SR-02 (S2, writes): Double-tap on Post/Reply publishes the same post twice

- **File:** `mobile/app/src/features/compose/ComposeScreen.tsx:329`. Also `:232` (`canPost`), `features/compose/pending-posts.ts:499-553`, `ui/ScalePressable.tsx`. **Shared with web:** no.
- **Scenario (verifier-corrected):** Signed in and online. Type a post and double-tap Post, with the second touch-down within about 1-3 frames of the first touch-up. The window is wider on Android and on slow devices, where the slide-out leaves the button hittable for part of the animation.
  1. The first press runs `post()`: `publishPost` creates pending entry A and a publish write, then `router.back()`.
  2. The modal is still mounted and `canPost` is still true. `post()` never checks `posted.current`, so the second press runs `post()` again and creates pending entry B, with a new localId and a second `posts.publish` ticket.
  3. Result: two optimistic cards, then two identical posts on chain, each paying a fee. A reply duplicates the same way, and "Post all (N)" duplicates the whole thread.
- **Evidence:**
  - `post()` checks only `canPost`, which the first press does not change. `posted.current` is set at `:332` but only `persist()` reads it.
  - `ScalePressable` is a plain Pressable with no debounce.
  - `publishPost` creates a new localId each call, and each write key `publish:${localId}` is distinct, so `writes.ts` never queues the second press.
  - Compose is a transparentModal (`app/_layout.tsx:43-46,101`), so `router.back()` only starts a native dismissal.
  - No test covers a double tap.
- **Verifier reasoning:** Nothing stops the second press. This is the known React Navigation double-tap problem, here with a paid write attached. S2: the user must delete the duplicate by hand and pays a second fee, but no content is lost. Unverified side effect: a second `router.back()` may also pop the screen behind compose. Fix direction: return early from `post()` when `posted.current` (or `leaving.current`) is set.
- **Repro hint:** agent-device taps on testID `compose-post` twice within about 50-100 ms. On Android, also try a tap during the slide-down. Diagnostics shows two `Write post.publish <id>: pending` lines with different ticket ids, and the profile shows two posts.

### SR-03 (S2, writes): A thread or post cut short by an engine restart or app kill forgets the parts already posted, and Edit then reposts them

- **File:** `mobile/engine/src/writes/publish.ts:141`. Also `writes/tickets.ts:190-197`, `features/compose/pending-posts.ts:139-147,173,400-403`, `publish.ts:182-188` (probe). **Shared with web:** no. The fix may need per-part ids from the shared `lib/compose/publish-thread.ts`.
- **Scenario (verifier-corrected):**
  1. Post a 5-part thread. At "Posting 3 of 5…", parts 1-2 are on chain and the persisted ticket has `progress.done=2` but `documents=[]`.
  2. Run `bin/qa engine-kill`, or kill and relaunch the app. After boot the ticket is `unconfirmed` (ENGINE_RESTARTED, `retryable:false`, documents still `[]`).
  3. The card shows "Couldn't confirm. Check your profile · Edit" with no Check again. NET-04 and COMP-10 require "Not confirmed yet · Check again". Even if the probe ran, it would answer `unknown` because part 1 has no id.
  4. Tap Edit. Compose opens all 5 parts with none marked Posted, even though `adoptedId` holds part 1's id.
  5. Tap Post. Parts 1-2 are published again as a new thread. This breaks COMP-05 ("never reposts a posted one").

  Single-post variant: kill after `createPost` returned but while the hashtag and mention index writes are still running. The card already shows the real post, yet still says "Couldn't confirm · Edit", and Edit then Post makes a duplicate.
- **Evidence:**
  - `run()` never calls `ctx.documents()`; ids are only built after `await publishThread(...)` returns. `onProgress` (`:153-157`) records only stage and progress.
  - `WriteRunContext.documents` (`tickets.ts:41-42`) exists for exactly this purpose, but nothing calls it.
  - `postedIds()` reads only `draft.resume` and `ticket.documents`.
  - `draftPartsOf` ignores `adoptedId`.
  - `publish.test.ts` does not cover a restart mid-thread.
- **Verifier reasoning:** Confirmed end to end; the trigger (a kill while "Posting n of N" with n ≥ 2) is reachable. S2 rather than S1, because the duplicate needs the user to tap Edit and then Post, and the card does tell them to check their profile first.
- **Repro hint:** Android emulator or iOS sim, dev network. Post a 5-part thread and run `bin/qa engine-kill` at "Posting 3 of 5". Diagnostics shows `Write post.publish <id>: unconfirmed (ENGINE_RESTARTED)`; `writes.get(ticket).documents == []`; `progress.done == 2`. Tap Edit, then Post, and confirm parts 1-2 are duplicated on the profile.

### SR-04 (S2, writes): Engagement failures that lib reports as `false` become a silent "unconfirmed"

- **File:** `mobile/engine/src/writes/tickets.ts:275`. Also `mobile/engine/src/writes/lib-results.ts:27-31`, `writes/classify.ts:136-140,156-161`, `api/engage.ts:124-178`, `api/posts.ts:457`, `app/src/data/writes.ts:229-244`, `features/post/post-writes.ts:35,54,71`. **Shared with web:** no. The root cause (lib swallowing errors in `like-service.ts:215-221`) is shared, but web compensates in `hooks/use-post-engagement.ts:112-118`.
- **Scenario (verifier-corrected):**
  1. These lib calls return `false` whenever the write is refused or never sent: `likePost`, `unlikePost`, `bookmarkPost`, `removeBookmark`, `repostPost`/`removeRepost` (v2), and `deleteOwnPost`/`deleteOwnReply`. That covers consensus refusals (moderation-barred, agreement or target refusals), PENDING_WRITE, a missing key, and other caught errors.
  2. `fromBoolean(false)` turns that into a generic Error, "The network did not accept this change". `classify` matches no rule, because the NETWORK markers are case-sensitive, and returns UNKNOWN/`unknown`. The ticket becomes `unconfirmed` with `retryable:false`.
  3. Like, repost and bookmark have `announceUnconfirmed:false`, so the optimistic state stays. The user gets no G-4 toast, no Retry and no key prompt (NO_KEY never reaches `onKeyRequired`).
  4. Nothing checks the ticket. The next refetch reverts the state silently, so NET-05 is not met.

  Clearest trigger: an SDK-signed write (unfollow, unbookmark, profile save) with an unknown outcome leaves a nonce entry pending for 15 minutes (`identity-nonce.ts` PENDING_LIFETIME_MS). Every like and bookmark in that window fails with PENDING_WRITE and looks successful on mobile.

  Deletes are partly covered: "Not confirmed yet · Check again" leads to a probe that proves the post still exists, then undoes the hide with "Your delete didn't go through". The G-4 categorized message is still lost.
- **Evidence:** the files above. `tickets.test.ts:85` asserts `fromBoolean(false).state === 'failed'`, but no test covers the ticket state the store derives from it.
- **Verifier reasoning:** Traced through every step. A `false` from lib always means a real failure (a lost wait returns `success:true, confirmed:false`), so marking it "unconfirmed" is wrong. S2: refused writes look successful, offer no feedback or retry, and revert silently. No credits are lost.
- **Repro hint:** Dev network. Run `network stall` during an unfollow broadcast, restore the network, then like 3 posts within 15 minutes. The hearts stay filled with no toast, Diagnostics shows `Write like <id>: unconfirmed (UNKNOWN)`, and pull-to-refresh reverts them silently. Variant: like a post whose author deleted it (TARGET_GONE) from a stale feed. Web shows "Failed to update like. Please try again." for the same case.

### SR-05 (S2, writes): (suspected) A write queued behind a cut-short call is released into the next engine, possibly as a different account

- **File:** `mobile/app/src/data/writes.ts:364`. Also `engine/supervisor.ts:576-590` (dispatch queue), `:420-423,494-497` (drain), `:630-640`, `mobile/engine/src/api/engage.ts:200-215`, `features/auth/accounts.ts:67-71`, `data/sync.ts:69-74`. **Shared with web:** no.
- **Scenario (verifier-corrected):** v10 (`repostsAreQuotes`). Two accounts on the device; A is active and has already reposted post P. The network is slow or stalled so that DAPI reads hang without failing quickly.
  1. Undo the repost. `engage.unrepost` is now waiting on `ownQuoteStrict` in engine A.
  2. Within about 1 s, repost again. It is queued under `repost:<P>`.
  3. Quickly switch to B. This must finish within the 15 s write deadline and before the SDK read times out.
  4. `session.switchAccount` rewrites the session slot to B. `restartEngine` tears down engine A, and the unrepost rejects with ENGINE_RESTARTED.
  5. `writes.ts:364-370` releases the key, and `engage.repost(P)` goes into the supervisor queue. The queue is drained into the new epoch as soon as `engine.boot()` runs.
  6. The new engine stamps the ticket with identity B and creates a bare quote of P signed by B.

  Result: B shows a repost it never made, paid with B's credits, and A keeps its repost.

  Variant without a switch (S3): the 15 s ENGINE_TIMEOUT releases the queued repost into engine A while the unrepost is still running. If the unrepost submits last, the chain ends "not reposted" while the UI shows "reposted" until refresh.
- **Evidence:**
  - `teardown()` does not run `failQueue`, so queued jobs survive a restart.
  - `resetWriteTracking` runs only when the new session is applied, which is after the drain, and it cannot reach the supervisor queue anyway.
  - If the read finishes before the switch, RESTART_REQUIRED safely drops the queued write. The bug needs the read to still be pending at teardown.
  - No test covers release-on-restart across an account switch.
- **Verifier reasoning:** Every link is unguarded, but the timing window is narrow. Impact: a public write is made under, and paid by, the wrong account, and the user must undo it by hand, so S2. Off v10, unrepost submits synchronously and the window is negligible. Any write method that awaits a network read before `tickets.submit` has the same exposure.
- **Repro hint:** Dev network, two accounts. Enable `network stall`, tap the repost toggle twice within 1 s, switch to B at once, then disable the stall. Diagnostics should show "Write cut short: The engine restarted during engage.unrepost", then "Switching accounts; restarting the engine", then a repost ticket in the new epoch with identityId B.

### SR-06 (S2, ux/compose): A failed resumed thread's text goes back into the new-post draft slot, where an open composer overwrites it

- **File:** `mobile/app/src/features/compose/pending-posts.ts:470`. Also `:420-436` (`draftSlotFree`, `returnToDraft`), `:541` (`placement: 'none'`), `:549` (`deleteDraft`), `ComposeScreen.tsx:242-263`, `drafts.ts:85-89,106-110`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. The user resumes a partly posted thread with "Post all". `publishPost` gives it placement `none` and deletes the `post` draft slot.
  2. The user opens compose again for a new post. The composer starts empty and reads its `initial` value only once, at mount.
  3. The resumed thread fails (refused, failed, partial, uncertain, or lost after a restart). `settleFailure` writes the thread's parts into the empty `post` slot with `fromPending` set, then `discardPending` drops the entry. The slot now holds the only copy of the text.
  4. Any of these destroys it:
     - The open composer's `persist()` runs (a keystroke, the 500 ms timer, backgrounding, or "Save draft") and calls `saveDraft` unconditionally, overwriting the slot.
     - Tapping Post in that composer: `publishPost` runs `deleteDraft(identityId, {mode:'post'})` with no `onlyFromPending` guard.
  5. No card or toast points to the text, because an entry with placement `none` is never placed. This breaks G-4 ("Composer text is never lost").

  Related variant: if the user has already typed in the new composer, `draftSlotFree` is false and the thread text stays in an entry with no card and no Edit, so it is invisible.
- **Evidence:** the lines above. Only the empty-content close path is guarded (`deleteOwnDraft` checks `fromPending`). No unit test covers a failure landing while another composer is open.
- **Verifier reasoning:** A resumed multi-part publish takes several seconds, and the FAB reopens an empty composer immediately, so the timing is easy to hit. S2: unposted text is lost with no recovery, but it needs a timing window and touches no funds or on-chain state.
- **Repro hint:** Devnet.
  1. Post a 3-part thread with `network stall` after part 1, so the card reads "Posted 1 of 3 · Retry the rest".
  2. Reopen compose and tap "Post all (3)".
  3. Tap the FAB at once and leave the composer empty.
  4. Make the resumed publish fail. Diagnostics shows `Write post.publish …: failed`.
  5. Type "x" and either wait 1 s then Cancel → Save draft, or tap Post.
  6. Reopen compose: the text of parts 2-3 is gone and no card is left.

### SR-07 (S2, dm): Manual unlock accepts any ENCRYPTION key, but the DM engine and peers use only the first one

- **File:** `lib/crypto/key-validation.ts:117`. Also `mobile/engine/src/api/dm.ts:493-505`, `lib/services/dm-v5/index.ts:58-66`, `lib/services/dm-v5/context.ts:85-90`, `lib/services/dm-v5/sdk-chain.ts:272-279`, `key-derivation.ts:94`. **Shared with web:** yes.
- **Scenario (verifier-corrected):**
  - **Setup:** an identity with two active secp256k1 ENCRYPTION keys. Yappr can create one itself: mobile wallet sign-in with a new login key or keyIndex registers another encryption key without checking for an existing one (`mobile/engine/src/session/key-exchange.ts:232-247` → `lib/services/identity-update-builder.ts:136-235`). A DashPay wallet identity with a bound ENCRYPTION key also qualifies.
  - **Steps:** on a fresh install, sign in with the auth key, go to Messages → "Enter encryption key", and paste the WIF of the key with the higher id.
  - **What happens:**
    - `validateKey` matches it and `dm.unlock` reports unlocked.
    - The DM engine takes its public key, selfRoot, state key and group ids from the stored key. Peers use `findEncryptionKey`, which picks the lowest-id key.
    - Existing conversations, invites, grants and self-state do not decrypt, so the inbox is empty or shows "You cannot read this group yet".
    - Messages sent from this device use a shared secret the peer cannot reproduce. They are never seen, their fees are wasted, and no error is shown.
  - **Recovery:** sign out and enter the lowest-id key's WIF. Nothing in the app says which key that is.
- **Evidence:** `validateKey` loops over all candidate keys and returns valid on any match. Every consumer resolves only the first key. The two unlock paths (manual entry and auto-derive) are therefore inconsistent.
- **Verifier reasoning:** Confirmed in code. **Raised from S3 to S2:** recovery needs user action the app does not guide, and outgoing messages silently never reach anyone. Related, out of scope: the login-key path (`vendor/platform-auth/src/core/controller.ts:449-466`) also stores a derived encryption key without checking that it is the first one.
- **Repro hint:** Devnet test identity with two ENCRYPTION keys (for example ids 4 and 5). Unlock with the second key's WIF. Expected: "Invalid key", or the key works. Actual: "Encryption key saved", then an empty inbox and sends the peer never receives. Control: the same identity unlocked with the first key shows its conversations.

### SR-08 (S2, engine): The restart cap never trips for slow failures, so the engine restarts forever

- **File:** `mobile/app/src/engine/supervisor.ts:289`. Also `:118-124` (DEFAULTS), `:274-297` (`crashed()`), `:353`, `:368`, `:572-590` (dispatch), `features/home/FeedPage.tsx:238`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **When it happens:** the engine fails slowly. Examples: a module-scope throw in the bundle or lib, a blank or failed loader page (such as an oversized inline storage snapshot on Android), or a hang during hello or boot. The cause is often persistent, so killing and relaunching reproduces it.
  - **Why the cap never trips:** `crashed()` counts only crashes in the last 120 s and fails at `maxFailures = 5`.
    - Hello timeout (30 s): the window settles at 4 crashes per 120 s with a 4 s backoff. That is about 1.75 restarts per minute, forever. The 8 s and 30 s backoff steps are never reached.
    - Boot deadline (90 s): at most about 1 restart per 94 s.
  - **Nothing breaks the loop:**
    - Diagnostics "Restart engine" clears `crashes` and starts the same loop again.
    - Home's "Couldn't connect" state needs `failed`, so it never appears.
    - `dispatch()` rejects only in failed, unsupported or stopped, and no caller adds a timeout (`engine/index.ts:64`). So every queued read, write and sign-in call hangs.
  - **What the user sees:** Home shows "Connecting to Dash Platform…" forever, and a like stays optimistic with no ticket.
  - **Not affected:** instant failures (prepare rejects, a renderer that dies immediately) still reach `failed` after 5 crashes.
  - **Spec conflict:** PRD NET-04 says 3 restarts in 2 minutes → "Couldn't connect", not a loop. ENGINE §3.4 says 5.
- **Evidence:** a scratch Jest simulation of the real `EngineSupervisor` with fake timers:
  - Engine that never says hello: after 20 min, epoch 36, 35 restarts, never `failed`.
  - Hello but no boot: after 20 min, epoch 14, never `failed`.
  - `supervisor.test.ts:191` tests the cap only with instant crashes.
- **Verifier reasoning:** Confirmed by tracing the timing by hand. The engine is already broken in this state; the defect is the recovery path. It loops forever, remounting a roughly 33 MB WebView about every 34 s, hangs every call and never offers "Try again". S2: nothing is written or lost, but no in-app action breaks the loop. Fix direction: count consecutive failed boots (reset on `ready`) instead of time-windowed crashes, and settle 3 versus 5.
- **Repro hint:** Dev build whose engine bundle throws at module scope, or with hello blocked. Leave Home open with an empty cache for 5 minutes. Diagnostics "restarts" climbs past 5, the log repeats "Engine crashed: handshake failed: Engine did not say hello within 30000 ms", and the state never becomes `failed`. A like tapped meanwhile stays optimistic with no ticket.

### SR-09 (S3, keys): Signing out a non-active account leaves its drafts and pending posts in unencrypted MMKV (AUTH-11)

- **File:** `mobile/app/src/features/compose/pending-posts.ts:819`. Also `:763-784` (`forgetAccount`, `forgetSignedOut`), `mobile/engine/src/api/session.ts:289-297`, `features/auth/accounts.ts:195-217`, `drafts.ts:112-115`, `state/storage.ts:7`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. Devnet, identities A and B on the device. While B is active, type "SR-draft" in a reply and close it. The draft is saved under `yappr.compose.drafts.<B>`.
  2. Switch to A, then Settings → Account → Accounts → menu on B → Sign out.
  3. The engine removes B's keys but emits no `session.changed`: it announces only for the active account (`session.ts:297`). So `forgetSignedOut` never runs, and B's draft stays in the unencrypted `yappr` MMKV.
  4. Force-quit and relaunch, which empties the in-memory `seen` set. Add B back with the same key and reopen Reply on the same post: "SR-draft" is restored.

  B's pending or failed post entries also stay until a later sign-out of the active account; the owners sweep catches those. Within one process, B's drafts are cleared only if B is still in `seen` when the active account later signs out.
- **Evidence:** `forgetDrafts` → `forgetAccount` → `forgetSignedOut` is the only cleanup chain, and it runs only from the `session.changed` listener when `reason === 'signed-out'`. `signOutAccount` does no draft cleanup. No unit test covers clearing drafts on a non-active sign-out.
- **Verifier reasoning:** Confirmed; the UI path is reachable from the account list's manage menu (`AccountSwitcher.tsx:28`). S3: the account's own text is left in local storage against AUTH-11, but no keys leak and the leftovers are visible only if B is added again.
- **Repro hint:** as above. Alternative proof: in a debug build, read the MMKV id `yappr` key `yappr.compose.drafts.<B id>` after the sign-out.

### SR-10 (S3, keys/dm): Sign-out leaves the account's DM v5 local cache in engine storage (AUTH-11 "DM state")

Filed by both the keys reviewer and the DM reviewer; merged here.

- **File:** `mobile/engine/src/api/session.ts:295`. Also `lib/services/dm-v5/index.ts:66` (`cacheKey: yappr_dm_v5:${identityId}`), `lib/services/dm-v5/local-cache.ts:1-52`, `mobile/engine/src/session/accounts.ts:31,140-146` (STASHED_KEYS holds only notifications), `lib/auth/platform-auth-adapters.ts:266-272`, `mobile/app/src/engine/storage/engine-storage.ts:113`. **Shared with web:** yes; web logout leaves the same localStorage key.
- **Scenario (verifier-corrected):**
  1. Devnet build (DM v5; `.env.devnet:90` sets `NEXT_PUBLIC_DM_TOPOLOGY=v5`). As A, open a few 1:1 and group DMs, read one, hide another, and block someone in Messages. The engine writes `yappr_dm_v5:<A>` to its plain localStorage area, which persists to the encrypted MMKV `yappr.engine.devnet-sakura`.
  2. Sign A out, either as the active account or from the switcher while B is active.
  3. Nothing removes the key:
     - `signOutNow` runs `stopDm`, whose un-awaited flush can even rewrite the cache, then `controller.logout` or the `clear*` loop.
     - `runLogoutCleanup` and `registry.remove` (notifications only) do not touch it.
     - A repo-wide grep finds `yappr_dm_v5` only at `dm-v5/index.ts:66`.
  4. A's conversation keys (`d:<peer hex>`, `g:<owner>:<gid>`), blocked-user hex ids, readAt/hiddenAt, `left` groups, heads and invite stats remain until reinstall or a full storage reset (`engineStorage.reset()`, which is not on the sign-out path).
- **Verifier reasoning:** Confirmed on both sign-out paths. S3, not S2: the data is metadata only (no message content, no keys), the store is AES-256 MMKV with its key in the Keychain, and no other account can read the per-identity key. It still breaks AUTH-11, it is the private "who you talk to" graph, and it adds slow kv growth for every account that signs out.
- **Repro hint:** Devnet debug build. Dump MMKV keys before and after sign-out: `yappr_dm_v5:<A>` is still there. Or compare Settings → Engine diagnostics → Storage "Plain keys" (`localKeys`, `engine-storage.ts:320`): it drops by the session and notification keys but not by the DM cache key.

### SR-11 (S3, keys): After the last account signs out, its private keys stay in the WebView DOM and in the RN heap until the engine restarts

- **File:** `mobile/app/src/engine/page.ts:69`. Also `:63-99` (inline script on iOS, loader page on Android), `mobile/engine/src/shims/storage.ts:333-342`, `engine/supervisor.ts:352`, `engine/EngineHost.tsx:54`, `features/auth/accounts.ts:195-217`, `engine/index.ts:33-40`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **Precondition:** the account was signed in when the current engine epoch booted, so its keys are in the boot snapshot. That covers any launch after sign-in, and any switch or restart. A sign-in made during the current epoch is never in the snapshot.
  - **Steps:**
    1. Sign in with a pool key, then kill and relaunch the app. The boot snapshot now carries `yappr_secure_*` WIFs and private-feed keys, inlined as `<script>window.__YAPPR_ENGINE_STORAGE__={...}</script>`.
    2. Sign out of this, the only account. `signOutNow` clears MemoryStorage and the Keychain items. `accounts.ts:209-215` restarts the engine only when another account exists, so there is no restart here.
  - **What remains:**
    - `takeInjectedSnapshot` only deletes the window global; nothing removes the `<script>` element, so its text stays in the DOM.
    - The full HTML string stays in RN memory as `supervisor.mount.load.source.html` and as the WebView `source` prop.
    - If another account then signs in during the same epoch, the old account's keys sit in the DOM next to the new session.
  - **Contradicts:** ENGINE §11.1 (`ENGINE.md:1111,1113`), which says secrets are held "until a switch or sign-out" and that RN drops its references.
- **Verifier reasoning:** Confirmed at every step. S3: this is residual retention against the §11.1 threats. Recovering the keys needs script execution in the engine, an RN heap dump or a debugger (`webviewDebuggingEnabled` is `__DEV__` only), and it ends at app kill or engine restart.
- **Repro hint:** Devnet dev client. After step 2, attach Safari Web Inspector or chrome://inspect to the engine WebView and run `[...document.scripts].some(s => s.textContent.includes('yappr_secure_'))`. It returns true where it should be false. Diagnostics → Restart engine, then re-run: false. Control: after a fresh sign-in with no relaunch, the check returns false, which confirms the precondition.

### SR-12 (S3, keys): (suspected) iOS app-switcher privacy depends on a JS re-render, and key screens get no switcher protection

- **File:** `mobile/app/src/features/auth/AppLockOverlay.tsx:59`. Also `:41,44`, `features/auth/app-lock.ts:84-88`, `modules/secure-window/index.ios.ts:10-13`, `ui/screen-capture.ts:24-27`, `node_modules/expo-screen-capture/ios/ScreenCaptureModule.swift:58-61,161-216`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **(a)** iOS, App lock on with timeout Immediately, app unlocked. The user swipes Home or into the app switcher while the JS thread is busy (engine boot or hydration after a resume, or a heavy feed render).
    - The cover appears only after `inactive` reaches JS, `covered` re-renders, and the `FullWindowOverlay` mounts. If that arrives after `didEnterBackground` returns, iOS saves a snapshot of the feed or a DM conversation instead of "Yappr is locked".
    - When `locked` is already true there is no race, because the overlay is mounted before the app leaves. So the literal AUTH-12 bullet holds. The gap is the leave-while-unlocked case, which the code itself means to cover.
    - The `private` scope is a no-op on iOS by design. `enableAppSwitcherProtectionAsync`, a native, synchronous willResignActive overlay, ships with expo-screen-capture 57.0.3 but is never called.
  - **(b)** Suspected and unconfirmed. With the lock off, on Sign in with a private key after tapping "Show key", the `secret` scope only calls `preventScreenCaptureAsync`, which moves the layer into a secure text-field layer. Whether iOS leaves secure-layer content out of switcher snapshots cannot be settled from the code. If it does not, the switcher card and the snapshot iOS saves to disk show the plaintext WIF. Check on a device before filing (b) on its own.
- **Verifier reasoning:** Not refutable from the code; the timing is unproven. iOS saves the snapshot about 0.3-0.5 s after willResignActive, so the cover usually lands in time, and the leak needs JS blocked for longer than that. S3; raise to S2 if the device repro leaks repeatedly. Fix: enable `enableAppSwitcherProtectionAsync` while the lock is on, or add a native cover in `modules/secure-window`. No unit test covers either path.
- **Repro hint:** Physical iPhone (simulator snapshot timing differs). (a) Lock on, Immediately. Scroll Home or resume so the JS thread is busy, then swipe into the switcher at once. Screenshot the card and repeat 20 times; record the leak rate. (b) Lock off. Sign in → Other ways → private key, paste a devnet WIF, tap "Show key", swipe to the switcher, and check the card.

### SR-13 (S3, keys/nav): Deep links: unsupported and web-only links go Home silently, and `/login` opens sign-in while signed in (NET-11 P0)

Also covers part (a) of the UX reviewer's "spec gaps" candidate, which the verifier rated S3.

- **File:** `mobile/app/src/navigation/deep-links.ts:110`. Also `:13-14` (`FALLBACK_ROUTE = '/'`, TODO), `:114`, `:136-141` (TODOs), `:206-225` (`toAppRoute`), `app/+not-found.tsx:9,15`, `app/+native-intent.tsx:9-20`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **Release build, any platform:**
    - Scheme links to web-only routes (`yappr-dev://dpns/register`, `://store`, `://blog`, `://terms`, …) and unknown routes (`yappr-dev://does-not-exist`) open Home with no toast, no "Open in browser" and no in-app browser. Expected per NET-11 and UX_SPEC §3.5/§5.11: the in-app browser for web-only routes, and Home plus "This link isn't supported in the app" for unknown ones.
    - Malformed known links (`/post?id=bad`) and links under another deployment's prefix (`/testing/...` on devnet) also go silently to Home.
  - **Signed in:** `yappr-dev://login` opens the sign-in sheet instead of being ignored. Signing in there with another key shows "Another account is signed in" (`errors.ts:42-43`). The sheet itself is harmless and can be cancelled.
  - **Unmapped routes:** `yappr-dev://user?id=<own id>` opens the generic `/user/<id>` screen instead of the Profile tab, `&edit=true` is ignored, and `yappr-dev://followers` with no id goes Home.
  - **Reach limits:** https://yap.pr links cannot reach this code in 1.0, because there are no associatedDomains or App Links in `app.config.ts`; only scheme links do. There is no evidence that wallets return through `/login` after the key exchange finishes.
- **Evidence:** `WEB_ROUTES` has no web-only entries. `allowAppRoutes` is `__DEV__` (`+native-intent.tsx:15`). The copy "This link isn't supported in the app" is not in `src`. `deep-links.test.ts` asserts `'/'` for unknown links, so the gap is untested against the spec.
- **Verifier reasoning:** Confirmed against PRD NET-11 (`PRD.md:1049-1053`) and UX_SPEC (`:638-668`, `:1849`). These are unmet P0 acceptance bullets with an easy workaround (open the link in a browser), so S3, borderline S4 given the narrow reach.
- **Repro hint:** Use a release-config build; in `__DEV__` unknown paths go through `+not-found`, which also redirects Home. Run `xcrun simctl openurl booted 'yappr-dev://dpns/register'` and `adb shell am start -a android.intent.action.VIEW -d 'yappr-dev://store'`: Home, no toast. Then `yappr-dev://login` while signed in: the sign-in sheet opens.

### SR-14 (S3, writes): An edit-profile double-tap queues a second `profile.update`, sent after the first confirms

- **File:** `mobile/app/src/features/profile/profile-writes.ts:28`. Also `data/writes.ts:212-216,249-255,330-341,477-481`, `EditProfileScreen.tsx:74,117-120`, `NewGroupScreen.tsx:66-71`. **Shared with web:** no.
- **Scenario (verifier-corrected):** Testnet build (v2 profile topology).
  1. Open Edit profile, change the bio, and tap Save twice before the engine answers with the first ticket. That window is tens to hundreds of ms, longer while feed work keeps the engine busy. `useWrite` status stays `idle` until a ticket arrives, so `canSave` is still true.
  2. The second call sees `profile:<viewerId>` busy. The spec has no `intent` to dedupe on, so it is queued.
  3. The first ticket confirms, the modal closes, and "Profile updated!" shows.
  4. `release(key, true)` then sends the queued identical update as a new ticket. On v2 that is a second paid replace.
  5. On a first-time profile (a duplicate create), or after a stale read following the first write's assumed-success confirm, it fails instead: "Failed to update profile" shows on whatever screen the user is on.

  The queued copy is also sent if the first write ends unconfirmed (not retryable). On devnet (v10), unchanged documents are skipped (`lib/profile/v10-profile.ts:299-318`), so the second ticket is usually a free no-op.
- **Evidence:** `NewGroupScreen` guards exactly this window with a `submitting` ref and a comment saying so; EditProfile does not. `reportWrite` avoids it with `intent`. `deleteWrite` (`post-writes.ts:93`) also has no intent; its call sites were not verified.
- **Verifier reasoning:** Confirmed. S3: identical, correct data, at the cost of one small extra fee or a misleading late toast.
- **Repro hint:** Testnet build. Edit profile, change the bio, double-tap testID `edit-save`. Diagnostics shows two `Write profile.update <id>` sequences with different ticket ids. Credits drop by two replace fees, or a late "Failed to update profile" appears on a first-time profile.

### SR-15 (S3, writes): `methods.ts` classes DM, safety, bookmark and check reads as writes

See also SR-31, which covers the fail-open `isBlocked` consequence of the same classification.

- **File:** `mobile/app/src/engine/methods.ts:42`. Also `:16-48`, `:58-59`, `engine/supervisor.ts:630-640`, `writes/publish.ts:182-190`, `writes/tickets.ts:325-343`, `data/writes.ts:406-413`. **Shared with web:** no.
- **Scenario (verifier-corrected):** `dm.status`, `dm.conversations`, `dm.messages`, `dm.search`, `dm.createdGroup`, `safety.blocked`, `safety.isBlocked`, `safety.ownReport`, `engage.bookmarks` and `writes.check` are classed as writes. They get a 15 s host deadline instead of the spec's 30 s (ENGINE §4.5) and no replay after a restart.
  - **(1) Slow DAPI (not dropped):** a cold Bookmarks open (a composite read: bookmarks, then posts, then enrich), or a large or first-time DM conversation, takes 15-30 s. Both the first call and React Query's one retry reject with "Engine call … timed out after 15000 ms". The screen shows its error state where a feed under the same conditions loads.
  - **(2) Check again:** with several unconfirmed thread parts on a slow network, the sequential proved reads (8 s SDK timeout each, plus a 2 s recheck on any disagreement) exceed 15 s. The host toasts "Couldn't check. Try again in a moment." while the engine's probe keeps running and later settles the ticket through `write.status`, contradicting the toast.
  - **(3) Engine restart mid-call mostly heals itself.** React Query's retry (`retry:1` / `retryDm`) re-dispatches into the supervisor queue about 1 s later. The exception is `safety.isBlocked` (SR-31).
- **Verifier reasoning:** The misclassification is confirmed and departs from ENGINE §4.4/§4.5 and the restart table. The finding's "error state after engine-kill" claim is mostly refuted, since lists recover through the retry. S3 for the slow-network flows: spurious errors with a retry workaround.
- **Repro hint:** `bin/qa network stall` with high latency. Open Bookmarks cold, or a large DM conversation: Diagnostics shows "timed out after 15000 ms". On a multi-part unconfirmed thread, tap Check again: "Check failed" in the host log, then the ticket flips seconds later. An `engine-kill` during `dm.messages` should not end in an error state; if it does, file it separately.

### SR-16 (S3, writes/dm): A DM send cut short before its ticket existed leaves a permanent "Not confirmed" bubble

- **File:** `mobile/app/src/features/messages/outbox.ts:187`. Also `:155-160,172-195`, `mobile/engine/src/api/dm.ts:376-380`, `data/writes.ts:258,364-370`, `engine/methods.ts:58-59`, `MessageBubble.tsx:100-104`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. `dm.send` runs two network reads, `assertSendable` and `messages()`, before `tickets.submit`.
  2. The host call ends in that window. Either (a) the engine is killed or crashes (ENGINE_RESTARTED/DISCONNECTED), or (b) the reads take longer than the 15 s write deadline (ENGINE_TIMEOUT) and the engine never submits.
  3. `runWrite` returns `unknown`, and the bubble becomes `unconfirmed` with `ticketId: null`. No ticket ever exists, so `adopt()` and `adoptRestoredWrites` never match it.
  4. Every tap takes the no-ticket branch of `resolveFailed`, which toasts "Still checking. If it doesn't show, send it again." The restore-to-composer branch is unreachable.
  5. The bubble ("Not confirmed · Tap to check") stays until sign-out, account switch or app restart. It even survives a successful resend, because `forgetLanded` adds the resent ids to the stuck entry's `before`.

  The post path handles the same no-ticket case with an orphaned/lost state (`pending-posts.ts:162`); the DM outbox has none.
- **Verifier reasoning:** Confirmed. S3, not higher: long-press → Copy works on every bubble, so the text can be copied and resent. Retyping is not needed. It still breaks DM-04 and G-4.
- **Repro hint:** Dev network, DMs unlocked. Kill variant (more reliable): `bin/qa network stall`, tap Send, `bin/qa engine-kill` within 2-5 s, lift the stall. Timeout variant: stall for more than 15 s. Evidence: "Write cut short: …dm.send…" with no later `Write dm.send <id>` line, testID `dm-outbox-unconfirmed`, repeated "Still checking…" toasts, and the old bubble still there after a resend.

### SR-17 (S3, dm): A DM send that fails before any broadcast is stuck "Not confirmed", can never be retried, and its text is not restored

- **File:** `mobile/engine/src/api/dm.ts:237`. Also `:209-221` (`running()` wraps only NO_KEY), `:237-245` (probe), `writes/tickets.ts:257-296`, `writes/classify.ts:147,156-162`, `lib/services/dm-v5/sender.ts:43,62-73,96`, `outbox.ts:182-195`, `ConversationScreen.tsx:212`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. v5 on devnet, signed in and unlocked, with a 1:1 or group open. DAPI is unreachable while NetInfo still reports online, so G-1 does not trigger.
  2. Tap Send. Inside the `dm.send` ticket's `run()`, a pre-broadcast read fails first: `syncOwnStream`/`fetchWants`, or `applyGroups` for a stale group (SendError "Could not check the group for changes...").
  3. The error is not a `NotSentError` and no stage is set, so the ticket becomes `unconfirmed`, not retryable.
  4. Each tap on "Not confirmed · Tap to check" calls `checkWrite`. The probe can only answer `applied` or `unknown`, never `not-applied`, so the bubble never changes for the rest of the session.
  5. `takeDraft` already cleared the composer, and the text is never restored. Long-press offers only Copy.

  The same dead end follows certain (not transient) failures:
  - "You are no longer a member of this group."
  - "Ask the group owner to resend your keys."
  - No stream key.
  - "Could not find a free message slot."
  - Consensus refusals of `createMessage`, which `sender.ts:96` rethrows as a plain SendError and `classify` reads as UNKNOWN.
- **Evidence:** the engine test "never proves a send by an earlier identical message" (`test/unit/dm.test.ts:256-268`) asserts that the ticket stays unconfirmed. No test covers how the user recovers.
- **Verifier reasoning:** Confirmed. PRD DM-04's "Failed · Tap to retry" path is unreachable because the handler can never report the send absent. S3: copy-and-resend works, and no money is lost.
- **Repro hint:** Devnet. Run `bin/qa network stall` (DAPI blackholed, Wi-Fi up), tap Send, wait about 10 s, lift the stall, then tap the bubble several times. A group makes it easier: wait past the freshness window first. Diagnostics shows `write.status` for `dm.send` with `state=unconfirmed`, `retryable=false`, and code NETWORK, TIMEOUT or UNKNOWN.

### SR-18 (S3, dm): A multi-part v5 send that fails partway is resent whole, duplicating the parts already delivered

- **File:** `mobile/engine/src/api/dm.ts:219`. Also `:217-229`, `lib/services/dm-v5/engine.ts:437-447`, `sender.ts:60-115`, `writes/classify.ts:82-84`, `writes/tickets.ts:249-291,472-489`, `outbox.ts:175-180,193-194,225-238,271-276`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. v5. Text that `splitText` cuts into two or more parts. Part 1 lands and the peer sees it.
  2. Part 2's `createMessage` fails with lib's exact NOT_RECORDED, PENDING_WRITE or STORAGE message. That classifies as retryable, and the ticket is `failed`, `retryable=true`: `dm.send` never recorded any documents, so `partlySent` is false.
  3. "Failed · Tap to retry" re-runs `dm.send` with the full text. Every part is sent again in new slots, so the peer gets part 1 twice and the user pays for it twice.
  4. With a non-retryable refusal (for example insufficient balance), "Tap to edit" puts the full text back, and resending it unedited duplicates part 1 the same way.

  `mergeOutbox` already knows the send is incomplete (`complete=false`), but `resolveFailed` ignores that. This breaks DM-04 ("Retry sends the same content only after the engine reports it absent").

  Related variant: if part 2 fails with a transport error, the ticket is unconfirmed, and the probe requires every part, so Check again never resolves.
- **Verifier reasoning:** Confirmed. S3: a duplicate message plus one message fee; the workaround is editing before resending. The failure conditions are uncommon but possible. No unit test covers a partial multi-part failure.
- **Repro hint:** Devnet debug build. Force the second `createMessage` of a ~9 KB (3-part) send to fail (inject PENDING_WRITE, or fund the identity for about one message), then tap retry. Check the peer's conversation for a repeated part 1, and Diagnostics for two `dm.send` runs.

### SR-19 (S3, dm): Android: the DM v5 engine keeps polling in the background and silently marks incoming messages read (NET-08)

See also SR-30 (the wider background-activity finding).

- **File:** `mobile/engine/src/dm/v5.ts:149`. Also `lib/services/dm-v5/engine.ts:212-217,227-233,249,256-270,415-419`, `lib/services/dm-v5/index.ts:38-49`, `node_modules/react-native-webview/android/.../RNCWebView.java:115-118`, `ConversationScreen.tsx:153-170`, `data/dm-data.ts:49-55,121-139,168`, `engine/dm/legacy.ts:293-298` (legacy does pause). **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. Android with DM v5, on a device or emulator without the cached-apps freezer (for example an API 30-33 emulator). With the freezer on (Android 14+), the window shrinks to about 10 s after the app becomes cached.
  2. Open a conversation and press Home. `lifecycle('background')` only flushes. The DmEngine timer keeps re-arming at `OPEN_POLL_MS` = 4 s, because `openKey` stays set: `useFocusEffect` does not blur on app background. `RNCWebView.onHostPause` is a no-op, so WebView JS keeps running.
  3. A peer's message arrives. The poll picks it up and the engine emits `dm.changed`. The conversations query refetches (no focusManager or foreground gate).
  4. `unread > 0` triggers `markConversationRead`, which calls engine `markRead` and schedules a self-state save, another background write.

  Result: the message counts as read without being seen. DAPI queries run every 4 s in the background (30 s with no conversation open), and the daily sweep may run.

  The app clearly means to stop polling on background: `useDmStatus` is AppState-gated, legacy DMs pause, and PRD NET-08 allows only the DM flush. iOS is unaffected, because the process is suspended.
- **Verifier reasoning:** Confirmed at each step. S3: nothing is lost permanently (only unread state is wrong), at a battery and data cost. Workaround: leave the conversation before backgrounding.
- **Repro hint:** Android API 31 emulator, devnet. Open a conversation, `bin/qa background`, send 2 messages from a second identity, and wait 60 s while watching Diagnostics or a proxy for DM queries with background timestamps. Foreground: no unread markers or badge. Control: run the same steps with the inbox open. The badge still updates every 30 s, but nothing is marked read.

### SR-20 (S3, dm): Blocking someone does not stop their DMs; on testnet the conversation keeps its composer

- **File:** `mobile/engine/src/dm/legacy.ts:148`. Also `:120-150` (`rowsOf`, `unreadOf`), `ConversationScreen.tsx:90-109,233`, `features/messages/dm-model.ts:62`, `features/safety/copy.ts:10`, `engine/src/api/safety.ts`, `BlockScreen.tsx:46,131-140`. **Shared with web:** partly; the block-sheet copy over-promises on web too.
- **Scenario (verifier-corrected):**
  - **Testnet (legacy DMs, DM-11):**
    1. Devices A and B exchange DMs. On A, open the conversation → menu "Block" → BlockScreen → confirm. The toast says "User blocked".
    2. Back in the conversation, the composer is still active. There is no "You blocked this person. Unblock them to send messages." banner, because `legacy.ts:148` hard-codes `flags.blocked=false`.
    3. B sends again. The message appears, the inbox row is unread, and the Messages badge goes up. DM-10's "their new messages are ignored" is not met.
    4. The menu still says "Block". Tapping it opens BlockScreen in its "You blocked @x" state with Unblock, so unblocking works, but behind the wrong label.
  - **Secondary, all builds, shared copy:** the SAFE-01 sheet says blocking stops messages. On devnet/v5, a block from a profile or post does not touch the separate "Blocked in Messages" list, so that person's DMs still arrive. That separation is deliberate (`engine/src/dm/types.ts:42`, PRD DM-12), and v5 has a working in-conversation Block, so this part is a copy/spec inconsistency, not a code defect.
- **Verifier reasoning:** Part (b), the legacy behaviour, is confirmed, and no guard exists in the app or engine. S3: on testnet there is no way to stop the messages, but no data is lost.
- **Repro hint:** Testnet build, devices A and B. Block from the conversation menu. Expected per DM-10: a banner replaces the composer, and later messages are ignored with no badge. Actual: the composer stays, B's next message raises the badge, and the menu still says "Block".

### SR-21 (S3, dm): Testnet: a failed first conversation-list read shows an empty inbox, and refresh does nothing for 30 s

- **File:** `mobile/engine/src/dm/legacy.ts:175`. Also `:102-106,170,188-189,300-307`, `lib/services/direct-message-service.ts:449-452`, `data/dm-data.ts:28-31`, `InboxScreen.tsx:183-192,236-262,271`, `ConversationScreen.tsx:283-290`, `changes.ts:45-48`. **Shared with web:** yes (the lib `catch { return [] }`).
- **Scenario (verifier-corrected):**
  1. Testnet (legacy DMs), an account with existing conversations. The first conversation-list read after a cold start or engine restart fails. A full DAPI stall is not needed: one timed-out or 504 invite query is enough.
  2. lib `getConversations` swallows the error and returns `[]`. `legacy.ts:175` treats `[]` as a failure only when conversations are already held, so it records `listedAt=now, error=null`, and `dm.status` reports ready.
  3. The inbox shows "Welcome to Messages" with "New message" instead of the G-11 error with "Try again". The "Couldn't check for new messages" notice is suppressed too.
  4. For 30 s, pull-to-refresh re-reads nothing (`LEGACY_LIST_TTL_MS` early return).
  5. Opening a known conversation by key (deep link, notification or restored route) fails with BAD_REQUEST. `retryDm` does not retry it, so the screen shows "This conversation isn't available".
  6. It recovers on its own: the 30 s foreground status and inbox polls re-read once the TTL has passed. `dm.changed` carries the new keys and the open conversation reloads, at most about 30 s after DAPI returns.
- **Evidence:** the unit test "keeps the list when lib reports a failed read as empty" covers only the case with conversations already held.
- **Verifier reasoning:** Core claim confirmed. "Permanently" and "cannot recover" are refuted, because the polls heal it. No data loss and no write risk (`getOrCreateConversation` is deterministic). S3.
- **Repro hint:** Testnet build, account with DMs. Kill the app, start `bin/qa network stall`, launch, open Messages: testID `messages-empty` instead of `messages-error`. Lift the stall and pull to refresh immediately: still empty. About 30 s later the conversations appear. Variant: during the stall, open a deep link to a known conversation (`dm-conversation-missing`); it turns into the thread about 30 s after the stall lifts.

### SR-22 (S3, dm): "Sent" is shown for a v5 message never read back from the chain, which can vanish after a restart

- **File:** `mobile/app/src/features/messages/dm-model.ts:171`. Also `:197-199`, `mobile/engine/src/dm/v5.ts:23`, `lib/services/dm-v5/engine.ts:297-306`, `lib/services/dm-v5/sender.ts:103-106`, `lib/services/dm-v5/poller.ts:145,216`, `lib/services/state-transition-service.ts:740-744`, `components/messages/thread-view.tsx:148` (web honours `pending`). **Shared with web:** no for the label defect. The on-trust hold that loses the message is in shared lib.
- **Scenario (verifier-corrected):**
  1. v5 DM send where the `dmMessage` create comes back unconfirmed twice (a timed-out wait, or a broadcast that fails without a verdict on a flaky link), and both slot reads come back empty.
  2. `sender.ts:103-106` holds the message on trust with `local:true`, and the ticket confirms.
  3. The outbox entry gives way to the engine message, which has no outbox state. `buildTimeline` ignores `MessageDTO.pending` and shows "Sent", while the engine still reports `pending=true`. The poller never reads the message back, so `pending` never clears.
  4. Kill and relaunch: the message is gone, because held messages live only in memory and only the head pointer is persisted.

  This contradicts DM-14 ("Killing the app right after a message shows Sent loses nothing") and ENGINE §7 (`ENGINE.md:824`: the per-message sending state comes from `MessageView.pending`).
- **Verifier reasoning:** Each link holds. On a normal send `pending` clears within one own-stream poll, so honouring it costs only a brief "Sending…". S3: the trigger is rare. Honouring `pending` would not prevent the loss, but it would show the unverified state so the user knows to resend.
- **Repro hint:** Fault injection: a proxy that drops the dmMessage broadcast POST (or answers 504) twice while reads pass through. Send: "Sent" shows. `bin/qa kill`, relaunch: the message is gone. Without fault injection: check that a fresh send shows "Sent" while engine state still has `pending=true` until the next own-stream poll.

### SR-23 (S3, dm): A "Reclaim message fees" change silently reverts if the save fails and the app is killed

- **File:** `lib/services/dm-v5/engine.ts:469`. Also `:258`, `lib/services/dm-v5/self-state-store.ts:5-10,45,325-328,351-355,389-392,417,435-438`, `lib/services/dm-v5/local-cache.ts:13-17,43-52`, `mobile/engine/src/api/dm.ts:467-470`, `MessageSettingsScreen.tsx:54-63`, `app/src/engine/lifecycle.ts:10,53-60`, `engine/src/shims/lifecycle.ts:27`. **Shared with web:** yes; closing the tab after a failed save reverts the setting the same way.
- **Scenario (verifier-corrected):**
  1. DM v5 on devnet. Open Message settings, start `bin/qa network stall`, and select "After 30 days".
  2. The radio updates at once with no error: the RPC returns before `flush()` runs, so the screen's rollback never fires.
  3. The save fails, and the state stays dirty with only a 5-minute retry timer.
  4. Before a retry or background flush succeeds, run `bin/qa kill` or `bin/qa engine-kill`.
  5. Relaunch: Message settings shows "Never (keep paying for storage)". Retention is not mirrored in LocalCache, unlike blocks and read/hidden positions. No toast ever appears, and the daily sweep never runs while retention is "never".

  Lower-probability iOS variant: kill from the app switcher during the save. `inactive` triggers no flush, and the background flush is capped at 2 s anyway.
- **Verifier reasoning:** Confirmed. The self-state-store header lists retention among the explicit choices it keeps locally, so this is a gap against the module's own design. S3: a preference silently reverts and the user keeps paying storage they meant to reclaim. No credits are taken.
- **Repro hint:** as in the scenario. Diagnostics shows "DM v5 self-state save refused" or "DM v5 self-state save failed", with no later successful save before the kill.

### SR-24 (S3, engine): A failed refetch or next page drops the Home feed from the on-disk cache

- **File:** `mobile/app/src/state/query-client.ts:67`. Also `:62-70`, `@tanstack/query-core` 5.104 `hydration.ts:186` (`defaultShouldDehydrateQuery` keeps only `status === 'success'`), `query.ts:864-878`, `infiniteQueryObserver.ts:222`, `persist.ts:135-140`, `features/home/use-home-feed.ts:70`, `FeedPage.tsx:226,250`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. Open Home and let a feed page load.
  2. Make DAPI fail without TanStack treating the device as offline; it never does, because `onlineManager` is not wired. A network-conditioner stall, a blocked DAPI host or a 504 all work.
  3. Scroll until a next page fails and `feed-load-more` appears. The home query is now `status: 'error'` with its data kept.
  4. Within about 1 s, the persister rewrites `yappr-query-cache` without `feed/home`.
  5. Do not tap Load More, pull to refresh, or tap the new-posts pill: each of these restores `success`.
  6. Force-kill and relaunch, offline or still stalled: skeletons or "Connecting…" (offline, no posts at all) instead of the cached first page. That breaks FEED-11 (cache-first) and G-1.

  The same applies to any persisted query (profile, thread) whose refetch fails just before a kill.
- **Evidence:** a scratch Jest test showed 1 dehydrated query after a good page, and 0 after a failed `fetchNextPage` (status `error`, pages 1).
- **Verifier reasoning:** Confirmed. S3: nothing is lost permanently and the next successful fetch restores the cache, but the cache-first and offline launch degrade.
- **Repro hint:** as in the scenario. Afterwards, the MMKV key `yappr-query-cache` no longer contains `feed/home`.

### SR-25 (S3, engine): Blocks and deletes are kept only in memory, so blocked or deleted posts come back after a relaunch

- **File:** `mobile/app/src/features/home/use-home-feed.ts:54`. Also `:45` (`staleTime: Infinity`), `features/safety/block-state.ts:24-33,55-62,187-191`, `data/optimistic.ts:198,211-221`, `features/post/post-writes.ts:105`, `use-post-safety.ts:59,79`, `PostItem.tsx:217-221`, `data/session.ts:82-83`, `HomeScreen.tsx:119-127,183`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **Block:**
    1. Signed in, on Home For You (or Following), with @X's post on the first page. Long-press → Block @X → confirm; the post disappears.
    2. Wait for the block to confirm, or kill the app while it is pending or unconfirmed. Relaunch, online or offline.
    3. The persisted first page restores with `viewer.authorBlocked=false`, and the in-memory block decisions are gone.
    4. The cold-start trim at `use-home-feed.ts:54` runs `setQueryData` while For You is still disabled (session unknown). That clears the `isInvalidated` flag the confirmed block set (refetchType `none`), and sets `dataUpdatedAt=now`. With `staleTime: Infinity` the feed is never refetched.
    5. @X's post shows as a normal card until a manual pull-to-refresh, or, offline, until the user is online and refreshes. This breaks G-6 and SAFE-02.
  - **Delete:**
    - If the app is killed before the delete confirms (in flight or unconfirmed), the post returns as a live card.
    - If the delete confirmed, `markPostDeleted` patches the persisted copy to `deleted:true`, but PostItem hides only ids in the in-memory removed set. So the post shows in Home as a "deleted" tombstone card instead of being hidden, against the delete dialog's "hidden from feeds".
    - The claim that "a second Delete then fails" was not verified.
- **Verifier reasoning:** Confirmed; no test covers relaunch after a block. S3 (borderline S2 if QA treats "blocked content reappears until the user acts" as a G-6 safety regression). Pull-to-refresh fixes it, because the engine filters blocks on read.
- **Repro hint:** Block (or delete your own post) from Home, then `kill`, optionally after the toast or confirm. Relaunch, optionally with the network stalled, and screenshot the first screen of Home: @X's post is visible. Pull-to-refresh while online removes it.

### SR-26 (S3, engine): No 200-post cap per feed, and the whole cache is re-serialized on every cache event

- **File:** `mobile/app/src/state/query-client.ts:34`. Also `:32-35`, `:45-51` (persister, default `throttleTime` 1000 ms), `:62-70`, `features/home/use-home-feed.ts:42-46,49-55`, `features/home/feed-data.ts:50`, `use-thread.ts:59` (the only `maxPages`), `state/storage.ts:15`, `mobile/engine/src/api/feed.ts:53`. **Shared with web:** no.
- **Scenario (verifier-corrected):** Not run on a device; timings are expectations.
  1. Mid-range Android, release build. On Home For You (Recent), scroll past the 3-page auto-load pause to about 500 posts (about 25 pages).
  2. Each page fetch fires a cache `updated` event. Even the non-persisted 15 s new-posts poll does. The persister (throttle 1000 ms) dehydrates every persisted query, runs it through `codec.encode` (a full intermediate copy) and `JSON.stringify`, and does a synchronous MMKV set.
  3. Expected: JS-thread stalls while paging that grow with the blob size. The blob reaches about 0.5-1 MB or more, against FEED-11's "at most 200 posts per feed".
  4. Cold start reads and decodes the whole blob before `isRestoring` turns false. Only then does `keepFirstPage` trim the feed to page 1. Expected: a slower start to the first cached card, against the M6 budget.

  Corrections from the verifier: restored queries get the default 5-minute `gcTime`, so the blob does not accumulate across days, only within one long session. Top is capped by `MAX_RANKED=100`. Holding 500 DTOs in memory (about 1 MB) is a weak FEED-07 claim.
- **Verifier reasoning:** Spec violation plus repeated full-blob serialization. S3, or S4 if the device shows the stringify cost is negligible.
- **Repro hint:** Log the length of the `yappr-query-cache` MMKV value after 500 posts. Run a Hermes or Systrace trace while paging and look for stringify and MMKV-set spikes about once per page. Compare cold-start time to first card after a 20-post session and after a 500-post session.

### SR-27 (S3, engine): The Lockdown / outdated-WebView state is never retried on return to foreground (NET-06)

- **File:** `mobile/app/src/engine/supervisor.ts:303`. Also `:300-308`, `:499-504` (`unsupported` tears down the client), `:573-576`, `engine/lifecycle.ts:58-64`, `engine/hooks.ts:60-68`, `engine/ui.tsx:114`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. iOS with Lockdown Mode on. Hello caps report no WebAssembly, the supervisor enters `unsupported`, and `/lockdown` shows.
  2. The user taps Open Settings, excludes Yappr under Configure Web Browsing, and switches back (assuming iOS does not terminate the app).
  3. `setForeground(true)` restarts only from `failed`. From `unsupported`, `ping()` does nothing (there is no client), and `engine.lifecycle active` is rejected with ENGINE_UNAVAILABLE.
  4. The epoch does not change and the Lockdown screen stays, contradicting NET-06 ("On return to the foreground the engine retries; when it boots, the screen goes away").

  Workaround: the plain "Try again" link calls `restart()` and recovers. On a real device, first check whether iOS kills the app when the exclusion changes; if it does, a cold launch hides the bug. The Android WebView-update variant is unlikely to reproduce, because updating the WebView provider package usually kills the app process.
- **Verifier reasoning:** Confirmed; no test covers foreground-from-unsupported (`supervisor.test.ts:223`). S3 given the workaround.
- **Repro hint:** Diagnostics (dev) → "simulate no-webassembly" to reach `/lockdown`. Background, then foreground. Diagnostics shows the state still `unsupported`, the epoch unchanged, no "Back in the foreground" log line, and only a "Foreground: …" warning.

### SR-28 (S3, engine): The "Couldn't connect to Dash Platform." banner (NET-01/NET-04) is not implemented

- **File:** `mobile/app/src/features/home/FeedPage.tsx:238`. Also `NotificationsScreen.tsx:202`, `HomeHeader.tsx:19-22`, `ui/gallery/sections.tsx:405` (the only place the copy appears), `app/_layout.tsx`, `ui/OfflineBanner.tsx`, `engine/supervisor.ts:281,289,365,443,574`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. Have a cached Home feed, then drive the engine to `failed`: kill it 5 times within 2 minutes (the code uses `maxFailures=5`, NET-04 says 3), or use a build with an app/engine protocol mismatch.
  2. Expected per NET-01/NET-04 and UX_SPEC §2.18/§4.34: a 44-pt-high `error.bg` banner under the nav bar reading "Couldn't connect to Dash Platform." with "Try again".
  3. Actual: the cached list renders with no banner. The only cue is the network chip changing to "unavailable".
  4. Pull-to-refresh only shows an error toast and does not restart the engine. Like and follow show a failure toast.
  5. Recovery only through a background/foreground cycle (`setForeground` restarts a failed engine) or Diagnostics → Restart engine.

  Notifications has the same gap. In the more common `degraded` case (DAPI unreachable), there is also no banner and the chip reads as a steady ready dot, but there the supervisor retries the boot automatically with backoff.
- **Verifier reasoning:** Confirmed. The engine-down ErrorState shows only when `data === undefined`, and no global banner is mounted. S3: a workaround exists and no data is lost.
- **Repro hint:** `engine-kill` five times within 2 minutes with Home cached. Check Diagnostics `state=failed` and that no banner shows, then pull to refresh: a toast, and the state is still `failed`.

### SR-29 (S3, engine): (suspected) Hello and boot deadlines keep running while iOS suspends the app, causing a spurious restart that kills an in-flight wallet sign-in

- **File:** `mobile/app/src/engine/supervisor.ts:353`. Also `:276-282`, `:300-302`, `:420`, `:523`, `:630-637`, `mobile/engine/src/rpc/client.ts:125-127`, `mobile/engine/src/api/session.ts:333-337`, `features/auth/key-exchange.ts:163-180,286-293`, `KeyExchangeParts.tsx:181`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. iOS, cold launch with a slow, stalled network (not offline; offline fails fast to `degraded`), so the engine stays in `booting` (SDK connect or contract preload) for a long time.
  2. While Diagnostics shows `booting`, tap Sign in with wallet. `startKeyExchange` answers without the SDK, the wallet opens, and `session.awaitKeyExchange` is in flight.
  3. iOS suspends the RN JS thread and WebContent.
  4. The user approves in the wallet and returns 90 s or more after mount, and under 130 s (beyond that, the call's own 130 s host timer gives the same symptom anyway).
  5. The overdue boot-deadline timer fires on the first frame: log "Engine crashed: no ready within 90 s", epoch +1, restarts +1.
  6. `awaitKeyExchange` rejects with ENGINE_RESTARTED (session calls are never replayed), and the sign-in shows "Sign-in failed" instead of picking up the wallet's answer.

  "Try again" re-polls the persisted request and signs in.

  Corrections from the verifier:
  - The 30 s hello-timer variant only adds an extra restart; queued calls survive because `teardown()` does not run `failQueue`.
  - In-flight writes going `unknown` comes from their own 15 s wall-clock timer, not from this deadline.
  - One extra crash in the failure window is negligible.
- **Verifier reasoning:** The deadline timer has no foreground check, and RN timers on iOS use wall-clock targets. S3 (S4 is arguable): a visible error with a one-tap workaround. Missing test: no case in `supervisor.test.ts` for the boot deadline expiring while backgrounded.
- **Repro hint:** iOS device. Shape the network to stall DAPI (a high-latency or loss profile, not airplane mode). Fresh launch, start wallet sign-in while `booting`, `background` for about 100 s, return. Expect the "no ready within 90 s" log line and the sign-in error.

### SR-30 (S3, engine): Background activity breaks NET-08: DM v5 polling and the auth balance refresh keep running

See also SR-19 (the read-marking consequence).

- **File:** `mobile/app/src/engine/supervisor.ts:418`. Also `mobile/engine/src/dm/v5.ts:149-154`, `lib/services/dm-v5/engine.ts:38-39,227-233`, `lib/services/dm-v5/index.ts:37-50`, `mobile/engine/src/api/session.ts:94-110`, `vendor/platform-auth/src/core/controller.ts:39,883`, `ConversationScreen.tsx:163-164`, `engine/dm/legacy.ts:293-297`. **Shared with web:** yes (lib and platform-auth timers).
- **Scenario (verifier-corrected):** Android 12 or 13 without an effective cached-apps freezer, or a freezer-disabled build (`adb shell settings put global cached_apps_freezer disabled` plus a reboot).
  - **(1) Devnet (v5 DMs):** sign in, open a DM thread, press Home. The engine WebView keeps running `DmV5Engine.tick()` every 4 s, because the thread stays open (`open(null)` is sent only on unmount). With no thread open it polls every 30 s, and `maybeSweep` can run its daily delete writes in the background.
  - **(2) Any variant, testnet included:** the platform-auth `balanceRefresh` setInterval (300 s) keeps issuing identity balance reads, because `createMobileAuthController` leaves it on.

  These are Chromium timers; `RNCWebView.onHostPause` is a no-op and nothing calls `pauseTimers`.

  Refuted parts:
  - (a) A background engine restart after a renderer kill: the relaunch timer is an RN timer, which pauses on Android and fires only on resume.
  - (c) The 30 s legacy inbox poll in the background: RN timers pause on Android, and iOS suspends the app.

  iOS is unaffected. On Android 14+ the freezer normally stops the process about 10 s after backgrounding.
- **Verifier reasoning:** Part (b) confirmed, plus the balance-refresh addition. S3 is kept (S4 is defensible given the reach): a P0 NET-08 violation that costs battery and data, with no lost data. Fix direction: stop or pause the DmEngine on `background` and tick/reschedule on `active`; stop and restart the auth balance refresh with the lifecycle.
- **Repro hint:** Devnet APK on Android 12/13. Open a DM thread, `background`, and watch for 2 minutes using Diagnostics engine logs or DAPI traffic through a proxy. Expect DM v5 poll requests about every 4 s. On testnet, expect a balance query about every 5 minutes.

### SR-31 (S3, engine): `safety.isBlocked` failures are cached as "not blocked", so quotes of blocked authors render

See also SR-15 (same misclassification in `methods.ts`).

- **File:** `mobile/app/src/engine/methods.ts:40`. Also `:16-47`, `:58-59`, `features/safety/block-state.ts:73-87,93-98`, `engine/supervisor.ts:635-640`, `data/session.ts:27-31,147-169`, `lib/services/block-service.ts:745-746`, `state/query-client.ts:43`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **Setup:** account A blocks @X. A's persisted feed shows a post by a non-blocked author that quotes @X.
  - **The bug:** `readBlockStatus` catches every error and caches `{}` ("not blocked") as a success. The quote embed then shows @X's content instead of "Post from an account you blocked" (G-6). It stays that way until the card remounts after the 30 s `staleTime`, or until a block or unblock invalidates `blockStatusAll`; there is no focus or online refetch.
  - **Triggers:**
    1. Simplest: a cold launch offline or with DAPI failing. The engine boots `degraded`, `session.current()` still restores A and sets `viewerId`, and `safety.isBlocked` rejects.
    2. From the misclassification: after `ready`, on slow DAPI, the composite `checkBlockedBatch` takes 15-30 s. The host rejects at 15 s, where a correctly classed read would get 30 s.
    3. From the misclassification: the engine is killed mid-call, rejects with ENGINE_RESTARTED, and is not replayed.
  - **Refuted:** that `isBlocked` is sent during engine boot. `viewerId` stays null until the engine is ready or degraded and the session resolves, so boot time never counts against it.
  - **Bookmarks and DM lists:** TanStack's `retry: 1` re-queues the call to the new engine, so a visible error is unlikely.

  The shared lib explicitly warns against this pattern ("Let failures reject so neither hooks nor enrichers cache a false negative").
- **Verifier reasoning:** The misclassification is real, but the user-visible bug is caused by the fail-open catch. S3: a self-healing G-6 display lapse, not a data leak. Fix: add the missing reads to `READS`, and do not cache a failure as "not blocked".
- **Repro hint:** Block @X on web and make sure a quote of @X is in the cached Home feed. Force-quit, enable airplane mode (or `network stall`), cold launch. Expected: the stub. Suspected actual: the quoted content. For trigger 3: `engine-kill` while a feed of quotes loads, and look for "The engine restarted during safety.isBlocked" with no "Replaying safety.isBlocked" line.

### SR-32 (S3, ux/compose): Replying to or quoting a post deleted on v10 shows "Couldn't load the post · Retry" forever

- **File:** `mobile/app/src/features/compose/ComposeScreen.tsx:219`. Also `:217-218,439,516`, `mobile/engine/src/api/posts.ts:106-121,257-268`, `ComposeScreen.test.tsx:325-337`, `PostItem.tsx:314`, `pending-posts.ts:632`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. A contract with real deletes (v10 devnet). Bob deletes a post, or a moderator removes it, while Alice still has it cached in Home.
  2. Alice taps Reply on the card, or Quote, or reopens a saved reply draft for it.
  3. Compose loads the target with `posts.get`. The engine proves the document absent and resolves `null`; a failed read would reject instead.
  4. `ComposeScreen.tsx:219` reads `null` as a failed read and shows "Couldn't load the post · Retry". Retry resolves `null` again, so Post stays disabled for good.

  Expected: what ThreadScreen's ReplyBar shows for the same `null`, "This post is unavailable, so it can't be replied to." (on v10, deletion and moderator removal both look like `null`). Alternatively the COMP-03 / UX_SPEC deleted line. In either case, no Retry. `CapabilitiesDTO.deletesAreTombstones` exists, but compose does not use it.
- **Evidence:** the compose comment at `:217` has the engine contract backwards. `ComposeScreen.test.tsx:326` pins the wrong reading.
- **Verifier reasoning:** Confirmed. S3 (near S4): the post is correctly blocked, but the network-error message is wrong, and a saved reply draft can never be posted with no explanation.
- **Repro hint:** Devnet, two accounts. B posts, A sees it in Home, B deletes it. Without refreshing, A taps Reply on the cached card (or opens `yappr-dev://compose?replyTo=<id>`). Diagnostics shows `posts.get` resolving `null` with no error, and Retry changes nothing.

### SR-33 (S3, ux): iOS: toasts raised while a page-sheet modal is open are hidden behind it

- **File:** `mobile/app/src/app/_layout.tsx:148`. Also `:101-110`, `ui/ToastHost.tsx:77-93`, `features/auth/TopOverlay.tsx:9-12`, `EditProfileScreen.tsx:110-115`, `NewMessageScreen.tsx:96,107`, `NewGroupScreen.tsx:84`, `data/writes.ts:192,225,379`, `UserPicker.tsx:161,180,192`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **Cause:** on iOS, a root modal (`profile/edit`, `messages/new`, `messages/new-group`, `sign-in`, and also compose, which is transparentModal) is its own view controller above the root RN view. The single `ToastHost` lives in that root view, so the sheet covers any toast raised while the modal is open.
  - **Failures reported only by toast while the modal stays open:**
    - A failed profile save ("Failed to update profile" or the categorized engine message).
    - New message start failures.
    - New group's member cap and create failures.
  - **What the user sees:** the Save or Create spinner stops and nothing explains why.
  - **Correction:** the "You can't message yourself" toast only fires when the screen is opened with your own id as the recipient param; UserPicker already filters you out and shows an inline hint.
  - **Both platforms:** any open `@gorhom` bottom sheet draws over toasts, because its PortalHost renders after `ToastHost`.
  - **Mitigations:** VoiceOver still announces the toast, a toast may still be visible after dismissing the modal, and no data is lost.
- **Verifier reasoning:** Confirmed. The codebase already works around this for the lock and auth gates (`TopOverlay`), but not for toasts. S3.
- **Repro hint:** iOS simulator, devnet.
  1. Settings → Edit profile, change the bio, stall or refuse the network, tap Save. The spinner ends with no visible toast.
  2. New group: select 99 members, then tap another. No visible cap message.
  3. Open the new-message deep link with your own id. No visible message.
  4. Any platform: open the Unlock messages sheet and enter a bad key. The toast is hidden or dimmed under the sheet.

### SR-34 (S3, ux): G-5 insufficient-credits / YAPP copy is never shown

- **File:** `mobile/app/src/data/writes.ts:177`. Also `:176-179` (`failureText`), `mobile/engine/src/writes/classify.ts:97,137-138`, `lib/error-utils.ts:237,1067-1240` (no identity-credit-balance branch; YAPP web copy at `:1188-1195`), `features/post/post-writes.ts:36`, `pending-posts.ts:391`, `ui/WriteStatus.tsx:46-49`. **Shared with web:** yes (`categorizeError`). The fix belongs in the mobile mapping.
- **Scenario (verifier-corrected):**
  - **Credits short:**
    - P-A Dana signs in with an identity that has almost no credits and taps Like. Platform refuses with "Insufficient identity … balance … required …".
    - `categorizeError` has no credits branch, so `classify` returns UNKNOWN with outcome `refused` and `retryable:false`. `failureText` falls back to "Failed to update like. Please try again." with no Retry and no top-up guidance.
    - A post fails the same way: the toast says "Couldn't post. Please try again.", and the card shows "Couldn't post" with Retry and Edit. Retry cannot succeed until credits are topped up.
    - The finding's "Not confirmed yet" path happens only if the error reaches the app without a consensus code.
  - **YAPP short (v2 testnet):** `INSUFFICIENT_YAPP` shows lib's web copy, either "You don't have enough YAPP. Buy more…" (possibly a store-policy issue, see COMPLIANCE) or "Switch to paying in credits in Settings", a setting mobile 1.0 does not have. There is no "Open yap.pr" action.
  - **Spec:** PRD G-5 (`PRD.md:172`) and UX_SPEC §5 (`:1866-1868`) define the mobile copy ("Your identity doesn't have enough credits for this. Top it up from your Dash wallet. Nothing was posted." and "You need YAPP to do this on testnet. Get YAPP on yap.pr, then try again." plus "Open yap.pr"). None of it exists in mobile code.
- **Verifier reasoning:** Confirmed. S3: misleading advice with no route to the fix, but nothing is lost.
- **Repro hint:** Testnet build, identity with about 0 credits (and 0 YAPP for the v2 case). Tap Like, then publish a post. Diagnostics write log: "Write like.set …: failed (UNKNOWN)" or "(INSUFFICIENT_YAPP)".

### SR-35 (S3, ux): The G-1 offline rule is not implemented for engagement, profile and safety writes

- **File:** `mobile/app/src/data/writes.ts:326`. Also `:229-243,326-380,499`, `features/post/post-writes.ts:28-86`, `PostItem.tsx:241-249`, `lib/services/like-service.ts:174-221`, `mobile/engine/src/api/engage.ts:129`, `mobile/engine/src/writes/tickets.ts:276-282`, `mobile/engine/src/api/engine.ts:123`. The only NetInfo checks on writes are in the DM composer (`ConversationScreen.tsx:203-208`) and compose (`ComposeScreen.tsx:188`). **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. Any build, signed in, feed loaded while online (engine booted). Turn on airplane mode (`network offline`) and tap Like.
  2. The heart fills at once (optimistic). `likePost` hits the transport failure, catches it and returns `false`. `fromBoolean` → UNKNOWN → `unconfirmed`, not retryable (the same chain as SR-04).
  3. Like has `announceUnconfirmed:false`, so there is no toast and no undo.
  4. Result: the heart stays filled with no message, although nothing was sent. Repost, Bookmark and Follow behave the same way.
  5. Block and Unblock (default announce) keep their optimistic change and show "Not confirmed yet · Check again" instead of "You're offline. Nothing was sent."
  6. Recovery: reconnect and pull to refresh. The UI goes back to server state, showing the write never happened, and the user can tap again.

  Expected (PRD G-1, `PRD.md:168`): no optimistic change, and the toast "You're offline. Nothing was sent."
- **Verifier reasoning:** Confirmed: no layer (host, call sites, engine) checks connectivity before these writes. S3: nothing is written or charged, and a refresh restores the truth.
- **Repro hint:** `network offline`, tap Like on a post and Follow on a profile: both flip and stay. Diagnostics has no "Write refused" line; the ticket list shows the like as `unconfirmed (UNKNOWN)`. Reconnect and pull to refresh: the like was never written.

### SR-36 (S3, ux): Lockdown "Browse saved posts" has no banner, no "Fix", and no "Unavailable in Lockdown Mode" on writes

- **File:** `mobile/app/src/engine/ui.tsx:109`. Also `engine/hooks.ts:35-55`, `engine/supervisor.ts:300-308,574-576`, `data/require-auth.tsx:27-31`, `data/session.ts:150-153`, `data/writes.ts:140,371-379`, `ComposeScreen.tsx:232`, `pending-posts.ts:457-460`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. iOS with Lockdown on (`unsupported`). On the Lockdown screen, "Browse saved posts" just runs `router.back()`.
  2. There is no persistent "Lockdown Mode is on. You're browsing saved posts." banner and no "Fix" (UX_SPEC §4.33, PRD NET-06). `useUnsupportedEngineRoute` will not route back in the same episode, and `setForeground` does not retry `unsupported` (SR-27). The Lockdown screen cannot be reached again until the app is killed.
  3. Session status stays `unknown`, and `requireAuth` treats `unknown` plus `lastIdentity()` as signed in. So like, bookmark, follow, reply and compose all pass the gate.
  4. Each write is rejected at once with ENGINE_UNAVAILABLE. The optimistic change reverts and the generic per-write toast shows (for example "Failed to update like. Please try again."), not "Unavailable in Lockdown Mode".
  5. Compose still enables Post (`canPost` ignores engine state), so a post becomes a refused "Couldn't post" card, and its text goes back to the draft. Nothing is lost.
- **Verifier reasoning:** Confirmed. Neither "browsing saved posts" nor "Unavailable in Lockdown Mode" appears anywhere in `src`. S3. Workaround: turn off Lockdown for Yappr, kill and relaunch.
- **Repro hint:** iOS, previously signed in. Diagnostics → "Simulate Lockdown Mode" → "Browse saved posts". Tap Like on a cached post: a heart flicker and the generic toast. FAB → type → Post: a failed card. Background and foreground: the Lockdown screen does not come back, and there is no banner anywhere.

### SR-37 (S3, ux/compose): Compose accepts image URLs over the contract's 512-character `mediaUrl` limit

- **File:** `mobile/app/src/features/compose/ComposeScreen.tsx:230`. Also `:58` (`HOSTED_URL`), `mobile/engine/src/writes/handler-kit.ts:30-35`, `writes/publish.ts:46,52`, `lib/utils/ipfs-gateway.ts:159`, `lib/compose/publish-thread.ts:178,189,193,218-225`, `lib/media/image-digest.ts:12-16`, `contracts/yappr-social-contract-v2.json` / `-v10.json` (`post.mediaUrl`, `reply.mediaUrl` `maxLength: 512`), `pending-posts.ts:353-364,391`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. The user pastes an image URL longer than 512 characters (for example a signed CDN link) and adds text.
  2. Post is enabled: both the UI and the engine's `assertMediaUrl` check only the scheme.
  3. The post/reply document breaks `maxLength: 512` on v2 and v10, and is rejected with a non-timeout error. The ticket ends `failed`.
  4. The toast reads "Couldn't post. Please try again.", and the card shows "Couldn't post" with Retry and Edit.
  5. Retry resends the same draft and fails the same way. Nothing says the link is too long; the only recovery is Edit, then shortening or removing the URL.
- **Verifier reasoning:** Confirmed; no length guard exists anywhere. S3: the draft is kept for Edit. Repro correction: on v10, `mediaFields` first fetches the URL to fingerprint the image, so a made-up example.com URL fails with "Could not read the image…" and hides the length problem.
- **Repro hint:** On v2 (prod or /testing), paste `https://example.com/` plus about 600 "a" plus `.png`. On v10 (/devnet), use a real reachable image URL with `?x=` and about 600 characters appended. Expected: an inline error before posting. Actual: "Couldn't post", and Retry fails again. Diagnostics shows the schema (maxLength) error.

### SR-38 (S3, ux): Group names over 200 UTF-8 bytes fail with a generic toast; text fields cap in UTF-16 units

- **File:** `mobile/app/src/ui/TextField.tsx:58`. Also `:81,127-128`, `NewGroupScreen.tsx:28,76,189`, `GroupInfoScreen.tsx:40,64`, `mobile/engine/src/api/dm.ts:33,42,280-285,399-403,429`, `lib/services/dm-v5/groups.ts:43,76`, `data/writes.ts:363-380`, `features/messages/dm-writes.ts:91`, `EditProfileScreen.tsx:128-182`, `edit-profile-form.ts:60-62,81-87`. **Shared with web:** yes (web's new-group dialog has the same 100 `maxLength`; HTML `maxLength` also counts UTF-16).
- **Scenario (verifier-corrected):**
  - **Group names (S3):**
    1. New group (or Rename group): type 70 CJK characters (for example 中文测试 repeated; 210 UTF-8 bytes; anything from 67 characters up passes the UI's 100-unit cap). Add a member and tap Create.
    2. `groupNameOf` (`dm.ts:282`) throws BAD_REQUEST "A group name is 1 to 100 characters" before any ticket is created. `writes.ts` logs "Write refused: …" and shows only "Could not create the group" (or "Couldn't rename the group. Please try again.").
    3. Every retry fails the same way, and the user is never told the name is too long.
    - Fix: check the 200-byte limit in the UI, or surface the engine's BAD_REQUEST message.
    - Correction: group names have no code-point contract limit (encrypted DM state), and the engine's 100-character check also uses UTF-16, so only the byte limit is unchecked.
  - **Profile, report and block fields (S4 on their own):** RN `TextInput maxLength` and the `TextField` counter count UTF-16 units, while `validateForm` and the contract count code points. A devnet bio (140) stops at 70 non-BMP emoji, and the counter reads "140 / 140". This is an under-allowance only; nothing is refused or lost.
- **Verifier reasoning:** Raised from S4 to S3 because of the group-name path: it fails every time with no reason given, and the only workaround is guessing a shorter name. The claim that the toast is invisible on iOS belongs to SR-33.
- **Repro hint:** Devnet → New group → paste 70 CJK characters → add a member → Create: generic error toast; Diagnostics "Write refused: A group name is 1 to 100 characters". Edit profile → paste 100 "😀" into Bio: input stops at 70 and the counter reads 140/140.

### SR-39 (S4, keys): The app lock does not gate secret hydration (ENGINE §9.2)

- **File:** `mobile/app/src/engine/index.ts:33`. Also `:33-41` (`prepare()`), `engine/EngineHost.tsx:23-27`, `app/_layout.tsx:145`, `features/auth/app-lock.ts:56-61`, `AppLockOverlay.tsx:59-76`, `mobile/engine/src/api/session.ts:155`, `engine/supervisor.ts:432`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. Turn the app lock on, kill the app, relaunch, and leave the lock screen up.
  2. `EngineHost` starts the supervisor on mount. `prepare()` reads every Keychain secret of the active account and injects it into the WebView.
  3. The engine restores the session and starts background work (pending-write reconcile and resume, DM v5 polling), all before any `expo-local-authentication` check.

  This breaks ENGINE.md §9.2 / ADR E5 (`ENGINE.md:1014`: "local-authentication *before* reading secrets for hydration").
- **Verifier reasoning:** Confirmed. S4: on its own nothing is exposed. The Keychain items are `WHEN_UNLOCKED_THIS_DEVICE_ONLY` with no `requireAuthentication`, so gating hydration adds no cryptographic protection; it only orders work inside the process. The cost is lost defence in depth: any way past the overlay (SR-01) reaches an engine that is already signed in and can sign writes. If combined with a confirmed overlay bypass, file the combination under SR-01.
- **Repro hint:** Lock on, kill, relaunch, do not unlock. In Diagnostics, "Engine ready in … ms" (info level) and the session `restored` event are timestamped before the unlock. This needs info-level host logs in the build under test.

### SR-40 (S4, dm): Starting a chat with a user who has no encryption key shows "No user found with this identity ID"

- **File:** `mobile/app/src/features/messages/NewMessageScreen.tsx:43`. Also `:40-44` (`startFailedMessage`), `mobile/engine/src/dm/v5.ts:220-227`, `lib/services/dm-v5/directs.ts:18-22`, `lib/services/dm-v5/context.ts:146-150`, `profile-actions.ts:66-67`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. v5 DMs, signed in and unlocked. In New message the user picks an identity from UserPicker, or opens `/messages/new?with=<id>`. The identity exists but has no ENCRYPTION key (for example a fresh devnet identity with only auth keys), and there is no existing 1:1 with it.
  2. `requirePeerKey` throws `NoEncryptionKeyError` ("This account has no encryption key yet, so it cannot receive encrypted messages."). `v5.ts:225` maps it to BAD_REQUEST.
  3. `startFailedMessage` shows "No user found with this identity ID" for any BAD_REQUEST without "yourself", which is wrong for a user the picker just listed.

  Starting from the profile's Message button shows the correct text (`errorMessage`).
- **Verifier reasoning:** Confirmed. S4: the conversation cannot be started either way; only the stated reason is wrong.
- **Repro hint:** Devnet. Paste the id of an auth-key-only identity into New message, or tap it in search results, and read the toast.

### SR-41 (S4, dm): When every conversation is hidden, the inbox shows the first-run "Welcome to Messages" state

- **File:** `mobile/app/src/features/messages/InboxScreen.tsx:250`. Also `:176-180` (`hiddenCount`), `:236-264` (empty-state chain with no `hiddenCount` branch), `:278-288` (footer), `data/dm-data.ts:59`, `dm-actions.ts:25`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. v5, signed in and unlocked. Hide every conversation with "Delete conversation" (iOS swipe, or the long-press action sheet on either platform).
  2. `rows` becomes empty while `list.data` still holds the hidden conversations.
  3. With an empty query, `ListEmptyComponent` falls through to the first-run "Welcome to Messages / Private 1-on-1 and group conversations…" with a "New message" button. The search box shows above it and "Show N deleted conversations" below it.

  The PRD defines the welcome copy only for a genuinely empty inbox (`PRD.md:810`).
- **Verifier reasoning:** Confirmed. S4: the footer toggle brings the conversations back, and no data is lost.
- **Repro hint:** Devnet account with 1-2 DMs. Delete each one: the welcome state shows with the deleted-conversations link below it.

### SR-42 (S4, dm): Message settings: the "Blocked" section shows a skeleton forever while Messages are locked

- **File:** `mobile/app/src/features/messages/MessageSettingsScreen.tsx:181`. Also `:168-171` (retention has a locked branch), `mobile/engine/src/dm/v5.ts:155-171`, `InboxScreen.tsx:212` (the gear is hidden while locked), `SettingsScreen.tsx:133-141`, `navigation/deep-links.ts:172`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. v5 network. A signed-in user whose device has no DM encryption key (Messages locked) opens Settings → Messages, or uses a deep link to `/messages/settings`. The inbox gear is hidden while locked, so the original "Messages → Message settings" route does not work.
  2. Status has `locked=true`, `ready=false`. "Reclaim message fees" correctly says "Unlock your messages to change this setting."
  3. The "Blocked" section renders `<RowSkeleton/>` forever, with no lock message.

  Same symptom when the engine runs but its saved state never loads (`snapshot.error`): a skeleton in Blocked and a spinner in retention, both forever.
- **Verifier reasoning:** Confirmed. S4: unblocking is impossible while locked anyway (it throws NO_KEY). Fix: add a `status.data?.locked` branch with the same unlock copy.
- **Repro hint:** Devnet. Sign in with an auth key only and do not enter or derive the encryption key. Settings tab → Messages: the Blocked section shimmers indefinitely.

### SR-43 (S4, ux/compose): The compose counter and red overflow use untrimmed text, while Post and the engine trim

- **File:** `mobile/app/src/features/compose/ComposeScreen.tsx:229`. Also `:232,382,526`, `ComposePart.tsx:68,74`, `ComposeAccessoryBar.tsx:40,83-91`, `limits.ts:84-95`, `mobile/engine/src/writes/publish.ts:59`, `lib/compose/publish-thread.ts:49`, web `components/compose/compose-modal.tsx:156`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  1. Testnet / v2 limits (500 characters, no byte limit). Paste 500 "a", then press Return twice, or type two spaces before the text.
  2. The counter shows a red "502 / 500". VoiceOver/TalkBack reads "502 of 500 characters, 2 over limit". The red highlight starts at character 501; with leading spaces, it lands on the last 2 real characters.
  3. Post stays enabled, and publishes the trimmed 500-character text (`planPosts` trims) with no error.

  On dev (v10), the "N bytes over the size limit" line behaves the same way. This contradicts PRD COMP-02 ("Over either limit, Post is disabled and the overflowing text is highlighted").

  Web disables Post in this case (it checks untrimmed text). That is a separate web inconsistency; mobile's enable decision is the correct one.
- **Verifier reasoning:** Confirmed. S4: no data is lost, and the network accepts the post. Fix: run the counter, label, tone and overage on trimmed text, or offset the highlight by the leading whitespace.
- **Repro hint:** Testnet. Compose, paste 500 "a", press Return twice: red "502 / 500", "2 over limit", Post enabled and succeeds.

### SR-44 (S4, ux/a11y): The fixed-height compose header, NSFW chip and mention rows overflow at accessibility text sizes

- **File:** `mobile/app/src/features/compose/ComposeScreen.tsx:404`. Also `:95-102` (chip `h-8`, the Text at `:100` has no `maxFontSizeMultiplier`), `MentionSuggestions.tsx:16,53,65`, `ui/Text.tsx` (no global cap). **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **Setup:** iOS AX5 (or Android 200% font), signed in, compose open, a second thread part added.
  - **Header (`:404`):** a fixed `h-14` (56 pt). The Post button (`min-h-8` plus `buttonSm` text at about 3x, likely wrapping "Post all (2)") grows past 56 pt and overflows into the editor. RN overflow is visible, so it overlaps rather than clips.
  - **NSFW chip:** its label draws beyond its rounded border. UX_SPEC §6.1 requires fixed-height chips to cap the multiplier at 1.5.
  - **Mention suggestions** (type `@ali`): each row is a fixed 56 pt, the name and handle need about 130 pt, and the text overlaps the rows below.
  - **Not affected:** the signed-out header at `:154` holds only an icon.

  Rule: G-12 and UX_SPEC §6.1 (no fixed-height text containers). Every other header uses `min-h-14`.
- **Verifier reasoning:** Confirmed. S4, at the upper edge: posting still works, but the overlapping suggestion rows are hard to read at AX5.
- **Repro hint:** iOS Settings → Accessibility → Larger Text AX5 (Android: font size 200%). Open compose, add a part so the button reads "Post all (2)", type `@ali` on devnet, and screenshot the header, chip and suggestion rows.

### SR-45 (S4, ux/a11y): Write-status actions have no testID, and their hit areas overlap

- **File:** `mobile/app/src/ui/WriteStatus.tsx:124`. Also `:101` (`gap-1.5` row), `:117-125`, `ui/LinkText.tsx:31-36`, `ui/tokens.ts:193-199` (`hitSlopFor`), `pending-posts.ts:628-640` (`editPending`), `e2e/flows/compose.yaml`. **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **Hit areas:** on a failed optimistic post ("Couldn't post · Retry · Edit"), each LinkText gets 12 pt (iOS) or 14 pt (Android) of hitSlop on every side. Neighbouring actions are only about 15 pt apart, so the slop areas overlap by about 9-13 pt. The later sibling, Edit, wins the overlap. A tap from about 2-3 pt right of Retry's last glyph (about 1 pt on Android) opens compose with the text, and the failed card may be dropped. The text is kept and can be posted again.
  - **testIDs:** Check again, Retry, Edit and Retry the rest have no testID; only the `write-status` container does. PRD A11Y-08 (P0) and UX_SPEC (`:1944`) require a testID on every interactive element. Text selectors still work, which is the copy coupling A11Y-08 is meant to remove.
  - **Spacing rule:** UX_SPEC §6.4 asks for at least 8 pt between adjacent targets.
- **Verifier reasoning:** Both halves confirmed. S4: Edit is not destructive, and screen-reader users get unambiguous `accessibilityActions` on PostCard.
- **Repro hint:** Make a post fail (network stall, then a refusal). Look up Retry by id with a Maestro or `bin/qa` selector: it is not found. Tap about 3 pt right of the "y" in Retry: Edit opens.

### SR-46 (S4, release): iOS Release keeps ATS `NSAllowsLocalNetworking`, so cleartext media from `.local` hosts loads

- **File:** `mobile/app/app.config.ts:104`. Also `:98-111` (the `ios` block has no infoPlist ATS override), `plugins/release-hardening/index.js` (Android only), `scripts/release-ios.sh:52-60`, `ui/media-url.tsx:13,24`, `mobile/RELEASE.md:68`, Expo prebuild template (`NSAllowsArbitraryLoads=false`, `NSAllowsLocalNetworking=true`). **Shared with web:** no.
- **Scenario (verifier-corrected):**
  - **What happens:** Release iOS keeps `NSAllowsLocalNetworking=true` from the prebuild template; nothing removes it. A post whose `mediaUrl` or link-preview image is `http://<host>.local/x.png` or `http://<unqualified-host>/x.png` loads over cleartext on every iOS viewer's device. On Android Release, which blocks cleartext, it fails. This contradicts RELEASE.md:68 ("ATS blocks http:// loads, as on Android").
  - **Practical impact is minimal:**
    - ATS never applied to IP literals, so `http://192.168.x.x` media loads on iOS with or without this key.
    - https `.local` hosts load too.
    - The Local Network prompt comes from LAN/mDNS access in general, not from this key.
- **Verifier reasoning:** The premise is confirmed; the impact is smaller than first claimed. S4: a config/doc divergence. Fix: drop the key for Release only (dev needs it for localhost Metro), either in `release-ios.sh` and the EAS release path, or with a per-build-type `ios.infoPlist.NSAppTransportSecurity`. The infoPlist mod merges shallowly, so it replaces the whole dict. Also correct RELEASE.md, because IP-literal http stays allowed by iOS.
- **Repro hint:** Run `npm run release:ios -- simulator`, then `plutil -p <app>/Info.plist | grep -A3 NSAppTransportSecurity`, which shows `NSAllowsLocalNetworking => 1`. On a device on Wi-Fi, open a devnet post with media `http://<laptop>.local:8000/t.png` served by `python3 -m http.server`. iOS renders it and the GET shows in the server log; Android Release shows a broken image.

### SR-47 (S4, ux/compose): Compose has no hardware-keyboard shortcut to post (COMP-12, P1)

Part (b) of the UX reviewer's "spec gaps" candidate. Part (a), the unknown-link toast, is in SR-13.

- **File:** `mobile/app/src/features/compose/ComposeScreen.tsx`. There is no key handler: a grep of `mobile/app/src` and `mobile/app/modules` for `onKeyPress`, `metaKey`, `ctrlKey` or key commands returns nothing, and `onSubmitEditing` is used only in sign-in/key, UnlockSheet, GroupInfo and Search. **Shared with web:** no.
- **Scenario:** with a hardware keyboard connected (iPad or iPhone simulator, or an Android emulator with a keyboard), open compose, type text, and press ⌘↩ or Ctrl+Enter. Nothing posts and a newline is inserted. PRD COMP-12 (P1, `PRD.md:551`) says the post should be sent. RN's TextInput `onKeyPress` does not report modifiers on iOS, so this needs native key-command support that does not exist.
- **Verifier reasoning:** Confirmed as a spec gap. S4: tapping Post works.
- **Repro hint:** iPhone simulator with the hardware keyboard connected. Compose, type, press ⌘↩: a newline is inserted and nothing is posted.

## Refuted candidates

| Candidate | Why refuted |
| --- | --- |
| UI gates on network name instead of capability flags (G-10): windowed-notifications footer and mention hint (`mobile/app/src/features/notifications/NotificationsScreen.tsx`, `ComposeScreen.tsx:192`) | **Gating:** cannot happen in any shipped 1.0 build. Engine topology is fixed per variant at build time (`mobile/engine/build.mjs:32-33`): devnet reads `.env.devnet` (`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v11`), and testnet/mainnet default to v2. With v11, `notificationsAreWindowed`, `mentionsAreInline` and `hashtagsAreInline` are all true; with v2 they are all false. So `config.network === 'devnet'` always matches `notificationsWindowed`, and `hashtagsInline` always matches `mentionsInline`. The only topology where they differ is v9, which no variant builds. This is a future-maintenance concern, not a defect in this build. **The `.dash` sub-point:** `composeHints` counts `@alice @alice.dash` as two mentions, so the hint shows. But the write path (`lib/post-helpers.ts`) strips `.dash` and dedupes, so alice is correctly notified and the hint "Only the first @mention notifies the person." is still true. That is at most a redundant hint on contrived input, below the no-nits bar. |
