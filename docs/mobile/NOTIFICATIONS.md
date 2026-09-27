# Notifications and background sync

Yappr has no server to send pushes. Notifications are **derived** on the client
from Platform documents that reference the user; see
`lib/services/notification-service.ts`. Mobile keeps that model and adds two
delivery modes:

| Mode | Default | Latency | Infrastructure | What anyone else learns |
| --- | --- | --- | --- | --- |
| **Private (polling)** | Yes | iOS: roughly 15 min to hours, set by the OS; nothing after a force-quit. Android: at least 15 min, longer in Doze or rare-use buckets. | None | Nothing beyond normal DAPI reads |
| **Instant (relay)** | Opt-in | Seconds | A stateless wake-up relay (self-hostable) plus APNs/FCM. Android can instead use UnifiedPush directly with no relay. | The relay and Apple/Google see *that* a device got a ping, and when. They never see who sent it or what it says. |

Users pick the mode during onboarding, in a pre-permission screen that states
this tradeoff, and can change it in Settings → Notifications. Both modes feed
the same local pipeline, so notifications look the same and are deduplicated.

## What we notify about

| Type | Source (unchanged from web) | Channel (Android) / category (iOS) | Default | Grouping |
| --- | --- | --- | --- | --- |
| DM | DM v5 streams / v3 `directMessage` | Messages, high importance | On | Per conversation |
| Reply | `reply.parentOwnerId` | Replies & mentions | On | Per thread |
| Mention | `postMention.mentionedUserId` | Replies & mentions | On | Per post |
| Like | `like` / `likeReply` | Likes & reposts, low importance | **Summary only** | "@a and 12 others liked your post" |
| Repost / quote | `repost.postOwnerId` | Likes & reposts | On | Per post |
| Follow | `follow.followingId` | Follows | On | Daily digest after 5 or more |
| Private-feed request | `followRequest.targetId` | Private feed | On (cannot be turned off, same as web) | — |
| Private-feed approved | `privateFeedGrant` has no index on the recipient, only `[$ownerId, recipientId]`. So for each owner with a **pending** `followRequest` from me (at most 20, oldest first), probe `[$ownerId == owner, recipientId == me]`. This is new; web declares the type but never produces it. | Private feed | On | — |
| Blog post / comment | Existing blog sources | Blogs (1.x) | Off | — |
| Account / security | Local: "Signed out by DashPay", "Key about to expire" | Account, high importance | Always on | — |

Tips have no notification. Credit tips leave no document, and tips on posts
are out of scope on iOS (see [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping)).

## Shared pipeline

```
          ┌──────────── triggers ────────────┐
 app foreground   BGAppRefresh /     push received
 (30 s timer;      WorkManager       (NSE / FCM service /
 4 s in open chat) periodic job      UnifiedPush receiver)
          └───────────────┬──────────────────┘
                          ▼
                 SyncCore.run(identity, budget)
                          │ 1. per-source queries since each source's cursor (limit 20)
                          │ 2. DM sweep: stream heads for known conversations + invite scan
                          │ 3. filter: blocked users, muted threads, prefs, quiet hours
                          │ 4. dedupe by document id against shared `seen` table
                          ▼
            local notification(s) + badge + persisted cursors
```

