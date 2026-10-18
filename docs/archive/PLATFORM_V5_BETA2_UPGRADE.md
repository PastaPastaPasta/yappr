# Platform 5.0.0-beta.2: SDK, social v12 and the sakura redeploy

On 2026-10-06 sakura moved to drive/rs-dapi **5.0.0-beta.2**, still protocol 14. Its **Platform chain was wiped** and restarted at block 1. Core was kept, at chainlocked height ~50.8k. Every yappr contract and identity on sakura was gone, so `/devnet` was down until the redeploy below. The previous cut-over, onto 5.0.0-beta.1, is [PLATFORM_V5_BETA1_UPGRADE.md](PLATFORM_V5_BETA1_UPGRADE.md); every sakura id in that document is dead.

| PR | What |
| --- | --- |
| #686 | `@dashevo/evo-sdk`, `wasm-sdk` and `wasm-dpp2` 5.0.0-beta.2 in lockstep; the beta.2 document meta-schema v3 vendored; consensus error 41212 mapped |
| #687 | social v12 ([SOCIAL_V12.md](SOCIAL_V12.md)), topology `v12`, the v12 like-notification client, and the `/devnet` cut-over (`.env.devnet`, the `devnet-sakura` bundle) |
| this | the live fee table in SOCIAL_V12.md, this record, the tombstone e2e expectation for v11/v12, and simplifications of the v12 client |

## What beta.2 brought, and what yappr took

| Platform PR | Keyword or rule | yappr |
| --- | --- | --- |
| #5250 | `summableOffCountIndex`: one counter per group of another index | **Taken in v12** on `like.byAuthorPost`, `like.byHashtagPost` and `likeReply.byAuthorReply`. Live: likes cost 34–45% less. |
| #5250 | a range total through a ranked level is refused | No client query needs one. Every grouped read groups by the last property. Proven refused on `byAuthorPost` and `byPost` (cn-c). |
| #5253 | `retractedWhen`: a banned or suspended author may still write the declared retraction | **Taken in v12** on post and reply (`{ "present": "deleted" }`). It closes open decision 3 of the 2026-10 moderation QA. Not on blog, which has no tombstone shape. |
| #5260 | with `approvals` above 1, a member the leader added counts only for documents created after its addition (41212); `approversPredateDocument: false` lifts the rule | The default is kept (user decision). E1's members are elected through join requests, so they always count. 41212 is mapped to `TEAM_MEMBER_ADDED_AFTER_DOCUMENT`. |
| #5294 | clients refuse GroveDB V0 proof envelopes | Nothing to do: the beta.2 node proves V1, and the beta.2 SDK reads it. |
| #5239, #5284, #5240, #4760 | `onlyWhenConsumed`; refusing a by-id `refersTo` into an indexOnly type; contested sum bounds; token shielded pools | Not applicable: no `consume`, no such reference, no contested types, and YAPP is non-transferable. |

The SDK's API change is additive (shielded token transitions, an optional `platformVersion` on asset-lock builders). Every staging contract still parses through both wasm parses and the beta.2 meta-schema.

## Sakura after the wipe

