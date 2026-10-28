# Wallet integration

Only a DashPay wallet can sign a user into Yappr mobile (D1). The Yappr app
never imports a recovery phrase, WIF, or password-vault or passkey-vault key on
production builds; non-production builds also allow raw-key sessions (README D9,
D20). A wallet sign-in holds only the keys the wallet provisions through App Connect: a
CRITICAL key bound to Yappr's contract group, a HIGH key bound to the DashPay
`profile` document type, and one ENCRYPTION/MEDIUM key bound to the
`yappr-app` anchor contract. It sends anything more privileged to the wallet.
The request, the keys and how the app verifies them are defined in
[APP_CONNECT_PROFILE.md](../APP_CONNECT_PROFILE.md), and this document does not
restate them. It covers what is specific to the mobile apps.

Where this doc says "wallet", it means **DashPay for iOS**
(`org.dashfoundation.dash`) or **DashPay / Dash Wallet for Android**
(`hashengineering.darkcoin.wallet`). Both run on the dashpay/platform native
SDKs. Which wallet builds speak App Connect, and over which carrier, is
recorded in the status box of the profile; this document does not repeat it.

## What each side holds

| Capability | Held by | How Yappr uses it |
| --- | --- | --- |
| Recovery phrase, the identity's own unbound MASTER and CRITICAL keys, L1 funds | Wallet | Never leave the wallet (Yappr holds a CRITICAL *group session* key, which is a different key) |
| Identity creation, username (DPNS) registration from zero, credit top-up | Wallet | Onboarding sends users to DashPay to create an identity and username |
| Adding keys to the identity (`IdentityUpdate`) | Wallet (MASTER) | Done at each sign-in, in one update |
| Contract-group key (CRITICAL, 0.5 DASH, 90 days) | Yappr, in the Keychain/Keystore | Signs everything Yappr writes to the contracts in its group: social (posts, replies, likes, follows, `yapprProfile`, blocks, reports, private feeds), DM v5 and the other members. DPNS registration stays in the wallet. |
| DashPay `profile` key (HIGH, about 60¢, 90 days) | Yappr, in the Keychain/Keystore | DashPay `profile` (name, avatar, bio), which a group key cannot sign for |
| ENCRYPTION/MEDIUM key, one per identity and app, bound to the anchor and shared by the user's devices | Yappr, in the Keychain/Keystore | DM v5 (ECDH plus the `selfRoot` / group-secret HKDFs), private-feed ECIES, background DM decryption, DM-report key envelopes |
| Starter-grant claim (100 YAPP, a token batch, CRITICAL) | Yappr, with the CRITICAL group key | Not surfaced in 1.0 (YAPP is optional on v10; see [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping)) |
| Credit transfers (TRANSFER key) | Wallet, via `dash-st:` (planned: `dashpay://sign`) | Proved credit tips, 1.x |
| L1 DASH payments | Wallet, via `dash:` BIP21 | Profile tips, storefront checkout (1.x) |

The mobile app does not need the web app's password vault, passkey vault or
pasted TRANSFER key. The web app keeps those paths. Identities created through
them are a devnet/testnet artefact; mobile does not migrate them (D9).

## Sign-in on one device

Both wallets register `dash-key` and `dash-st` URL schemes, and the Android
wallet has an intent filter on `MainActivity`. Yappr must **not** register
these schemes, or the OS may send the request back to Yappr. The planned
`dashpay://connect` and `dashpay://sign` carriers are the same: the `dashpay`
scheme belongs to the wallet.

