# Wallet integration

Only a DashPay wallet can sign a user into Yappr mobile (D1). The Yappr app
never imports a recovery phrase, WIF, or password-vault or passkey-vault key.
It holds only keys that the wallet provisions for it: per-device
AUTHENTICATION/HIGH keys bound to the contracts Yappr writes, and one
ENCRYPTION/MEDIUM key. It sends anything more privileged to the wallet.

Where this doc says "wallet", it means **DashPay for iOS**
(`org.dashfoundation.dash`, App Store 9.1.2+) or **DashPay / Dash Wallet for
Android** (`hashengineering.darkcoin.wallet`). Both run on the dashpay/platform
native SDKs, and both ship the DashConnect code (`dash-key:` / `dash-st:`) in
their store builds, enabled on testnet only (2026-09-30).

## What each side holds

| Capability | Held by | How Yappr uses it |
| --- | --- | --- |
| Recovery phrase, MASTER and CRITICAL identity keys, L1 funds | Wallet | Never leaves the wallet |
| Identity creation, username (DPNS) registration from zero, credit top-up | Wallet | Onboarding sends users to DashPay to create an identity and username |
| Adding keys to the identity (`IdentityUpdate`) | Wallet (MASTER) | Done once per device at sign-in |
| AUTHENTICATION/HIGH keys, one set per device, each bound to one contract (D6) | Yappr, in the Keychain/Keystore | Social (posts, replies, likes, follows, `yapprProfile`, blocks, reports, private feeds), DM v5, `yappr-push`, and DashPay `profile` (name, avatar, bio). DPNS registration stays in the wallet. |
| ENCRYPTION/MEDIUM key, one per identity and app, shared by the user's devices | Yappr, in the Keychain/Keystore | DM v5 (ECDH plus the `selfRoot` / group-secret HKDFs), private-feed ECIES, background DM decryption, DM-report key envelopes |
| Starter-grant claim (100 YAPP, CRITICAL) | Wallet, via `dash-st:` | Not surfaced in 1.0 (YAPP is optional on v10; see [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping)) |
| Credit transfers (TRANSFER key) | Wallet, via `dash-st:` | Proved credit tips, 1.x |
| L1 DASH payments | Wallet, via `dash:` BIP21 | Profile tips, storefront checkout (1.x) |

The mobile app does not need the web app's password vault, passkey vault or
pasted TRANSFER key. The web app keeps those paths. Identities created through
them are a devnet/testnet artefact; mobile does not migrate them (D9).

## Sign-in on one device

Both wallets register `dash-key` and `dash-st` URL schemes, and the Android
wallet has an intent filter on `MainActivity`. Yappr must **not** register
these schemes, or the OS may send the request back to Yappr.

```
Yappr                                         DashPay
─────                                         ───────
1. Generate an ephemeral secp256k1 keypair
   and save the request context (ephemeral
   private key, created time, network)
   in the Keychain/Keystore.
2. Open dash-key:<payload>?n=m&v=1[&cb=…]  ──▶ 3. Approval sheet: "Yappr wants to sign
   (UIApplication.open / ACTION_VIEW)             in as @alice" with the app, network
                                                   and permissions; the user picks an
                                                   identity if they have several.
                                              4. Derive the device's keys, add them to
                                                   the identity (bound per contract),
                                                   wait for confirmation, publish an
                                                   App Connect response.
                                    ◀──────── 5. Open cb (W3), or the user switches back.
6. On foreground or cb: poll by
   hash160(ephPub), check that the keys are
   live on $ownerId, decrypt, keep the auth
   keys and the encryption key, throw away
   the ephemeral key.
7. With the legacy contract only: if the keys
   are not registered, build dash-st and
   open the wallet a second time (step 2).
```

### Key model: per-device auth, shared encryption

Today's web protocol derives **one** `loginKey` per identity and app, and from
it one unbound auth key and one encryption key. Every device and browser
session therefore holds the same keys, which causes three problems:

- Revoking a lost phone revokes every session.
- Platform will not re-add a disabled key, so signing in again needs a new
  `keyIndex`, which means a **new encryption key**.
- DM v5 key rotation is designed but not built (DM_V5 Appendix A), so changing
  the encryption key orphans the DM v5 self-state, group secrets and
  private-feed grants.

Mobile uses (D6, proposed to the wallets as W2):