| | |
| --- | --- |
| Network | Core `devnet-sakura` (kept), Platform chainId `dash-devnet-sakura`, protocol 14, dapi/drive 5.0.0-beta.2, 13 validators |
| DAPI | unchanged: `https://68.67.122.{86,87,240,241,88,89,90,91,92,93,94,95,232}:1443`. The Let's Encrypt IP certificates renewed and **expire 2026-10-11**. Watch the auto-renew again. |
| Quorums / insight / faucet | unchanged ([PLATFORM_V5_BETA1_UPGRADE.md](PLATFORM_V5_BETA1_UPGRADE.md#sakura-the-devnet-cut-over)) |
| Quirks | The quorum service still lists only the newest 4 quorums. During a rotation, every proved read fails with `invalid quorum: Quorum not found in cache` for a few minutes; the ops tooling waits for a proved read before each run. `no available addresses to use` also shows up transiently. |

### Identities

The private ops directory `~/.local/share/yappr-sakura-20261006` (mode 0700) holds the ledgers, keys, logs and `RECOVERY.md`. The 2026-10-01 directory was only read.
- **All 163 identities were re-created** from new asset locks with the **same keys**, so every id is new: maker, CI, personal, 100 corpus and 48 non-social personas, battery bots 0-2, the fresh bot 3, and DM e2e bots 1-8.
- **Readback:** 163/163 present with matching keys, and 159/159 DPNS names resolve. Battery and fresh bots are unnamed by design.
- **Funding:** the treasury held 69.35 DASH, plus 4 sakura faucet drips. One split paid 163 asset locks (80.9 DASH): maker 15, bots 0-2 4 each, personas 0.3 each.

| Role | Id |
| --- | --- |
| maker (deployment seed index 9) | `GuNNAm7PZHKR67DKg1BbsivjPdEqHqV9Vr2e7KvPkhQM` |
| CI (`yappr-ci-devnet-260915`) | `7misd2AZpvZcrHZ2bh6TK8fi5WLg9i99Hp6esSZVU9ge` |
| personal (`pasta-yappr2`) | `EtUvC7e7HUbkTnewPnJUhorVJmgrMxnc73LzJzK5uh8Y` |
| battery bots 0 / 1 / 2 | `3T93xWB2…`, `GtZu3frU…`, `7teyUpG7…` |
| fresh/poor bot 3 | `7RGH5bG3cD7Kch1uvT4o6mUMWgwQ2F1q151dNyTdCzoq` |
| DM e2e bots 1-8 | in `.env.devnet` (`E2E_IDENTITY_IDS`, after the CI id) |

The maker got its DPNS name before the publish. A name registration uses the per-contract nonce for DPNS, not the identity nonce that contract creates use, so the publish still started at nonce 1.

### Contracts

Published 2026-10-06 by the maker (`ops/publish-sakura.mjs`, unsigned and signed dry runs first). Ids are `generateId(maker, nonce)`, nonces 1-10. All ten are in contract group `AEEpKL9ZhwGgGkKpmiwLPVsjM8zwpT6ELJXtkFa7P1Lq`, registered on the social create. The readback (`ops/verify-v10-contracts.mjs`, `LAYOUT=sakura`) passed **158/158 with 0 problems**.

| nonce | contract | id | source sha256 |
| ---: | --- | --- | --- |
| 1 | social v12 (topology `v12`, 19,877 B signed) | `78osKsoZq4X5AyRSn9C9fb92oHQ172qEUFw8Q1v6hS5G` | `5b9cf0cc…` |
| 2 | key backup | `ABQquoabTMDgQfCwzNU8zzeZKqiTRSXuNAqiRarhWSDT` | testnet snapshot |
| 3 | key exchange | `72KngCJcWg3EFcGTuofX4C8vkUZeZ1H2eL9EHHehGNBU` | testnet snapshot |
| 4 | vault | `6DkcKegt1iMtNzykqUbsJxfNhQZy3B3JqLhsGh3DiVXZ` | testnet snapshot |
| 5 | auth vault | `BNZ2g3eMcBuXFPWTohdJ5uX5qiTMNaR36QG2B4i3PrHK` | testnet snapshot |
| 6 | storefront v5 (embeds the social id) | `BQ8scEEDkLnmszu1JT5vFPkE2ppHhHiufSdYU6s7pEp3` | `ecd08e76…` |
| 7 | blog v6 with D5 (embeds the social id) | `z6vieQYH3iiGaYxSnRpW44i5MnckSkuYtEvzhNCCCfV` | `c5a2c9cd…` |
| 8 | DM v4 | `524SSp62bNepp3Twi4haMwx5F66deDP1kQFqUx3cwqpF` | `7a86b1d2…` |
| 9 | pollr v4 | `7VB2hBnAa8835BM7KqEtdNxxFpGF17JWey3FnLadqb18` | `dbc80063…` |
| 10 | DM v5 | `6BXefMngy7hP72dCvrzqDeybUk3k5kbqNHTCioeYGAtD` | `82c03a3c…` |

- **YAPP** (social token position 0) is `9Dk2zA32FDtDLxbTotedhV5rmVEEErkkqYHtaG3ChZxg`.
  - It is paused and never priced: a transfer is refused 40711 and a purchase 40721 (`ops/yapp-lock-check.mjs`).
  - 14 starter grants were claimed (maker, CI, personal, bots, DM bots).
  - The maker minted 4,000 each to CI and bots 0/1, 10,000 to personal, and 400 each to the five most prolific seed authors.
- **The maker is at nonce 10** after the publish, with ~1,184e9 credits.
- **Next maker nonce: 11 or later.** Any further registration on sakura (for example a storefront v6) takes it and must embed the social id above.
- `lib/contracts/bundled/devnet-sakura.json` snapshots these ten plus DashPay (`--prune`).

### Moderation election E1

- **Filed** right after the publish with `ops/election/`:
  - leader tess1999 (persona 5, `AhRvJuA9WbiBUW1xGRLCUiyRajM2Eo56S4ik3yEFJKD8`), topped up by 1 DASH from the treasury for the 0.5 DASH contest fund;
  - reasons SPM, ABU and REP (REP is `HaGfrkp4DZQ3T5xYuZYAyJuzkeUkmSRAfrRSpZxRRn4K`);
  - submitted charter `6kiTPiturzSefwfV5fpwth5juakNpc64txMbBWQ6RFP3`.
- **Members** alice7-sept (persona 0, `CYFGdG38qmSokBwBv96Ua7BxExNwMj1K5Lk2N8FZKPku`) and battery bot 1 (`GtZu3frU…`) joined by **join request**. They are elected members, so #5260 counts them for every document. A leader-added member would not count for posts older than its addition.
- **Applied** at 18:22Z (elected charter `474LaWkbjTYb2TvZcqvW2JyFC7b7fRxo3at8z3bsbbFb`) and **seated** an hour later. `/devnet/contract` shows it.

### Seed

- `scripts/seed/provision-seed-identities.mjs` readied all 148 personas: profiles, `yapprProfile` and the 100 YAPP grant.
- `scripts/seed/run-seeder.mjs` with `ops/corpus-800.jsonl` ran **800/800**.
  - The first pass left 26 ops failed: five heavy authors ran out of YAPP before their 400-YAPP mint.
  - After the mint, a resume ran exactly those 26.

## Proof

- **Throwaway v12** (`43C4JawyXSVDmz3RBA9A3zgZtFTzdnnbMwFqtBHw6Lno`, registered by bot 0): `scripts/prove-merged-counts.mjs` passed **158/158**. It covers the counters, the rankings, the refused range totals and documents reads, preallocated zeros, unlike decrements, and `retractedWhen` under a ban and a suspension. Details are in [SOCIAL_V12.md](SOCIAL_V12.md#live-proof-on-sakura-500-beta2).
- **Fees:** v12 against a v11 copy on the same chain ([SOCIAL_V12.md](SOCIAL_V12.md#measured-costs)).
- **App against sakura:**
  - The devnet topology e2e passed 21/21, exercising post, reply, like and unlike (tagged and untagged), the tag page, trending, creators, profile Top and the trend windows.
  - The one remaining spec expected v9's in-place tombstone card. On v11/v12 a tombstoned leaf reply is dropped from the thread, and the spec now says so.
  - The notifications page loads signed in.
- **Batteries on the production contracts:**

Logs are in the ops dir as `ops/battery-*-v12.log` and `ops/verify-v12-*.log`, run by `ops/run-batteries-v12.sh`, which waits for a proved read before each run.

| Battery | Result |
| --- | --- |
| `verify-v10 --contract-file …v12.json --team-member bot:1 --reason-doc <REP>` (social v12, team seated) | **196 PASS, 0 FAIL**, 12 SKIP: the interim-owner cases a seated team refuses (w1, m1, m2, x1tn, x3f, x4, r1j–r1s, a4, s1) and the fresh/poor-bot cases run separately. x4 (`retractedWhen`) is proven on the throwaway above. |
| `verify-v10 --only x3,y1 --fresh-bot 3` | 13 PASS, 1 SKIP (x3f, interim owner) |
| `verify-v10 --only k2 --poor 3` | SKIP: the fresh-bot run claimed bot 3's grant first, so no YAPP-less bot was left. Run k2 before y1 next time. |
| pollr v4 | 41/41 |
| DM v4 | 31/31 |
| DM v5 | 107/107: 106 in one run, plus `invitequery` re-run 12/12 after a quorum-cache flake on q1c |
| blog v6 (`--moderator maker`) | 81/81 |
| storefront v5 (`--moderator maker`) | 105/105 |
| tips | 6 PASS, 5 SKIP (YAPP is locked, so tips are credit tips) |

The blog and storefront batteries default to moderator persona 260. The publish appoints `[personal, maker]`, and `personal` (persona 900) is not in the seed ledger, so pass `--moderator maker`.

## /devnet

The staging Pages deploy of #687 (run 37517414652) republished `/devnet`. The served bundle carries `78osKsoZ…` and topology `v12`. Home, explore (trending tags off the v12 counters), the feed and `/contract` (E1 seated) render with no page errors.

Remember that a master-triggered Pages deploy drops `/devnet` (deploy.yml's devnet step is staging-only). If that happens, redeploy with `gh workflow run "Deploy to GitHub Pages" --ref staging`.
