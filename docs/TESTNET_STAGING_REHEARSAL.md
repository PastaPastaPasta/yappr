# Testnet staging release rehearsal

This is the D36 rehearsal on Dash **testnet**, chain `dash-testnet-51`, using Platform 5.0.0-rc.4 / protocol 14. The production maker is excluded from all operations. Root, `/testing` and `/devnet` keep their existing resolved configuration. The rehearsal uses a separate maker, App Connect anchor, group and storage epoch; production registration remains an owner action after QA.

## Registered set

Maker: `At8Xd9BpbVbzxvrna2smE3GbACeTaxf7YGUEwn7FHUZF`. Group: `ePtSmVdSqxJESyegxxRGcS7CwznyWSAn2FULYow8Dks`. Every member is version 1. The proved initial maker nonce was 0; registration consumed nonces 1–8. Plan, unsigned dry run and signed dry run preceded the journaled live registration with `--interim notYetUsable --election-windows 3600,3600`.

| Member | ID | Nonce | Inclusion H | Credits | Reference ¢ |
|---|---|---:|---:|---:|---:|
| app | `AwjuEqZtXwBq5jU9tg8UnRMmXrwb3nozSgGx59ghD1c1` | 1 | 632136 | 13,098,395,870 | 785.90 |
| social | `AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9` | 2 | 632242 | 91,786,311,700 | 5,507.18 |
| blocks | `8nqBhNLpschHdSfodFRfKP4xiu13KWqddoe54eXgEDcA` | 3 | 632255 | 19,112,142,480 | 1,146.73 |
| dmV5 | `EoPoTVht7vkQcymBLajhbmEg62mAAxA3EUAqvB1DoxvE` | 4 | 632258 | 22,184,626,110 | 1,331.08 |
| blog | `HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa` | 5 | 632260 | 38,427,571,200 | 2,305.65 |
| pollr | `BFSLhfSc5yzoKg1iCymw37kZusNkMVk2K48qPEsdvd6Q` | 6 | 632275 | 17,161,715,480 | 1,029.70 |
| storefront | `9Z5W23rzbMdwPBEn9e5pKKz6rmRVAkoCYDTWaqzLpWqS` | 7 | 632277 | 60,740,381,750 | 3,644.42 |
| passkeyVault | `7yVNQ35szs8ZvsYAwBd8o3QGj1zuMN1EkQbgDtdw9M3U` | 8 | 632289 | 13,085,824,250 | 785.15 |

Total registration: **275,596,968,840 credits (16,535.82¢)**. Reference conversion throughout is 1M credits ≈ 0.06¢. Maker identity registration cost 133,806,160 credits (8.03¢). Funding principal and charter deposits are accounted separately from fees.

This set was registered from social v17 `b21d61f7…` and blog v9 `a0301222…`, whose post, reply, blog post and blog comment carry `deleteWithin: 604800`. D39 (2026-10-19) changed the committed files to 86,400 s (`ae4d3e7d…`, `6f8b07e0…`), so /staging keeps the seven-day single-moderator window until the set is re-cut. The client's removal routing reads the window the registered contract declares, so /staging moderators keep seven days; the Terms sentence follows the build's committed file and says one day there.

All eight inclusion heights were recovered through a read-only authenticated session to a known testnet evonode's local Tenderdash RPC. Its live status proved `dash-testnet-51`; every RPC transaction hash exactly matched the hash computed privately from the saved signed bytes, and every registration `gas_used` exactly matched the measured debit above. Inclusion spanned **17:46:12.031–17:54:52.398 UTC**. The public testnet explorer backend returned HTTP503, so the run did not depend on its indexer. Contract/group/version readback remained separately proved through the SDK.

## Elections and batteries

All three sole contenders seated without masternode votes. Readback proved each expected leader, exactly three distinct members, `WonByIdentity`, and zero contender/abstain/lock votes. Dates below are 2026-10-18 UTC.