| Key | Derivation (wallet side) | Contract bound | Lifetime |
| --- | --- | --- | --- |
| Encryption key | `HKDF(loginKey(app, keyIndex=k), salt=identityId, info="encryption")`, where `k` is the keyIndex of the identity's **currently active** Yappr encryption key (0 for a first sign-in), so wallet-QR web users keep the key peers already encrypt to | None (read by peers for every Yappr contract) | Stable per identity and app. Never revoked by "disconnect device". Rotated only by an explicit "Reset messaging keys" action (1.x, Y6). |
| Auth keys | `HKDF(loginKey(app, keyIndex=n), …, info="auth:<contract>")` with a **fresh `n` for each device** (the wallet tracks `n` and the device label in its Connections list) | One key each for social, DM v5, `yappr-push` and DashPay `profile` | One set per device. Revoking one device leaves the others working. |

**Why multi-bound.** A contract-bound key can only sign for its contract: a
social-bound key writing the DashPay `profile` is refused (20014,
`lib/profile/v10-profile.ts:325`). On v10 the DashPay `profile` *is* the Yappr
base profile, and DMs live in their own contract, so one bound key is not
enough.

Grant payload: five 32-byte keys (`authKey_social ‖ authKey_dm ‖
authKey_push ‖ authKey_dashpay ‖ encKey`) plus the envelope overhead, about
188 bytes, inside App Connect's 60–572-byte, 1–17-key range. An unbound
shared encryption key next to bound auth keys departs from Platform's
"session key plus bindings" model, so it is an explicit point to agree with
the wallet teams in `APP_CONNECT_PROFILE.md`. Platform keeps disabled keys on
the identity forever, so the auth-key count grows with re-logins. With limited
keys (W7), expired auth keys take no further action. The old-key count is
shown in Settings → Security.

