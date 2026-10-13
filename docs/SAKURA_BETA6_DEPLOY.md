# Sakura after the 5.0.0-beta.6 wipe (2026-10-13)

Sakura's Platform chain was wiped for 5.0.0-beta.6 at about 14:10Z on 2026-10-13 and restarted at height 1, with all 13 nodes on Drive/DAPI 5.0.0-beta.6 (protocol 14). Core was kept. This record covers the rebuild and the `/devnet` cut-over to social v16 ([SOCIAL_V16.md](SOCIAL_V16.md)); [PLATFORM_V5_BETA6_UPGRADE.md](PLATFORM_V5_BETA6_UPGRADE.md) covers the release itself. Every other contract is registered from the same file and sha256 pin as on beta.5.

The SDK is 5.0.0-beta.6. Credit costs are paired with cents at $60/DASH (1M credits = 0.06¢).

**Status: planned.** The ids below are computed offline (`register-app-connect-contracts.mjs --plan --start-nonce 24`); this section is replaced by the registration record.

## Identities

Every identity is **replayed** from its 2026-10-08 asset lock, as on beta.5: the locks are mined and chainlocked on the Core chain that survived, so a ChainLock proof of the same outpoint recreates the same identity id with the same keys. The maker (`9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH`), CI, the DM e2e bots, the battery bots and the 148 personas keep their ids, so `E2E_IDENTITY_IDS`, the battery and mobile pools and the GitHub secrets do not change. Keys added after creation (App Connect test keys, anchor messaging keys, E1 join-request keys) are added again.

## Contract ids: none reused

The replayed maker starts at identity nonce 0. It burns nonces **1–23**, every nonce an earlier sakura chain registered a contract at, so the anchor lands on **24** and no contract or group id of this chain was ever another chain's:

| Nonce | Contract | Id |
| ---: | --- | --- |
| 1–23 | burned (credit transfers to CI) | — |
| 24 | `yappr-app` anchor (registers the group) | `BbWcUA8Msi7HSgC2hCJsCtDADs2FzQVabRuHvk1tnj4d` |
| 25 | social v16 | `4qctQYg3YNxp3kVojKxq47iABNbPFtRqSLxQvRz3cjeF` |
| 26 | blocks | `6QCijw1ia3EBmgVCGFxGwpFpX6PwiJpXESZzu2D8QdDN` |
| 27 | DM v5 | `BnKea2J8BSF4CxK9eJGKVYu9pv9NQK58LyfkEHxmKQiJ` |
| 28 | blog v8 | `8XAk3nrbhn69V7ZUfERRKjrJtivrvoRHDKpki6LSftej` |
| 29 | pollr v7 | `AG5Z5YzuaSW2yLcHnZRHLz5coZFDAWNhu26QyZ6QG4nN` |
| 30 | storefront v8 | `9hZwi4W3qqNtHFygjkgDvgud4EmE3dUxQUk5NjTYsdqN` |
| 31 | auth vault | `9PoojBAXm6PNabkJEU65nd9dPcvpjpSfXK15bJVeFWAt` |
| 32 | key exchange (no group) | `7ELVaZigyrSVTxHcvjNAAXPSpdaPvn3b3CSw76b57jKg` |
| 33 | vault (no group) | `HQrUuCsUFFgs3PKNnToqn8SNXqLVQxRrfCE1ybvFoHo1` |
| 34 | key backup (no group) | `FFpJgHb7rpK9KEAj6uNWD3f1B6bnM3o6yLPCuUNGRb6m` |

Group `7iM9B6WDREEURDgMakuSP5sZRQy62dscFQpN1APPC9hF` = `contractGroupId(maker, 24)`. The App Connect set is the beta.5 one with social v16 in v15's slot (`scripts/app-connect-set.mjs`): a fresh genesis starts a new group, so the replaced v15 is not carried along.

**Why not reproduce the beta.5 ids.** Replaying the maker and burning to nonce 12 again would put the anchor back on `CWbSpGNi…` and social on `BVW1hBXx…`, but social would then be a different contract under the same id:

- The client caches contracts by id and version. The bundled snapshot seeds the SDK by id and revalidates only the version, and the SDK drops a cached contract only for a newer `$contractVersion`. v15 and v16 at one id are both version 1, so a stale cache (a tab left open, a cached chunk, the beta.5 mobile RC) would decode v16 documents with v15's schema instead of failing cleanly on a missing contract.
- The group would change members under the same id, which memberships never do on a live chain.
- The anchor-derived messaging key (HKDF info names the anchor) would come back unchanged while the chain no longer holds it, so a browser's "confirmed anchor key" mark from beta.5 would claim messaging is set up. With a new anchor the derived key differs, the stale mark no longer matches, and the user is asked to set up messaging.

Keeping only the anchor's id (its bytes are unchanged) and moving the members was also considered. It needs a gap in the publisher's contiguous plan and keeps the stale-mark problem, for the benefit of a stable devnet `APP_ID`. A live chain never re-registers its anchor, so mainnet keeps one `APP_ID` either way.

## Client

`.env.devnet` points at the ids above, sets `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v16` and the four `NEXT_PUBLIC_APP_CONNECT_*` values, and keeps storefront `v8`, blog `v8`, pollr `v7`, DM `v5`, a blank DM v4 id and `NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect`. `lib/contracts/bundled/devnet-sakura.json` is re-snapshotted with `--prune` once the set is registered.