| Target | Personas (leader, members) | Proposal time | Application time | Join close | Winner block | Winner block time |
|---|---|---|---|---|---:|---|
| social | 60; 61–63 | 17:53:07.939 | 17:53:53.583 | 18:53:53.583 | 633142 | 18:54:21.780 |
| blog | 64; 65–67 | 17:54:11.501 | 17:54:23.439 | 18:54:23.439 | 633143 | 18:55:59.756 |
| storefront | 68; 69–71 | 17:54:35.980 | 17:54:47.231 | 18:54:47.231 | 633143 | 18:55:59.756 |

| Target | Registration H | Proposal H | Application H |
|---|---:|---:|---:|
| social | 632242 | 632244 (H+2) | 632251 |
| blog | 632260 | 632263 (H+3) | 632271 |
| storefront | 632277 | 632279 (H+2) | 632286 |

Exact-hash RPC matches for all24 charter document transactions give **1,142,402,420 credits (68.54¢)** in fees, excluding bound-key identity updates. Three applications committed **150,000,000,000 credits (9,000¢; 1.5tDASH)** as contest principal, separate from those fees. All32 registration/charter lookups matched successful transactions.

The registered join/vote windows remain 3600/3600 seconds. A sole contender finishes at join close, then seats in a following block; the second hour is needed when another contender enters. Testnet's sparse block production delayed the latter two seats until the next block. An earlier short-window throwaway proof also seated with zero votes at block 632604 (18:13:44.428). No masternode keys were used.

| Battery | PASS | FAIL | SKIP | Result |
|---|---:|---:|---:|---|
| App Connect g1–g3, a1 | 32 | 0 | 0 | release set |
| App Connect keyholder | 4 | 0 | 0 | release anchor |
| DM v5 | 107 | 0 | 0 | final complete run, including evidence output |
| Tips | 6 | 0 | 5 | non-transferable YAPP cases skip |
| Pollr | 77 | 0 | 0 | reusable throwaway contract |
| Merged counts | 174 | 0 | 2 | fresh throwaway, absent reply-author index cases skip |
| Seated-team deletion | 15 | 0 | 1 | separate short-window throwaway, optional late-member case skips |
| Blog v9 | 109 | 0 | 0 | elected moderation and cleanup |
| Storefront v10 | 164 | 0 | 0 | elected moderation and cleanup |
| Social v17, interrupted early sections | 231 | 0 | 9 | e0 through c1 completed, then interrupted during r1 |
| Social v17, remaining sections | 107 | 0 | 4 | r1 through k2 passed, all 25 new public fixtures cleaned |
| Social query bundles | 10 | 0 | 1 | nonempty pinned reply thread; legacy DM v4 absent |

Every social section is covered by the two preserved runs; r1a appears in both, so the 338 PASS observations include one repeated assertion. All five actual-release r2 team checks passed. Final independent readback passed all 48 public-cleanup checks again after the resumed run. No newly observed contract failure remains relative to the devnet rehearsal. Batteries ran from an operational overlay in the protected run directory. The social battery and registered contract schema are byte-identical to this PR; adapters select explicit testnet SDK/Insight connections, the throwaway maker and actor indices, protected ledger paths, staging links and demo mappings. No assertion oracle was relaxed. Stale copies of build, snapshot, monitoring and test files in that directory were not used for product validation or deployment. D37's removed media-denylist copy is unused by the batteries.

Earlier failed attempts remain in the evidence. DM initially received unsupported CLI flags before writes; its next run passed 106 assertions but exited while producing devnet-specific evidence metadata; the final complete testnet run passed 107. The first merged-count attempt filed a short charter before interim-owner tests, so the team seated and the now-required reason caused ten sequencing failures; a fresh full proof without that charter passed, and a separate seated proof passed. The first social invocation failed on an absolute contract-file path before connecting; a storefront connection failed before writes on a legacy public node. These are invocation/adapter/fixture failures, not newly observed consensus regressions.

