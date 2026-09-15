# Contract v4 QA battery results (Phase 2c)

*Run 2026-08-29 live on moutai devnet against the registered v4 draft contract
`Aux325ifCRkYUteevirCv7ptHm3YB2g7PbMo8UjQwoz` with `@dashevo/evo-sdk@4.2.0-dev.5`
(protocol v14). Battery: `scripts/verify-v4.mjs` — **68/68 strict checks PASSED**
end-to-end (`ALL CHECKS PASSED`, exit 0) on the first complete run. Signers:
bot 0 `EEKarQ4hK3eiBGWNp1j11L7DMfdyFD6zfqaUktj81ikD` (A) and bot 1
`3NdmhtrNQA83jfUMTotE2pZyxSoYd1JxYqabNFdNRwGu` (B), paying YAPP token
`FcxZ9pAkUMTq41Zfc2Xmufd6dT9vgJmDi9SnTkXfSPDW` per write (post 10 / reply 3 /
like 1 / likeReply 1 / repost 1).*

Every acceptance was decided by chain readback (never the SDK's throw/no-throw)
and every rejection had to match the case's expected consensus reason — a
rejection for any other reason fails the case.

A full **re-run on the then-dirty contract also passed 68/68**, surviving a
mid-run devnet quorum rotation via the battery's reconnect logic (see the
second SDK gotcha below). Re-runnability is by construction: run-unique
hashtags, fresh anchors per run, a leftover-follow sweep, and
accumulation-proof ranked assertions.

**Contract defects found: NONE.** The one blocker hit was a *client SDK*
landmine (§ "SDK gotcha" below), worked around inside the battery.

## Verdicts

### A — v3 topology rebased onto v4 (posts/replies now require `author` + `hashtag`)

| Case | Verdict | Notes |
|---|---|---|
| a1a ghost `rootPostId` rejected | PASS | 40120 |
| a1b flat reply (no `replyToReplyId`) accepted | PASS | |
| a1c nested reply (real `replyToReplyId`) accepted | PASS | |
| a1d ghost `replyToReplyId` rejected | PASS | 40120 |
| a2a quote-of-post accepted | PASS | |
| a2b quote-of-reply accepted | PASS | |
| a2c same owner re-quoting same post accepted | PASS | uniqueness deliberately dropped |
| a2d both quote fields at once tolerated | PASS | |
| a2e ghost `quotedPostId` rejected | PASS | 40120 |
| a2f ghost `quotedReplyId` rejected | PASS | 40120 |
| a2g REPLY id in `quotedPostId` rejected | PASS | resolves only against `post` |
| a3a repost of a REPLY rejected | PASS | 40120 |
| a3b bookmark of a REPLY rejected | PASS | 40120 |
| a3c/a3d repost + bookmark of a real post accepted | PASS | |
| a4a–c post: tombstone replace accepted, delete rejected | PASS | `canBeDeleted: false` |
| a4d–f reply: tombstone replace accepted, delete rejected | PASS | |
| a5a follow of ghost identity rejected | PASS | 40120, identity refersTo |
| a5b follow of real identity accepted | PASS | swept + cleaned up (unique `ownerAndFollowing` outlives runs) |
| a5c postMention of ghost identity rejected | PASS | 40120 |
| a5d postMention of real identity accepted | PASS | |
| a6a `byRoot` counts the whole thread | PASS | 4/4 (flat + nested + anchor + tombstoned reply) |
| a6b `byReplyToReply` exact | PASS | 1/1 |
| a6c `quoteCount` exact | PASS | 3/3 |
| a6d `quoteReplyCount` exact | PASS | 2/2 |

### B — the indexOnly like family

