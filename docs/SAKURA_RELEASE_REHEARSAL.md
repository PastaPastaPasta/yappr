# Sakura release rehearsal — 2026-10-18

This rehearsal registers the complete release set on **devnet sakura only**, then moves `/devnet` to it through `staging`. Sakura remains on Platform beta.6 with protocol 14. Registration, batteries and seeding used SDK 5.0.0-rc.3; the final cutover integrates staging PR #797's SDK 5.0.0-rc.4 client baseline. No chain reset, testnet/mainnet broadcast, master branch change, or manual production deployment is part of this operation. The existing staging Pages workflow rebuilds the four published variants from their configured branches.

## Release set

Owner: `9RPq2JuMsmrTUoxQLricaT245t4bYskCj4hXWcedCagH`. Group: `8Ahhf3N5EnakHZyFTeDSmbfBGnpZpZWzz3CxH4DCr7hS`. All eight contracts are pinned at version 1. The bundled snapshot additionally includes the DashPay system contract at version 2.

Registration ran `--plan`, `--dry-run`, `--signed-dry-run`, then `--live --journal`, with `NETWORK=devnet --start-nonce 35 --interim notYetUsable --election-windows 3600,3600`. The maker's proved starting nonce was 34; its measured starting balance was 1,020,103,213,407 credits (61,206.19¢), lower than the historical runbook estimate.

| Contract | Nonce | ID | Inclusion H | Registration credits | Reference cost |
| --- | ---: | --- | ---: | ---: | ---: |
| app | 35 | `5wfKdCWAxH8oEtsbXXw4CWoBpWSF5JAyRTZkxfVJpD7F` | 28,291 | 13,094,976,810 | 785.70¢ |
| social | 36 | `5sgocKC9gg3RPYdTqnmWUgpatTDd5xzsdQLe6ADk6BnP` | 28,293 | 91,784,113,080 | 5,507.05¢ |
| blocks | 37 | `A9WdJPumwd4exLEkZBV7eXCab4MGvsSA1dRBcrbTiqD2` | 28,295 | 19,111,658,760 | 1,146.70¢ |
| dmV5 | 38 | `GRgZG766iFKEwREVqdCKmLEUyNoH1BUGXzKjxqVf84LC` | 28,297 | 22,184,199,310 | 1,331.05¢ |
| blog | 39 | `3HVUDF6Xgi8aNMc8bGyH5D445jtpx4gm1Xj3yNWLA7ep` | 28,300 | 38,426,982,040 | 2,305.62¢ |
| pollr | 40 | `AFZoNi1rTb3fLoAJfAuqRXeYnNnuqqc59ex2UMyeAfyp` | 28,302 | 17,161,388,680 | 1,029.68¢ |
| storefront | 41 | `GvumHxASNGRaogZBHSryzoYg6rx9mcHr1QX5DqBYpdSJ` | 28,305 | 60,739,804,950 | 3,644.39¢ |
| passkeyVault | 42 | `9wTMqLyXCbGRePZg2aBHGPpMYKDFpbuANbSLuh69RsSE` | 28,306 | 13,085,450,170 | 785.13¢ |

Total registration: **275,588,573,800 credits (16,535.31¢)**. Conversion throughout this record is 1M credits ≈ 0.06¢, a reference price rather than a fiat payment. The preflight estimate was about 279.43B credits, with a 335.32B signing reserve. Retired key exchange, password/auth vault, key backup and DM v4 were not registered.

**Height evidence:** Sakura's explorer API at `https://explorer.sakura.networks.dash.org/backend` reports the inclusion heights above. Each successful DATA_CONTRACT_CREATE transaction hash was recomputed from the saved signed bytes and matched exactly; every explorer fee also matched the measured registration debit. These are indexer observations, separate from the authenticated contract readback. Registration inclusion spanned 03:57:08.712–03:57:27.055 UTC. The preflight had proved epoch 109 at H=28,234.


## Moderation elections

Each release target has two distinct eligible teams, so all three elections exercise the full contested one-hour join and one-hour vote windows. Leaders are devnet personas, never the maker; each intended team has three members. Reasons are SPM (spam), ABU (abuse), ILG (illegal content), with a 60% moderator share and a 40/30/30 leader/equal/actions reward split.

