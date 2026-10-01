# mobile/tools: test-wallet responder

A Node stand-in for DashPay, so agents and Maestro can sign in to Yappr without
a human tapping through a wallet (ADR-001 E5.4). Given a `dash-key:` or
`dash-st:` URI and a sakura pool persona, it does what a wallet would do:

| URI | What the responder does |
| --- | --- |
| `dash-key:` key-exchange request | Parses it with `parseYapprKeyExchangeUri`. Derives the persona's login key for the app contract (see [Derivation](#derivation)). Does ECDH with the app's ephemeral key and encrypts the login key with AES-GCM. Then it creates the persona's `loginKeyResponse` on the key-exchange contract, or replaces it on a re-login, signed with keyId 2 (AUTHENTICATION/HIGH). |
| `dash-st:` unsigned IdentityUpdate | Decodes it. Checks that it updates the persona's identity, that it only adds AUTHENTICATION/HIGH and ENCRYPTION/MEDIUM keys and disables none (the 1.0 key registration), and that its identity nonce is not stale. Signs it with keyId 0 (MASTER), broadcasts it, and waits for the result. |

It only serves **devnet** (sakura) requests. A request whose `n=` names another
network is refused, so it can never write to testnet or mainnet.

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
| Pool | `YAPPR_SAKURA_IDENTITIES`: path to the sakura ops `identities.json` (ENGINE.md §12.3). It is never copied into the repo, and no key material is ever printed. |
| Network | One variant env file: `--env-file <path>`, else `YAPPR_ENV_FILE`, else `<repo>/.env.devnet`. It must set `NEXT_PUBLIC_NETWORK=devnet`, `NEXT_PUBLIC_DEVNET_NAME` and `NEXT_PUBLIC_DAPI_ADDRESSES`. `NEXT_PUBLIC_QUORUM_URL` is optional. Values missing from that file are errors; they never fall back to another file. |
| Key-exchange contract | `NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID` in the same env file. It is needed for `dash-key:` only. |

The pool is tagged with its devnet (`"network": "devnet-sakura"`). The
responder refuses to start when the env file targets a different devnet. That
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

## Live status

The live `dash-key:` path is **blocked until W-SAKURA**: the sakura Yappr
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
| `src/platform.ts` | The live ports: devnet SDK from `scripts/sdk-env.mjs`, the `loginKeyResponse` write, the broadcast |
| `src/pool.ts`, `src/config.ts` | Pool and env-file loading |
| `src/main.ts` | CLI and HTTP server |
| `test/` | A full app ↔ wallet round trip with the write stubbed; `dash-st:` parse, sign and signature check |
