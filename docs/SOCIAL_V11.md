# Social v11 for Platform 5.0.0-beta.1

Social v11 is social v10 plus three Platform 5.0.0-beta.1 keywords. The user approved them on 2026-10-01 (decisions D1, D3 and D4 of the 5.0 upgrade plan):

| Decision | Keyword | What changes |
| --- | --- | --- |
| **D1, cheaper likes** | `outlivesDelete` (#5232/#5233) | The two like trend windows outlive deletes. The like author indexes drop `$createdAt`, so no like index keeps a like's time. An unlike names no `$createdAt`, and like notifications are timeless. |
| **D3, moderation teams** | `deleteWithin` + `deleteSettled` (#5215), reads (#5230) | One moderator deletes a post or reply for 7 days. After that the seated team deletes it together: the leader plus two members. A team deletion can never be restored. |
| **D4, removal records keep fields** | `deleteKeepsFields` (#5219) | A moderator's removal record keeps the post's `hashtag` and `$createdAt`, or the reply's `rootPostId` and `$createdAt`. |

**Not adopted, D2.** Posts stay author-deletable. References to posts and replies stay `deletableDocument`, and there are no preallocated like trees (the plan's §3a: +19M to +40M per post, nothing saved per steady like).

Topology `v11` (`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v11`). v2, v9 and v10 behave exactly as before.

## The file

| | |
| --- | --- |
| File | `contracts/yappr-social-contract-v11.json` |
| sha256 | `e0d38f6213659056a3fcfeacd90ab362d24d0d958fd94e88385e7791a3939a24` |
| Signed create | **~17,295 B**: 2,705 B under the 20,000 B budget, and +185 B on v10's 17,110 B |
| Parses | wasm-sdk and wasm-dpp2 under full validation; `auditNodeRules` clean; meta-schema v3 (5.0) clean |

It is byte-for-byte the 5.0 plan's `v11b-outlives-keepfields-settled` prototype, with the `SOCIAL_CONTRACT_ID` placeholder kept. `lib/contract-topology.test.ts` pins the whole diff against v10, which is exactly this:

| Type | v10 | v11 |
| --- | --- | --- |
| `like` | `byAuthorPostTime [postAuthor, postId, $createdAt]` → `$ownerId`, ranked at `[postAuthor, postId]` | **`byAuthorPost [postAuthor, postId]`** → `$ownerId`, same ranking and `rangeCountable` |
| `like` | `byTrendPost` (72h/24h), `byTrendHashtagPost` (24h/6h) | the same windows, **`outlivesDelete: true`** |
| `likeReply` | `byAuthorReplyTime [replyAuthor, replyId, $createdAt]`; `required` has `$createdAt` | **`byAuthorReply [replyAuthor, replyId]`**; `$createdAt` dropped from `required` (a type that requires it but indexes it nowhere still commits rows to it) |
| `post` | `moderatorAbilities: { delete: true }` | `{ delete: true, deleteKeepsFields: ["hashtag", "$createdAt"], deleteWithin: 604800, deleteSettled: { leader: true, approvals: 3 } }` |
| `reply` | `moderatorAbilities: { delete: true }` | `{ delete: true, deleteKeepsFields: ["rootPostId", "$createdAt"], deleteWithin: 604800, deleteSettled: { leader: true, approvals: 3 } }` |

Everything else, including the elected declaration (which already gives the team `deleteDocuments` on post and reply), is v10's.

**Why it works.** A delete stops committing to `$createdAt` only when every like index involving it outlives deletes (`index/outlives_delete.rs`). That is why the author index loses its time, not only the windows (the probe "the trend windows outlive deletes while the author index keeps $createdAt" registers but saves nothing). Each window's key minus `$createdAt` contains `byPost`'s whole key (`[postId] → $ownerId`), as the key rule requires. `approvals: 3` with `leader: true` is the leader and two other members. The declared team can hold the leader, 15 elected members and 10 added ones (26), so the rule always fits.

## Measured costs

The steady-case marginal cost is the case where the liker, post, author and tag were all seen before. It is `documentCreateCost` with known index values, plus 27,000 credits per byte for elements that are new on every write (a `$createdAt` level, or a path that pins both the target and the liker). This is the rule behind the 40.2M design-C figure. It was measured on the committed v10 and v11 files with the npm 5.0.0-beta.1 SDK. Prices are at $60/DASH, where 1M credits = $0.0006 = 0.06¢.

| Write | v10 steady | v11 steady | Saved | v10 new / known | v11 new / known |
| --- | ---: | ---: | ---: | ---: | ---: |
| like, untagged | 40.2M (2.41¢) | **30.4M (1.83¢)** | −9.8M (−0.59¢, −24%) | 95.3M / 30.7M | 85.1M / 30.4M |
| like, tagged | 66.8M (4.01¢) | **56.9M (3.42¢)** | −9.8M (−0.59¢, −15%) | 158.5M / 57.2M | 148.2M / 56.9M |
| reply like | 27.7M (1.66¢) | **19.3M (1.16¢)** | −8.5M (−0.51¢, −30%) | 57.1M / 19.5M | 48.2M / 19.3M |
| unlike | a `$createdAt` lookup read, then the delete | the delete alone | one read | | |
| post, plain / tagged / quote | 116.7M / 127.0M / 140.8M known | unchanged | 0 | | |
| reply to the root / to a reply | 56.0M / 57.0M known | unchanged | 0 | | |

The plan quoted 1.82¢ / 3.41¢ for the same credits (30.43M, 56.94M), rounded down; rounded to the nearest, they are 1.83¢ and 3.42¢.

**Moderators (D3, D4).** Nothing changes for users: posts, replies and likes cost the same. The removal record carries the kept fields: about 20 B for a short tag plus the time, and up to about 75 B for a 61-character tag or a reply's 32-byte root. That is about 0.5M to 2M credits (0.03¢ to 0.12¢) per removal, paid by the moderator. A team deletion also costs each member its approval transition, and the proposer the action, which is refunded when it runs (the closed copy is paid by the approval that ran it). The trees that hold actions refund nobody.

## What users and moderators will notice

These were accepted with the decisions:

- **Like notifications are timeless.** They read "Alice and 3 others liked your post", with no "5 min ago", and they are dated when this device first noticed them.
  - A new device starts from a silent baseline, so it shows no backlog of old like alerts.
  - Likes are diffed per recent post (see the client section). An unlike plus a new like by someone else between two polls leaves the count unchanged, so that new like is not announced.
- **An unliked like keeps counting in trending** until its window passes: up to 72 h for top posts and 24 h for trending tags. It still counts once per liker per window. A re-like within the window writes over the kept entry and is not counted twice.
  - The all-time counts drop at once: the like count, the heart, profile Top, top creators and hashtag Top all-time.
- **Moderation.**
  - For 7 days after a post or reply is written, any one moderator removes it, as on v10, and can restore it within a week.
  - After 7 days a single moderator is refused (41116). The interim owner is refused too.
  - Before a team is seated, nobody can remove a settled post (41205).
  - Once a team is seated, a member proposes, the others approve, and the deletion runs when the leader and two members have approved. It can never be restored (41209), not even by the leader.
- **Removed posts say what they were.** The removal record keeps the post's hashtag and time (a reply's thread and time), so a quote, a thread or a reply parent shows "Removed by moderators · #tag · posted Sep 30".
  - The records are not indexed, so a hashtag page still cannot list removed posts.
  - Likes of a removed post are indexOnly and nobody can remove them, so the client keeps filtering removed ids out of Top and trending, as on v10.

## Live proof on sakura (5.0.0-beta.1)

Throwaway contracts were registered by battery bots, never the maker. Proof bots: idx 0 `AtXXnY4f…` (A), idx 1 `7ardkprL…` (B), idx 2 `AXNuko2P…` (C), and persona 99 `EoAQ31Gm…` (D, never on the team). The published v11 contract is the migration's job and was not touched.

**1. `prove-merged-counts.mjs --contract-file contracts/yappr-social-contract-v11.json`.** The script registers a throwaway contract with v11's post, reply, follow, followRequest, like and likeReply types. It copies the indexes, rules and references, but leaves out fees and token costs, and it keeps v11's moderator abilities and an elected declaration over post and reply. Four week-long values get minute-long stand-ins, so that settling and expiry happen within one run:

- `deleteWithin` 90 s;
- election windows 60 s;
- the trend grids 6 min/2 min (posts) and 4 min/1 min (tags), at the real 3:1 and 4:1 ratios;
- no owner protection.

On sakura, throwaway contract `CsBuw7dqonyTBziMf2zunWTpFMU3HofeU7j5LPwyLpsf` (run 3), registered by A: **all 85 checks passed.** One quorum rotation mid-run was absorbed by the script's reconnect.

- **Every v10 shape still holds:**
  - u1-u3: 40105 on a second quote or repost; 10422 `notEmpty`;
  - q1-q4: quote counts;
  - a1-a3: author counts and the ranked top authors;
  - r1-r8: `repliesOf`;
  - f1-f5: follows;
  - c1-c6, c2x/c3x and c5x: composites, including the For You page and the path-rule refusals;
  - w1/w2, o1/o2: bare reposts and the viewer's own quote;
  - n1-n3, n6x, n7x, n8: the notification windows and the permanent bundle;
  - t1/t2, l1/l2, g1 and rm1.
- **Hearts and feed slots, unchanged from v10:** dc-a1/a3 and dc-b1 read the heart state and the feed composite's viewer-likes slot.
- **Rankings on `byAuthorPost`:**
  - ol-c: top creators.
  - ol-d: a profile's Top.
- **Likers without a time:**
  - ol-e1: one post's likers, `postId ==` ordered `[postId, $ownerId]`.
  - ol-e2: the `$ownerId >` keyset walks both likers once.
  - ol-e4/ol-e6: several posts' or replies' likers in one author-pinned `in` read.
  - ol-e3x/ol-e5x: the target-only `in` is refused.
- **Recent posts that gained likes:** dc-f1, dc-f2, dc-f3 and ol-f4 (`postAuthor ==`, `postId in`, grouped). dc-g2: reply like counts.
- **Trending.**
  - ol-t1: top posts in the oldest open window, with C's already-unliked T3 still counted.
  - ol-t2: trending tags.
  - ol-t3: a tag's top posts in its window.
  - ol-t4: hashtag Top all-time.
- **Unlikes without `$createdAt`.**
  - ol-u0, ol-h1 and ol-h2: the count and the heart drop, and so does the profile Top, while the 3-day window keeps the entry. The like and the reply like both work this way.
  - ol-h3: unliking a tagged like drops hashtag Top all-time to 1, while the 24h tag window stays at 2.
  - ol-h4: a re-like while the kept entry stands counts once, so the window still shows 1.
  - INFO ol-h0: a `$createdAt` an unlike carries is dropped by the SDK.
- **Expiry.**
  - ol-x1: once its window passed, C's unliked tag entry is gone, while B's later live like stays (tag 1, Th 1).
  - ol-x2: C's unliked T3 has left the 3-day window.
  - ol-x3: the permanent indexes are untouched.
- **D4, kept fields.**
  - kf-1: the interim owner removes D's tagged post within the window. The record keeps `{hashtag: "kept", $createdAt}`, equal to the post's own `$createdAt`.
  - kf-2: a reply's record keeps `{rootPostId, $createdAt}`.
  - kf-3: `documentRemovals` by id returns the same.
- **D3 before seating.**
  - tm-0a: past the 90 s window, the interim owner's lone delete is refused (41116).
  - tm-0b: a team proposal is refused, since no team is seated (41205).

Run 1 (contract `9DvxGGj3…`) is where the node taught the two refusals above. The `postId in` liker reads became ol-e3x/e5x. An expiry check trusted the local clock and became a poll.

**2. Seating the team.** The ops election tooling (`ops/election` in the sakura ops directory) seated the throwaway contract's team with a single applicant and no votes:

- `file-charter.mjs`: the leader B with reasons SPM and ABU (SPM is `8P94zE6z…`);
- `join-request.mjs`: C and A;
- `file-charter.mjs --apply`: the 0.5 DASH election fund.

The seat was awarded when the 60 s join window closed.

`prove-merged-counts.mjs --team-proof CsBuw7dq… --reason-doc 8P94zE6z…` passed **all 15 checks.** D writes fresh targets for each run and they settle, so the phase can be repeated. Action counts are compared as deltas, because they reset only when the pot pays out.

- **tm-1, the team.** The leader is B, the members C and A. `seats(10)` = 13, so a settled deletion needs min(3, 13) = 3 approvals, the leader's among them. D is not on the team.
- **tm-2:** a member's lone delete of the settled S1 is refused (41116).
- **Proposal and reads.**
  - tm-3: C proposes. The action is active, holding C's own approval.
  - tm-4: `teamActions(active)` shows `approvalCount` 1 with C as proposer, and `teamActionSigners` = [C].
  - tm-5: C approving again is refused (41208).
- **Approvals and the deletion.**
  - tm-6: A approves. The action is 2 of 3 and still active, because the leader is required, and S1 still exists.
  - tm-7: the leader approves. The action runs and closes with 3 approvals and 3 signers, and S1 is gone.
- **tm-8, the record.** The moderator is the leader, whose approval ran the deletion. It carries the proposal's reason and `keptFields {hashtag: "settle", $createdAt}`.
- **tm-9:** restoring a team deletion is refused, even for the leader (41209).
- **Action counts.**
  - tm-10: +1 for each of the three approvers.
  - tm-13: after the later steps, leader +2, first member +2, second member +3.
- **Inside the window.**
  - tm-11a: a proposal for a fresh post is refused (41206).
  - tm-11b: a lone member delete of it works, and the record keeps `hashtag: "fresh"`.
- **tm-12, a settled reply:** the leader proposes and two members approve (active, active, closed). The record keeps `rootPostId` and `$createdAt`.
- **tm-14:** approving a closed action is refused (41210).

It also passed 15/15 on run 1 (`9DvxGGj3…`).

**3. `verify-v10.mjs --contract-file contracts/yappr-social-contract-v11.json`** ran against a full v11 draft. The draft `C94i8HwriER7YNcYX24MRw3vKxd5hhsQsQ5QqYa51P4Y` was registered from this exact file (sha `e0d38f62…`) by bot 2 with `register-social-v3-draft.mjs`, which also funded the bots with YAPP. Bot 2, the draft's owner, was the interim moderator.

It passed **221 checks** with 4 SKIPs and 3 FAILs.

- **SKIPs:**
  - x3a and y1f-y1g need a fresh identity with no DashPay profile and no starter claim (`--fresh-bot`). The only such bot is reserved for the migration's battery.
  - r2 needs a seated team.
  - k2 needs a bot with no YAPP.
- **FAILs:** the 3 were transport faults, not v11 behaviour. r1i and r1j hit "Quorum not found in cache" during a quorum rotation, and s1b's proved status read came back from a lagging node. The re-run of r1 and s1 alone (`--only r1,s1`) passed all 33 checks.

The v11 switches all passed:

- **m1k:** an interim removal keeps the untagged post's `$createdAt`, and no hashtag.
- **t2h-t2o:**
  - an unlike with no `$createdAt`;
  - the 24h tag window and the 3-day window still count it;
  - the all-time `byHashtagPost` drops it;
  - a re-like counts once.
- **n2b-n2g:**
  - the author-pinned liker read has no time;
  - the heart state;
  - unlikes with no time, for a post and a reply.

Every carried v10 case passed, the action-fee, token, ban, warning and report cases included.

**What the node taught us** (the client follows all of these):

- **Several targets' likers in one read must pin the author.**
  - `like` where `postAuthor == me && postId in [...]`, ordered `[postAuthor, postId]`, works on `byAuthorPost`; the same holds for `likeReply` on `byAuthorReply`. Rows come back without a time.
  - `postId in [...]` alone on `byPost` is refused: "an `in` clause on an indexOnly prefix property requires an EQUALITY clause on the terminal". The heart state form, `postId in` + `$ownerId ==`, is unaffected.
- **One target's likers are paged by a keyset on the terminal:** `postId == T && $ownerId > <last>`, ordered `[postId, $ownerId]`. An id cursor is still refused on indexOnly.
- **The SDK drops a `$createdAt` an unlike carries on a type that outlives deletes**, so the delete is accepted either way. The client never sends one.
- **Block time trails the local clock by up to a block or two.** Window-expiry checks poll instead of trusting the local clock, and the client already treats the minute around a deletion window's end as undecided (the node rules).
- **`deleteSettled` on a type the team cannot delete** passes both wasm parsers. The node refuses it with 10900, so `auditNodeRules` now flags it.

## Client (topology v11)

**Topology** (`lib/contract-topology.ts`):

- `v11` reuses every v10 surface; `isV10()` is true on v10 and v11.
- New helpers:
  - `isV11()`;
  - `IndexOnlyLikeShape.deleteNamesCreatedAt` (false on v11) and `authorTimeIndex: null`;
  - `likeNotificationsAreTimeless()`;
  - `settledDeletionFor(docType)` (`{ windowSeconds, leaderRequired, approvals }`), `moderatorDeleteWindowSeconds(docType)` and `removalKeptFieldsFor(docType)`.
- Contract-derived values (windows, grant, fees, election) read the v11 JSON.

**Likes** (`like-service.ts`, `notification-service.ts`, `lib/like-notification-snapshot.ts`):

- **Unlike.** The client reads the heart state (`byPost`/`byReply`, `$ownerId ==`), then deletes by values: the like's content properties only, with no `$createdAt` and no tuple recovery or cache. Unliking something that isn't liked is a no-op.
- **Notifications.**
  1. Find the user's recent posts and replies with like counts. This is the v10 composite count slot, kept as `getRecentTargetLikeCounts`.
  2. Compare the counts with this device's snapshot.
  3. For targets whose count changed, read the likers with one author-pinned `in` read per kind. A full page falls back to per-target keyset pages.
  4. Diff against the stored likers. New likers become one notification per target, "Alice and N others".
- **Snapshot.** Scoped storage key `yappr_like_notifications:<userId>`. It keeps only the recent targets and keeps batches for 7 days, at most 100.
  - The first poll per kind is a silent baseline.
  - The snapshot also keeps a horizon: the time of the oldest recent target per kind. An older post that re-enters the recent window (for example after a newer one is deleted) is recorded silently.
  - Stored likers are merged with each read unless the count fell. A read that lists fewer likers than the count stores the lower count, so a node a block behind is read again next poll. A liker already named in a kept batch is not named again.
  - Each target tracks at most 200 likers. Past that it stops naming new ones.
  - A poll whose snapshot did not save creates no new batch.
  - Two tabs serialize through `navigator.locks` where the browser has it; otherwise a poll that sees another tab's save keeps that one and diffs again next time.
  - Batches count as delivered only after a poll succeeds.
  - The user is never their own liker.
  - Like notifications stay out of the poll watermark.
- **The notifications page** shows the aggregate and hides the relative time for these alone.
- **Unchanged.** Profile Top, top creators, trending and hashtag Top name no index and keep their v10 queries.

**Moderation** (`moderation-service.ts`, `components/moderation/*`):

- **Removal records** carry `kept` (`hashtag`, `rootPostId`, `createdAt`), shown on removed-post stubs and in the removal list.
- **A post's deletion phase** is `open`, `closing` or `settled`. `closing` covers the 60 s either side of the window's end: the single delete is still offered there, and a 41116 switches to the team route. The Remove menu reads "Remove post (settled: team only)" for a settled post.
- **For a settled post, a seated member gets "Propose team removal".**
  - The reason must be one the team's charter lists.
  - The modal says it needs the leader plus N members and cannot be undone.
  - If another member already proposed the same post, it offers "Approve the proposed removal" instead, or "You already approved (n of m)" to a member who signed it.
  - When no team is seated, or the viewer is not on it, the modal explains that.
  - `seats()` counts unfilled added seats, so a team smaller than the rule (a leader with one member) could never meet it, and a proposal never lapses. The modal and the panel then warn that the team must add a member, and Propose is disabled.
- **The team removals panel** lists the newest 20 active proposals with "2 of 3 approvals", whether the leader is still needed, who signed, the post, the reason, and Approve or "You approved". Signers and liveness are read for the shown rows only, and a proposal whose post is already gone is dimmed with no Approve. Closed actions are one page, labelled a sample when there are more (action ids carry no time order). There is no restore button.
- **v2, v9 and v10** resolve the single delete synchronously, and read team seats only on v11.
- **Team seats and per-member action counts** show beside the moderators pot (`moderationActionCounts`). The pot's action share splits by these counts.
- **Errors** 41116 and 41204-41211 have messages, plus `DOCUMENT_GONE` for an approval whose document is already deleted.

## Tooling

- **`scripts/validate-contract-offline.mjs`** passes v11 with `--strict-size --cost`.
  - The probes add a v11 control and 14 v11 probes: the `outlivesDelete` key rule, ttl and stored-type refusals, the partial-adoption control, the `deleteSettled` bounds 1-26 and its need for `deleteWithin`, a 0 s window, and `deleteKeepsFields` naming `$id`, an unknown property, an unrequired time, or a record kept nowhere.
  - `auditNodeRules` adds two rules: a `deleteSettled` type the team cannot delete (10900), and `deleteSettled` without an elected team (10231).
  - The `propertyConstraints` cases also run against the v11 file, whose rules are v10's.
- **`scripts/prove-merged-counts.mjs`**:
  - `--contract-file` selects the cut.
  - v11 replaces the time-based like reads (dc-e, dc-h, dc-k) with the `ol-*` checks and adds `kf-*` and `tm-0*`.
  - `--team-proof <contractId> --reason-doc <id>` runs the team phase.
  - It takes a fourth identity, D. Phase 1 writes its targets to a `--state-file` for the record. The team phase writes fresh targets and compares action counts as deltas, so it can run again.
  - A quorum rotation rebuilds the SDK instance and re-runs the read (as verify-lib does); writes that must not be sent twice are not retried.
- **`scripts/verify-v10.mjs`**:
  - `--contract-file contracts/yappr-social-contract-v11.json` switches t2, n2 and m1 to the v11 behaviour, and the self-test to v11's pins.
  - `--moderator bot:<n>` accepts the bot that registered a draft, checked against the contract's owner.

## Publishing (the migration's job)

- A new social id means storefront, blog and pollr are published again, since they embed the social id for YAPP prices. DM, key exchange and the vaults are reused.
- Set `NEXT_PUBLIC_CONTRACT_TOPOLOGY=v11` with the new id.
- **E1 must run on the new contract.** `deleteSettled` needs a seated team, and until one is seated nobody can remove a post older than a week. The devnet election windows stay 3600 s.
- The charter should list SPM, ABU and REP, as for v10.
