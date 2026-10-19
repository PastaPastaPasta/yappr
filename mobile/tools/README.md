# mobile/tools: test-wallet responder

A Node stand-in for DashPay, so agents and Maestro can sign in to Yappr without
a human tapping through a wallet (ADR-001 E5.4). Given a `dash-key:` or
`dash-st:` URI and a sakura pool persona, it does what a wallet would do:

| URI | What the responder does |
| --- | --- |
| `dash-key:…&v=2` App Connect request | Follows [`docs/APP_CONNECT_PROFILE.md`](../../docs/APP_CONNECT_PROFILE.md): checks the request, registers the granted V1 keys in one MASTER-signed IdentityUpdate, then replaces the persona's `loginKeyResponse` on the App Connect system contract. See [App Connect](#app-connect-request-v2). |
| `dash-key:…&v=1` legacy key-exchange request | Parses it with `parseYapprKeyExchangeUri`. Derives the persona's login key for the app contract (see [Derivation](#derivation)). Does ECDH with the app's ephemeral key and encrypts the login key with AES-GCM. Then it creates the persona's `loginKeyResponse` on the key-exchange contract, or replaces it on a re-login, signed with keyId 2 (AUTHENTICATION/HIGH). |
| `dash-st:` unsigned IdentityUpdate | Decodes it. Checks that it updates the persona's identity, that it only adds AUTHENTICATION/HIGH and ENCRYPTION/MEDIUM keys and disables none (the 1.0 key registration), and that its identity nonce is not stale. Signs it with keyId 0 (MASTER), broadcasts it, and waits for the result. |

It serves **devnet** or **testnet**, selected by one explicit env file. Requests for another network are refused before any write. Mainnet is always refused.

## Setup

```bash
npm ci                     # repo root: the SDK and crypto libraries come from here
npm --prefix mobile/tools ci
npm --prefix mobile/tools test        # unit tests, no network
npm --prefix mobile/tools run typecheck
```

`test-wallet-responder.mjs` bundles `src/` with esbuild into `dist/` on every
run, then runs it. npm packages are left external and resolve from the root
`node_modules`.

## Configuration

