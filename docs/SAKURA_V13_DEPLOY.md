# The v13 set on sakura (2026-10-07)

`/devnet` moves from social v12 to the mainnet candidate set: social v13 ([SOCIAL_V13.md](SOCIAL_V13.md)), the blocks contract, pollr v5, blog v7 and storefront v6 ([NON_SOCIAL_CONTRACTS.md](NON_SOCIAL_CONTRACTS.md)). The chain is the one [PLATFORM_V5_BETA2_UPGRADE.md](PLATFORM_V5_BETA2_UPGRADE.md) re-created after the 2026-10-06 wipe. It was not wiped again, so every identity, the maker, the contract group and the six contracts that did not change are kept. This is the first time the v13 shapes ran live.

## Contracts

The maker `GuNNAm7PZHKR67DKg1BbsivjPdEqHqV9Vr2e7KvPkhQM` registered the five contracts at identity nonces 11 to 15, in nonce order, after unsigned and signed dry runs. Every transition was decoded by the 5.0.0-beta.2 wasm-sdk (byte-identical re-encode, nonce, the carried contract equal to the assembled one) and by wasm-dpp2 (full parse) plus `auditNodeRules`. No group was registered: each create joined the existing group `AEEpKL9ZhwGgGkKpmiwLPVsjM8zwpT6ELJXtkFa7P1Lq` (social v12 registered it at nonce 1), which now enumerates 15 contracts. The five creates cost the maker 209.9 × 10⁹ credits (about 2.1 DASH).