**`SyncCore`**
- A single implementation that the app, the background task and (in reduced
  form) the push handlers all call. See
  [ARCHITECTURE.md › Background execution](ARCHITECTURE.md#background-execution).
- Every run has a budget: 20 s on iOS background, 8 s from an FCM handler.
  Work is done in priority order (DMs, replies/mentions, then the rest). A
  source that runs out of budget keeps its cursor and resumes next run.

**Cursors**
- Each source keeps its own cursor. The web's single `lastFetchTimestamp`,
  taken as the max `$createdAt` across everything, can skip items when sources
  lag each other.
- Cursors are stored in the shared SQLite database (the App Group container on
  iOS), so the NSE and the app agree.
- A cold start or reinstall starts from 7 days back, the same as web, and
  reports only the newest 20 so a user returning after a week is not flooded.

**Dedupe**
- The notification identifier is `<type>:<documentId>`. A push, a background
  poll and a foreground poll for the same event all produce one notification.

**Read state**
- Opening the Notifications tab or a conversation marks items read, clears
  delivered notifications (`removeDeliveredNotifications` /
  `NotificationManager.cancel`) and updates the badge.
- DM read state already syncs across devices through DM v5 `dmSelfState.readAt`.
- Read state for other notifications is per device, as on web. Syncing it is a
  1.x candidate.

**Badge**
- iOS: `setBadgeCount` equals unread notifications plus unread DM
  conversations.
- Android: notification dots only, no numeric launcher badge.

## Mode 1: background polling

### iOS

**BGAppRefreshTask `pr.yap.app.refresh`**
- Rescheduled on every run and every time the app goes to the background.
- `earliestBeginDate` is 15 minutes.
- The OS decides when it actually runs, based on usage. Force-quit, Low Power
  Mode or Background App Refresh turned off will suppress it.

**BGProcessingTask `pr.yap.app.maintenance`**
- Requires a network connection, and prefers the device to be charging.
- Prunes caches, re-checks key validity, and rotates the relay token when it
  is due.
- Some work needs signing, so it runs only while the device is unlocked: the
  DM v5 self-state flush and the `pushEndpoint` refresh. It is skipped
  otherwise.

**Keychain access in the background**
- Reads (the `SyncCore` sync) use only public queries and the ENCRYPTION
  key, which is readable after first unlock. They work while the device is
  locked.
- Writes need the auth key, which is readable only while the device is
  unlocked (and within the app-lock window if app lock is on). They are
  attempted only when the device is unlocked, and otherwise deferred to the
  next foreground.

**Telling the user about delays**
- If Background App Refresh is off, or no run has happened in 24 hours, the
  Notifications tab shows an inline banner. It explains the delay and offers
  "Turn on instant notifications".

### Android

**WorkManager periodic work `sync`**
- Runs every 15 minutes with a 5-minute flex, only when there is a network
  connection.
- Uses `setExpedited` for runs triggered by a push.

**Things we will not do**
- No foreground service for syncing: dataSync is capped and Play scrutinizes
  it.
- No exact alarms.
- No request for a battery-optimization exemption; Play policy only allows it
  when FCM cannot work.

**Restricted bucket**
- After 8 days unused, the OS allows about one run a day. That matches how
  engaged the user is, and the app accepts it.

**POST_NOTIFICATIONS (Android 13+)**
- Requested in context, never at first launch. Good moments: after the first
  follow, on first DM open, or when the user picks a mode in onboarding.

## Mode 2: opt-in instant delivery

### How it works

Delivery is **triggered by the sender**, with **no watcher**: no service polls
Platform on the user's behalf.

1. The recipient's device creates a Web Push keypair (RFC 8291: a P-256 key
   plus a 16-byte auth secret) and registers with a relay, or on Android with
   a UnifiedPush distributor. It then publishes a `pushEndpoint` document on
   Platform.
2. Whenever a client makes a write that would notify someone (like, reply,
   mention, follow, repost, DM, follow request), it looks up the recipient's
   `pushEndpoint` documents. The lookup is cached for 1 hour. For each device
   it POSTs a small **RFC 8291-encrypted** payload to the endpoint. The client
   doing this can be web or mobile.
3. The relay turns the POST into an APNs or FCM message. A UnifiedPush
   endpoint receives it directly. The device decrypts it and shows the
   notification, then `SyncCore` confirms against the chain.

Using the Web Push encryption standard means the same payload works for
UnifiedPush distributors (ntfy etc.) as well as our relay. Neither ever sees
plaintext.

### `pushEndpoint` document (new, small `yappr-push` contract)

This is a new contract, so the social contract does not change.

| Field | Type | Notes |
| --- | --- | --- |
| `deviceId` | 16 bytes | Random per install; unique index `[$ownerId, deviceId]` |
| `endpoint` | string ≤ 512 | `https://relay.yap.pr/v1/p/<opaque token>`, or a UnifiedPush URL |
| `p256dh` | 65 bytes | RFC 8291 receiver public key |
| `auth` | 16 bytes | RFC 8291 auth secret |
| `types` | uint16 bitmask | Which events the user wants pinged for, so senders skip the rest |
| `expiresAt` | timestamp | At most **7 days** ahead, matching the relay token lifetime. The replace is signed with the auth key, which is readable only while the device is unlocked. So the app refreshes it on foreground once 24 h have passed, and the maintenance task retries while the device is unlocked. Senders ignore expired endpoints. If the user does not open the app for 7 days, instant mode quietly lapses to polling until the next open. |

- Each identity may have up to 5 devices; older documents are replaced.
- Mutable and deletable. Sign-out and account deletion delete the document.
- **Privacy:** anyone can see that an identity has instant notifications on,
  and which relay host it uses. Private mode publishes nothing, and the
  settings screen says so.
- **Endpoint allowlist (sender side).** A published endpoint is
  attacker-controlled input, and every sender's device POSTs to it. To avoid
  turning clients into a request-forgery or DDoS source, `ping.ts` only POSTs
  when all of these hold:
  - the URL is `https` on port 443;
  - the host is on a **built-in allowlist**: Yappr relay hosts, plus known
    UnifiedPush providers such as `ntfy.sh` and other public distributors
    verified to send CORS headers;
  - the host resolves to a public IP (checked on native; browsers already
    block private-network requests).

  Endpoints on self-hosted distributors are reachable **from mobile senders
  only**, and only after the recipient's app confirms the host through a
  `/.well-known/yappr-push` probe. Web senders skip any host that fails CORS.

