# Contract v4 verification — Phase 2a results

*Like-overhaul design sprint, Phase 2a (PLAN_LIKE_OVERHAUL.md §7). Scope was
cut mid-phase to verification only — all fee pricing was dropped (the fee
schedule is about to change and the numbers are owned elsewhere). Run on the
moutai devnet, protocol v14, `@dashevo/evo-sdk` 4.2.0-dev.5, 2026-08-29.
Battery: `scripts/experiment-v4-verify.mjs` — 12/12 checks passed on the
first live run, no fallback shapes needed. Signer: the devnet maker (seed
index 9). Throwaway contract (maker-owned, supersedes nothing):
`ELmVZGM2nySbjf3pWFV4ttx74yg7UmbCqGZhty1TuKA8`.*

Contract shape: stored `post` (permanent, mutable; `content` + `author`) and
ONE minimal indexOnly `like`:

```
like: indexOnly · documentsMutable: false · canBeDeleted: true
  postId      refersTo permanentDocument→post, propertyAgreement {postAuthor: author}
  postAuthor  identifier
  required: postId, postAuthor, $createdAt      ← forced by byAuthorTimePost
  byAuthorPost      [postAuthor, postId] → $ownerId   countable+rangeCountable+rankedCountable, preallocated
  byAuthorTimePost  [postAuthor, $createdAt, postId] → $ownerId
  byLiker           [$ownerId] → postId
```

No hashtag property/axis — that half of the design is gated on the upstream
null-skip release (D6) and was out of scope here.

## Verdict 1 — 3-property byAuthorTimePost recovery: **WORKS end-to-end**

Phase 1 proved D2a tuple recovery only on the 2-property `byAuthorTime
[postAuthor, $createdAt]` (which collides for same-block likes); v4 specs the
collision-free 3-property spelling. Verified here end-to-end, using nothing
returned by the create:

1. `byLiker` (`$ownerId == me ORDER BY postId`) recovered both liked postIds;
2. `byAuthorTimePost` (`postAuthor == A1 ORDER BY $createdAt desc`) — the
   exact "newest first" notification shape the app will run — was accepted
   directly against the 3-property index (no orderBy fallback needed), and
   its synthesized projection carries **`$createdAt` AND `postId`**
   (+`postAuthor`, `$ownerId`). The postId in the projection makes the match
   exact rather than positional — no `byLiker` join is needed to know which
   like a notification row is, confirming the Phase-1 prediction;
3. recovered `$createdAt` was the consensus-assigned epoch-ms timestamp
   (3s skew from wall clock at read time);
4. the referenced post supplied `postAuthor`;
5. a locally rebuilt `Document` carrying the recovered
   `(postId, postAuthor, $createdAt)` tuple under a fresh local `$id`
   **deleted successfully**, and the neighboring like (same author, same
   liker) survived the deletion untouched.

## Verdict 2 — byAuthorPost does NOT trip the one-like-per-author trap: **CONFIRMED**

Two likes by one liker on two different posts of the same author were both
accepted. The Phase-1 `byAuthor [postAuthor] terminal $ownerId` shape
projects to `(postAuthor, $ownerId)` and structurally rejects the second like
with 40105; `byAuthorPost [postAuthor, postId]` regains `postId` in the
projection and is safe. (The unlike in verdict 1 then deleted one of the two
while the other remained — entries are fully independent.)

## Verdict 3 — author-pinned ranked on byAuthorPost: **WORKS**

The profile-"Top"-tab query shape returns the author's posts ordered by like
count:

```js
sdk.documents.ranked({
  dataContractId, documentTypeName: 'like',
  groupBy: 'postId', aggregate: { type: 'count' }, limit: 10,
  where: [['postAuthor', '==', authorIdBase58]],
})
```

With 3 posts by the pinned author (2 liked, 1 not), the page returned exactly
3 entries with values `[1, 1, 0]` — the unliked post appears as a zero-count
group because `preallocated` makes every referenced post a rankable group
from birth (consistent with Phase 1: clients filter `value === 0n`).

## Grammar surprises

None. Everything registered and behaved exactly as the Phase-1 findings
predicted:

- `byAuthorPost [postAuthor, postId]` with the full
  countable→rangeCountable→rankedCountable chain + `preallocated` registers
  (postId, the referring property, is in the index's own property list;
  postAuthor binds as an agreement key).
- The 3-property `byAuthorTimePost` registers and forces `$createdAt` into
  `required`.
- `ORDER BY $createdAt desc` with the leading property pinned lowers onto the
  3-property index without needing `postId` in the orderBy.

## Reproduction

```bash
node scripts/experiment-v4-verify.mjs --dry-run          # local validation only
node scripts/experiment-v4-verify.mjs                    # full battery (~2 min, registers a throwaway)
node scripts/experiment-v4-verify.mjs --contract <id>    # reuse a registered contract
```

Needs `E2E_SEED_PHRASE` (env or `.env.local`) and warm moutai quorum
endpoints (`curl https://quorums.moutai.networks.dash.org/{quorums,previous,masternodes}`
first after idle).
