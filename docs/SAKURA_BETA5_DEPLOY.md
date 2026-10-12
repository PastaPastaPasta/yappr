# Sakura after the 5.0.0-beta.5 wipe (2026-10-12)

Sakura's Platform chain was wiped for 5.0.0-beta.5 at about 20:15Z on 2026-10-12 and restarted at height 1, with all 13 nodes on Drive/DAPI 5.0.0-beta.5 (protocol 14). Core was kept (chainlocked ~103.8k). Beta.5 could not run in place, because #5350's unsigned-integer index rekey only runs on the first PV14 block. This record covers the rebuild and the `/devnet` cut-over:

- the App Connect contract set ([APP_CONNECT_CONTRACTS.md](APP_CONNECT_CONTRACTS.md)), a new narrow contract group registered by the `yappr-app` anchor;
- the beta.5 re-cuts: social v15 with multiple mentions, pollr v7, storefront v8 and blog v8 ([PLATFORM_V5_BETA5_UPGRADE.md](PLATFORM_V5_BETA5_UPGRADE.md));
- the legacy sign-in contracts, outside any group.

The SDK is 5.0.0-beta.5. Credit costs are paired with cents at $60/DASH (1M credits = 0.06¢).

## Identities

Every identity was **replayed** from its 2026-10-08 asset lock. The locks are mined and chainlocked on the Core chain that survived, so a ChainLock proof of the same outpoint recreates the same identity id with the same keys. No new DASH was spent. All 163 identities came back at their beta.3 ids, as did the E1 leader's +1 DASH top-up (tess1999), whose lock was replayed the same way. 159 DPNS names were re-registered; the battery bots 0–3 stay unnamed by design. A proved readback matched all 163 key sets, and all 159 names resolve to their ledger ids.

Keys that were added to an identity after its creation on the beta.3 chain did not come back: E1 join-request keys, responder logins and App Connect test keys. They are re-added as needed.

| Role | Id |
| --- | --- |
| maker (`yappr-maker-260929.dash`) | `9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH` |
| CI and DM e2e bots 1–8 | `E2E_IDENTITY_IDS` in `.env.devnet` (unchanged) |
| battery/proof bots 0, 1, 2 | `H9ytLzCNWfh8Q4Ho6hEJaLT8Vj1UYUzmsGFuz9SE2VvQ`, `HwBSXMB7Tiam91bKUTaFpLdChLEaKz7Ugew5bEfBgpjk`, `93WXKyy7WtEzLyzACc7SCH1wYLHTqqXFw8etm6VzR58d` |
| fresh/poor bot 3 | `AUTRHQvyBZ1FJyhk8B6GfAgTMV8xULWKAcxzCsqPL6GK` |

## Contracts

The replayed maker starts at identity nonce 0. Its nonces 1–12 were **burned** with twelve 1M-credit transfers to the CI identity, which cost 27.3M credits (~1.6¢), 12M of them moved to CI. This did two things:

- the App Connect anchor landed on nonce 13, so `APP_ID` and `GROUP_ID` are the ids [APP_CONNECT_CONTRACTS.md](APP_CONNECT_CONTRACTS.md) planned;
- no new contract reuses a beta.3 contract id. Browsers and the old bundled snapshot have seen those ids with different contents.

`scripts/register-app-connect-contracts.mjs` registered the set from the sha256-pinned files in `scripts/app-connect-set.mjs`. The run was journaled and preceded by an unsigned and a signed dry run. The anchor went first (`--upto app`) and was checked before the rest. Each create decoded with both wasm builds, and each contract was read back with proofs, membership included. Key exchange, vault and key backup were then created **with no group registration and no membership** by `ops/publish-legacy-beta5.mjs`, from the pinned testnet snapshot (`6101eb0f…`). The snapshot keeps vault's `requiresIdentityEncryptionBoundedKey: 2`, which the bare `contracts/yappr-vault-contract.json` lacks. DM v4 was not registered: a fresh chain has no legacy threads to read.

Group `3S3owNijnVrxE9FvgcHbCTG6iogKBwg69iwFhV7Pke8c` ("Yappr"): owner = maker, no admins, eight whole-contract members.