| Target | Intended leader | Members (persona indices) | Rival leader (persona) | Join closes UTC | Election ends UTC |
| --- | --- | --- | --- | --- | --- |
| Social | `6ezxTNTH6yCbZyHZNzxiTg1HwKwepfNaMQEpPq8CJs5d` (60) | 61, 62, 63 | 72 | 04:57:18.857 | 05:57:18.857 |
| Blog | `7kMVm6UiCHuTFGdBoh6736oUJNkhk4xoTW38xp18fooa` (64) | 65, 66, 67 | 76 | 04:57:27.961 | 05:57:27.961 |
| Storefront | `8qFpPQajPQMS6D7iRyE1R9U1NDRy1Mh8qwBTsgjkyJiB` (68) | 69, 70, 71 | 80 | 04:57:39.546 | 05:57:39.546 |

| Target | Registration H | Proposal H | Application H |
| --- | ---: | ---: | ---: |
| social | 28,293 | 28,294 (H+1) | 28,299 (H+6) |
| blog | 28,300 | 28,303 (H+3) | 28,307 (H+7) |
| storefront | 28,305 | 28,308 (H+3) | 28,313 (H+8) |

These inclusion heights were resolved by the hashes of the saved signed charter transitions. Social reached the proposal H+1 target; blog and storefront reached H+3. Full-member applications followed the proposal and three joins; their heights are not described as H+1. Storefront’s rival opened its election at 03:57:39.546, before the intended application at 03:57:40.356. The earliest application determines its deadline.

The 48 release-charter document transactions cost **2,125,795,260 credits (127.55¢)** according to exact signed-hash matches in the Sakura explorer; this figure excludes bound-key identity updates. Six applications committed **300,000,000,000 credits (18,000¢; 3 devnet DASH)** as prefunded contest balances. This principal is separate from registration fees. Both storefront leaders received 0.3 devnet DASH through the existing treasury asset-lock path; transferred principal is not counted again as spend.

All 13 verified Sakura masternodes voted for each intended leader. Each target read back weight **52**, with every voter nonce advancing exactly once; verification completed at 04:58:38.425 (social), 04:59:10.046 (blog), and 04:59:38.512 UTC (storefront). The 39 votes draw **78,000,000 credits (4.68¢)** from the contest funds, already included in their principal rather than counted as another leader debit. The local lifecycle wrapper initially stopped on a voter-file wrapper/array mismatch before any vote broadcast or attempt checkpoint; loading its `voters` array corrected that operational error.

Exact team readback at **2026-10-18T05:58:23.872Z**, H=30,035, proved all three intended leaders and exactly their three elected members. All canonical winners are `WonByIdentity`.

| Target | Winner H | Winner block time UTC | Elected charter | Submitted charter |
| --- | ---: | --- | --- | --- |
| social | 30,022 | 05:57:21.202 | `8psMPnwMSRPAWLSVJbMCpsB4UabdGN6Jt4Ax8L7s7XxB` | `GLZqAKZDixA6zPdtFX4VC8HeZrbdk34fVAu5LZpTwTS9` |
| blog | 30,027 | 05:57:29.640 | `12vndCdT3c1BE2AqymFqovPzE7vEWtsw36wFDNaMMG81` | `Homna47Kms6XxxjP8VeuVVZ6y9TEST3yRJsNH1vySMCW` |
| storefront | 30,034 | 05:57:43.269 | `GWyAEqw2cnVTfzWpFRqSB4WTEhMzMrQRhY5VBkfqMjbU` | `5YNFegUZ2bpcQADJYgfA4Pruszt2wV7nsvfVf1qGU75N` |

Post-seat posting and feature opening were proved by the full batteries below.

## Batteries

Scripts target the release set except the intentionally isolated Pollr and merged-count proof contracts.