| Nonce | Contract | Id | File sha256 | Signed create | Registered from |
| ---: | --- | --- | --- | ---: | --- |
| 11 | social v13 | `6ABCzyyXNus9jKfWvGJUEgzk1FxPFDUK6B7PS1fK51Wr` | `d58a25cb6a4cb4a2652112fc04c584f142d6f9b2dfbd63f7f31530beac79b81f` | 18,823 B | staging (#690) |
| 12 | blocks | `8zJG5EZuPGycLan5JVw6eZArPRqT1pYewrL7FLEw6wPC` | `45f04cba5f81db446cc4846ab36d32e949a99ce2068f31572a9ab5c23ae4a850` | 1,428 B | staging (#690) |
| 13 | pollr v5 | `BX94nj87AZ61KpU2Vqv4oPUu5N4b4YrKrvHvfB833Q3z` | `9434ee427b27b7cd14d4d9c46267f06067cf8a5f096b217667853b7ac391d8b3` | 4,003 B | #691 head `d965e578` (the contract last changed in `581cdc99`) |
| 14 | blog v7 | `BQyfE9bqHPejKaHKbrZh4ZfRFgUZAa8AqPMPJmH13wq2` | `a04df9156216fc0644e8b924f17ce6e8fa2e008bedf0950fe363214e1cd5c467` | 7,009 B | staging (#692) |
| 15 | storefront v6 | `EDr9McRVsuRZ1J52crVkiESrJ2uKTasj2WNGuZvPZ6w8` | `c6c9c67822ed66231199c40e7a9deabde1fa36bd8f0e31ea0afb4c8c3265067a` | 17,209 B | #693 head `4c4d70e3` (the contract last changed in `2795ba0f`) |

- Social v13 published at 18,823 B, within a byte of the validator's 18,824 B estimate (v12's estimate was 65 B short of its live size).
- Blog v7 and storefront v6 dropped their YAPP costs for action fees, so neither embeds the social id any more: no `SOCIAL_CONTRACT_ID` substitution was needed.
- **Moderation.** Social, blog and storefront registered with the files' elected declarations: a 7-day join window, a 3-day vote window, a contestable seat with a 30-day cool-down, `maxAddedModerators: 10`, `ownerProtected`, and the `contractOwner` interim (passed explicitly through `withInterim`; on a devnet it is the file's own). There is no per-network window override, so the mainnet windows are what sakura runs: a team seats 7 days after its application if no one contests it, 10 if someone does. Until then the maker moderates as the interim owner.
- **YAPP** (social token 0) is `ChNexmVJnMbJvDtu1aCkjaJ5GVEKXbbv8EdZqtmgsEcw`. It starts paused with no price: a maker transfer is refused 40711 and a direct purchase 40721, and nothing moved.
- **Readback** (an independent script that re-assembles each pinned file itself): **101/101**. On-chain bytes (chain metadata stripped) equal each pinned file. Also checked: the ids are `generateId(maker, nonce)`; owner and version; group membership; document types, moderator abilities, rule names, `ttl`, action fees and the elected declaration (hand-written from the docs); the v13 shapes (no block types, `live` const, `reply.rootOwnerId` bound by `rootPostId.where`, no `likeReply.replyAuthor`, report `about`/`box` and its five indexes, `mediaUrls`); YAPP paused with no price; the ten 2026-10-06 contracts still present and enumerated.
- **Kept:** key backup (nonce 2), key exchange (3), vault (4), auth vault (5), DM v4 (8), DM v5 (10). **Superseded**, still on chain: social v12 (1), storefront v5 (6), blog v6 (7), pollr v4 (9).

## Moderation election E1 on social v13

tess1999 (`AhRvJuA9…`) leads; alice7 (`CYFGdG38…`) and battery bot 1 (`GtZu3frU…`) joined through join requests, so they count for every document (platform#5260). The charter reuses the leader's reasons SPM, ABU and REP (`HaGfrkp4DZQ3T5xYuZYAyJuzkeUkmSRAfrRSpZxRRn4K`), with a 60 % moderators' share split 40/30/30.

| Step | Document |
| --- | --- |
| submitted charter | `6uSFp9ZSKCMNiMLCtEiQP6mQHpaYF1kEjy8c8mm2F2v6` |
| join requests | `4HxAYpEJC1PaigfWzaKA5TPdMp5hAwFHM51Zx7dT4G4k` (bot 1), `CCC9RbnMWEnk2Q8pjXV8QQzRbknkEPeRiVoHo5Vxm6b` (alice7) |
| electedCharter (contest fund 0.5 DASH) | `6RhCUyJuQV3SspiutJhtb1JWDUDyTx2RtdgXRzHSgYHX`, applied 2026-10-07 05:37Z |

The contest window ends at 2026-10-14 05:37Z. **Seating is blocked on sakura:** an election test campaign found a Platform bug that permanently stops the chain from awarding contested polls. Second-applicant moves leak empty end-date trees, which wedge `check_for_ended_vote_polls`. Until Platform fixes or cleans the chain, the charter stays filed and unseated, and no further charters are filed on sakura. The maker moderates social, blog v7 and storefront v6 as the interim owner.

## Data

- Starter grants (100 YAPP) claimed for the maker, CI, the personal account, the battery bots and the DM bots (14/14). DashPay profiles survived; the 13 special `yapprProfile` extensions were re-created on v13. The maker minted CI 4,000, personal 10,000 and bots 0/1 4,000 YAPP each.
- The 148 corpus and non-social personas were re-profiled on v13 and each claimed its grant (the provisioner resets a persona when the social contract changes). Seed authors 1, 5, 11, 19 and 27 were minted up to 400 YAPP.
- **Seed: 800/800** in 193 s, 0 failed (426 follows, 285 posts, 58 likes, 30 replies, 1 quote).

## Batteries

Run serially on the production contracts above. Each run waits for a proved read first.

| Battery | Result |
| --- | --- |
| contract readback | 101/101 |
| pollr v5 | **50/50** |
| blog v7 (`--moderator maker`) | **103/103**. The first run passed 101; b3c and b12b failed for battery reasons fixed in this PR (below). With the fixes, a second full run passed 102, and b23, aborted by a "no available addresses" read, passed on re-run. |
| storefront v6 (`--moderator maker`) | **132/132**: 131 in the full run plus s4f (a "Quorum not found in cache" read), which passed on re-run. The first run used the #693 head the contract was registered from; its s4b/s22k shape helpers dropped the `buyerId` they probe, a battery bug fixed on staging in `e186681e` before the rerun. A hand-built probe confirmed that consensus refuses the undeclared property (10101). |
| DM v4 | **31/31** |
| DM v5 | **107/107** |
| tips | 6 PASS, 5 SKIP (YAPP is locked, so tips are credit tips) |
| `verify-v10 --contract-file …v13.json --blocks-contract <blocks>` (interim owner) | **274 PASS, 0 FAIL**, 6 SKIP, all by design: o2a and n2e/n2ex/n2gc (v13 has no `likeReply.replyAuthor` or reply-like author counter), r2 (no team is seated yet), and x3a and y1f–y1g (the fresh-bot run below) |
| `verify-v10 --only k2 --poor 3` | **1/1** (run before the fresh-bot run, which claims bot 3's grant) |
| `verify-v10 --only x3,y1 --fresh-bot 3` | **14/14** |
| `prove-merged-counts --contract-file …v13.json` (throwaway copy `8RnxdKmv…`) | **162 PASS, 0 FAIL**, 2 SKIP (v13 has no reply-like author counter: ol-e6, cn-f1s–cn-f3). Includes the live marker (lv-1 to lv-5: `live: true` on a new post; the author count, timeline and top creators drop a tombstone) and the bar on banned and suspended authors (rw-*). On the first copy (`62hrbPEW…`) ol-x1 and ol-x2 failed: their poll gave a trend window 100 s past its expected expiry, and an idle sakura makes a block only every few minutes, while windows pass in block time. The grace is now 10 minutes, and the second copy passed. |
| devnet topology e2e (local `/devnet` build) | **22/22** |

Battery fixes in this PR:
- **blog b12b** re-dated `publishedAt` a day ahead. Blog v7's `publishedNotAhead` (10422, judged before immutability) refused it first, so the case never reached the 40128 it pins. It now back-dates.
- **blog b3c** (a comment without its action fee agreement, 40132) went through the SDK facade. The facade's cached identity contract nonce was behind after the actor's hand-built agreed creates, so it reused a spent nonce. A no-agreement create by a persona is now hand-built too, with the nonce read off the chain.

## Live fees

The credits each confirmed write cost its signer (balance before and after), each measured 3 times. Cents are at $60/DASH, where 1M credits = 0.06¢. The fee multiplier was 1000‰.

### Pollr v5, blog v7, storefront v6

Measured on the production contracts by non-social personas 303 to 307. The action fee goes to the contract's moderators' pot.

| Write | Mean | ¢ | Action fee | Network fee |
| --- | ---: | ---: | ---: | ---: |
| poll (3 options) | 45.7M | 2.74 | — | 45.7M (2.74¢) |
| vote (a first ballot) | 65.9M | 3.95 | — | 65.9M (3.95¢) |
| blog | 143.8M | 8.63 | 80M | 63.8M (3.83¢) |
| blogPost (512 B body) | 156.3M | 9.38 | 80M | 76.3M (4.58¢) |
| blogComment | 75.9M | 4.55 | 16M | 59.9M (3.59¢) |
| store | 1,079.7M | 64.78 | 1,000M | 79.7M (4.78¢) |
| storeItem | 83.4M | 5.00 | 50M | 33.4M (2.00¢) |

The first write of each kind cost more than later ones (a new index path): the first poll 56.8M against about 40.2M after, the first ballot 71.6M against 63.1M, the first store 103.0M of network fee against about 68M.

### Social v13

`scripts/measure-social-fees.mjs` on a throwaway v13 copy (`6WTjesqy…`), registered and written by battery bots 0 to 3. The copy carries the file's indexes, references, preallocation, moderation and rules but no YAPP costs or action fees, so the figures are network fees. A live write adds its action fee on top: 80M for a post (quote, repost), 16M for a reply, 50M for a report. Means of 3 runs (6 for the "later" likes). The v12 column is the 2026-10-06 measurement ([SOCIAL_V12.md](SOCIAL_V12.md#measured-costs)).

| Write | v13 live (network fee) | ¢ | + action fee = total | v12 live |
| --- | ---: | ---: | ---: | ---: |
| post, 140 characters | 97.9M | 5.87 | 177.9M (10.67¢) | 94.6M |
| post, tagged | 122.4M | 7.34 | 202.4M (12.14¢) | 121.8M |
| post, one image | 85.5M | 5.13 | 165.5M (9.93¢) | — |
| post, four images | 91.0M | 5.46 | 171.0M (10.26¢) | — |
| quote | 144.8M | 8.69 | 224.8M (13.49¢) | 142.3M |
| repost (a bare quote) | 146.7M | 8.80 | 226.7M (13.60¢) | 142.2M |
| reply | 94.0M | 5.64 | 110.0M (6.60¢) | 102.7M (−8.7M on v13: no reply-like author counter) |
| like (first / later) | 15.4M / 16.1M | 0.93 / 0.97 | — | 14.7M / 15.9M |
| like, tagged post (first / later) | 20.6M / 20.0M | 1.24 / 1.20 | — | 20.2M / 19.7M |
| reply like (first / later) | 9.6M / 9.7M | 0.57 / 0.58 | — | 9.7M / 9.8M |
| report a post | 10.1M | 0.61 | 60.1M (3.61¢) | — |
| report a profile (`about: 1`) | 10.2M | 0.61 | 60.2M (3.62¢) | — |
| unlike / unlike tagged / reply unlike (refunds) | −3.8M / −3.4M / −5.8M | | | |
| tombstone (refund) | −17.3M | −1.04 | | |

- The first post of each run pays for new index paths (126.1M in run 1, about 84M after), so the 97.9M post mean sits between the two. The estimator's "later" figure (74.8M) is close to the steady state.
- Image posts measured below the plain post because each ran after the author's posts already existed: per image, a post costs about 1.8M more (85.5M for one, 91.0M for four).
- A tombstone now refunds 17.3M (about 1¢), where v12 refunded about 0: leaving out `live` takes the post off `ownerAndTime` and its counters.
- Reply likes and replies are cheaper (no `byAuthorReply` counter). Likes and posts are within noise of v12.
- The estimator overstates every like and report (74.4M against 15.4M for a first like, for example). The live figures are the ones to quote.

## Where the ops live

`~/.local/share/yappr-sakura-20261007` (private, 0700; keys by reference to the 2026-10-06 dir). Its `RECOVERY.md` has the full run book. The tools: `ops/publish-v13.mjs` (the incremental publisher), `ops/verify-v13-contracts.mjs`, `ops/reestablish-v13.sh`, `ops/run-batteries-v13.sh`, `ops/measure-feature-fees.mjs` and `ops/election/`.

## Open items

- E1 cannot seat until Platform fixes the vote-poll wedge (above). Once a team is seated, run `verify-v10 --team-member bot:1 --reason-doc HaGfrkp4…` for the seated-team cases (r2, settled deletion through the team).
- Blog v7 and storefront v6 moderation is the maker's until someone files a charter on them.
- The LE IP certificates on the sakura nodes expire 2026-10-11 and have auto-renewed before.