| Nonce | Contract | Id | Source sha256 | Signed create | Cost |
| ---: | --- | --- | --- | ---: | ---: |
| 13 | `yappr-app` anchor (registers the group) | `CWbSpGNiKGL1i3bmLSWiMQvv364FBCh8sgBqNb1Qo9N9` | `d3acd888…` | 707 B | 13.09e9 (786¢) |
| 14 | social v15 | `BVW1hBXxLSSTo7V5ZXUf6vhJ3Zkb2CgWoCQz3fHt9t9F` | `9b6c7eed…` | 16,456 B | 91.74e9 (5,505¢) |
| 15 | blocks | `3QghCZZmaMtgCCvpPaspjwWr9G4fXcbXHBtfCkLQuUyx` | `ba0ef67a…` | 1,258 B | 19.11e9 (1,147¢) |
| 16 | DM v5 | `9z2CHrTbbkZjwVTD9WQsAGSMoHJ4zuqufNWJcH93v4Dz` | `4fe2b3f4…` | 3,557 B | 22.18e9 (1,331¢) |
| 17 | blog v8 | `C5zxo8z6r1tpUAUaUbGWhwxDKaRcU4uwtfP4gXjh4Fjs` | `79c8a462…` | 6,657 B | 29.32e9 (1,759¢) |
| 18 | pollr v7 | `4HJTBsr9fX8rxS6rGGMw4ZqsxV2MkJ46ByAADmmQ6J3i` | `4b660df8…` | 3,704 B | 19.17e9 (1,150¢) |
| 19 | storefront v8 | `9ujMJQ6NVbVyPNipviYfedqodpdgG6Jj8dTqqbUeVB69` | `8f0feeeb…` | 16,314 B | 51.65e9 (3,099¢) |
| 20 | auth vault | `6u6Ztd6V64L1tn7YuCMzZntqAcv1rAFfmVWrXCN6xC3e` | `cecf0ccc…` | 2,029 B | 17.12e9 (1,027¢) |
| 21 | key exchange (no group) | `6LXB25PxQK8BewKdMrKo65oYmuBF3Gf1qxGRHXwrAZ5N` | snapshot | 1,427 B | 14.08e9 (845¢) |
| 22 | vault (no group) | `A4jd8chdN5AiVduWc8gBBPoi2qdKGcyS4k53JUdYCKYo` | snapshot | 626 B | 13.05e9 (783¢) |
| 23 | key backup (no group) | `AdhD9Vmu7Hn3YTGbmpFc4PeFzDtufQUZRQgxB1Y4uJt3` | snapshot | 957 B | 13.06e9 (784¢) |

Totals:

| | credits | ¢ |
| --- | ---: | ---: |
| App Connect set | 263.39e9 | 15,803 |
| legacy contracts | 40.20e9 | 2,412 |
| maker, from the replay to nonce 23 (includes the burn and its DPNS name) | 303.69e9 | 18,222 |

`verify-appconnect.mjs --only g1,g2,g3,a1` passes all 31 checks:

- the group's owner, admins and name;
- exactly the eight pinned members, with no document-type or token members;
- `APP_ID` and `GROUP_ID` both derive from nonce 13;
- every member lists the group and is still at version 1;
- the anchor's encryption opt-in is 2 and its schema equals the file.

System contracts (DPNS, DashPay, token history) kept their ids.

## Client

