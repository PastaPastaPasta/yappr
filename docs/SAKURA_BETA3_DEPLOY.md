# Sakura after the 5.0.0-beta.3 wipe (2026-10-08)

Sakura's Platform chain was wiped for 5.0.0-beta.3 at about 18:12Z on 2026-10-08 and restarted at height 1. Core was kept (chainlocked ~68.6k), so the treasury's UTXOs survived. Every Yappr identity, contract, DPNS name, the contract group, YAPP, the seed data and election E1 were gone. This record covers the rebuild and the `/devnet` cut-over to the new ids: social v14 ([SOCIAL_V14.md](SOCIAL_V14.md)), pollr v6 and the unchanged blocks, blog v7, storefront v6, DM v4/v5, key backup, key exchange, vault and auth vault ([NON_SOCIAL_CONTRACTS.md](NON_SOCIAL_CONTRACTS.md)). The SDK is 5.0.0-beta.3 ([PLATFORM_V5_BETA3_UPGRADE.md](PLATFORM_V5_BETA3_UPGRADE.md)). Credit costs are paired with cents at $60/DASH (1M credits = 0.06¢).

## Identities

All 163 identities were re-created from new asset locks with the **same keys**, so every id is new. The treasury held 27.45 DASH; six sakura core-faucet drips (10 DASH each) brought it to 87.45, and one split funded 163 one-shot asset-lock addresses (80.9 DASH: maker 15, CI 3, personal 0.5, 100 corpus and 48 non-social personas 0.3 each, battery/proof bots 0–2 4 each, the fresh bot 3 2, DM bots 1–8 0.5 each). Two creates hit sakura's "Quorum not found in cache" and landed on a second pass. 159 DPNS names were re-registered (the battery bots stay unnamed by design); a proof-backed readback matched all 163 key sets and resolved all 159 names to their new ids.

| Role | Id |
| --- | --- |
| maker (`yappr-maker-260929.dash`) | `9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH` |
| CI and DM e2e bots 1–8 | `E2E_IDENTITY_IDS` in `.env.devnet` |
| battery/proof bots 0, 1, 2 | `H9ytLzCNWfh8Q4Ho6hEJaLT8Vj1UYUzmsGFuz9SE2VvQ`, `HwBSXMB7Tiam91bKUTaFpLdChLEaKz7Ugew5bEfBgpjk`, `93WXKyy7WtEzLyzACc7SCH1wYLHTqqXFw8etm6VzR58d` |
| fresh/poor bot 3 | `AUTRHQvyBZ1FJyhk8B6GfAgTMV8xULWKAcxzCsqPL6GK` |

## Contracts

One publisher registered the whole `/devnet` set at maker nonces 1–11, after unsigned and signed dry runs. Every transition was decoded by the 5.0.0-beta.3 wasm-sdk (byte-identical re-encode, nonce, the carried contract equal to the assembled one) and by wasm-dpp2 (full parse) plus `auditNodeRules`; every source is sha256-pinned.

**The contract group is registered by the first create** (key backup, nonce 1), not by social as on v12. A group is a named, enumerable family of contracts and the scope of group-bound keys; nothing in a contract, the client or the tooling depends on which create registers it, and its id is `contractGroupId(maker, 1)` either way. Registering it on nonce 1 let the nine unchanged contracts publish while social v14 and pollr v6 were still in review. No contract embeds another's id; social's only cross-contract reference is DashPay's `profile`, a system contract that survived the wipe.

Group `Cxxdiq5bBMFr2j8H1ug4hKaDqv7CcVYMt8PPvopj2rDF`, 11 members.