The request is App Connect request v2
([profile](../APP_CONNECT_PROFILE.md#request)). It travels today as a
`dash-key:` link; `dashpay://connect` is planned and no wallet handles it yet.

```
Yappr                                         DashPay
─────                                         ───────
1. Generate an ephemeral secp256k1 keypair
   and save the request context (ephemeral
   private key, created time, network,
   connection id) in the Keychain/Keystore.
2. Open dash-key:<body>?n=t&v=2&cb=…        ──▶ 3. Approval sheet: "Yappr wants to sign
   (UIApplication.open / ACTION_VIEW)             in as @alice" with the app id, network
                                                   and permissions; the user picks an
                                                   identity if they have several.
                                              4. Derive the keys, register them in one
                                                   IdentityUpdate (which also disables the
                                                   earlier grant of this connection), wait
                                                   for confirmation, publish the response.
                                    ◀──────── 5. Open cb, or the user switches back.
6. On foreground or cb: poll by
   hash160(ephPub), verify every key on
   chain, decrypt, keep the key ring, throw
   away the ephemeral key.
```

There is no second hand-off: the wallet registers the keys before it
responds. A build picks its sign-in by `NEXT_PUBLIC_LOGIN_PROTOCOL`: the engine
reports `capabilities.walletSignIn` as `'app-connect'` or `'legacy'`
([engine README](../../mobile/engine/README.md)). The legacy path is the v1 key
exchange, described at the end of this section.

### Keys and re-login

A sign-in yields the three keys above (profile rules 3 to 7). Two things matter
on a phone:

- **Auth keys are new at every login.** A login with the same `CONNECTION_ID`
  (one per app install and network, kept across sign-outs) disables the
  previous grant's auth keys in the same update, so a re-login replaces this
  device's keys and leaves other devices' keys alone. Platform keeps disabled
  keys on the identity forever, so the old-key count grows with re-logins.
  Expired and spent keys take no further action. The app can list the keys the
  user's wallets granted it (`appConnectConnections()`), and the user revokes
  them in the wallet.
- **The encryption key is the same on every device and every login.** Peers
  encrypt to it, so DM and private-feed history stays readable
  ([profile rule 7](../APP_CONNECT_PROFILE.md#wallet-rules)). The profile
  defines no rotation; replacing the key is not defined. DM v5 key rotation
  (Y6) depends on such a mechanism, which does not exist yet.

When a contract id changes (a social or DM re-cut, a new feature contract), the
new contract joins the existing group ([APP_CONNECT_CONTRACTS.md](../APP_CONNECT_CONTRACTS.md))
and the group key covers it, with no new grant. The app pins each member as
`id:version` and blocks new logins on an unexpected group.

On App Connect builds the encryption key is the one bound to the anchor
(`lib/crypto/encryption-key-lookup.ts`, via `identities.contractKeys`), and the
first-active-key fallback applies to legacy builds only.

### Return path

| Field | Spec |
| --- | --- |
| `cb` | `https://yap.pr[/prefix]/connect/?r=<hash160 hex>&app=<scheme>`. The wallet appends `ac=<status>` after the user's decision (profile, [Callback](../APP_CONNECT_PROFILE.md#callback)). |
| Handling the `cb` link | The wallet opens the https link. The `/connect/` page reads `app=<scheme>` and hands the user straight back to the app with `<scheme>://connect?r=…&ac=…`. Universal links (iOS) and verified App Links (Android) for `yap.pr` are optional on top of that and need the owner's signing identifiers ([RELEASE.md](../../mobile/RELEASE.md)). If the page is reached without `app=`, it cannot finish the sign-in: only the app holds the ephemeral key. |
| No `cb` | Yappr keeps the request alive for up to 10 minutes and polls whenever it returns to the foreground. The waiting screen says "Approve in DashPay, then come back here". |

### Accepted risk: request hijack

Nothing proves which app created a request. A malicious app can put Yappr's
contract id next to its own ephemeral key, and if the user approves, it
receives keys bound to Yappr's group and the DashPay `profile`. This follows
from the model: an app is its contract id, and the wallet shows the id and
every scope instead of claiming to know who the app is
([App identity](../APP_CONNECT_PROFILE.md#app-identity)). The `cb` host is
shown, not trusted.

Mitigations:

- The wallet approval sheet says "Only approve if you just started signing in
  on yap.pr".
- The wallet shows the time the request was created, and rejects requests
  older than 10 minutes.
- Every key carries a budget and an expiry that Platform enforces (profile
  rule 5), so a stolen key stops on its own.
- Contract binding limits a stolen key to Yappr's group and the DashPay
  profile; it cannot touch other apps' contracts.
- The user can disable a connection's keys in the wallet's Connections list.

OS-level attestation of the calling app is not available through a URL
handoff.

This risk is recorded in the audit scope and in the wallet teams' threat
model.

### Legacy: the v1 key exchange

Builds without `NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect` sign in through the v1
key exchange, as the production web root still does. The wallet derives one
`loginKey` per identity and app and, from it, one unbound auth key and the
encryption key; the app derives the same two from the response and discards the
`loginKey`. A first login can need a second hand-off, a `dash-st:`
IdentityUpdate that registers the keys. Every device and browser shares that
key set, so revoking one device signs out all of them. v1 and `dash-st:` are
legacy and go before mainnet. The release set does not register the key
exchange contract (D9, D10).

### Sign-in UX states

| State | UI | Exit |
| --- | --- | --- |
| No wallet installed (the `canOpenURL("dash-key:")` / `queryIntentActivities` check fails) | "Yappr uses DashPay for your identity", with an App Store / Play button and a "Get help" link | The user comes back after installing |
| Wallet has no identity | Detected by timeout, because the `ac` statuses have no "no identity" code | Deep link into DashPay's "Create username"; this costs DASH, and the screen explains it |
| Waiting for approval | Wallet icon, "Waiting for DashPay…", a Cancel button, and "Open DashPay again" | A response arrives, or the user cancels, or 10 minutes pass |
| Provisioning keys (legacy builds only) | "Finishing setup in DashPay (one more step)" | The keys are live on the identity |
| Signed in | Home. There is no profile step (D15): the user shows by DashPay `displayName`, else the DPNS label, else `User <last6>`. | — |
| Signed in, no DPNS name | An optional "Claim @name in DashPay" card on Home and the profile | — |

On the wallet's side, only one identity is used per sign-in. The app supports
**multiple signed-in identities** through an account switcher. Each identity's
keys are stored under that identity's ID.

## Other wallet handoffs

| Action | URI | Available today | Return |
| --- | --- | --- | --- |
| Tip a profile in DASH | `dash:<address>?amount=<x>&label=Tip%20for%20@bob` (from `yapprProfile.paymentUris`) | Yes, both wallets, mainnet | No callback. Yappr shows "Tip sent?" and checks the address via Insight, as the checkout does (`lib/services/insight-api-service.ts`). |
| Pay with txid callback (Android) | `dashwallet://?pay=<addr>&amount=<x>&sender=yappr` | Android returns the txid; iOS turns it into a `dash:` payment with no callback | Use it where supported |
| Sign a MASTER, CRITICAL or TRANSFER transition | `dash-st:<base58 transition>?n=…&v=1` today; `dashpay://sign` planned ([profile](../APP_CONNECT_PROFILE.md#dashpaysign)) | DashConnect (testnet) | Yappr polls for the expected state change. On App Connect builds mobile uses `dash-st:` only for a missing encryption key in a raw-key session (D38), a MASTER-signed `IdentityUpdate`. Legacy builds also use it for first-login key registration. |
| Add as DashPay contact | `dashpay://user?id=<identity>&username=<name>` | iOS parses it (`DashPayUserLink.swift`); Android unverified (W6) | None needed |
| Top up credits | None today | — | W5; fallback: "Open DashPay" plus instructions |

The **`dash-st:` nonce trap:** an unsigned transition embeds a nonce, and
anything else that uses the same nonce in the meantime makes it stale. The
1.0 uses are `IdentityUpdate`s, which take the **identity** nonce; Yappr's own
document writes use per-contract nonces and cannot collide with them, but
another app or the wallet itself can. So Yappr:

1. Builds the transition right before the handoff.
2. On return, checks the result. If it is stale, it rebuilds and asks again
   rather than failing silently.

Token or credit-transfer handoffs (1.x) take a contract or identity nonce that
Yappr's own writes can touch; those pause Yappr's write queue while
outstanding.

## Key custody on the device

| Item | iOS | Android |
| --- | --- | --- |
| Auth keys (the group key and the DashPay `profile` key) | Keychain items, `WhenUnlockedThisDeviceOnly`, main app access group only. Each is ECIES-wrapped under SE key **A** (`WhenUnlockedThisDeviceOnly`, `.privateKeyUsage`, plus `.userPresence` when app lock is on). A LAContext reuse window equal to the app-lock timeout avoids a prompt on every like. | AES-256-GCM Keystore key (StrongBox where available). With app lock on: API 30+ uses `setUserAuthenticationParameters(timeout, BIOMETRIC_STRONG\|DEVICE_CREDENTIAL)`; API 29 uses `setUserAuthenticationValidityDurationSeconds(timeout)`. The timeout equals the app-lock timeout. |
| Encryption key (MEDIUM) | Keychain item, `AfterFirstUnlockThisDeviceOnly`, **main app access group only**, so the NSE never has it. It is wrapped under SE key **B** (`AfterFirstUnlockThisDeviceOnly`, `.privateKeyUsage`, no presence flag), so the main app's background task can use it while the device is locked. | Keystore key without an auth requirement, so WorkManager can decrypt |
| Web Push key (P-256) and auth secret | **App Group** access group, so the NSE can decrypt pings. The P-256 private key *is* an SE key (C, `AfterFirstUnlockThisDeviceOnly`); `SecKeyCopyKeyExchangeResult` does the RFC 8291 ECDH without the key leaving the SE. The 16-byte auth secret is a Keychain item in the same group. | Keystore-wrapped file read by the FCM / UnifiedPush receiver |
| Ephemeral sign-in request | Keychain, deleted on completion or after 10 minutes | Keystore-wrapped file, same lifetime |
| `loginKey` | Legacy builds only: derived from the wallet's response and **never stored**. App Connect builds have none: the wallet returns the private keys. | Same |
| Backup and transfer | Excluded (`ThisDeviceOnly`; files marked `isExcludedFromBackup`) | `dataExtractionRules` exclude them from cloud backup and device transfer |

Note what the SE wrap buys, and what it doesn't:

- It keeps key bytes out of the Keychain database at rest, and binds them to
  this device.
- It gives no protection against code that already holds the same Keychain
  entitlement. That is why the encryption key stays out of the App Group.

Unwrapping and every operation that uses a private key happen in native code.
Neither JS nor the NSE ever holds an auth or encryption private key. See
[ARCHITECTURE.md › Signer](ARCHITECTURE.md#signer-and-key-store).

A new device means signing in again through the wallet. It gets its own auth
keys and the same encryption key, so DM and private-feed history rebuilds from
chain data (DM v5 §1.5, private feed spec §8) without migrating anything.

### Sign-out, revocation, lost phone

| Situation | What happens |
| --- | --- |
| Sign out | The app wipes its keys, caches, the push endpoint document (a best-effort delete) and relay registration. The keys stay on the identity; the app tells the user they can revoke them in DashPay → Connections. |
| A key is disabled in the wallet | Each foreground start and each background run check that the device's auth keys are still enabled (`identities.fetch`, cached for 1 hour). If they have been revoked or superseded, the app shows "Signed out by DashPay" and wipes local data. |
| Lost phone | The user revokes that device's connection in DashPay → Connections. Other devices keep working. The lost phone can still *read* DMs with the shared encryption key (if unlocked). The profile defines no way to replace that key, so until one exists (Y6, 1.x) the app tells the user plainly that past and future DMs are readable on that phone. The push endpoint stays until it expires (7 days), and relay pings to it show only generic text. |

## DashPay social integration

- **The DashPay profile is the Yappr profile (v10).** Yappr reads and writes
  the DashPay `profile` (`displayName` ≤ 25, `publicMessage` ≤ 140, avatar
  with `avatarHash` / `avatarFingerprint`) with the DashPay-bound key. Banner,
  links, payment URIs and the other Yappr-only fields live in `yapprProfile`,
  which requires the DashPay profile to exist (40120). The edit screen says
  "This also updates your DashPay profile".
- **Contact suggestions.** Keep the existing `dashpay-contacts-service` logic:
  a DashPay contact becomes mutual when there is a `contactRequest` in each
  direction; show those people as follow suggestions during onboarding and in
  Explore.
- **Profile badge.** Show "DashPay contact" on profiles when the two people are
  mutual contacts.
- **Profile action.** Offer "Pay in DashPay" (the `dashpay://user` link) as
  well as a tip.
- **Invites (1.1).** "Invite a friend" sends users to DashPay's invitation
  flow.
- **Not in scope:** decrypting contact requests (DIP-15 `encryptedPublicKey`)
  or deriving payment addresses. Yappr does not hold the keys for either.

## What we need from the wallets

Tracked as external dependencies in [README.md](README.md#critical-dependencies-outside-the-mobile-apps).
The asks below date from the 2026-09-30 plan. W2, W3 and W7 are now part of App
Connect request v2 (the profile), and W4 applies to the legacy key exchange
only. Per-wallet status is not repeated here; the profile's status box has the
current builds.

| ID | Ask | Needed by |
| --- | --- | --- |
| W1 | App Connect enabled on mainnet in a store release (the `dash-key:` / `dash-st:` carriers must be gone first; the profile has the migration) | G3 |
| W2 | App Connect request v2 as the profile defines it: contract-group, DashPay `profile` and encryption keys in one hop, delete-plus-create re-login | G3 |
| W3 | `cb` return URL and the `ac` statuses; request-age limit and the "only approve if you just started signing in" copy (in the profile) | G2 |
| W4 | Re-login lookup fix (#1137 / platform #4822), legacy key exchange only | G2 (moot with W2) |
| W5 | Top-up deep link, e.g. `dashwallet://topup?identity=<id>&amount=<credits>&sender=…` | 1.1 (nice to have) |
| W6 | `dashpay://user` handling on Android | 1.1 |
| W7 | Limited keys (budget and expiry): in request v2; plus a "Connections" list showing last use and a revoke action | 1.1 |
| W8 | Devnet-capable internal/TestFlight builds that accept a custom devnet (DAPI list, quorum URL, devnet name) | G2 |
| W9 | Confirm Yappr's dHash matches DashPay's `avatarFingerprint` | G2 |

**Process.** Open one tracking issue per wallet repo in Phase 0, with an
interop matrix both teams run in CI (see
[QA_RELEASE.md](QA_RELEASE.md#wallet-interop)). The spec the three clients
share is [APP_CONNECT_PROFILE.md](../APP_CONNECT_PROFILE.md): it pins the
request body, the key set, `cb`, the `ac` statuses, the key derivation and the
test vectors.

## Testing without a human wallet

Automated E2E cannot tap through DashPay. Yappr's tests therefore use a
**test-wallet responder**: the Node tool `mobile/tools/test-wallet-responder.mjs`
(ADR E5.4). It answers App Connect request v2 the way a wallet does, and the
v1 key exchange for legacy builds, and publishes real `loginKeyResponse`
documents. It is run against the sakura identity pool
(`YAPPR_SAKURA_IDENTITIES`). `mobile/tools/README.md` is its manual, and the
best description of wallet behaviour in this repo.

Real-wallet interop runs manually on every release candidate: store builds on
testnet, W8 builds on the devnet. See
[QA_RELEASE.md](QA_RELEASE.md#wallet-interop).