| Case | Verdict | Notes |
|---|---|---|
| b1a like on tagged post accepted | PASS | readback via `postId == X AND $ownerId == me` (byPost entry) |
| b1b `byPost` countable sees it | PASS | count 1 |
| b2a wrong hashtag on like → 40127 | PASS | |
| b2b wrong postAuthor → 40127 | PASS | agreement names the referenced property (`author`) |
| b2c `''` post + tagged like → 40127 | PASS | sentinel enforced this direction |
| b2d tagged post + `''` like → 40127 | PASS | and the other direction |
| b3a ghost postId → 40120 | PASS | |
| b4a duplicate like → 40105 | PASS | structural uniqueness; the colliding projection reported was `["postAuthor", "postId", "$ownerId"]` (byAuthorPost — ANY index projection collision rejects) |
| b5a same liker, 2nd post by SAME author accepted | PASS | **trap-regression guard**: a `[postAuthor]`-only index would have 40105'd this |
| b5b `''` + `''` (positive sentinel) accepted | PASS | |
| b6a batched membership exact | PASS | `$ownerId == me AND postId IN [4] ORDER BY postId` → exactly the 3 liked; absence of the 4th proved |
| b7a global ranked: liked posts at count 1 | PASS | `documents.ranked` groupBy postId |
| b7b never-liked post is a ZERO-count group | PASS | preallocation materializes groups at post-create; clients must filter `value > 0` |
| b7c per-hashtag pin exact | PASS | run-unique tag → exactly 2 groups, both 1 |
| b7d `''` sentinel pin | PASS | untagged liked post at 1, zero groups filtered |
| b7e author pin (byAuthorPost) | PASS | B's 3 liked posts at 1 |
| b8a `byLiker` recovers postId | PASS | |
| b8b `byAuthorTimePost` projection carries `$createdAt` (+ postId + $ownerId) | PASS | the notification/recovery read |
| b8c referenced post supplies hashtag + postAuthor | PASS | |
| b8d unlike with the query-recovered tuple accepted | PASS | **no create-returned Document used anywhere** |
| b8e `byPost` count decrements 1 → 0 | PASS | |
| b8f re-like accepted | PASS | uniqueness cleared by the delete |
| b9a bot B's own (self-)like accepted | PASS | victim tuple |
| b9b bot A deleting B's tuple rejected | PASS | `Invalid State Transition signature` — dies in signature validation |
| b9c B's entry survives | PASS | |
| b10a–i likeReply mirror | PASS ×9 | ghost 40120, wrong replyAuthor 40127, duplicate 40105 (projection `["$ownerId", "replyId"]` = byLiker), byReply count exact, full query-recovery unlike, count back to 0 |
| b11a–d tombstone interplay | PASS ×4 | see documented behavior below |
| b12a tag listing via `post.tagAndTime` | PASS | hashtag ==, orderBy `$createdAt` → exactly the run's 2 tagged posts |

### b11 documented behavior — likes outlive tombstones

Tombstoning is an ordinary replace: the post document still exists, so its
likes (entries, counts, ranked groups, preallocated trees) are untouched, and
nothing stops NEW likes on a tombstoned post. Clients must hide tombstoned
posts (and their like affordances) by the `deleted` flag — the chain does not
cascade.

## SDK gotcha (blocker found + workaround; NOT a contract defect)

The first run died on `sdk.contracts.fetch(Aux325if…)` — and every other proved
read touching the v4 contract — with, verbatim:

```
dash drive: protocol: value wrong type error: unexpected property name  (error class: Proof)
```

Root cause (confirmed by bisecting `DataContract.fromBytes` of the raw on-chain
bytes across platform versions — PV12/13 reproduce the error exactly, PV14
parses fine): **rs-sdk starts every devnet SDK instance at protocol version 12**
(`min_protocol_version` in rs-sdk `sdk.rs`) and only ratchets upward from
*verified* response metadata (`maybe_update_protocol_version`). The v4 contract
uses the PV14 ranked-index grammar (`terminal`, `preallocated`,
`countable`/`rangeCountable`/`rankedCountable`), whose keys the PV12/13 index
parser rejects as unknown — and the failing verification never ratchets, so the
SDK is stuck (and the DAPI address pool gets poisoned by the retries:
`no available addresses to retry`). The chain itself reports PV14 everywhere
(`getStatus`, epoch info, block metadata).

Workaround (baked into `verify-v4.mjs`, required for **every** v4 client): issue
one proved query that does not involve a ranked-grammar contract — the battery
uses `sdk.epoch.current()` — immediately after `connect()`, before touching the
v4 contract. Phase 1 dodged this by accident (it fetched the maker identity
before its contract). **Phase 3 client migration must guarantee the same
ordering** (or pin the SDK version once an explicit knob is exposed:
`SdkBuilder::with_version` exists in Rust but is not surfaced in evo-sdk JS).
Worth filing upstream: devnets should start at latest-known or ratchet from
`getStatus` at connect.