| Battery | PASS | FAIL | SKIP | Status |
| --- | ---: | ---: | ---: | --- |
| App Connect g1–g3, a1 | 32 | 0 | 0 | passed |
| DM v5 | 106 | 0 | 0 | passed |
| Tips | 6 | 0 | 5 | passed; YAPP transfer cases correctly skip for non-transferable YAPP |
| Pollr reusable contract | 77 | 0 | 0 | passed |
| App Connect keyholder | 4 | 0 | 0 | passed |
| Social v17 full + r2 | 258 | 1 | 13 | sole c1 transport abort recovered by the separately recorded retry |
| Social c1 isolated rerun | 105 | 0 | 0 | passed all expected post/reply constraint probes |
| Blog v9 | 109 | 0 | 0 | passed, including elected moderation and cleanup |
| Storefront v10 | 164 | 0 | 0 | passed, including elected moderation and cleanup |
| Merged counts | 174 | 0 | 2 | passed on fresh throwaway; two absent reply-author-index cases skip |
| Settled-team deletion proof | 15 | 0 | 1 | passed; optional late-added-member scenario requires an additional pre-filed join |
| Social query bundles | 10 | 0 | 1 | all composite equivalence checks passed; legacy DM v4 absent |

The social full run passed all five actual-release r2 checks with elected member 61 and the seated SPM reason. Its sole failure was a c1 case abort when proved readback exhausted four attempts during a quorum/address outage; the SDK then reconnected and the remaining cases passed. Cleanup tombstoned all 59 public fixtures (29 from bot 0, 30 from bot 1), and independent queries proved zero live posts/replies for all four bots before the isolated c1 rerun. That retry completed at 06:49:06.859 UTC with all 105 expected probes passing and its fixture cleaned. A recovery record checks every expected label, the exact release contract, cleanup timestamps and both log hashes. The original failure is retained rather than replaced by the rerun; no social battery failure remains unresolved.

The first DM invocation used the CI identity ids with the separate battery mnemonic and stopped on a key mismatch before broadcasting. It was corrected to the battery pool, then passed. Preserve that failed preflight in the private operations evidence; it was not a contract failure.

After the full batteries and isolated social retry completed, independent readback at **07:03:06.144 UTC** passed all 48 cleanup checks: zero live posts/replies for all four social bots, no battery blogs/live posts/comments, closed battery stores, deleted items, and no remaining reviews, shipping zones or deliverable kits. Permanent encrypted order metadata and the protected owner's resolved report remain as contract-permitted historical records; they do not leave live demo-feed or catalog fixtures.

## Fresh demo data

Social seeding completed at 07:09:10.768 UTC: 12 personas, 36 public posts, 12 replies, 108 likes and 33 follows (189 operations, none failed). All 60 social/non-social actors were provisioned after seating. The social corpus used credit payment for all 12 authors, preserving their 100-YAPP starter balances; non-social seeders also spent YAPP. DM v5 clients use the actual application engine and anchor-bound encryption keys; encrypted conversations are uploaded as recoverable self-state. Three private feeds and six grants were prepared with the actual feed encryption and grant services. A follower read immediately after opening initially saw a stale empty feed list; the setup resumed only after that read-only preflight failure was identified, then completed with cache/readback settling between devices. Four direct DM conversations and a three-person group (22 messages) were seeded and flushed for all five participants, costing 1,072,050,260 credits (64.32¢). Fresh client processes then recovered all expected messages: 11 conversation views across the five participants, including the group for all three members.

Private-feed setup and subsequent DM self-state synchronization cost a further **813,254,500 credits (48.80¢)**, measured from the DM cost snapshot to a second five-person balance read before public seeding. This interval contains the three feeds and six requests/grants; no private posts had been created yet. Anchor messaging-key preparation added 157 keys across the broader QA/demo actor pool for **4,783,931,960 credits (287.04¢)**; the three separate battery-bot keys cost 147,965,800 credits (8.88¢) and are excluded from demo seeding.

Encrypted-demo access uses the personas’ wallet-derived, anchor-bound encryption keys. A raw authentication-key sign-in can browse and post but must unlock messaging with the matching retained encryption key or wallet grant to recover those existing DMs and private feeds. Do not replace their advertised encryption keys to bypass that requirement. Fresh-process DM recovery was verified with those matching keys.

The first storefront demo seed exposed a **seeder key-selection defect**: its local ECIES round trip succeeded using unbound ledger ENCRYPTION keys, but those differed from the keys the App Connect application resolves. Public-key checks confirmed this for all ten actors. Its seven stores, 51 items, 17 zones, 28 orders, 91 status notes, 20 store reviews and 32 item reviews are preserved in the rejected checkpoint. Orders and status notes are immutable; the failed-rehearsal history is not presented as usable demo orders.