| Input | Source |
| --- | --- |
| Pool | `YAPPR_SAKURA_IDENTITIES`: path to the sakura ops `identities.json` (ENGINE.md §12.3), or any pool in its shape. It is never copied into the repo, and no key material is ever printed. A pool may name a recovery phrase (`mnemonicFile`) for [seeded personas](#app-connect-derivation). |
| Network | One variant env file: `--env-file <path>`, else `YAPPR_ENV_FILE`, else `<repo>/.env.devnet`. For devnet, set `NEXT_PUBLIC_NETWORK=devnet`, `NEXT_PUBLIC_DEVNET_NAME` and `NEXT_PUBLIC_DAPI_ADDRESSES`. For testnet, set `NEXT_PUBLIC_NETWORK=testnet` with no devnet or endpoint overrides; the SDK uses its trusted testnet configuration. `NEXT_PUBLIC_QUORUM_URL` is optional. Values missing from that file are errors; they never fall back to another file. |
| Key-exchange contract | `NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID` in the same env file. It is needed for legacy `dash-key:` (`v=1`) only. |
| App Connect state | `--state-file <path>`, else `YAPPR_APP_CONNECT_STATE`, else `~/.local/state/yappr-mobile-tools/app-connect-<devnet>.json` on devnet or `app-connect-network-testnet.json` in the same directory on testnet. See [Grant state](#grant-state). |

The pool is tagged with its network (`"network": "devnet-sakura"` or `"network": "testnet"`). The
responder refuses to start when the env file targets a different network. That
catches a stale `.env.devnet`: staging's still points at the abandoned bonsia.

## Usage

```bash
export YAPPR_SAKURA_IDENTITIES=/Users/pasta/.local/share/yappr-sakura-20261001/identities.json

# One request (the answer is one JSON line on stdout; logs go to stderr)
node mobile/tools/test-wallet-responder.mjs --uri 'dash-key:…?n=d&v=1' --persona 90
node mobile/tools/test-wallet-responder.mjs --uri 'dash-st:…?n=d&v=1' --persona 90

# Server for Maestro runScript (loopback only; it answers one request at a time)
node mobile/tools/test-wallet-responder.mjs --serve 127.0.0.1:8789
curl -s -XPOST 127.0.0.1:8789/respond -H 'content-type: application/json' -d '{"uri":"dash-key:…","persona":90}'
curl -s 127.0.0.1:8789/health
```

- `--key-index <n>` (CLI) or `"keyIndex"` (HTTP) requests a key rotation. By
  default the responder reuses the keyIndex stored in the persona's existing
  response for that app contract, or 0 if there is none. An index below the
  stored one is refused (spec §12.2). The spec's request (§8.1) carries a
  keyIndex; the request format Yappr ships (`vendor/platform-auth`) does not,
  so the index is chosen on the responder side, as the wallets do.
- Routes: `POST /respond` (any URI above; App Connect also takes `faults`,
  `otherPersona` and `spamPersonas`), `POST /revoke` (App Connect,
  [below](#renew-and-revoke)) and `GET /health`.
- HTTP status codes: `200` with the answer; `400` for a malformed body; `422`
  when the request was refused or failed; `404` for any other route; `403` for
  anything a browser could send. Loopback binding keeps other machines out but
  not web pages, so the server refuses requests with an `Origin` header, a
  non-loopback `Host` (DNS rebinding), or a `Content-Type` other than
  `application/json`.
- Use personas **90–99**, the mobile reservation (ENGINE.md §12.3), so mobile
  writes never collide with corpus seeding.

A first sign-in takes two calls, just as with a real wallet:
1. The app shows `dash-key:`. The responder publishes the response.
2. The app finds that the derived keys are not on the identity yet, and shows
   `dash-st:`. The responder signs the IdentityUpdate with MASTER and
   broadcasts it.

A re-login needs only step 1. It derives the same keys.

## Derivation

The responder follows `YAPPR_DET_SIGNER_SPEC.md` §5.1 step 2, §6 and §9: the
"Dash Platform Application Key Exchange Protocol", which `vendor/platform-auth`
and `lib/services/key-exchange-service.ts` implement on the app side. It
departs from the spec in one place. A real wallet takes the HKDF input key from
BIP32 (`m/9'/coin'/21'/account'`), but the pool holds no seed, so the responder
uses the persona's AUTHENTICATION/CRITICAL key (keyId 1) instead:

```
login_key  = HKDF-SHA256(ikm = keyId 1 private key, salt = identityId (32 B),
                         info = appContractId (32 B) || u32le(keyIndex), 32 B)
             (if the result is not a valid secp256k1 scalar, re-derive with a
              counter byte 1..255 appended to info)
shared     = HKDF-SHA256(ikm = ECDH_x(walletEph, appEph), salt = "dash:key-exchange:v1", info = "", 32 B)
payload    = nonce (12 B) || AES-256-GCM(shared, nonce, login_key) || tag (16 B)   // 60 B
```

The app then derives `auth = HKDF(login_key, identityId, "auth")` and
`encryption = HKDF(login_key, identityId, "encryption")`
(`deriveYapprAuthKeyFromLogin` and `deriveYapprEncryptionKeyFromLogin`). The
same (identity, app contract, keyIndex) always gives the same keys, so a
re-login does not need a second IdentityUpdate.

## App Connect (request v2)

The responder answers App Connect requests the way the profile's wallet rules
describe. It reuses `vendor/platform-auth/src/app-connect/` for the request
codec and the response crypto, so it cannot drift from the app side:

1. **Decode strictly** with `parseAppConnectUri`. Codec errors are refused as
   `unsupported` or `invalid`. Only requests matching the configured devnet (`n=d`) or testnet (`n=t`) are served.
2. **Freshness**: refused as `stale` when created more than 10 minutes ago or
   more than 2 minutes ahead.
3. **Identity hint**: with an `IDENTITY_HINT`, only that identity answers.
   Another persona is refused as `invalid`.
4. **Owner consistency** (chain reads): the group's owner, and the owner of
   every singleContract or documentType contract, must be the owner of
   `appId`. The only foreign document type allowed is DashPay `profile`. An
   `ENC_BINDING` must name `appId`, and `appId` must opt in to bounded keys of
   that purpose. A proposed expiry in the past is `invalid`.
5. **Limits**: each auth key gets the binding's level and its proposals,
   clamped to 5 DASH and 365 days. A binding without an expiry gets the
   90-day preset, so every auth key is V1.
6. **Keys**: one fresh auth key per granted binding (see
   [Derivation](#app-connect-derivation)). The encryption key is re-sent when
   `identities.contractKeys` already returns one this wallet derives: rotation 0
   for a seeded persona (#1210), or for a seedless one any rotation
   (`scripts/verify-appconnect.mjs --restore-anchor-key` registers a later one
   when a test left the current key one nobody holds). It is registered
   (rotation 0) when there is none, and left out when another wallet made it or
   this wallet's key was disabled. The responder itself never rotates it.
7. **One IdentityUpdate**, signed by MASTER (keyId 0). It adds the new keys
   with `contractBounds`, `totalBudget` and `expiresAt`
   (`IdentityPublicKeyInCreation` V1, evo-sdk 5.0.0-beta.4), and disables the
   auth keys of the previous grant for the same `CONNECTION_ID`. At most 6
   keys. The responder waits until the change is visible on chain.
8. **Publish**: delete the persona's previous responses for the app, then
   create the new one. The delete is index-only and carries all three values,
   which the state file keeps. A delete Platform refuses with
   `DocumentNotFoundError` (the entry is gone) is forgotten; any other failure
   is retried on the next answer. The new response's values are recorded
   before the create, and forgotten only if Platform refuses it, so a create
   whose outcome is unknown can still be deleted later. The response
   is sealed with `sealAppConnectPayload` and its AAD, and signed with the
   persona's unbound HIGH key (keyId 2).

Answering the same URI again, for example after a publish failed, is safe:
keys this request already registered are re-sent rather than registered
twice, which Platform would refuse.

The answer is one JSON line. It has the slots (role, binding index, key id),
the added, disabled and raised key ids, and `callbackUrl`: the request's `cb`
with `ac=ok` appended, for a test to open. A refusal prints (CLI) or returns
(HTTP `422`) `{"error", "ac", "callbackUrl"}`, where `ac` is the profile's
status: `stale`, `unsupported`, `invalid`, `declined` or `failed`.

### Renew and revoke

- **Renew** (`MODE = 1`): when the connection's grant has a live key for
  every requested binding, the responder raises their limits in place. It
  sends one IdentityKeyLimitsUpdate per key (`sdk.identities.updateKeyLimits`,
  signed by MASTER): the binding's budget proposal is *added* to the key's
  total, up to the 5 DASH cap, and its expiry replaces the current one when it
  is later. A limit the key does not have is not added, because Platform
  refuses that. It then republishes the same keys. The targets are fixed once
  per request and saved, so retrying the request does not add the allowance
  twice. It answers as a new login instead, which supersedes the old keys
  (the profile's phase-1 renewal), when there is no such grant, when an old
  key lacks the level or a limit the request needs, when a key would have
  no budget left within the cap, or when a fault flag shapes the keys
  (`unregistered-key`, `unbound-key`, `critical`, `foreign-group`, `expired`,
  `expires-in`, `budget`; a renewal can only raise limits, never cut them).
- **Revoke** (disable-only): `--revoke --persona <idx> --app-id <id>
  [--connection-id <hex>]`, or `POST /revoke`. MASTER-signed IdentityUpdates,
  ten keys each (Platform's limit), disable the auth keys of that
  connection's grant (or of every connection's), and the grant is forgotten.
  The shared encryption key and the published response stay.

A key is only ever disabled when the responder can prove it made it: a live,
non-MASTER auth key whose public key re-derives from the grant record. A
stale or edited state file cannot get anything else disabled, including the
pool's own keys (0–4) and keys other wallets added.

### Fault flags

`--fault <flag>` (repeatable) or `"faults": [...]` makes the responder
misbehave in one specific way, so app-side tests can check that the bad
answer is refused. The last column is what `verifyAppConnectCandidate`
reports; `test/app-connect.test.ts` checks it.

| Flag | What the responder does | App sees |
| --- | --- | --- |
| `wrong-owner` | Seals the AAD for another `$ownerId` (`--other-persona`, else a fixed stranger id) and publishes under the persona | `decrypt` |
| `copy-response` | Answers honestly, then `--other-persona` republishes the same payload under its own id | that candidate: `decrypt` |
| `unregistered-key` | Sends the primary binding's key without registering it | `key-not-found` |
| `unbound-key` | Registers the primary key without contract bounds | `key-unbound` |
| `critical` | Registers the first non-group auth key at CRITICAL | `key-level` |
| `foreign-group=<id>` | Binds the group key to another existing group | `key-unmatched` |
| `expired` | Every auth key expires 60 s from now (Platform refuses an already-expired key) | `key-expired`, then 20016 |
| `expires-in=<s>` | Every auth key expires `s` seconds from now | `key-expired` under an hour; then 20016 |
| `budget=<n>` | Every auth key gets a budget of `n` credits | accepted; 40218 or 20015 on writes |
| `bad-tag` | Flips a bit of the AES-GCM tag | `decrypt` |
| `extra-slot` | Appends a slot holding a key that is on no identity | `framing` (`key-not-found` when a binding was declined) |
| `spam=<n>` | First, `n` other personas publish well-framed junk to the request (`--spam-personas`, default 90–99). Junk only adds: it never deletes a spammer's live response | those candidates fail |
| `second-identity` | After its own answer, `--other-persona` answers too, with its own keys | two valid candidates (chooser; a hint filters the stranger) |
| `omit-enc` | Declines the encryption bindings | accepted, no encryption key |
| `omit-profile` | Declines the documentType bindings (DashPay profile) | accepted, group key only |

### App Connect derivation

**Seeded personas** derive what the reference wallet derives (dashwallet-ios
#1210 through swift-sdk `deriveConnectKey`, rs-platform-wallet `ConnectKey`
and key-wallet), on the same wasm-sdk primitive as the web's recovery-phrase
sign-in (`lib/crypto/dip13.ts`, whose Vitest spec pins the reference vectors).
A pool is seeded when its `identities.json` names a recovery phrase,
`"mnemonicFile": "<path relative to the pool file>"`, and a persona gives its
DIP-13 `"identityIndex"`. The persona's keyId 0 must be the phrase's MASTER key
at that index, or the persona is refused:

```
enc    = m/9'/coin'/5'/7'/0'/identityId'/appId'/purpose'                 (rotation 0 only, as #1210)
auth_i = m/9'/coin'/5'/6'/0'/identityId'/hash256(appEphPub || u8(i))'      (#1210's leaf)
```

Do not add `identityIndex` to a persona whose anchor key the legacy scheme
registered: the responder would no longer derive that key, and would leave the
encryption slot out ("another wallet").

`identityId'` and `appId'` are DIP-14 256-bit hardened children; coin is `5'`
on mainnet, `1'` on testnet and devnets. The encryption key is normative, so a
DashPay build that restores the phrase, and Yappr's recovery-phrase sign-in, find
exactly the key the responder registered.

**Seedless personas** (the sakura pool, and the testnet staging ledger, whose
keys sit at a pre-DIP-13 path) keep the legacy scheme their on-chain keys were
made with. It uses the same inputs, with HKDF-SHA256 over the persona's
AUTHENTICATION/CRITICAL key (keyId 1), like the legacy derivation below:

```
auth_i = HKDF-SHA256(ikm = keyId 1 private key, salt = identityId,
                     info = "yappr-test-wallet/app-connect/auth" || hash256(appEphPub) || u8(bindingIndex))
enc    = HKDF-SHA256(ikm = keyId 1 private key, salt = identityId,
                     info = "yappr-test-wallet/app-connect/enc" || appId || u8(purpose) || u32be(rotation))
         (an invalid scalar re-derives with a counter byte 1..255 appended to info)
```

No real wallet derives those keys. Auth keys are fresh per request: they follow
the request's ephemeral key and the binding's position in it. The encryption key
is the same for every login of the persona to the app. All keys are
ECDSA_SECP256K1, so each signs its own registration.

### Grant state

One JSON file per network, outside the repo, records per (identity, app):

- the responses the responder published, with their three values. The
  indexOnly delete needs them, and nothing on chain lists responses by owner;
- per `CONNECTION_ID`, the key ids of the current grant, with each key's
  binding index and derivation tag. Keys are recorded as pending before the
  IdentityUpdate, so an update that lands without a confirmation is still
  superseded by the next login.

It holds no private key. Losing it is harmless: old responses stay on chain,
and the next login does not disable the old keys (they still expire).

One responder process owns the file at a time (`<file>.lock` holds its pid).
A second process using the same file is refused; use another `--state-file`
for it. A lock left by a process that is gone is taken over.

### Running it live

Not possible yet: sakura runs Platform 5.0.0-beta.3, and the `yappr-app`
anchor contract and its group are not registered. The App Connect system
contract (`H8F9…`) exists, and the responder's chain reads were checked
against sakura (read-only). Once sakura runs beta.4 and the anchor is
registered, answer a request from the app (or one built with
`buildAppConnectUri`) like this:

```bash
export YAPPR_SAKURA_IDENTITIES=~/.local/share/yappr-sakura-<date>/identities.json
node mobile/tools/test-wallet-responder.mjs --uri 'dash-key:…?n=d&v=2&cb=…' --persona 90
node mobile/tools/test-wallet-responder.mjs --uri 'dash-key:…?n=d&v=2' --persona 90 --fault expires-in=120
node mobile/tools/test-wallet-responder.mjs --uri 'dash-key:…?n=d&v=2' --persona 90 --fault second-identity --other-persona 91
node mobile/tools/test-wallet-responder.mjs --revoke --persona 90 --app-id <anchor id>

# Playwright / Maestro
node mobile/tools/test-wallet-responder.mjs --serve 127.0.0.1:8789
curl -s -XPOST 127.0.0.1:8789/respond -H 'content-type: application/json' \
  -d '{"uri":"dash-key:…&v=2","persona":90,"faults":["budget=1000"]}'
```

## Live status

The live legacy `dash-key:` (`v=1`) path is **blocked until W-SAKURA**: the sakura Yappr
contracts, including key-exchange, are not published yet. Until then, a
`dash-key:` request fails before it connects to the network:

```
NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID is unset in <env file>: the key-exchange contract is not
published on devnet sakura yet (W-SAKURA), so dash-key: requests cannot be answered.
```

Once W-SAKURA lands, run it with the cut-over `.env.devnet`, which needs no
`--env-file`. Until then, use the sakura template
(`--env-file /Users/pasta/.local/share/yappr-sakura-20261001/env.devnet.template`)
for `dash-st:`.

## Layout

| File | Role |
| --- | --- |
| `src/key-exchange.ts` | Login-key derivation and the encrypted response (pure) |
| `src/dash-st.ts` | IdentityUpdate decode and MASTER signing (wasm, offline) |
| `src/responder.ts` | URI dispatch, network and keyIndex rules; Platform access goes through `ResponderPorts` |
| `src/app-connect/wallet.ts` | App Connect wallet rules, key plan, sealing, renew and revoke; Platform access goes through `AppConnectPorts` |
| `src/app-connect/derive.ts`, `faults.ts`, `state.ts` | Key derivation, fault flags, grant state file |
| `src/app-connect/platform.ts` | The live App Connect ports (identity update, key limits, response delete and create) |
| `src/platform.ts` | The live ports: network-selected SDK from `scripts/sdk-env.mjs`, the `loginKeyResponse` write, the broadcast |
| `src/pool.ts`, `src/config.ts` | Pool and env-file loading |
| `src/main.ts` | CLI and HTTP server |
| `test/` | A full app ↔ wallet round trip with the write stubbed; `dash-st:` parse, sign and signature check; App Connect against an in-memory chain (`test/app-connect-chain.ts`) judged by the shared verifier, and the interop vectors through the responder's sealing |

### Testnet staging rehearsal

Use the protected staging persona ledger as the pool and the committed staging env file:

```sh
npm --prefix mobile/tools run build
YAPPR_SAKURA_IDENTITIES="$STAGING_PERSONA_LEDGER" node mobile/tools/test-wallet-responder.mjs --serve 127.0.0.1:8789 --env-file .env.staging
```

Set `STAGING_PERSONA_LEDGER` to the protected testnet ledger path. Run `--help` for the persona selection options. The pool must be tagged `testnet`. App Connect requests carry the staging APP_ID; grant state is stored in the testnet namespace. Messaging derives from the persona's CRITICAL key and the requested app anchor, matching staging provisioning.
