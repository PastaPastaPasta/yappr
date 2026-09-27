# Wallet integration

Only a DashPay wallet can sign a user into Yappr mobile. The Yappr app never
imports a recovery phrase, WIF, or password-vault or passkey-vault key. It
holds only two keys that the wallet provisions for it: an AUTHENTICATION/HIGH
key and an ENCRYPTION/MEDIUM key. It sends anything more privileged to the
wallet.

Where this doc says "wallet", it means **DashPay for iOS**
(`org.dashfoundation.dash`, App Store 9.1.1+) or **DashPay / Dash Wallet for
Android** (`hashengineering.darkcoin.wallet`). Both now run on the dashpay/platform
native SDKs, and both already ship the DashConnect code (`dash-key:` /
`dash-st:`), though only enabled on testnet.

## What each side holds

| Capability | Held by | How Yappr uses it |
| --- | --- | --- |
| Recovery phrase, MASTER and CRITICAL identity keys, L1 funds | Wallet | Never leaves the wallet |
| Identity creation, username (DPNS) registration from zero, credit top-up | Wallet | Onboarding sends users to DashPay to create an identity and username |
| Adding keys to the identity (`IdentityUpdate`) | Wallet (MASTER) | Done once per device at sign-in |
| AUTHENTICATION/HIGH key, one per device (signs every document write) | Yappr, in the Keychain/Keystore | Posts, replies, likes, follows, profile, DMs, private feeds, blocks, reports, DPNS registration |
| ENCRYPTION/MEDIUM key, one per identity and app, shared by the user's devices | Yappr, in the Keychain/Keystore | DM v5 (ECDH plus the `selfRoot` / group-secret HKDFs), private-feed ECIES, background DM decryption |
| Token transitions (buy YAPP, YAPP transfer/tip, starter grant) needing CRITICAL | Wallet, via `dash-st:` | Android and later only (see [COMPLIANCE.md](COMPLIANCE.md#crypto-fees-and-tipping)) |
| L1 DASH payments | Wallet, via `dash:` BIP21 | Profile tips, storefront checkout (1.x) |

The mobile app does not need the web app's password vault, passkey vault or
pasted TRANSFER key. The web app keeps those paths.

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
                                              4. Derive loginKey, provision the keys
                                                   (App Connect: in the same step),
                                                   wait for confirmation, publish a
                                                   loginKeyResponse.
                                    ◀──────── 5. Open cb (W3), or the user switches back.
6. On foreground or cb: poll by
   hash160(ephPub), check that the keys are
   live on $ownerId, decrypt, derive
   authKey and encKey, keep them, throw
   away the loginKey and the ephemeral key.
7. With the legacy contract only: if the keys
   are not registered, build dash-st and
   open the wallet a second time (step 2).
```

### Key model: per-device auth, shared encryption

Today's web protocol derives **one** `loginKey` per identity and app, and from
it one auth key and one encryption key. Every device and browser session
therefore holds the same keys, which causes three problems:

- Revoking a lost phone revokes every session.
- Platform will not re-add a disabled key, so signing in again needs a new
  `keyIndex`, which means a **new encryption key**.
- DM v5 key rotation is designed but not built (DM_V5 Appendix A), so changing
  the encryption key orphans the DM v5 self-state, group secrets and
  private-feed grants.

Mobile uses (and proposes to the wallets as part of W2):

| Key | Derivation (wallet side) | Lifetime |
| --- | --- | --- |
| Encryption key | `HKDF(loginKey(app, keyIndex=0), salt=identityId, info="encryption")`, unchanged from today, so web QR users keep the same key | Stable per identity and app. Never revoked by "disconnect device". Rotated only by an explicit "Reset messaging keys" action (1.x, Y6). |
| Auth key | `HKDF(loginKey(app, keyIndex=n), …, info="auth")` with a **fresh `n` for each device** (the wallet tracks `n`, and the device label, in its Connections list) | One per device. Revoking one device leaves the others working. |

Grant payload: `authKey_n ‖ encKey` (2 × 32 bytes; this fits App Connect's
60–572-byte range). Platform keeps disabled keys on the identity forever, so
the per-device auth-key count grows with re-logins. With limited keys (W7),
expired auth keys take no further action. The old-key count is shown in
Settings → Security.

### Existing web users

Some web users signed in with a passkey, a password vault or a pasted key, and
have an **"external"** ENCRYPTION key that was not wallet-derived
(`vendor/platform-auth/src/core/controller.ts:775-798`). The mobile app will
not import that key, because the wallet is the only way to sign in. Also,
`findEncryptionKey` (`lib/crypto/encryption-key-lookup.ts:28`) returns the
*first* active secp256k1 ENCRYPTION key and ignores contract bounds, so peers
may keep encrypting to the old key.

Required (Y4, a shared `lib/` fix):

1. **Selection rule.** Skip keys bound to another contract. Among the rest,
   prefer keys bound to Yappr's contract; otherwise pick the newest (highest
   key id).
2. **Migration.** When mobile provisions the wallet-derived key, identities
   that also have an external key get a one-time "Move messaging to your
   DashPay key" step:
   - The owner's private feed is re-keyed. `privateFeedRekey` exists for this,
     and the `encryptedSeed` is re-wrapped.
   - DM v5 self-state is re-created under the new key.
   - Old DMs stay readable on web, where the old key still lives, and show
     "Earlier messages are on the web" on mobile.
   - Wallet-QR web users are not affected, because their encryption key is
     already the wallet-derived one.
3. **QA** covers all three source cohorts: wallet-QR, passkey and pasted key.

### Login contract: App Connect vs Yappr key-exchange

| | App Connect system contract `H8F9mP1B…` | Yappr `key-exchange-v2` (`7UaqHG…`) |
| --- | --- | --- |
| Available on | Every network from protocol v14; the same ID everywhere | Testnet only; mainnet would need a deploy |
| Wallet support today | None | DashConnect on both wallets, testnet only |
| Key provisioning | The wallet provisions the keys **before** it responds, so one handoff | The app builds `dash-st:` and a second handoff follows |
| Limited keys (budget/expiry, protocol v14) | Designed for it | Not modeled |
| Schema | `appEphemeralPubKeyHash`, `walletEphemeralPubKey`, `encryptedPayload` (60–572 bytes, 1–17 keys) | Also has `contractId`, `keyIndex` |
| Re-login | Index-only delete plus create; one entry per request per identity | Replace; unique `[$ownerId, contractId]` |

**Recommendation: App Connect.** It cuts a handoff from every first sign-in,
needs no contract deploy that Yappr owns, and suits other Dash apps too. The
cost:

- The wallets have to change their document shape (W2).
- `vendor/platform-auth` gets an App Connect protocol module (Y3), which the
  web app shares.

Keep `key-exchange-v2` working for testnet betas until both wallets ship App
Connect.

### Request format and return path

| Field | Spec |
| --- | --- |
| Payload | Keep the existing `dash-key:` body: `0x01 ‖ appEphPub33 ‖ appContractId32 ‖ labelLen ‖ label`, plus `n=<m\|t\|d>` and `v=1`. |
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
approves, it receives a HIGH auth key for Yappr. `cb` allowlisting does not
prevent this.

Mitigations in 1.0:

- The wallet approval sheet says "Only approve if you just tapped *Continue with
  DashPay* in Yappr".
- The wallet shows the time the request was created, and rejects requests
  older than 10 minutes.
- Per-device keys (above) let the user revoke just the stolen session.
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
| Signed in, no Yappr profile | Profile creation, same fields as web | Home |
| Signed in, no DPNS name | Profile creation, then an optional "Claim @name" step | Home |

On the wallet's side, only one identity is used per sign-in. The app supports
**multiple signed-in identities** through an account switcher. Each identity's
keys are stored under that identity's ID.

## Other wallet handoffs

| Action | URI | Available today | Return |
| --- | --- | --- | --- |
| Tip a profile in DASH | `dash:<address>?amount=<x>&label=Tip%20for%20@bob` (from profile `paymentUris`) | Yes, both wallets, mainnet | No callback. Yappr shows "Tip sent?" and checks the address via Insight, as the checkout does (`lib/services/insight-api-service.ts`). |
| Pay with txid callback (Android) | `dashwallet://?pay=<addr>&amount=<x>&sender=yappr` | Android returns the txid; iOS turns it into a `dash:` payment with no callback | Use it where supported |
| Sign a token or CRITICAL transition | `dash-st:<base58 transition>?n=…&v=1` | DashConnect (testnet); iOS #1109 authorizes token purchases | Yappr polls for the expected state change |
| Add as DashPay contact | `dashpay://user?id=<identity>&username=<name>` | iOS parses it (`DashPayUserLink.swift`); Android unverified (W6) | None needed |
| Top up credits | None today | — | W5; fallback: "Open DashPay" plus instructions |

The **`dash-st:` nonce trap:** an unsigned transition embeds the identity
contract nonce. Any other write from Yappr in the meantime makes it stale. This
matters in 1.0 only for provisioning a missing encryption key (a
MASTER-signed `IdentityUpdate`, which uses the identity nonce) and for the
legacy two-hop login. Token transitions (the contract nonce) arrive in 1.1. To
avoid staleness, while a `dash-st:` handoff is outstanding, Yappr:

1. Pauses its own write queue.
2. Builds the transition right before the handoff.
3. On return, checks the result. If it is stale, it rebuilds and asks again
   rather than failing silently.

## Key custody on the device

| Item | iOS | Android |
| --- | --- | --- |
| Auth key (HIGH) | Keychain item, `WhenUnlockedThisDeviceOnly`, main app access group only. It is ECIES-wrapped under SE key **A** (`WhenUnlockedThisDeviceOnly`, `.privateKeyUsage`, plus `.userPresence` when app lock is on). A LAContext reuse window equal to the app-lock timeout avoids a prompt on every like. | AES-256-GCM Keystore key (StrongBox where available). With app lock on: API 30+ uses `setUserAuthenticationParameters(timeout, BIOMETRIC_STRONG\|DEVICE_CREDENTIAL)`; API 29 uses `setUserAuthenticationValidityDurationSeconds(timeout)`. The timeout equals the app-lock timeout. |
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
Neither JS nor the NSE ever holds the auth or encryption private key. See
[ARCHITECTURE.md › Signer](ARCHITECTURE.md#signer-and-key-store).

A new device means signing in again through the wallet. It gets its own auth
key and the same encryption key, so DM and private-feed history rebuilds from
chain data (DM v5 §1.5, private feed spec §8) without migrating anything.

### Sign-out, revocation, lost phone

| Situation | What happens |
| --- | --- |
| Sign out | The app wipes its keys, caches, the push endpoint document (a best-effort delete) and relay registration. The keys stay on the identity; the app tells the user they can revoke it in DashPay → Connections. |
| The key is disabled in the wallet | Each foreground start and each background run check that the auth key is still enabled (`identities.fetch`, cached for 1 hour). If it has been revoked, the app shows "Signed out by DashPay" and wipes local data. |
| Lost phone | The user revokes that device's auth key in DashPay → Connections. Other devices keep working. The lost phone can still *read* DMs with the shared encryption key (if unlocked), so the revoke screen offers "Also reset messaging keys" (Y6, 1.x). Until Y6 ships, it tells the user plainly that past and future DMs are readable on that phone. The push endpoint stays until it expires (7 days), and relay pings to it show only generic text. |

## DashPay social integration (read-only plus links)

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

| ID | Ask | iOS status | Android status | Needed by |
| --- | --- | --- | --- | --- |
| W1 | DashConnect enabled on mainnet in a store release | Draft #1133; blocked on the contract | `SUPPORTS_CONNECT=false` in prod; enabling it for 11.9.1 was reverted | G3 |
| W2 | Move to the App Connect system contract, with one-hop provisioning and the per-device key model | Not started | Not started | G3 |
| W3 | `cb=` return URL, allowlisted per app; error codes (`cancelled`, `no-identity`, `wrong-network`); request-age limit and the "only approve if you just tapped" copy | Not started | Not started | G2 |
| W4 | Re-login lookup fix (#1137 / platform #4822) | Open | Check | G2 |
| W5 | Top-up deep link, e.g. `dashwallet://topup?identity=<id>&amount=<credits>&sender=…` | — | — | 1.1 (nice to have) |
| W6 | `dashpay://user` handling on Android | Supported | Unverified | 1.1 |
| W7 | Limited keys (protocol v14 budget/expiry) for Yappr's HIGH key, with a "Connections" list showing last use and a revoke action | #1138 (BLE) builds limited keys | — | 1.1 |

**Process.** Open one tracking issue per wallet repo in Phase 0, with a
testnet interop matrix both teams run in CI (see
[QA_RELEASE.md](QA_RELEASE.md#wallet-interop)). Yappr maintains a small spec
page, `docs/mobile/APP_CONNECT_PROFILE.md`, which is a Phase 0 deliverable. It
pins the exact payload, `cb`, error codes, key model and test vectors, so the
three clients stay in step.

## Testing without a human wallet

Automated E2E cannot tap through DashPay. Yappr's tests therefore use a
**test-wallet harness**: a tiny debug-only app (or a Maestro-driven mode of the
Yappr debug build) that registers `dash-key`/`dash-st` on emulators only.

- It uses the e2e identity pool (`docs/TESTING.md` §4, derivation
  `m/9'/1'/5'/0'/<i>'/<k>'`).
- It publishes real `loginKeyResponse` documents on testnet.

Real-wallet interop runs manually on every release candidate. See
[QA_RELEASE.md](QA_RELEASE.md#wallet-interop).