The repair derives the same anchor key as the actual test wallet (CRITICAL key, purpose 1, rotation 0), requires the exact currently advertised key for every actor before any write, and stamps checkpoints with the anchor and actor map. Existing populated or pending checkpoints without matching provenance are refused, including old legacy checkpoints. Offline tests seal with the actual seeder and decrypt through the application as both buyer and seller. The read-only preflight correctly refused rotated persona 241, so the final replacements use 313 instead without changing anyone's key.

Recovery uses disjoint, already provisioned actors on the same elected contracts: `200→220, 202→221, 270→222, 271→240, 272→313, 273→250, 203→260, 201→310, 274→311, 275→312`. All 20 independent store/order slot checks passed before replacement. Retired original actors are excluded from the active storefront demo; independent readback at 07:30:01.422 UTC passed all 246 checks: seven closed stores, 51 deleted items, 17 absent zones, 20 absent store reviews, 32 absent item reviews, and the expected 28 retained orders plus 91 retained status notes. Actual-client readback at 07:36:54.449 UTC verified all ten advertised keys, 28 unique orders and 91 unique status notes with **238 successful decryptions** through the application (both buyer and seller), and no duplicate orders/statuses. The replacement wrote all 246 documents, then exited 1 on global ranking readback; this failed process result is retained separately from its successful writes. After the archived-review recovery below, `--verify-only` passed every storefront check without creating documents.

Blog seeding completed at 07:42:39.559 UTC: eight blogs, 40 posts, four edits, 73 comments and 40 follows (165 operations: 161 creates and four edits, none failed). Pollr's first run retained two uncertain creates during quorum/address errors and exited 1; resuming the same checkpoint adopted the exact saved poll IDs and completed with 20 creates, 120 already present and no failures. Final Pollr counts are 14 polls, 14 embedding posts and 112 ballots, with 142 counted selections. Three short-window demo polls intentionally close shortly after seeding. No pending poll creates remain.

Six private posts completed at 07:47:46.361 UTC. Independent social readback verified the exact IDs, authors, content and uniqueness of all 36 public posts and 12 replies; all 12 authorized follower/post decryptions passed at 07:47:54.338 UTC. Query-bundle verification passed all ten checks, including both post and reply composite enrichment; the legacy DM v4 bundle correctly skipped. The first attempt selected only the 20 newest posts, which by then contained no replied-to thread. The battery now accepts `QUERY_BUNDLE_THREAD_ROOT`; the rerun pinned independently verified corpus thread `9dqTkNxBUjegsocJJbGPGhcWukyPU5472MM763JRjSAo` and exercised a nonempty reply page. The original fixture-selection failure is retained.

The main seeding interval, **07:03:29.830–07:48:31.948 UTC**, cost **99,290,415,968 credits (5,957.42¢)** across the maker plus 60 actors. It includes provisioning, all public/non-social/private-post seeds, the rejected storefront seed, its cleanup, corrected storefront seed and seven archived-review pins. Internal transfers cancel across those 61 identities. Adding the separately measured anchor preparation, DMs and private-feed setup intervals gives **105,959,652,688 credits (6,357.58¢)** for the broader demo preparation; separate battery keys are excluded. These are measured balance intervals, not a per-document fee estimate.

## Rehearsal lessons for testnet

- Measure the maker balance and nonce immediately before planning; historical balance estimates drift.
- Use the exact registration policy flags when checking the deployed schema. The social battery now accepts `--interim` and `--election-windows` for this comparison.
- With `notYetUsable`, interim-owner moderation tests must skip. The existing preparation reads the seat for filtered `--only` runs too; seated-team tests establish actual authority.
- Blog and storefront moderation batteries need a reason document listed in the seated charter; pass `--reason-doc` and run them only after seating. Unlike the social interim cases, their moderation cases do not skip under `notYetUsable`.
- Pollr v8 retains v7 ballot fields/indexes but removes the two unused poll listing indexes. Its seeder now accepts v8 and reads polls by id.
- Keep the CI mnemonic/id pool separate from the deployment battery pool. Check key ownership before any write.
- Bound-key preparation can outpace proved readback. Resume the same manifest and journal to adopt the exact saved key after it appears. Never clear ambiguous checkpoints or invent a new nonce.
- Reused election members may already hold charter-bound keys. Retain their private halves and prove an exact public-key match before adopting them.
- Snapshot discovery needs the App Connect anchor explicitly; use `--prune` and verify exactly eight release members plus DashPay.
- The merged-count battery needed bounded readback for newly created moderation fixtures: proved creates may be followed by stale reads from another node. Retry the read, never recreate the document. The first run passed its query phases but stopped at that fixture read; a fresh throwaway run passed all 174 checks after the fix.
- The 90-second settled-delete proof uses a throwaway v17-derived contract (`HWKBNJndfNSmvgbkXkErWFBrjNYyRaJU4eXj5mQRxTs7`); it does not shorten the actual release's seven-day rule. Its single contender seated at H=29,214, chain time 04:32:15.311 UTC. All 15 core team checks passed: three approvals including the leader, refusal of duplicate/closed approvals, preserved removal fields, per-approver action counts, fresh-document single deletion, and non-restorability of a team deletion. The optional late-added-member scenario was not run because it requires another identity's join request before the charter window closes.