The long social run was interrupted by a harness handoff after 231 passes, zero failures and nine skips (through c1, plus the first r1 assertion). Its immutable log is retained. Owner-signed cleanup tombstoned its 37 remaining posts/replies; independent queries then proved every public social, blog and storefront battery fixture clean. Only unfinished sections were resumed on the same isolated actors, with new run-unique fixtures. The active driver started after the successful cleanup and independent proof; later source hardening adds explicit bot-ID pairs and duplicate-attempt guards for any future invocation, and is not misrepresented as having run in that already-loaded process. A driver summary accidentally read the first storefront attempt's log and recorded zero passes; an explicit reconciliation row preserves that row and records the successful retry's actual 164/0/0.

Read-only storefront ranking probes passed before batteries and after their cleanup. The devnet dangling last-review deletion defect did not reproduce in this testnet cleanup; this does not establish that every deletion path is fixed.

## QA personas and demo data

Before demo seeding, independent chain readback proved **80 complete personas** (0–71, 76–79, 200–203), each with a DPNS name, DashPay profile, social extension, enabled anchor-bound wallet-derived encryption key, readiness and at least 100 starter YAPP. The immutable pre-seed proof is preserved. The pool contains 100 fresh named identities; additional battery actors are provisioned only after their test cases and cleanup. A later independent readback at 20:05:25.869 UTC, before Pollr/private-post seeding, found 87 complete personas; nine battery-only actors intentionally retain their test keys rather than the wallet-derived messaging key. After demo token spending, another independent audit at 20:22:08.833 UTC still proved 73 personas with every readiness check and at least 100 YAPP, above the required 60; prior starter-grant proofs remain preserved for actors who spent tokens. Preparing 91 anchor keys cost 2,556,254,412 credits (153.38¢). A separately measured 57-profile preparation batch cost 2,695,443,020 credits (161.73¢), excluding 23 earlier adopted profile writes.

The actual DM client engine seeded four direct conversations and one three-person group (22 messages). Restarted clients independently recovered all 11 expected conversation views. Public seeding completed at 20:07:07.028 UTC with all 189 operations successful: 36 posts, 12 replies, 108 likes and 33 follows. Independent readback proved every public post/reply ID, owner, exact content and uniqueness. Public corpus payment used credits, preserving starter grants; the measured 12-actor debit was 14,912,496,940 credits (894.75¢), with zero YAPP consumed.

Blog seeding and verification completed with eight blogs, 40 posts, four edits, 73 comments and 40 follows (165 operations, none failed). Three private feeds, six follower grants and six private posts were seeded through the actual application services. Readback passed all 12 authorized follower/post decryptions and all six encrypted-but-denied non-follower reads. Pollr seeded 14 polls, 14 embedding posts and 117 ballot documents, including changes and withdrawals; readback verified 159 counted selections and all planned tallies, with zero failed writes. Three short-window polls close at 20:25:20.601 UTC. Storefront seeded seven stores, 51 items, 17 shipping zones, 28 orders, 91 status notes, 20 store reviews and 32 item reviews (246 documents). Actual application crypto readback at 20:23:40.097 UTC verified all ten enabled advertised wallet-derived keys, 28 unique orders and 91 unique status notes, with 238 successful buyer/seller decryptions. Directory, per-store counts, review averages and seeded-store rankings all passed: Kintsugi Ceramics is top-rated and Anvil & Ash Coffee most-ordered among the seeded stores. All 246 writes succeeded; no rejected storefront checkpoint was needed on testnet.

## Cost and validation checkpoints

The final pre-deployment snapshot at **20:24:55.587 UTC** retained **72.61995 confirmed tDASH**, zero unconfirmed treasury duffs, and **1,924,020,390,126 Platform credits (115,441.22¢)** across the maker plus 100 pool identities. The maker held **619,313,443,980 credits (37,158.81¢)**. No faucet was used; the required 1 tDASH QA reserve remains available.

The **19:56:46.125–20:24:55.587 UTC** balance interval consumed **72,383,661,940 credits (4,343.02¢)** net across those 101 identities. It includes the resumed social battery, cleanup, public/blog/Pollr/storefront/private-feed seeding and any client synchronization in that interval. Internal transfers cancel; this is a measured net balance interval, not a claim that every debit is a transaction fee. Earlier registration, contest principal, keys, provisioning and battery intervals are excluded. Tips separately measured 3,097,500 credits (0.19¢) of fees, excluding its 100,000,000-credit (6¢) principal.

