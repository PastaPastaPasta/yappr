# Social v14, the Platform 5.0.0-beta.3 re-cut

Social v14 is social v13 ([SOCIAL_V13.md](SOCIAL_V13.md)) re-cut for Platform 5.0.0-beta.3 ([PLATFORM_V5_BETA3_UPGRADE.md](PLATFORM_V5_BETA3_UPGRADE.md)). It adopts beta.3's new grammar (`countPresent`, `deleteConstraints`, a derived `skipIfAbsent` property) and unpauses YAPP, which beta.3 would otherwise make unspendable. The analysis behind it, with every rule checked in the beta.3 source, is the 2026-10-08 contracts analysis (items S2–S7).

This document was written with the PR that adds the contract, the client topology `v14`, the tooling and the batteries. **Nothing is registered yet.** The sakura registration and the `/devnet` cut-over are a later PR; `.env.devnet` stays on v13 until then. It needs the 5.0.0-beta.3 SDK (#700): the 5.0.0-beta.2 SDK cannot parse v14.

| # | Decision (user-approved) | What changes |
| --- | --- | --- |
| 1 | **YAPP unpaused** | `tokens["0"].startAsPaused: false`. Every other token property is v13's. The optional YAPP `tokenCost` on post, reply, like and likeReply (with sponsored gas, `gasFeesPaidBy: 2`) works again under beta.3. |
| 2 | **`countPresent` rules (S2–S5)** | `report.oneTarget`, `private` and `embed`, `blankTombstone`, `live` and `notEmpty` rewritten. Same names, same behaviour. |
| 3 | **No withdrawing a resolved report (S6)** | `report.deleteConstraints: {"pending": {"absent": "status"}}`. Withdrawing a resolved report is refused with 40147 (paid). |
| 4 | **Derived reply-owner windows (S7)** | `reply.parentOwnerId`, `reply.rootOwnerId` and `parentIsRoot` are dropped. Two windows read the owners off the referenced documents: `rootOwnerRecent [$createdAt, rootPostId.$ownerId]` and `parentOwnerRecent [$createdAt, replyToReplyId.$ownerId]` (skipping top-level replies). |
| 5 | **Everything else stays v13's** | Action fees, moderation configuration, election windows, every other index, the `live` marker, media arrays, reports, the blocks contract. |

## The file

| | Social v14 |
| --- | --- |
| File | `contracts/yappr-social-contract-v14.json` |
| sha256 | `b18f7c82b865c36810a02ac4716d12a291ae7011936aa79f0fdead74f14d9a3d` |
| Serialized (beta.3 rs-dpp) | 17,868 B (v13: 18,717 B) |
| Signed create (estimate: serialized + 107 B, calibrated on v12 and v13) | **~17,975 B**: 849 B smaller than v13's ~18,824 B, 2,025 B under the 20,000 B budget and 2,505 B under the 20,480 B cap. The interim is one enum, so mainnet's rendering is the same size. |
| Document types | 12, as v13 |
| Parses | `validate-contract-offline.mjs --network mainnet --cost --strict-size` on the 5.0.0-beta.3 wasm-sdk and wasm-dpp2 (full validation, meta-schema, node-rule audit): OK, ~17,975 B signed; also rs-dpp at the `v5.0.0-beta.3` tag, with and without full validation |

The ~17.6 KB of the analysis assumed S1 (dropping the four `tokenCost` blocks, −316 B). v14 keeps them, because YAPP is unpaused instead.

What each change adds to or saves from the serialized size, measured on beta.3 by applying that change alone to v13. Here the deltas do add up to the whole diff:

| Change | Bytes |
| --- | ---: |
| S2 `report.oneTarget` as one `countPresent` | −98 |
| S3 `private` (post and reply) and `embed` as `in [countPresent, [0, 3]]` | −312 |
| S4 `blankTombstone` as `countPresent = 0` (post: 15 paths, reply: 9) | −178 |
| S5 `live` (−23) and `notEmpty` (−22) | −45 |
| S6 `report.deleteConstraints` | +48 |
| S7 derived reply-owner windows (two fields, one rule and two `where` entries dropped; one index added) | −264 |
| YAPP `startAsPaused: false` | 0 |
| **v13 → v14** | **18,717 → 17,868 (−849)** |

## The diff against v13

| Type | v13 | v14 |
| --- | --- | --- |
| `tokens["0"]` (YAPP) | `startAsPaused: true`, `emergencyActionRules` `noOne` (paused for good) | **`startAsPaused: false`**; everything else unchanged, `emergencyActionRules` still `noOne` (nobody can ever pause it) |
| `reply` | `rootOwnerId` and `parentOwnerId` (required, immutable); `rootPostId` `where {$ownerId: rootOwnerId}`; `replyToReplyId` `where {$ownerId: parentOwnerId, rootPostId: rootPostId}`; rule `parentIsRoot`; `parentOwnerRecent [$createdAt, parentOwnerId]` | **no stored owner**; `rootPostId` with no `where`; `replyToReplyId` `where {rootPostId: rootPostId}`; no `parentIsRoot`; **`rootOwnerRecent [$createdAt, rootPostId.$ownerId]`** and **`parentOwnerRecent [$createdAt, replyToReplyId.$ownerId]`** (`skipIfAbsent: ["replyToReplyId.$ownerId"]`), both on v13's grid (`range`/`step` 302,400 s, `ttl` 604,800 s); positions renumbered 0–11 |
| `report` | `oneTarget` a nested `ifThenElse` | `oneTarget` `{"equal": [{"countPresent": ["postId", "replyId", "about"]}, 1]}`; **`deleteConstraints {"pending": {"absent": "status"}}`** |
| `post`, `reply` | `private`, `embed`: `anyOf` of all-present / all-absent; `blankTombstone`: 15 (reply 9) `absent` checks | `{"in": [{"countPresent": [3 paths]}, [0, 3]]}`; `{"equal": [{"countPresent": [paths]}, 0]}` |
| `post` | `live`: `ifThenElse`; `notEmpty`: a 7-way `anyOf` | `live`: `{"equal": [{"countPresent": ["deleted", "live"]}, 1]}`; `notEmpty`: `anyOf [length(content) > 0, countPresent(6 paths) ≥ 1]` |

## The changes

### 1. YAPP unpaused

Beta.3 (dashpay/platform#5325) makes a document's token payment follow the token's own rules: a `tokenCost` paid with a paused token is refused with `TokenIsPausedError` (40711). It is a state error, so the user is charged and the nonce is spent. v13's YAPP starts paused and nobody can ever unpause it (`emergencyActionRules: noOne`), so under beta.3 no v13 post, reply or like can pay YAPP at all (`fix/credits-while-yapp-locked` makes the v13 client pay credits instead).

v14's YAPP starts unpaused. The optional `tokenCost` (post 10, reply 3, like and likeReply 1 YAPP, the contract owner sponsoring the gas when its balance covers it, `gasFeesPaidBy: 2`) works again, the 100-YAPP once-per-identity grant is unchanged, and YAPP stays unpriced (`changeDirectPurchasePricingRules: noOne`, no direct purchase).

- **YAPP is transferable on devnet.** Beta.3 has no non-transferable flag: an unpaused token can be transferred. The user accepted that for devnet. Yappr adds no transfer UI, and tips stay credit tips. **Refusing paused-token payments in beta.3 is a critical Platform regression to fix before testnet or mainnet**: Yappr's design (a non-transferable, non-purchasable YAPP that still pays document costs) needs either the old exemption for document payments or a non-transferable token flag. Until then, a mainnet cut has to choose between this (a transferable YAPP) and no YAPP costs at all (S1).
- **The emergency rules stay v13's (`noOne`).** That keeps YAPP unpaused for good: nobody, the contract owner included, can pause it. Staying unpaused does not need anything else, so v13's rules were kept, as the user asked. The price is that a devnet incident cannot be stopped by pausing the token; the owner can still freeze an identity's balance (`freezeRules: contractOwner`).
- **Client.** Two predicates read the token off the committed JSON. `yappIsPausedForGood()` (#699: paused, and no one may unpause it) is false on v14, so `planPayment` pays YAPP when the user chose it and the balance covers it, the YAPP/credits choice is shown again, and the starter grant is offered on a zero balance with its sponsored-fee copy. `yappIsLocked()` now means "Yappr neither sells nor sends YAPP" (no one may ever price it or change its pause state) and stays true on v14: no Buy YAPP, credit tips only, no transfer anywhere in the app, and running out of YAPP opens the starter grant (or, once claimed, says YAPP can't be bought and credits can pay).

### 2. `countPresent` rules

`countPresent` (beta.3) counts how many of two or more distinct paths a document holds, each tested the way `present` tests it. It costs 1 node plus 1 per path against a rule's 32-node budget. The rewritten rules keep their names, so 10422 errors and `scripts/property-constraint-cases.mjs` still map, and they judge every document the way v13's did: the 85 post and report cases shared with v13 give the same outcome against both files under beta.3's evaluator.

| Rule | v14 |
| --- | --- |
| `report.oneTarget` | exactly one of `postId`, `replyId`, `about` |
| `private` (post, reply) | none or all three of `encryptedContent`, `keyGeneration`, `nonce` |
| `embed` (post) | none or all three of `embedContractId`, `embedDocType`, `embedId` |
| `blankTombstone` (post, reply) | `deleted` absent, or `deleted` is `true` and none of the 15 (reply: 9) content paths is present |
| `live` (post) | exactly one of `deleted` and `live` |
| `notEmpty` (post) | text, or at least one of `encryptedContent`, `mediaUrls`, `embedId`, `quotedPostId`, `quotedReplyId`, `deleted` |

### 3. Reports stay once resolved

`deleteConstraints` (beta.3) are rules the stored document must meet for its **owner** to delete it, in the `propertyConstraints` grammar. A broken rule refuses the delete with `DocumentDeleteConstraintViolatedError` (40147), a paid state error. Moderator deletes and ttl expiry are not judged, and the rules are fixed once registered (an update changing them is 10246).

v14's report declares `pending: {absent: status}`. A reporter withdraws an open report as before; once a moderator has resolved it (written `status`), the reporter can no longer delete it, and it stays until its 90-day `ttl`. That closes the audit finding that a reporter could erase a report the moderators had acted on.

Client: the report dialog (web `components/moderation/report-post-modal.tsx`, mobile `ReportScreen`) offers no Withdraw on a resolved report and says why; `reportService.withdrawReport` re-reads the report first and refuses a resolved one before signing, so a report resolved after the dialog loaded costs nothing (only a node that has not seen the resolution yet can still let a paid 40147 through); a 40147 is worded "The moderators have already resolved this report, so it can no longer be withdrawn" (`withdrawFailureMessage`). The mobile engine's `ownReport` carries `withdrawable`, and a withdrawal refused as resolved fails `REPORT_RESOLVED`, which the app answers with a neutral toast and a fresh read of the report.

### 4. Replies without stored owners

A derived index property (5.0, with a derived `skipIfAbsent` from beta.3) is `"<reference property>.<field>"`: Drive reads the value off the document the reference points at whenever it writes or removes the entry, and the document never stores it. Beta.3 admits one only through a reference the type fixes for good: `rootPostId` and `replyToReplyId` are both unconditionally `immutable`, so both windows parse (a conditionally frozen reference is refused, which is why `post.quotedPostId.$ownerId` cannot have a window: a tombstone clears the quote).

| Window | Keys | Holds |
| --- | --- | --- |
| `rootOwnerRecent` | `[$createdAt, rootPostId.$ownerId]` | **every** reply of a thread, under the root post's owner |
| `parentOwnerRecent` | `[$createdAt, replyToReplyId.$ownerId]`, `skipIfAbsent` on the derived owner | every nested reply, under its parent reply's owner; a top-level reply is left out |

Nothing a reply stores can name a wrong owner any more, so v13's binding machinery goes: `rootOwnerId`, `parentOwnerId`, `parentIsRoot` and the two `$ownerId` `where` entries. A nested reply's parent must still be in the same thread (`replyToReplyId.where {rootPostId: rootPostId}`, 40127).

**Client.** On v14 a reply writes `rootPostId` (and `replyToReplyId` when nested) and nothing else about its owners; nothing reads the root post's owner before replying any more. "Replies to me" are two sources (`replyService.getRepliesToMyContent`):

- `parentOwnerRecent` with `replyToReplyId.$ownerId == me`: replies to my replies ("replied to your reply");
- `rootOwnerRecent` with `rootPostId.$ownerId == me`: every reply of my threads, of which only the **top-level** ones answer me ("replied to your post"). A nested one is either already in the first source (its parent is mine) or answers somebody else, and is dropped.

The two are merged by id, so a reply that reaches me both ways (a nested reply to my reply, in my own thread) notifies once, as "replied to your reply", and the root owner is never notified twice. My own replies drop out with the other self-notifications. The keys are derived by consensus, so the v9-era check that re-read a direct reply's root to trust its `parentOwnerId` is not needed. Each window is read twice (the current and the previous 3.5-day window), so a notification poll on v14 makes seven requests instead of five. v13 and older topologies read exactly as before.

**The trade-off the user accepted.** `rootOwnerRecent` holds every reply of the owner's threads, including back-and-forth between other people that the client then drops. A window read pages up to 1,000 documents (`NOTIFICATION_WINDOW_MAX_PAGES` × 100) in document-id order, not time order, so once an owner's threads take more than 1,000 replies in one 3.5-day window some top-level replies to their posts can be missed, and each poll downloads more than v13's did. Measure it on sakura with a busy thread. If it matters, a later cut could try a window that serves top-level replies alone, for example `[$createdAt, rootPostId.$ownerId, replyToReplyId]` read with `replyToReplyId == null` (not verified on beta.3), at the price of an index entry that carries the parent id.

## Costs

`node scripts/validate-contract-offline.mjs <file> --cost` on the 5.0.0-beta.3 SDK, v13 and v14 side by side. Every non-reply write prices exactly as on v13. Cents are at $60/DASH (1M credits = 0.06¢); the estimator overstates the live fee by about 30%. (Before the SDK bump, a beta.2 rendering of v14 with the rules swapped back and the skip handled by hand gave the same deltas within 0.1M.)

| Write | v13, first / later | **v14, first / later** | Δ |
| --- | ---: | ---: | ---: |
| reply, 140 characters | 106.0M (6.36¢) / 50.8M (3.05¢) | **104.2M (6.25¢) / 48.9M (2.94¢)** | −1.8M / −1.9M |
| reply to a reply | 108.8M (6.53¢) / 51.8M (3.11¢) | **107.4M (6.44¢) / 50.5M (3.03¢)** | −1.4M / −1.3M |
| reply, one image | 115.7M (6.94¢) / 60.5M (3.63¢) | **113.8M (6.83¢) / 58.6M (3.52¢)** | −1.9M / −1.9M |
| post, like, reply like, report, bookmark, follow | as [SOCIAL_V13.md](SOCIAL_V13.md#costs) | **the same** | 0 |

- A reply stores 64 B less (two identifiers). A top-level reply writes one window entry, as on v13; a nested one writes two, but the second is a ttl'd window entry, cheaper than the stored bytes it replaces.
- Not priced by the estimator: Drive reads the referenced post (and parent reply) to key the windows when a reply is written, tombstoned or removed by a moderator. The reply's references are already fetched and checked on create, so this is expected to be small; measure it on sakura.
- The action fees (post 80M, reply 16M, report 50M moderators) are v13's. YAPP costs are tokens, not credits, and are not included.
- `deleteConstraints` cost nothing on a create; an owner's delete of a report evaluates one rule on the stored document.

## Tooling

- **`scripts/property-constraint-cases.mjs`**: 108 v14 write cases (every v13 post and report case, plus each `countPresent` boundary: each partial subset of the private and embed triples, both sides of `live`, each `notEmpty` path alone, each tombstone path alone and all at once, all three report targets) and 6 delete cases (`DELETE_CASES`: an open report is deletable, a report resolved with status 1, 2 or 3 is not). `--constraints` judges the delete cases with rs-dpp's own evaluator by parsing the file once more with each type's `deleteConstraints` in place of its `propertyConstraints`. `DECLARED_DELETE_RULES` pins the delete rule names.
- **`scripts/contract-probes.mjs`** (`--probes`), v14: controls (committed, mainnet rendering); YAPP unpaused and unpausable; the parsed reply's derived windows and the parsed report's `deleteConstraints` read back; refused: `replyToReplyId` frozen only while not tombstoned, `rootPostId` not frozen, a quote-owner window on post, a derived skip on the never-absent `rootPostId.$ownerId`, the boolean `skipIfAbsent` on `parentOwnerRecent`, `deleteConstraints` on the indexOnly like and on the undeletable post, a delete rule reading an unknown property, `countPresent` over one path, naming `$ownerId`, or repeating a path; update probes: the delete rule relaxed or removed (10246); `where` cases: a nested reply crossing threads is still 40127.
- **`scripts/social-shapes.mjs`**: a `storedReplyOwners` cut flag (false on v14); `reply()` drops `parentOwnerId`/`rootOwnerId` on v14 whatever the caller passes, so every script written for v10–v13 builds a valid v14 reply.
- **Batteries**: `verify-v10.mjs --contract-file contracts/yappr-social-contract-v14.json` builds v14 shapes and adds the derived-window cases (a top-level reply in `rootOwnerRecent` and not in `parentOwnerRecent`; a nested reply in both), the resolved-report withdrawal (40147) and the unpaused YAPP cases (a YAPP-paid post lands; a transfer lands). `prove-merged-counts.mjs`, `measure-social-fees.mjs`, the seeder and `verify-social-query-bundles.mjs` build v14 replies and read the v14 windows.

### Validation done for this PR

On the 5.0.0-beta.3 SDK (#700):

- `node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v14.json --network mainnet --cost --strict-size`: OK, ~17,975 B signed, meta-schema v3 clean, no node-rule problem;
- `--probes`: every probe and `where` case behaves as recorded (185), the v14 ones included;
- `--constraints`: every case of every file as recorded (336), among them v14's 108 write and 6 delete cases;
- `node scripts/social-shapes.mjs --self-test`, `verify-v10.mjs --self-test`, `prove-merged-counts.mjs --dry-run` and `measure-social-fees.mjs --dry-run` with `--contract-file contracts/yappr-social-contract-v14.json`: pass.

Before the SDK bump, the same cases were judged by an offline build of rs-dpp at the `v5.0.0-beta.3` tag (114 of 114 as recorded), and the 85 post and report cases shared with v13 gave identical outcomes against v13's rules. The client's unit tests pin the topology against the JSON (`lib/contract-topology.test.ts`).

## Client: topology `v14`

`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v14` with `NEXT_PUBLIC_YAPPR_CONTRACT_ID` (and `NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID`, as on v13). The descriptor is v13's but for the reply tombstone, which carries `rootPostId` and `replyToReplyId` only. New predicates: `replyOwnersAreDerived()`, `reportsWithdrawOnlyWhilePending()`, and a `threadReply` notification window. `repliesNameRootOwner()` is v13 only. `yappIsPausedForGood()` is false and `yappIsLocked()` true (see §1). The mobile engine imports all of it from `lib/`.

## Open items

- **Register and prove live** (the cut-over PR): register on sakura, run `verify-v10` and `prove-merged-counts` against it, broadcast the 40147 and the YAPP-payment paths, measure live fees (including the derived-property reads), then cut `/devnet` over.
- **YAPP on testnet and mainnet** depends on the Platform fix above.
