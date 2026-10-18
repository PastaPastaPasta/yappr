# Sakura after the 5.0.0-beta.6 wipe (2026-10-13)

Sakura's Platform chain was wiped for 5.0.0-beta.6 at about 14:10Z on 2026-10-13 and restarted at height 1, with all 13 nodes on Drive/DAPI 5.0.0-beta.6 (protocol 14). Core was kept. This record covers the rebuild and the `/devnet` cut-over to social v16 ([SOCIAL_V16.md](SOCIAL_V16.md)); [PLATFORM_V5_BETA6_UPGRADE.md](archive/PLATFORM_V5_BETA6_UPGRADE.md) covers the release itself. Every other contract is registered from the same file and sha256 pin as on beta.5.

The SDK is 5.0.0-beta.6. Credit costs are paired with cents at $60/DASH (1M credits = 0.06¢).

**Status: registered on 2026-10-13, every id exactly as planned offline** (`register-app-connect-contracts.mjs --plan --start-nonce 24`).

## Identities

Every identity was **replayed** from its 2026-10-08 asset lock, as on beta.5: the locks are mined and chainlocked on the Core chain that survived, so a ChainLock proof of the same outpoint recreates the same identity id with the same keys. All 164 lock transactions were on Insight under the chainlock, and 163/163 identities came back at their recorded ids with matching key sets (the maker `9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH` with 1,499.87e9 credits, CI, the DM e2e bots, the battery bots and the 148 personas); tess1999's E1 top-up was replayed from its lock too. They keep their ids, so `E2E_IDENTITY_IDS`, the battery and mobile pools and the GitHub secrets do not change. Keys added after creation (App Connect test keys, anchor messaging keys, E1 join-request keys) are added again.

## Contract ids: none reused

The replayed maker started at identity nonce 0. It burned nonces **1–23** (23 transfers to CI, 60.65M credits, ~3.6¢, 23M of them moved), every nonce an earlier sakura chain registered a contract at, so the anchor lands on **24** and no contract or group id of this chain was ever another chain's:

| Nonce | Contract | Id | Cost |
| ---: | --- | --- | ---: |
| 1–23 | burned (credit transfers to CI) | — | 0.06e9 (4¢) |
| 24 | `yappr-app` anchor (registers the group) | `BbWcUA8Msi7HSgC2hCJsCtDADs2FzQVabRuHvk1tnj4d` | 13.09e9 (786¢) |
| 25 | social v16 | `4qctQYg3YNxp3kVojKxq47iABNbPFtRqSLxQvRz3cjeF` | 91.74e9 (5,505¢) |
| 26 | blocks | `6QCijw1ia3EBmgVCGFxGwpFpX6PwiJpXESZzu2D8QdDN` | 19.11e9 (1,147¢) |
| 27 | DM v5 | `BnKea2J8BSF4CxK9eJGKVYu9pv9NQK58LyfkEHxmKQiJ` | 22.18e9 (1,331¢) |
| 28 | blog v8 | `8XAk3nrbhn69V7ZUfERRKjrJtivrvoRHDKpki6LSftej` | 29.32e9 (1,759¢) |
| 29 | pollr v7 | `AG5Z5YzuaSW2yLcHnZRHLz5coZFDAWNhu26QyZ6QG4nN` | 19.17e9 (1,150¢) |
| 30 | storefront v8 | `9hZwi4W3qqNtHFygjkgDvgud4EmE3dUxQUk5NjTYsdqN` | 51.65e9 (3,099¢) |
| 31 | auth vault | `9PoojBAXm6PNabkJEU65nd9dPcvpjpSfXK15bJVeFWAt` | 17.12e9 (1,027¢) |
| 32 | key exchange (no group) | `7ELVaZigyrSVTxHcvjNAAXPSpdaPvn3b3CSw76b57jKg` | 14.08e9 (845¢) |
| 33 | vault (no group) | `HQrUuCsUFFgs3PKNnToqn8SNXqLVQxRrfCE1ybvFoHo1` | 13.05e9 (783¢) |
| 34 | key backup (no group) | `FFpJgHb7rpK9KEAj6uNWD3f1B6bnM3o6yLPCuUNGRb6m` | 13.06e9 (784¢) |

The App Connect set cost 263.39e9 (15,803¢) and the legacy contracts 40.20e9 (2,412¢). With the burn and its DPNS name (0.08e9), the maker spent 303.73e9 (18,224¢) in all and kept 1,196.1e9 at nonce 34. Each create went through an unsigned and a signed dry run, was journaled, and was read back with proofs; the anchor went first (`--upto app`) and was checked before the rest. `verify-appconnect.mjs --only g1,g2,g3,a1` passes 32/0: owner = maker, no admins, exactly the eight pinned members, all at version 1, `APP_ID` and `GROUP_ID` from nonce 24, the anchor's encryption opt-in 2. The legacy contracts read back with no membership.