### Encrypted payload

At most 3 KB after encryption.

```
CBOR map {
  v: 1, t: "reply", a: <actor identityId 32B>, k: <actor keyId u32>,
  d: <documentId 32B>, p: <optional preview ≤ 140 chars>, ts: <unix s>,
  s: <65B recoverable ECDSA sig>
}
signed digest = sha256("yappr-push-v1\0" ‖ canonical CBOR of {v,t,a,k,d,p,ts,recipient})
```

- **Signature encoding.** Yappr auth keys are `ECDSA_HASH160`
  (`lib/services/identity-update-builder.ts:190`): only the hash is on chain.
  So the signature is **recoverable**. The receiver recovers the public key,
  computes its `hash160`, and compares it with key `k` of identity `a`.
- **Domain separation.** The `yappr-push-v1` prefix keeps a push signature
  from ever being a valid state-transition signature, and the reverse.
- **Test vectors.** The encoding and test vectors live in `PUSH_PROFILE.md`,
  a Phase 0 deliverable.

For DMs, `p` is left out: the message text comes only from the chain,
decrypted with the encryption key. That way no sender-provided text is ever
shown as a DM.

**Spoofing defense**
- Anyone can POST to a public endpoint, so the receiver does not trust the
  payload as given.
- It checks the signature against the shared **known-identities cache**:
  `(identityId, keyId) → hash160`, for people you follow, DM, or have
  interacted with. The cache is refreshed by `SyncCore`.
- **Actor verified and not blocked or muted:** show "@alice replied: …".
- **Actor blocked or muted:** drop the ping. This needs the filtering
  entitlement on iOS; see below.
- **Actor unknown or signature bad:** collapse into **one** replaceable
  notification, "New activity on Yappr", with a fixed `collapse-id` and thread.
  However many unverified pings arrive, the user sees at most one. The app's
  next sync replaces it with chain-verified items or removes it.

**Relay abuse limits**
- Per token: 30 pings per minute and 300 per hour; bursts are coalesced into
  one delivery per 10 s. Per source IP: 600 per hour across all tokens.
- Bodies over 4 KB are rejected.
- A token that keeps producing undecryptable payloads is reported to the
  device, which rotates it.

**DM ping privacy**
- A DM ping links the time of a DM write to the recipient's token for anyone
  who sees both: the relay, plus the DAPI node the sender used.
- That weakens DM v5's unlinkability goal (DM_V5 §1).
- So DM pings are **off by default**. The recipient opts in with a note
  ("Instant DM alerts reveal when you receive a message to the relay").
- When on, the sender adds 0–20 s of random delay and sends no preview.

### The relay (`mobile/relay/`)

- **Almost stateless.** The token is
  `AEAD_relayKey(platform ‖ deviceToken ‖ expiry ≤ 7 days)`, so there is no
  user database. Two small pieces of state exist:
  - an in-memory rate-limit window;
  - a **revocation set** of token hashes, in a replicated KV with a TTL equal
    to the token expiry.
- **Revocation.** `POST /v1/revoke` with the token revokes it. The app calls it
  on sign-out, on account switch and on rotation. Operators use the same set
  to block abusive tokens.
- **API**
  - `POST /v1/register {platform, deviceToken} → {token, expiresAt}`, with
    App Attest / Play Integrity as a soft signal.
  - `POST /v1/p/<token>` with body `aes128gcm` (RFC 8291), returning 201,
    410 (revoked or expired: the sender drops this endpoint from its cache) or
    429.
  - `POST /v1/revoke {token}`, returning 204.
  - CORS allows any origin for `/v1/p/*` only.
  - `GET /healthz`.
- **Delivery, iOS:** an alert push with `mutable-content: 1`, alert text
  "New activity", the ciphertext in `y`, and `thread-id` / `collapse-id` from
  an opaque hash.
- **Delivery, Android:** an FCM **data** message at high priority. The app must
  always post a visible notification, or FCM downgrades the priority.
- **Holds** only the APNs `.p8` key and the FCM service account. No logs of
  tokens or IPs beyond the in-memory rate-limit window.
- **Build and deploy.** Written in Go or Rust, one binary plus a Docker image.
  Terraform goes in `mobile/relay/deploy/`. The default instance runs at
  `relay.yap.pr`, with 2 regions behind anycast or GeoDNS.
- **Self-hosting.** The docs say that a self-hosted relay can only reach
  *official* app builds if it holds *our* APNs/FCM credentials. So in practice,
  self-hosting is for forks, and for UnifiedPush users who need no relay at
  all.