| Nonce | Contract | Id | Source sha256 | Signed create | Cost |
| ---: | --- | --- | --- | ---: | ---: |
| 1 | key backup (registers the group) | `Abe7MfKpUysqjGTvbYBo5KAEpgxwXVHX8uxWAaAYm52C` | testnet snapshot | 1,056 B | 13.1e9 ($7.86) |
| 2 | key exchange | `AidVzHpUNSDAq8Q79EiYpnrhCpkZrv1FuYhDMkES1nZg` | testnet snapshot | 1,460 B | 14.1e9 ($8.46) |
| 3 | vault | `FbZ45amM1dnRbxD2ZngfhzJ9Mngj1tbnp7mDVGQKSDxb` | testnet snapshot | 659 B | 13.1e9 ($7.84) |
| 4 | auth vault | `AfkTRtNUfAuF2CckhNE5CYEEhGsBBQGfMEBGm82wbh5g` | testnet snapshot | 2,219 B | 17.1e9 ($10.28) |
| 5 | blocks | `2huLPRT5KsC3gmbCtQ2EdWNaP697owVNCforoxDpPnXx` | `45f04cba…` | 1,428 B | 19.1e9 ($11.47) |
| 6 | blog v7 | `4F1Wi4dim7j6eWrFQ3aHWEB9az5dHcJBmdvMvpx7sx1j` | `a04df915…` | 7,009 B | 29.3e9 ($17.60) |
| 7 | storefront v6 | `5qh1gpJY36bkEXb4PMPJ2E1VhRxZZ796FHFGWu3oCmhk` | `c6c9c678…` | 17,209 B | 51.7e9 ($31.00) |
| 8 | DM v4 | `8a1p5yGq5rJMpWyEm25PEnDcC3kTNWGq3t8au25vC2EX` | `7a86b1d2…` | 2,737 B | 20.2e9 ($12.09) |
| 9 | DM v5 | `4PU6mxANMUXaApgkUNq7VzmftMmbk8p2fUeFoiqRS79D` | `82c03a3c…` | 3,673 B | 22.2e9 ($13.31) |
| 10 | social v14 | `6GrRBNDe7r5JXZFr9XgUETKACzvrUZjHdfgKCYCMcc9y` | `b18f7c82…` (staging `5552f4de`, #702) | 17,974 B | 91.8e9 ($55.08) |
| 11 | pollr v6 | `Fq5yTk2YqJZ2wa7uESKB119nX3ea23QP2gUsLqGtEu8c` | `fa081adf…` (#701, unchanged since `dc846d95`) | 4,256 B | 19.2e9 ($11.51) |

**Pollr v6 is registered but not wired yet:** the client's v6 topology arrives with #701, so this cut-over blanks `NEXT_PUBLIC_POLLR_CONTRACT_ID` (polls off: nothing reads, embeds or offers a poll) and a follow-up sets the id and `NEXT_PUBLIC_POLLR_TOPOLOGY=v6`.

The eleven creates cost the maker 330.8e9 credits (about 3.3 DASH, $198). Social v14 published at 17,974 B against the doc's ~17,975 B estimate.

- **Moderation.** Social, blog and storefront registered with the files' elected declarations (7-day join, 3-day vote, a contestable seat with a 30-day cool-down, `maxAddedModerators: 10`, `ownerProtected`, `contractOwner` interim). The maker moderates as the interim owner until a team is seated.
- **YAPP** (social token 0) is `AMrtbchVQGGhgJR5CrGyn8qFZdfPoY3C4CqweA7qM9Jw`: **unpaused** and unpriced. A direct purchase is refused 40721 and nothing moves.
- **Readback** (an independent script that re-assembles each pinned source itself): **159/159**. On-chain bytes (metadata stripped) equal each pinned source; ids are `generateId(maker, nonce)`; owner, version and group membership; document types, moderator abilities, `propertyConstraints` and `deleteConstraints` rule names, `ttl`, action fees and the elected declaration (hand-written from the docs); the v14 shapes (no stored reply owners, the derived `rootOwnerRecent`/`parentOwnerRecent` windows, `report.deleteConstraints.pending`); YAPP unpaused, never pausable and unpriced.

## Election E1 on social v14

tess1999 (`ArJTzdaFpQfeARjmrZYSiNd7zirkbkevDubNczY8tYP3`, topped up 1 DASH from the treasury) leads; alice7 (`4mKsqgo71nxEpeWEgHA2hW7QZUXTNZEChyZyXKfkBJFw`) and battery bot 1 joined through join requests. The charter lists reasons SPM, ABU and REP, with a 60 % moderators' share split 40/30/30.

| Step | Document |
| --- | --- |
| submitted charter | `BWnb37rYd4AhLRgXr9gnmDKoWn9z27CFDvDuazGMwFzR` |
| join requests | `Be7tszoUqofSAdTp5ERfigo6poe1XbwrzoMPGDtWdm6u` (bot 1), `6eGHxQgbxVV2WLkmEUmgBZvvwdnYUhzn9sUuCqMvQmFf` (alice7) |
| electedCharter (contest fund 0.5 DASH) | `GN7SWmrWh5a56uez7mSrGG7mWNXWcX9m2HFVWez2szRf`, applied 2026-10-08 18:54Z |

Uncontested, the seat is awarded after the 7-day join window, about 2026-10-15 18:54Z. Beta.3 fixes the vote-poll wedge that kept E1 on v13 from ever seating, so this is also the live retest of that fix.

## Data

- Starter grants (100 YAPP) for the maker, CI, the personal account, the battery bots and the DM bots; 13 special `yapprProfile` extensions (and their DashPay profiles). The maker minted CI 4,000, personal 10,000 and bots 0/1 4,000 YAPP each.
- The 148 corpus and non-social personas were profiled and each claimed its grant. Seed authors 1, 5, 11, 19 and 27 were minted up to 400 YAPP.
- **Seed: 800/800** in 320 s, 0 failed (426 follows, 285 posts, 58 likes, 30 replies, 1 quote). With YAPP unpaused, the seeder's v14 default pays YAPP for three quarters of the authors (the contract owner offered the gas) and credits for the rest: 2,323 YAPP and 40.0e9 credits ($23.98). **YAPP-paid writes land on beta.3**, which refuses them on a paused token (v13).

## Batteries

Run on the production contracts above, serially. Each run waits for a proved read first.

| Battery | Result |
| --- | --- |
| contract readback | **159/159** |
| `verify-v10 --contract-file …v14.json --blocks-contract <blocks>` (interim owner) | **281 PASS**, 2 FAIL, 6 SKIP. The 2 failures (o4, c1) are reads aborted by sakura's "Quorum not found in cache"; BATTERY_V14_RERUN. The skips are by design: o2a and n2e/n2ex/n2gc (no `likeReply.replyAuthor`), r2 (no team seated yet), x3a and y1f–y1g (the fresh-bot run), k2 (its own run). The v14 cases pass live: r1wa/r1wb (a reporter withdrawing a RESOLVED report is refused 40147, the report stays), n2a/n2i/n2j/n2k (the derived windows key each reply under the right owner), y1a (a 1-YAPP transfer lands), y1d/y1h and q1b (YAPP-paid post, reply and repost land, gas offered to the owner). |
| `verify-v10 --only k2 --poor 3` | **1/1** (before the fresh-bot run) |
| `verify-v10 --only x3,y1 --fresh-bot 3` | **16/16** |
| `prove-merged-counts --contract-file …v14.json` (throwaway copy `AcED42QGa3GTxGVpdF5tvWwkARKwmipvubfKqAgxTCKu`) | **164 PASS, 0 FAIL**, 2 SKIP (no reply-like author counter) |
| pollr v6 (`verify-pollr.mjs`, #701) | BATTERY_POLLR |
| blog v7 (`--moderator maker`) | BATTERY_BLOG |
| storefront v6 (`--moderator maker`) | BATTERY_STOREFRONT |
| DM v4 | **31/31** |
| DM v5 | **106/106** |
| tips | 6 PASS, 5 SKIP (tips are credit tips) |
| devnet topology e2e (local `/devnet` build) | E2E_RESULT |

## Sakura quirks

As on 2026-10-06: transient "no available addresses" and "Quorum not found in cache" (the quorum service lists only the newest quorums), and idle stalls. This run hit the quorum-cache error far more often than before; reads that exhaust their retries abort a battery case, which a re-run settles. No failure in this run was a contract or Platform finding.

## Ops

The private run book is `~/.local/share/yappr-sakura-20261008/RECOVERY.md` (publisher `ops/publish-beta3.mjs`, readback `ops/verify-beta3-contracts.mjs`, journal `deployment.json`).