## Validation and deployment

After integrating staging `b0be588c3b5bc8d0248a83928accc491602b6b0a`, local validation at 07:31–07:33 UTC passed lint, 246 test files / 3,651 tests, dead-code analysis, default production build and devnet build. All five checks passed again at 07:49–07:50 UTC after the optional query-bundle thread fixture was added. The preceding storefront repair suite passed 19 focused crypto/interoperability checks, including five new seeder tests. After staging advanced to `8480a65cf7803cbfe25fa3212b3d41e216063985` (SDK rc.4), the branch merged it cleanly and reran `npm ci`. The rc.4 validation passed lint, **246 files / 3,664 tests**, dead-code checks, default build and devnet build. Read-only rc.4 reruns also passed all ten query bundles, every storefront verification with zero writes, and all 238 actual-client order/status decryptions at 08:11:00.110 UTC. The earlier battery results remain explicitly associated with the rc.3 client.

Independent Opus correctness and Sonnet simplification reviews approved both the cutover and the storefront repair. They found the malformed env comment and interim-policy battery guard, then identified stricter immutable-seed safeguards; all blocking findings were corrected. Both implementation commits and the staging integration are SSH signed. Final Opus correctness and Sonnet simplification reviews also approved the fixture option and completed record without blockers. The final PR targets `staging`; CI and the exact merge/Pages commit, artifact-to-live hashes and authenticated Playwright smoke results will be recorded on that PR after deployment, avoiding a documentation-only deployment cycle.

Private operation journals, signed bytes and keys are kept under the protected release audit directory and are not committed. Public evidence and final deployment details belong in this record.

### Sakura aggregate-index defect found during demo recovery

After deleting every store review from the retired first demo, global `storeReview` average ranking failed with a server-side GroveDB `indexed target chain` / `primary entry ... is missing` error for retired store `CgGFe4xK5FpVSemKwiRvTupP9qzDJWJWyWno2KLpPfXn`. The store itself still reads as closed, and the active directory returns exactly seven replacement stores. Per-store averages, all replacement crypto readbacks, and global most-ordered ranking pass. A positive-average HAVING query also encounters the dangling entry, so it is not a client decoding issue. The original corrected seeder process exited 1 during that global ranking verification after all 246 writes and 11 prior verification checks; that failed result is retained. The original seed-stage success does not stand in for the failed replacement verification.

An independently reviewed retention helper first restored one honest archived review on the first retired store. The original dangling group cleared and the error moved to the next retired store, authorizing the remaining six writes. Independent readback at **07:48:09.774 UTC** proved global ranked and positive-average HAVING agree, exactly 13 unique groups (six rated active stores plus seven archived groups), no duplicate ranking entries, all seven retired stores still closed with exactly one archived review each, and exactly seven replacement stores in active discovery. The seventh active store is intentionally unrated and therefore absent from average ranking. Every storefront seeder verification then passed with zero writes.

These seven archived reviews are **permanent devnet pins until the Platform defect is fixed**; deleting them may break ranking again. No retired catalog was reopened. The app filters ranked stores to `status === active`, so closed pins occupy ranking slots but are not shown. The aggregate-index deletion defect observed on Sakura beta.6 remains open. Because owner/moderator deletion is allowed for store reviews, deleting a store's final review can disable global Top-rated for everyone. A minimal upstream issue draft and exact server errors are preserved in the private audit; other server versions/networks have not been tested. Reproduce and resolve or explicitly gate this on the current testnet server rehearsal before production.