- Code, SLO and runbook are covered in
  [QA_RELEASE.md › Relay](QA_RELEASE.md#relay).

### iOS Notification Service Extension

- The extension decrypts RFC 8291 with **CryptoKit**, which covers P-256 ECDH,
  HKDF and AES-GCM. It checks `sig` with a tiny secp256k1 verifier
  (libsecp256k1, verify only).
- It reads the known-identities cache and the prefs from the App Group SQLite
  database, rewrites the title, body and thread, and sets `relevanceScore`.
- **No Platform SDK in the extension** (about 24 MB memory limit, 30 s time
  limit). If the payload is not verified, the collapsed generic notification
  stays until the next foreground or BGAppRefresh sync replaces it. **The NSE
  cannot start the app, and the relay sends no follow-up silent push**, so on
  iOS there is no "push-triggered background refresh".
- **Opening the shared SQLite from the NSE** is read-only, uses WAL, and has
  no long transactions in the app. This avoids `0xdead10cc` kills when the
  app is suspended holding a lock, and has a matching QA case.
- **Filtering entitlement.** To drop pings from blocked or unknown actors, the
  app needs `com.apple.developer.usernotifications.filtering`, requested from
  Apple in Phase 0. It is a **G2 dependency**. If it has not been granted by
  G2, 1.0 ships with the collapsed generic notification. Spam is then limited
  to one replaceable "New activity" alert, not a stream.

### Android handlers

**FCM**
- `FirebaseMessagingService.onMessageReceived` decrypts and verifies the
  payload and posts the notification within the few seconds it is given.
- It then enqueues an expedited `SyncCore` run.

**UnifiedPush (FOSS flavor and de-Googled phones)**
- The `MessagingReceiver` path is the same.
- The endpoint is the distributor URL, so no Yappr relay is involved at all.
- Only the FOSS flavor bundles UnifiedPush; the Play flavor offers FCM, and
  UnifiedPush when a distributor is installed.

### Change to Yappr web (small, shared)

- Add `lib/push/ping.ts`, used by web and mobile after any successful write
  that notifies someone. It:
  - looks up the recipient's endpoints;
  - applies the endpoint allowlist;
  - builds and signs the payload (on web, the signature uses the session's
    auth key; on mobile, the native signer's `signPushPayload`, which only
    signs with the `yappr-push-v1` prefix);
  - encrypts it (RFC 8291 with `@noble/curves` p256 plus the existing HKDF and
    AES-GCM);
  - makes a fire-and-forget POST with a 3 s timeout.

  It never blocks or fails the write.
- Without this, activity from web users never pushes to mobile users. It is on
  the Y2 list in [README.md](README.md#critical-dependencies-outside-the-mobile-apps).
- **Privacy note:** the sender's IP reaches the relay. A web sender pinging
  about a DM tells the relay that *some* sender pinged token X at time t, but
  not who. The same leak applies from mobile senders.

## Preferences

Settings → Notifications:

- Mode: Private or Instant, with a plain-language explanation and a relay host
  field under Advanced.
- Per-type toggles, reusing `lib/notification-preferences.ts` keys. Toggling
  also updates `pushEndpoint.types`, so senders stop pinging.
- Quiet hours (local only; notifications are delivered silently during them).
- Show previews: Always / When unlocked / Never. Maps to iOS
  `showPreviewsSetting` and Android lock-screen `VISIBILITY_PRIVATE`.
- Per-conversation mute and per-thread mute, stored in the shared SQLite.
- A diagnostics view showing the last background run, last push, relay status
  and "Send test notification". The test sends a ping to your own endpoint.

## Notification actions

| Platform | Actions | Release |
| --- | --- | --- |
| iOS categories / Android actions | DM: **Reply** (text input), **Mark read**. Reply or mention: **Like**, **Reply**. | 1.0 |
| Signing from an action | Requires the auth key, which is only readable while the device is unlocked. Every signing action sets `UNNotificationActionOptions.authenticationRequired` (iOS) or `setAuthenticationRequired(true)` (Android 12+; on Android 10–11 the action opens the app). With app lock on, the key's biometric window applies. Mark read writes DM v5 self-state, so it is also a signing action. | 1.0 |
| Communication notifications (iOS `INSendMessageIntent`, Android `MessagingStyle` plus conversation shortcuts) | Show avatars and bubbles for DMs | 1.0 |

## Phase placement

| Phase | Delivers |
| --- | --- |
| 1 | Foreground polling, the Notifications tab, badges |
| 2 | `SyncCore` background runs, local notifications, the push contract, `lib/push/ping.ts`, relay v1, NSE, FCM/UnifiedPush, preferences, actions |
| 3 | Relay load test and penetration test, battery measurements, abuse tests |
| 1.x | Watcher-mode relay (opt-in, for users who want instant delivery for events whose senders don't ping); read-state sync; blog notifications |