`.env.devnet` points at the ids above and sets the topologies: `v15`, storefront `v8`, blog `v8`, pollr `v7`, DM `v5`. It sets `NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID` blank and the four `NEXT_PUBLIC_APP_CONNECT_*` values. `NEXT_PUBLIC_LOGIN_PROTOCOL` was first left unset (legacy sign-in); the flip (#737) set it to `app-connect`. Key exchange, password vault and key backup stay registered, outside the group, as the rollback: unsetting the variable restores the legacy sign-in.

Web App Connect (#726, #727) merged, and the live responder checklist passed on an app-connect build. The flip waited on #742: App Connect builds accept only an ENCRYPTION key bound to the anchor, so identities without one could not be sent DMs or store orders. #745 settled it as "anchor key only; prompt others": people without one get "Set up messaging", and everyone else sees "@name hasn't set up messaging yet". `ops/add-anchor-messaging-keys.mjs` gave the seeded and test identities their key; CI pool slot 0 is kept without one as the e2e fixture. `lib/contracts/bundled/devnet-sakura.json` was re-snapshotted with `--prune`.

## Data

YAPP on v15 is non-transferable, with `baseSupply` 0, so every YAPP comes from the 100-YAPP starter grant or a maker mint. The reseed used the replayed personas.

| Step | Result |
| --- | --- |
| Starter grants (maker, CI, personal, bots, DM bots) | 14/14 |
| DashPay profile + `yapprProfile` for the special identities | 13/13 |
| Maker mints | CI 4,000; personal 10,000; bots 0 and 1, 4,000 each; five seed authors, 400 each |
| Personas (profiles + grant claims) | 148/148 |
| 800-op social corpus | 800 done, 0 failed |
| Multi-mention posts | 6 posts naming 2–8 personas each; `mentionedUserIds contains` reads them back |
| Pollr v7 | 145 writes; tallies as planned |
| Storefront v8 | 246 documents, all checks passed |
| Blog v8 | 163 documents: 8 blogs, 42 posts, 40 follows, 73 comments |

The storefront and blog seeders needed fixes for v8 (#733); the client was never affected. The DM seeder targets DM v4 only, which this chain does not register.

On App Connect builds, the 7 seeded stores showed "not accepting orders" until each owner had an encryption key bound to the anchor. Each owner was given one by an identity update (key id 5).

## Election E1 (social v15)

- **Charter:** tess1999 (persona 5) filed `DNiAmQZumw97WHyfdT9x7NS3cSc3hcojUxUZ5uMJBh6b`.
  - Reasons: SPM, ABU, REP.
  - Moderators' share: 60. Split: 40/30/30.
- **Join requests:** persona 0 (`AKVhxjxw…`) and battery bot 1 (`GZ8xSUWn…`).
- **Applied** at 2026-10-12 22:55Z with the 0.5 DASH fund (contender `7jodGPJX2LAVoiy6MyDX4iSmexXiXjWDpopYWoeVzwZ4`).
- **Seat:** about 2026-10-19 22:55Z if uncontested. Until then the maker moderates as the interim owner.

## Batteries

| battery | result |
| --- | --- |
| `verify-appconnect --only g1,g2,g3,a1` | 32 PASS |
| `verify-v10` on v15 (full) | 339 PASS, 0 FAIL, 8 SKIP |
| &nbsp;&nbsp;new beta.4/beta.5 cases | all PASS: y1a 40726 transfer, y1j/y1k burn, n1h–n1l mentions, x1tc2, r1q2–r1q3 `staysResolved` |
| &nbsp;&nbsp;skips | structural ones, plus r2, which runs after E1 seats |
| `verify-v10 --only k2 --poor 3` | 1/1 |
| `verify-v10 --only x3,y1 --fresh-bot 3` | 18/18 |
| `prove-merged-counts` (v15) | 164 PASS, 2 SKIP |
| `verify-social-query-bundles` | all PASS; the DM v4 bundle SKIPs; enrichment takes 2 requests (#735) |
| `verify-tips` | 6 PASS, 5 SKIP (YAPP tips; YAPP is not transferable) |
| `verify-pollr` (v7) | 77/77, incl. the 40127 late vote (p9) and the 31-day boundary (p10) |
| `verify-blog` (v8) | 101/101, incl. comments-off `where` (b20) and the tombstone (b24) |
| `verify-storefront` (v8) | 154/154; s14c passed on a re-run after a stale-nonce flake; includes paused and closed stores (s21) |
| `verify-dm-v5` | 106/106 |
| `verify-appconnect --only k1 --keyholder 241` | 3/3 (the default keyholder, 242, is not in this chain's seed ledger) |

`e2e/write/topology.spec.ts` against the live https://yap.pr/devnet: 22/22.

## Costs

| | credits | ¢ |
| --- | ---: | ---: |
| Maker: burn, DPNS, 11 contracts, mints, sponsored gas | 339.6e9 | 20,373 |
| All other identities: DPNS, profiles, claims, seeds, batteries, E1 fund, App Connect tests | 295.4e9 | 17,722 |
| **Total** | **~635e9** | **~38,100** |