Also observed: moutai was restarted ~2026-08-29 03:05 UTC (epoch 0, genesis at
PV14, height ~560 during the run). All pre-restart data on the old chain is
gone, but the v4 contract, both bots, and their 1000-YAPP balances are live on
the new chain.

## Second SDK gotcha: mid-run quorum rotation kills the trusted context

A ~20-minute run outlives devnet DKG cycles. The trusted context prefetches
quorum keys once at `connect()`; when a new quorum starts signing proofs the
verification fails with, verbatim:

```
Proof verification error: context provider error: invalid quorum: Quorum not found in cache for hash: 000001ae5f82081f58d7c4f0a1cf76467b97
```

and each failure **bans the DAPI address** until the pool is empty
(`no available addresses to retry` / `no available addresses to use`), leaving
the SDK instance permanently dead — there is no quorum-refresh or unban API in
evo-sdk 4.2.0-dev.5. One full run was lost to this. The battery now detects the
collapse signature and swaps in a freshly connected SDK (new quorum prefetch +
address pool + version ratchet + contract cache) behind a proxy handle; the
re-run hit a real rotation mid-flight, reconnected once, and finished 68/68.
Long-lived v4 clients (the app keeps one SDK for a whole session) need the same
recover-by-reconnect strategy; worth filing upstream alongside the ratchet ask.

## Verbatim consensus errors (every negative case)

The excerpts below are the error **message** field; the SDK additionally
attaches the numeric consensus code (`code=40120` / `40127` / `40105`) on the
same error object, and the battery's expected-reason patterns key on that code
first (via `describeErr`, which concatenates message + code), with the message
text as the documented human-readable alternative.

- **40120 — referenced permanent document not found** (a1a, a1d, a2e, a2f, a2g, a3a, a3b, b3a, b10b):
  ```
  state transition broadcast error: referenced permanent document (own contract, document type post) DiBZiAnpN3arfdL795RnX21AwSwadrqHHbhBeM5gVuaZ not found for path rootPostId
  state transition broadcast error: referenced permanent document (own contract, document type reply) FvFKrQwTT2GcfcmiVZd5WCTGgfvbETR95B5m4N3FMzFB not found for path replyToReplyId
  state transition broadcast error: referenced permanent document (own contract, document type post) CajGntLHVSJr2RvqnUaopCipqkkCBB3x3KL2F6Jcjj2r not found for path quotedPostId
  state transition broadcast error: referenced permanent document (own contract, document type reply) 91uKytb8joPBwXanNcJeVCBDRk4Apayyhb5GB9JJJ1HH not found for path quotedReplyId
  state transition broadcast error: referenced permanent document (own contract, document type post) 3nvCdG5je7grK3xD3pEzpuoR7Bg55fKQj97n9R7wdiYT not found for path quotedPostId   ← a REPLY id offered where a post is required
  state transition broadcast error: referenced permanent document (own contract, document type post) 3nvCdG5je7grK3xD3pEzpuoR7Bg55fKQj97n9R7wdiYT not found for path postId          ← repost/bookmark of a reply
  state transition broadcast error: referenced permanent document (own contract, document type post) 2UeMgXPaVE724vRrM3gCArxhCTWLEwGoXWKyikMAHova not found for path postId          ← ghost like target
  state transition broadcast error: referenced permanent document (own contract, document type reply) TTwWNsnzcFQvuR5HzQtjYzkRYA2DhU348sEgtMrtX2b not found for path replyId         ← ghost likeReply target
  ```
- **40120 — referenced identity not found** (a5a, a5c):
  ```
  state transition broadcast error: referenced identity GbxgTsaNCK6XkYfjN7qQbhcc9gCYuRZqhgN6mu39sCJM not found for path followingId
  state transition broadcast error: referenced identity Hc6u6FSJHngcukroHTNXXu3LdqU92umFApoBkDMWq5t7 not found for path mentionedUserId
  ```
- **40127 — propertyAgreement mismatch** (b2a–d, b10c):
  ```
  state transition broadcast error: the document's hashtag does not agree with the referenced document's hashtag (propertyAgreement on postId)
  state transition broadcast error: the document's postAuthor does not agree with the referenced document's author (propertyAgreement on postId)
  state transition broadcast error: the document's replyAuthor does not agree with the referenced document's author (propertyAgreement on replyId)
  ```
  (both `''`-sentinel directions produce the hashtag variant)