On source head `495305b84c19b92ab5aed47a627c745728cce409`, local lint, dead-code analysis, all **3,822 root tests**, and the normal build passed. Mobile tooling's **110 tests**, typecheck and build passed. All four deployment variants and the ordinary staging compatibility build passed; emitted production/testing/devnet configuration matched the baseline exactly except webpack's compilation-local module field. One initial local test run inherited the operations directory's restrictive umask and failed a fixture intentionally asserting a public 0644 mode; rerunning the same tests with the standard 022 subprocess umask passed all 3,822. Private operations files remain 0600.

Independent Opus correctness and Sonnet simplification reviews approved the product source and the operational verification helpers after corrections. All 15 CI checks on that source head passed. This final documentation commit records the completed chain rehearsal; exact merge/Pages SHA, artifact-to-live byte hashes and authenticated Playwright results will be recorded on PR #807 and in the protected QA handoff after deployment, avoiding a documentation-only deployment cycle.

## Deployment isolation

`.env.staging` is the authoritative public release configuration; it explicitly pins all eight group members, the App Connect protocol and storage epoch `testnet-staging-20261018`. The staging-only snapshot lives outside the ordinary dynamic bundle directory. It includes the eight members plus proved current DashPay profile, DPNS and token-history system contracts. The build refuses a mismatched snapshot or a client compilation that did not replace it.

Both `npm run build:staging` and `BASE_PATH=/staging npm run build` load this configuration. The latter preserves the rehearsal when the older workflow on master builds the staging checkout. CI builds the rehearsal too. Monitoring reads the staging env/snapshot as its own set. No master change or manual master deploy is required. The scheduled monitoring workflow activates only after its code reaches master; this staging PR supplies its future staging expectations without claiming the schedule is already active.

Regenerate this read-only snapshot with:

```sh
NETWORK=testnet npm run contracts:snapshot -- --staging --prune
```

This reads only `.env.staging` and writes only `lib/contracts/snapshots/testnet-staging.json`; ordinary testnet snapshots remain separate. Root's existing profile/history snapshots are older than the proved testnet v2 system contracts and must be refreshed for the later production cut.

## Operational lessons

- If the public explorer is unavailable, recover transaction heights and fees through a known testnet evonode’s local Tenderdash RPC, verify its chain ID, and match each transaction hash privately. Do not substitute a sampled chain tip for inclusion height.
- Pin `NETWORK=testnet` and the testnet Insight endpoint explicitly in every operational child. Repository env fallbacks can otherwise select the devnet Insight URL.
- Wait for the owner's funding confirmation before spending. Confirm a bulk split before creating many descendant locks; Core's unconfirmed descendant limit is 25.
- Under `notYetUsable`, social profile extensions are gated as well as posts. Prepare identities, DPNS names, encryption keys and non-moderated batteries first, then resume profiles after seating.
- A once-per-identity starter claim can prove before a subsequent balance query catches up. Retry the read; do not repeat a proved claim or interpret an immediate zero as failed funding. Final persona readiness is checked against chain state.
- Preserve signed bytes and journals after uncertain outcomes. Adopt proved writes rather than resetting nonces or creating replacement fixtures.
- The responder now accepts an explicit testnet env/pool, uses trusted testnet SDK defaults, and refuses mainnet and cross-network requests before writes. Messaging keys use the wallet's CRITICAL-key/anchor derivation; immutable store orders must verify those advertised keys and checkpoint provenance before writing.
- Operational seeder copies are isolated in the protected run directory, explicitly require testnet, and remap demo actors into the new ledger. Repository devnet-only seeder guards remain in place.
- D36 temporarily overrides D20's shared production/staging set. After the owner's QA all-clear, change the staging pins/snapshot and epoch together when retiring this set.