**When a contract id changes.** A binding names one contract id. A social or
DM re-cut, a devnet wipe, a deploy to a new network, or a 1.x feature that
writes a new contract (blog, pollr, storefront) leaves every device without a
valid key for it. The app detects the missing binding, explains why ("Yappr
moved to a new contract; approve once in DashPay"), and asks the wallet to
**add the binding** to the device's existing key set. That re-grant is part of
the App Connect profile and the W2 ask, and every coordinated contract release
plans for it.

**Encryption key selection (Y4).** `findEncryptionKey`
(`lib/crypto/encryption-key-lookup.ts:28`) still returns the *first* active
secp256k1 ENCRYPTION key and ignores contract bounds. Web and mobile share the
fix: prefer a key bound to the contract in use (DM v5 for DMs, social for
private feeds), then an unbound key, then the newest (highest key id).

### Login contract: App Connect

| | App Connect system contract `H8F9mP1B…` (chosen) | Yappr `key-exchange-v2` (fallback) |
| --- | --- | --- |
| Available on | Every network from protocol 14 (bonsia today); the same ID everywhere | Testnet (`7UaqHG…`) and bonsia (`9UgRuCx9…`); mainnet would need a deploy |
| Wallet support today | None | DashConnect on both wallets, testnet in store builds |
| Key provisioning | The wallet provisions the keys **before** it responds, so one handoff | The app builds `dash-st:` and a second handoff follows |
| Limited keys (budget/expiry, protocol 14) | Designed for it | Not modeled |
| Schema | `appEphemeralPubKeyHash`, `walletEphemeralPubKey`, `encryptedPayload` (60–572 bytes, 1–17 keys); `indexOnly` | Also has `contractId`, `keyIndex` |
| Re-login | Delete plus create; one entry per request per identity. The wallets' current replace-based re-login does not carry over. | Replace; unique `[$ownerId, contractId]` |

It cuts a handoff from every first sign-in, needs no contract deploy that
Yappr owns, and suits other Dash apps too. The cost:

- The wallets implement App Connect with the multi-bound key set (W2). Their
  re-login logic changes too, which also retires the #1137 lookup bug (W4).
- `vendor/platform-auth` gets an App Connect protocol module (Y3), which the
  web app shares.

`key-exchange-v2` keeps working for testnet interop until both wallets ship
App Connect.

### Fallback: key-exchange-v2

If W2 is late, mobile signs in through `key-exchange-v2` the way web does
today: the wallet derives one `loginKey` per identity and app, and from it one
**unbound** auth key and the encryption key. Mobile derives those two from the
response and then discards the `loginKey`. Every device and browser shares
that key set, so the per-device revoke and the bindings above do not exist on
this path. Revoking one device signs out all of them, and the lost-phone
advice in [Sign-out](#sign-out-revocation-lost-phone) applies to the whole
set. An unbound key can write the DashPay `profile` itself, so no extra
handoff is needed. Bonsia's Beta 1 runs this path unless the W8 wallet builds
already have App Connect.

### Request format and return path

| Field | Spec |
| --- | --- |
| Payload | Keep the existing `dash-key:` body: `0x01 ‖ appEphPub33 ‖ appContractId32 ‖ labelLen ‖ label`, plus `n=<m\|t\|d>` and `v=1`. The App Connect profile adds the list of contracts to bind (Phase 0, `APP_CONNECT_PROFILE.md`). |
| `cb` (new) | An optional HTTPS URL that the wallet opens after the response is published, e.g. `https://yap.pr/app/connect?r=<hash160 hex>`. |
| `cb` validation | Only accept `https` with a host on an allowlist the wallet ties to the app's contract ID. Until a manifest exists, the wallet's existing brand map (iOS `PlatformDashConnectDataSource.swift:35`) does this. Show the host on the approval sheet. |
| Handling the `cb` link | A universal link (iOS) or verified App Link (Android) for `yap.pr`. It opens Yappr. If the app is not installed, or the OS falls back to the browser, the static `/app/connect` page just says "Return to the Yappr app". Only the app holds the ephemeral key, so the page cannot finish the sign-in. |
| No `cb` | Yappr keeps the request alive for up to 10 minutes and polls whenever it returns to the foreground. The waiting screen says "Approve in DashPay, then come back here". |

The existing web flow's `dash-key:` payload does not change; it just gains a
query parameter. Wallets that ignore `cb` still work.

### Accepted risk: request hijack

Nothing proves which app created a `dash-key:` request. The DashPay iOS source
says so itself, in the `DashConnectDeepLink.swift` header. A malicious app can
put Yappr's contract ID next to its own ephemeral key, and if the user
approves, it receives Yappr's auth keys. `cb` allowlisting does not prevent
this.

Mitigations in 1.0:

- The wallet approval sheet says "Only approve if you just tapped *Continue with
  DashPay* in Yappr".
- The wallet shows the time the request was created, and rejects requests
  older than 10 minutes.
- Per-device keys (above) let the user revoke just the stolen session.
- Contract binding limits a stolen key set to Yappr's contracts and the
  DashPay profile; it cannot touch other apps or funds.
- Settings → Security lists "Devices signed in" with their last use. This is
  the wallet's Connections list, reached by a link.

For 1.x, W7 limited keys (budget plus expiry) cap the damage from a hijacked
key. OS-level attestation of the calling app is not available through a URL
handoff.

This risk is recorded in the audit scope and in the wallet teams' threat
model.

### Sign-in UX states

| State | UI | Exit |
| --- | --- | --- |
| No wallet installed (the `canOpenURL("dash-key:")` / `queryIntentActivities` check fails) | "Yappr uses DashPay for your identity", with an App Store / Play button and a "Get help" link | The user comes back after installing |
| Wallet has no identity | Detected by timeout plus a hint from the wallet, if W3 returns an error code | Deep link into DashPay's "Create username"; this costs DASH, and the screen explains it |
| Waiting for approval | Wallet icon, "Waiting for DashPay…", a Cancel button, and "Open DashPay again" | A response arrives, or the user cancels, or 10 minutes pass |
| Provisioning keys (legacy contract) | "Finishing setup in DashPay (one more step)" | The keys are live on the identity |
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
| Sign a MASTER, CRITICAL or TRANSFER transition | `dash-st:<base58 transition>?n=…&v=1` | DashConnect (testnet) | Yappr polls for the expected state change. 1.0 uses it only for the legacy two-hop login's key registration and a missing encryption key, both MASTER-signed `IdentityUpdate`s. |
| Add as DashPay contact | `dashpay://user?id=<identity>&username=<name>` | iOS parses it (`DashPayUserLink.swift`); Android unverified (W6) | None needed |
| Top up credits | None today | — | W5; fallback: "Open DashPay" plus instructions |

The **`dash-st:` nonce trap:** an unsigned transition embeds a nonce, and
anything else that uses the same nonce in the meantime makes it stale. The two
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
| Auth keys (HIGH, one per bound contract) | Keychain items, `WhenUnlockedThisDeviceOnly`, main app access group only. Each is ECIES-wrapped under SE key **A** (`WhenUnlockedThisDeviceOnly`, `.privateKeyUsage`, plus `.userPresence` when app lock is on). A LAContext reuse window equal to the app-lock timeout avoids a prompt on every like. | AES-256-GCM Keystore key (StrongBox where available). With app lock on: API 30+ uses `setUserAuthenticationParameters(timeout, BIOMETRIC_STRONG\|DEVICE_CREDENTIAL)`; API 29 uses `setUserAuthenticationValidityDurationSeconds(timeout)`. The timeout equals the app-lock timeout. |
| Encryption key (MEDIUM) | Keychain item, `AfterFirstUnlockThisDeviceOnly`, **main app access group only**, so the NSE never has it. It is wrapped under SE key **B** (`AfterFirstUnlockThisDeviceOnly`, `.privateKeyUsage`, no presence flag), so the main app's background task can use it while the device is locked. | Keystore key without an auth requirement, so WorkManager can decrypt |
| Web Push key (P-256) and auth secret | **App Group** access group, so the NSE can decrypt pings. The P-256 private key *is* an SE key (C, `AfterFirstUnlockThisDeviceOnly`); `SecKeyCopyKeyExchangeResult` does the RFC 8291 ECDH without the key leaving the SE. The 16-byte auth secret is a Keychain item in the same group. | Keystore-wrapped file read by the FCM / UnifiedPush receiver |
| Ephemeral sign-in request | Keychain, deleted on completion or after 10 minutes | Keystore-wrapped file, same lifetime |
| loginKey | **Never stored** (the web app stores it; mobile does not) | Same |
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
| A key is disabled in the wallet | Each foreground start and each background run check that the device's auth keys are still enabled (`identities.fetch`, cached for 1 hour). If they have been revoked, the app shows "Signed out by DashPay" and wipes local data. |
| Lost phone | The user revokes that device's key set in DashPay → Connections. Other devices keep working. The lost phone can still *read* DMs with the shared encryption key (if unlocked), so the revoke screen offers "Also reset messaging keys" (Y6, 1.x). Until Y6 ships, it tells the user plainly that past and future DMs are readable on that phone. The push endpoint stays until it expires (7 days), and relay pings to it show only generic text. |

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

| ID | Ask | iOS status (2026-09-30) | Android status (2026-09-30) | Needed by |
| --- | --- | --- | --- | --- |
| W1 | DashConnect enabled on mainnet in a store release | 9.1.2 ships it on testnet only; mainnet draft #1133 waits on a login contract | 11.9.1 ships `SUPPORTS_CONNECT=false` in prod | G3 |
| W2 | App Connect system contract, one-hop provisioning, the per-device multi-bound key set (social, DM v5, `yappr-push`, DashPay `profile`), delete-plus-create re-login | Not started | Not started | G3 |
| W3 | `cb=` return URL, allowlisted per app; error codes (`cancelled`, `no-identity`, `wrong-network`); request-age limit and the "only approve if you just tapped" copy | Not started | Not started | G2 |
| W4 | Re-login lookup fix (#1137 / platform #4822) | Open, no fix PR | Check | G2 (moot with W2) |
| W5 | Top-up deep link, e.g. `dashwallet://topup?identity=<id>&amount=<credits>&sender=…` | — | — | 1.1 (nice to have) |
| W6 | `dashpay://user` handling on Android | Supported | Unverified | 1.1 |
| W7 | Limited keys (protocol 14 budget/expiry) for Yappr's keys, with a "Connections" list showing last use and a revoke action | #1138 (BLE) builds limited keys | — | 1.1 |
| W8 | Devnet-capable internal/TestFlight builds that accept a custom devnet (DAPI list, quorum URL, devnet name), for Beta 1 on bonsia | Internal `DASH_DEVNET` builds exist; store builds cannot | Devnet flavor exists | G2 |
| W9 | Confirm Yappr's dHash matches DashPay's `avatarFingerprint` | Check | Check | G2 |

**Process.** Open one tracking issue per wallet repo in Phase 0, with an
interop matrix both teams run in CI (see
[QA_RELEASE.md](QA_RELEASE.md#wallet-interop)). Yappr maintains a small spec
page, `docs/mobile/APP_CONNECT_PROFILE.md`, which is a Phase 0 deliverable. It
pins the exact payload, the bound-key list, `cb`, error codes, key model and
test vectors, so the three clients stay in step.

## Testing without a human wallet

Automated E2E cannot tap through DashPay. Yappr's tests therefore use a
**test-wallet harness**: a tiny debug-only app (or a Maestro-driven mode of the
Yappr debug build) that registers `dash-key`/`dash-st` on emulators only.

- On bonsia it uses the devnet pool (`E2E_DEVNET_SEED_PHRASE`,
  `docs/TESTING.md` §1); on testnet, the e2e identity pool (`docs/TESTING.md`
  §4, derivation `m/9'/1'/5'/0'/<i>'/<k>'`).
- It publishes real App Connect and `loginKeyResponse` documents.

Real-wallet interop runs manually on every release candidate: store builds on
testnet, W8 builds on bonsia. See
[QA_RELEASE.md](QA_RELEASE.md#wallet-interop).