Group `7iM9B6WDREEURDgMakuSP5sZRQy62dscFQpN1APPC9hF` = `contractGroupId(maker, 24)`. The App Connect set is the beta.5 one with social v16 in v15's slot (`scripts/app-connect-set.mjs`): a fresh genesis starts a new group, so the replaced v15 is not carried along.

**Why not reproduce the beta.5 ids.** Replaying the maker and burning to nonce 12 again would put the anchor back on `CWbSpGNi…` and social on `BVW1hBXx…`, but social would then be a different contract under the same id:

- The client caches contracts by id and version. The bundled snapshot seeds the SDK by id and revalidates only the version, and the SDK drops a cached contract only for a newer `$contractVersion`. v15 and v16 at one id are both version 1, so a stale cache (a tab left open, a cached chunk, the beta.5 mobile RC) would decode v16 documents with v15's schema instead of failing cleanly on a missing contract.
- The group would change members under the same id, which memberships never do on a live chain.
- The anchor-derived messaging key (HKDF info names the anchor) would come back unchanged while the chain no longer holds it, so a browser's "confirmed anchor key" mark from beta.5 would claim messaging is set up. With a new anchor the derived key differs, the stale mark no longer matches, and the user is asked to set up messaging.

Keeping only the anchor's id (its bytes are unchanged) and moving the members was also considered. It needs a gap in the publisher's contiguous plan and keeps the stale-mark problem, for the benefit of a stable devnet `APP_ID`. A live chain never re-registers its anchor, so mainnet keeps one `APP_ID` either way.

## Client