- **40105 — structural uniqueness** (b4a, b10e):
  ```
  state transition broadcast error: Document 7zqFDF6zjUyWCCu6XLKd4qfFg1mkqii7sHTTdAqzetoh has duplicate unique properties ["postAuthor", "postId", "$ownerId"] with other documents
  state transition broadcast error: Document 67rBCHoRnwDXhmUjvvsR2idYdzb9CuMEzcZLXpnzhDdG has duplicate unique properties ["$ownerId", "replyId"] with other documents
  ```
- **delete-immutability** (a4c, a4f):
  ```
  Document transition action documents of type post can not be deleted is not supported
  Document transition action documents of type reply can not be deleted is not supported
  ```
- **foreign delete** (b9b — a delete whose document `$ownerId` is B, signed by A):
  ```
  Invalid State Transition signature
  ```

## Working query shapes (verified live)

```jsonc
// batched liked-state membership (byLiker, terminal-in; absence proved)
{ "documentTypeName": "like",
  "where": [["$ownerId", "==", "<me>"], ["postId", "in", ["<id>", "…"]]],
  "orderBy": [["postId", "asc"]] }

// global top-K posts by like count (byPost ranked chain)
{ "documentTypeName": "like", "groupBy": "postId",
  "aggregate": { "type": "count" }, "limit": 100 }
// → sdk.documents.ranked(...); entries carry {groupValue: base58 postId, value: bigint};
//   preallocated zero-count groups ARE included — filter value > 0n client-side.

// per-hashtag top-K (byHashtagPost '==' pin; '' pins the untagged bucket)
{ "documentTypeName": "like", "groupBy": "postId",
  "aggregate": { "type": "count" }, "limit": 10,
  "where": [["hashtag", "==", "<tag-or-empty>"]] }

// author-pinned top-K (byAuthorPost '==' pin)
{ "documentTypeName": "like", "groupBy": "postId",
  "aggregate": { "type": "count" }, "limit": 100,
  "where": [["postAuthor", "==", "<authorId>"]] }

// my likes (byLiker)
{ "documentTypeName": "like",
  "where": [["$ownerId", "==", "<me>"]], "orderBy": [["postId", "asc"]] }

// notification / unlike-recovery read (byAuthorTimePost) — the projection
// carries $createdAt + postId + $ownerId, enough to rebuild the delete tuple
{ "documentTypeName": "like",
  "where": [["postAuthor", "==", "<authorId>"]],
  "orderBy": [["$createdAt", "desc"]], "limit": 100 }

// per-post like count (byPost countable) — sdk.documents.count
{ "documentTypeName": "like", "where": [["postId", "==", "<postId>"]] }

// tag-page listing (post.tagAndTime)
{ "documentTypeName": "post",
  "where": [["hashtag", "==", "<tag>"]], "orderBy": [["$createdAt", "asc"]] }
```

Unlike (delete-by-values): build a `Document` from the recovered tuple
`{postId, hashtag, postAuthor}` + `$createdAt` (v4 keeps `$createdAt` in
`required`, so it is part of the value tuple) under a fresh locally-generated
`$id`, and `sdk.documents.delete({document})`. Verified for `like` and
`likeReply`, with the create-returned Document never consulted.

## Surprises / carry-forwards for Phase 3

1. The **SDK protocol-version ratchet** (§ above) is the big one — every v4
   client must warm the SDK with a non-v4 proved query before its first v4 read.
2. The 40105 duplicate error for `like` reports the **byAuthorPost** projection
   (`["postAuthor", "postId", "$ownerId"]`), not byPost — any index projection
   collision fires; do not pattern-match a specific tuple client-side.
3. Ranked pages include zero-count groups (preallocation working as designed) —
   the client wrapper must filter `value > 0n`.
4. `documents.query` on indexOnly types returns synthesized projections whose
   `$id` differs per covering index — correlate by (`$ownerId`, `postId`), never
   by `$id` (re-confirms the Phase 1 finding).
5. Battery re-runs accumulate data on the shared contract: per-run-unique
   hashtags keep b7c/b12 exact; the global/author/`''` ranked assertions prove
   exact per-post values via the countable index (`countBy`) and only require
   page presence while the top-K page still has room (a full page may
   legitimately crowd out this run's count-1 groups). This drift is accepted:
   each run permanently leaves ~10 posts and ~5 likes behind (the a5 follow is
   the one uniquely-indexed doc, and it is swept).