`.env.devnet` points at the ids above, sets `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v16` and the four `NEXT_PUBLIC_APP_CONNECT_*` values, and keeps storefront `v8`, blog `v8`, pollr `v7`, DM `v5`, a blank DM v4 id and `NEXT_PUBLIC_LOGIN_PROTOCOL=app-connect`. `lib/contracts/bundled/devnet-sakura.json` was re-snapshotted with `--prune` from the registered chain (every contract `.env.devnet` names, and DashPay). `/devnet` went live on these ids at staging `e4641398` (#746, #747) with App Connect sign-in.

## Data

| Step | Result |
| --- | --- |
| Anchor messaging keys (anchor `BbWcUA8M…`) | 160/160 (personas, store owners, battery bots 0–2, DM e2e bots 1–8), 5.09e9 (305¢). The maker, CI pool slot 0 (the keyless e2e fixture) and fresh bot 3 stay without one |
| Starter grants, special profiles | 14, 13/13 |
| Maker mints | CI 4,000; personal 10,000; bots 0 and 1, 4,000 each; five seed authors, 400 each |
| Personas | 148/148 |
| 800-op social corpus | 800/0 |
| Multi-tag corpus | 241/0: 36 posts with 2, 3 and 4 tags (12 each; 13 with a cashtag) and 205 likes on them |
| Mention corpus | 6/0 |
| Storefront v8, blog v8, pollr v7 | 246, 167 and 145 documents |
| Tips, DM | not seeded: YAPP is not transferable (credit tips only), and the DM seeder writes DM v4 only |

## Election E1 (social v16)

tess1999 (persona 5) filed the charter `EJR1wPKEW8futJAfqnyouBFuyBWgeiHkh2sUBb3xufNR` (reasons SPM, ABU, REP; share 60, split 40/30/30), with join requests from persona 0 and battery bot 1. It was applied at 14:53Z with the 0.5 DASH fund (contender `4giwSWrGSJWRyRcZyuJ6ckT61BW3apZ2twUs4pkfpof6`) and seats about **2026-10-20 14:53Z** if uncontested; battery `r2` runs after that. Until then the maker moderates as the interim owner.

## Batteries

| battery | result |
| --- | --- |
| `verify-appconnect --only g1,g2,g3,a1` | 32/0 |
| `verify-v10` on v16 (full) | First run 347 PASS, 4 FAIL, 9 SKIP; re-run on #752's scripts **349 PASS, 0 FAIL after a re-run of a3** (5/5), 9 SKIP. Every v16 case passed: a like's list reordered, cut short or extended is refused 40127 and the exact list lands (o1h–o1k); tombstones and removal records keep the list (x1td2, x1td3, x1tp2); a two-tag like counts under each tag, and an unlike with a reordered or shortened list is refused 40101 (t2p–t2s, t2u–t2x). The first run's 4 failures (t2c, t2j, t2t, t2k) expected the run's fresh entry on the first 100-group page of a global ranking, which the reseeded chain fills past 100 groups; #752 pages through the ranking with `offset` (153–177 groups read). a3c/a3e (the moderators' fee pot) once saw another writer's fees land in the same window. The skips are features v16 lacks, fresh-bot cases run separately, and r2 (E1 not seated) |
| `verify-v10 --only k2 --poor 3`, `--only x3,y1 --fresh-bot 3` | 1/1, 18/18 |
| `prove-merged-counts` (v16) | 174 PASS, 2 SKIP, including the `tg-*` phase (per-tag counters at 0 from creation, one like counted once under each tag and once on the post, rank 1 under both tags all time and in the window, trending lists both, an unlike drops both, the window keeps the unliked entry), `cn-b4` (a tag's posts grouped by post) and `cn-e2` (a documents read through the per-tag counter is refused: "where clause on non indexed property") |
| `verify-social-query-bundles`, `verify-tips` | all PASS; 6 PASS, 5 SKIP (credit tips) |
| `verify-pollr` (v7), `verify-blog` (v8), `verify-dm-v5` | 77/77, 101/101, 106/106 |
| `verify-storefront` (v8) | 153 PASS; s14c (a stale-nonce flake) passed on a re-run |
| `verify-appconnect --only k1 --keyholder 241` | 3/3; on #752's scripts 4/4. k1 now adds only keys the test wallet derives (its next rotations), and its k1d leaves a held key newest. Its first run had left persona 241's newest anchor key one nobody held; `--restore-anchor-key` repaired it live (key 8, 18.2M credits, 1.1¢) |
| `e2e/write/topology.spec.ts` against https://yap.pr/devnet | 23/23, including a fifth tag refused in the composer and a two-tag post on both tag pages, counted under both |
| smoke against https://yap.pr/devnet | 28 passed; the 2 embed-offline specs cannot run against an https base URL, as on beta.5 |
| CI devnet e2e (#748) | topology 26, recovery 2, DM v5 22: all passed |

## Fees, live

`measure-social-fees.mjs` on a throwaway copy of v16 (no action fees or token costs), means of at least 3 writes, against the offline estimates #746 quoted:

| Write | Live | Estimate |
| --- | ---: | ---: |
| post, 1 tag | 122.7M (7.4¢) | 198.4M (11.9¢) |
| post, 4 tags | 232.9M (14.0¢) | 381.9M (22.9¢) |
| first like, 1 tag | 22.2M (1.3¢) | 126.6M (7.6¢) |
| first like, 4 tags | 36.2M (2.2¢) | 276.9M (16.6¢) |
| reply | 92.3M (5.5¢) | 104.2M (6.3¢) |

A four-tag post costs 1.90 times a one-tag post, and a four-tag like 1.63 times a one-tag like; the estimator is conservative everywhere. The published contract adds the 80M-credit (4.8¢) moderators' fee to each post.

## Test content kept off the public feeds

Battery and CI e2e writes showed up at the top of Recent ("Battery Bot 0 · x2 timeline …", maximum-length walls). The test identities tombstoned their own posts and replies (each pays, storage refunds make it net negative), the battery blogs were removed by the maker as the interim moderator (about 15.4M credits, 0.9¢, each), and battery store items, reviews, shipping zones and kits were deleted by their owners. The newest 40 timeline posts hold no test content afterwards. #748 and its follow-up make the batteries and the CI e2e clean up after themselves.

Five test polls by the pollr battery's creator persona cannot be removed: a poll is immutable and its owner may delete it only while it has no ballot, and ballots (even withdrawn ones) are permanent. They are `7C23sXsb…`, `CDHtSVzB…`, `CxerMvxW…`, `ikxUZgY2…` and `2PtqoEUM…` ("Single/Multi/Closing/Voted/Withdrawn mv6uo27h?", options alpha/bravo/charlie). The follow-up runs the pollr battery on a separate test contract.

## Costs

| | credits | ¢ |
| --- | ---: | ---: |
| Identity creation fees (163 replays, paid out of the locks) | 21.17e9 | 1,270 |
| Maker (burn, DPNS, 11 contracts, mints, sponsored seed gas, moderation) | 347.74e9 | 20,864 |
| All other identities (DPNS, anchor keys, grants, profiles, seeds, E1 fund, batteries, cleanup) | 434.07e9 | 26,044 |
| **Total** | **≈ 803e9** | **≈ 48,180** |

The maker kept 1,152.1e9 (69,128¢) at identity nonce 34, 77% of what the replay restored. The treasury (5.55 DASH) was not touched.

## Open items

- E1 seats about 2026-10-20 14:53Z; then `verify-v10 --only r2`.
- The iOS and Android release candidates need a rebuild on the 5.0.0-beta.6 SDK with these ids and topology v16. The engine shares `lib/`, and the persona pools keep their identity ids. The rebuild picks up #749 (bcd7104f): the mobile app's first wallet sign-in registers the anchor messaging key, and the mobile "Set up messaging" never re-adds a disabled key.
