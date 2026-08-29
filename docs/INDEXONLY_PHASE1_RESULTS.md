# indexOnly Phase 1 — devnet experiments + fee measurement

*Like-overhaul design sprint, Phase 1 (PLAN_LIKE_OVERHAUL.md §5.1). Run on the
moutai devnet, protocol v14, `@dashevo/evo-sdk` 4.2.0-dev.5, 2026-08-29.
Battery: `scripts/experiment-indexonly.mjs` — 41/41 checks passed on the final
run. Signer: the devnet maker (seed index 9). Throwaway contracts (all
maker-owned, superseded nothing):
`DBY5Jhnbs9PyXNftR6VzGSACikvuSEVShmnZiFkCZzNE` (round 1, plan-spec indexes),
`BcZX4b8dR6HLkMQny5AX3H9GjkR5BoLDcFEw2SNEVK9a`,
`DiqDqeTgex2z9erXwWnnTojcmKReM6E7bKEzAe2BC5Uk`,
`Bk3kWM5btFJCtK5hbwJLGYTdntnsNKM84FKSpfzcQsHQ` (round 4, final clean run).*

Battery contract shape: stored `post` (permanent, mutable) + byte-identical
control `postC` (nothing refers to it) + indexOnly `like` (3 ranked axes, 2–3
preallocated) + `likeT` (the D2 vehicle: `$createdAt` forced into the tuple by
a notification index) + `likeB` (the plan's original `byAuthor` shape, kept to
demonstrate its failure mode on demand).

## Experiment verdicts

### D1 — the `''` sentinel for untagged posts: **VIABLE, adopt it**

Everything the sentinel touches works:

- `minLength: 0` on an indexed string registers without complaint (v2 folklore
  said indexed strings need `minLength 1` — not true on meta-schema v3).
- `propertyAgreement` enforces `''` exactly like any other value: a like
  carrying `'dash'` against a `''` post is refused with **40127**, `''`
  against `'dash'` likewise, and `''`-on-`''` is accepted.
- The ranked surface pins `''` fine: `where: [['hashtag', '==', '']]` on
  `byHashtagPost` returns exactly the untagged posts' groups.

Verbatim 40127 text (both agreement keys produce the same shape):

```
state transition broadcast error: the document's hashtag does not agree with
the referenced document's hashtag (propertyAgreement on postId)   (code 40127)
state transition broadcast error: the document's postAuthor does not agree with
the referenced document's author (propertyAgreement on postId)    (code 40127)
```

### D2a — `$createdAt` recovery for multi-device unlike: **WORKS end-to-end**

A `likeT` (whose `[postAuthor, $createdAt]` index forces `$createdAt` into
`required` and therefore into the delete tuple) was created and then deleted
**without using anything returned by the create**:

1. `byLiker` (`$ownerId == me ORDER BY postId`) recovered the `postId`;
2. the notification index (`postAuthor == author ORDER BY $createdAt desc`)
   synthesized a projection carrying the exact consensus-assigned `$createdAt`
   (epoch ms, 3s skew from wall clock at read time);
3. the referenced post supplied `hashtag` + `postAuthor`;
4. a locally rebuilt `Document` carrying that tuple **deleted successfully**
   and refunded 101.2M of the 108.5M create.

So option (a) of D2 is safe — with two caveats found on the way:

- **Same-block collision**: `byAuthorTime [postAuthor, $createdAt] terminal
  $ownerId` projects to `(postAuthor, $createdAt, $ownerId)`. Two likes of the
  same author's posts landing in one block share the block timestamp and
  would collide (40105). Use **`byAuthorTimePost [postAuthor, $createdAt,
  postId] terminal $ownerId`** instead — it registers fine, cannot collide,
  and its projection hands the notification the `postId` for free (no
  `byLiker` join needed).
- **The create returns no confirmed Document today** (next section), so tuple
  recovery is not a fallback for other devices — right now it is the only
  correct unlike path for `$createdAt`-carrying types on the JS SDK.

### NEW — `byAuthor [postAuthor] terminal $ownerId` is structurally broken

The plan's creator-leaderboard index cannot exist on a like type. An
indexOnly create probes **every** index and any existing entry is a duplicate
(40105); an index's entry position is `(its properties…, terminal)`. For
`[postAuthor] terminal $ownerId` that is `(postAuthor, $ownerId)` — **one like
per (author, liker), ever**. Reproduced deliberately on `likeB`:

```
state transition broadcast error: Document 5tRwsr… has duplicate unique
properties ["postAuthor", "$ownerId"] with other documents        (code 40105)
```

(Round 1 hit this by accident: with `byAuthor` on the real `like` type, the
second like of any maker-authored post was refused, and the duplicate check
fired **before** `propertyAgreement`/`refersTo` validation, masking the 40127
and 40120 cases.)

**Fix adopted for the battery (recommend for v4): `byAuthorPost [postAuthor,
postId] terminal $ownerId`** — the projection regains `postId`, and because
`postId` (the referring property) is now among the index properties, the index
also becomes preallocatable. Consequences for features:

| Feature | Status |
|---|---|
| Author's top posts (profile "Top" tab) | **works** — ranked with `postAuthor` pinned, `groupBy: 'postId'` (shape below) |
| Global creator leaderboard (`groupBy: 'postAuthor'`) | **impossible** — needs a single-property `postAuthor` `rankedCountable` index, which is exactly the broken shape. Server refusal: *"no ranked index covers `group_by = [postAuthor]` on the Count axis … the document type needs a single-property index on `postAuthor` declaring `rankedCountable`"* |
| Per-author like totals via `count` | **impossible** — see the exact-match rule below. Client-side: sum the author's per-post counts from the pinned ranked page (bounded by post count / top-100) |

### Batched membership: works exactly as designed

`$ownerId == me AND postId IN [five ids] ORDER BY postId` on `byLiker`
returned exactly the three liked posts, absent posts silently and correctly
excluded (this is a terminal-`in` shape, immune to the #4511 trap by
construction). One provable query for "did I like [A..T]".

### Structural uniqueness (one like per post per owner): holds

Exact duplicate refused with 40105; the colliding projection reported is
whichever index's probe fires first (`["postAuthor", "postId", "$ownerId"]` on
the final shape). A like of a nonexistent post is refused with a proper
40120: `referenced permanent document (own contract, document type post)
<id> not found for path postId`.

## Working ranked / having / count query shapes (evo-sdk 4.2.0-dev.5)

First ranked queries ever run by this codebase — all verified live:

```js
// Global top-K posts by like count (single-property ranked index byPost).
sdk.documents.ranked({ dataContractId, documentTypeName: 'like',
  groupBy: 'postId', aggregate: { type: 'count' }, limit: 10 })

// Top posts within one hashtag (compound byHashtagPost: pin the prefix,
// group by the trailing property). '' pins work (D1).
sdk.documents.ranked({ dataContractId, documentTypeName: 'like',
  groupBy: 'postId', aggregate: { type: 'count' }, limit: 10,
  where: [['hashtag', '==', 'dash']] })

// An author's top posts (byAuthorPost) — the profile "Top" tab.
sdk.documents.ranked({ dataContractId, documentTypeName: 'like',
  groupBy: 'postId', aggregate: { type: 'count' }, limit: 10,
  where: [['postAuthor', '==', authorIdBase58]] })

// Value-bounded spelling of the same axis (posts with >= N likes).
sdk.documents.having({ dataContractId, documentTypeName: 'like',
  groupBy: 'postId', aggregate: { type: 'count' },
  having: { operator: '>=', value: 1 }, limit: 100 })
```

Results: `entries[].groupValue` is the base58 identifier, `entries[].value` a
bigint, `startingRank`/`rank` bigints. **Ranked pages on a preallocated index
include zero-count groups**: every referenced post is a rankable group from
birth, so global top-K over a young corpus returns unliked posts at count 0
after the liked ones (`values=[1,1,1,1,1,0,0]`). Clients should filter
`value === 0n` when zero-like posts are unwanted.

**Count queries follow an exact-index-match rule.** A proved count requires a
`countable` index whose property list *exactly equals* the where-clause
fields. `count(postId == X)` on `byPost [postId]` works (and preallocation
makes count-0 provable). `count(postAuthor == X)` on `byAuthorPost
[postAuthor, postId]` — a prefix — is refused, as is the grouped
`postAuthor IN […] groupBy ['postAuthor']` spelling:

```
where clause on non indexed property error: prove count requires a
`countable: true` index whose properties exactly match the where clause
fields, or `documentsCountable: true` on the document type for unfiltered
total counts — same requirement as the no-proof path
```

The same rule means **per-hashtag like totals** are not a count query on
`byHashtagPost` either — per-tag surfaces should use ranked/having pages.

## Fee table (maker credit-balance deltas, round-4 clean run)

Devnet conversion used: ~2.564e9 credits/$ (same basis as the $0.026 stored
baseline). Fees are deterministic — identical operations reproduced identical
credit deltas across rounds.

| Operation | Credits | ~USD | vs 67.1M stored-like baseline |
|---|---:|---:|---|
| Contract registration (5 doctypes, 24 indexes) | 33,189,814,370 | $12.94 | one-time |
| post, hashtag `''` (first use of `''`; preallocates 3 like indexes) | 77,105,160 | $0.030 | |
| post, hashtag `'dash'` (first use of `'dash'`) | 69,738,360 | $0.027 | |
| post, repeat hashtag (steady-state tagged post) | 63,709,000–64,111,080 | $0.025 | |
| post, first post under a new hashtag | 70,317,860–77,962,380 | $0.030 | +~6.6M for the byHashtagPost hashtag-level tree |
| **postC control (identical schema, nothing refers to it)** | **11,441,580** | **$0.004** | **preallocation premium ≈ +52.3M/post** |
| like #1 on a post, liker's first-ever like (`''` post) | 67,020,160 | $0.026 | 99.9% (pays the byLiker owner tree once) |
| like, steady state (every subsequent like, any post) | 57,774,540–58,720,520 | $0.023 | **86–88% — uniform: first like = nth like (preallocation works)** |
| unlike (delete by locally-rebuilt values) | **−2,500,675** | −$0.001 | net refund; preallocated trees are retained by design, so only entry bytes refund |
| likeT create (5 indexes, none preallocated — first entry pays all trees) | 108,475,400 | $0.042 | 162% |
| likeT delete (query-recovered tuple; non-preallocated trees pruned) | −101,222,263 | −$0.039 | 93% of create refunded |
| rejected write (40127/40105, in-block PaidConsensusError) | 837,380–905,260 | $0.0003 | |

Reading the table:

- **Preallocation moves ~52M credits/post from likers to the poster** (3
  preallocated ranked indexes). In exchange every like costs the same ~58M
  and "0 likes" is provable/rankable. A steady-state tagged post now costs
  ~64M (post) + its share of nothing else — but note the post itself got ~5.6×
  more expensive than the unreferenced control.
- **The indexOnly like is only ~13% cheaper than the stored-like baseline** at
  this index count. The cost is dominated by per-index count/range/ranked tree
  updates, not by the stored body the design removed. A leaner index set
  (e.g. dropping an axis) is the fee lever, not indexOnly per se.
- **Unlike is nearly refund-neutral, not a cost recovery**: ~2.5M net back on
  a 58M like. The old "delete refunds per entry" intuition only pays out where
  the delete prunes trees (the non-preallocated likeT shows −101M) — exactly
  the trees preallocation deliberately retains.
- Tagged vs untagged post: `''` is just another hashtag value; the fee
  difference is byte-length noise (`''` saves a few bytes per entry but paid
  a first-use tree in this run). No fee reason to avoid the sentinel.

## Schema-grammar and validator findings (meta-schema v3, PV14)

1. **`preallocated` demands the referring property in the index's own
   property list.** An agreement-key-only path does not bind, contrary to a
   plain reading of the book. Verbatim registration refusal on `byAuthor
   [postAuthor]`: *"index 'byAuthor' … declares `preallocated`, but its path
   is not determined by a reference: every index property must be either a
   property with a same-contract permanentDocument `refersTo` declaration …
   or a key of that declaration's `propertyAgreement` … System properties
   like $ownerId cannot be determined by the referenced document, so a
   preallocated index may carry $ownerId only as its terminal"* — rs-dpp's
   `preallocation_bindings` iterates the index's *own* properties looking for
   the referring candidate. `[postAuthor, postId]` binds (and preallocates).
2. **`rankedCountable: true` requires `rangeCountable: true`, which requires
   `countable`** — the plan's "byHashtagPost: rankedCountable only" is not
   expressible; the full chain must be declared per index.
3. `countable` accepts legacy `true` and the enum form
   (`"countable"` / `"countableAllowingOffset"` / `"notCountable"`); `true`
   registers fine on PV14.
4. `minLength: 0` on an indexed string is legal (D1 gate).
5. `required` may name `$createdAt`; indexing `$createdAt` *forces* it into
   `required`.
6. `terminal` must not repeat a listed index property; defaults to
   `$ownerId`; must be `$ownerId` or a single-id refersTo property.
7. **propertyAgreement registers against a *mutable* referenced property.**
   `post` is `documentsMutable: true` and the contract registered — agreement
   is checked at like-write time only. A post edit that changes `hashtag`
   would strand existing likes' denormalized values (and make *new* likes
   need the new value). v4 must keep `hashtag` immutable by convention
   (client-enforced) or accept drift; consensus will not protect it.
8. `$formatVersion: '1'` + plain `DataContract.fromJSON(json, true,
   platformVersion)` publishes indexOnly contracts fine (the
   `new DataContract` tokens/plain-object bug is irrelevant here — no token
   block needed).
9. refersTo + propertyAgreement metadata round-trips through
   `contracts.fetch(...).toJSON()` on PV14 (feature detection works).

## SDK / client-behavior findings (evo-sdk 4.2.0-dev.5 on moutai)

1. **`documents.create()` never yielded the promised confirmed Document for
   indexOnly types in these runs** — the call threw after broadcast (the
   familiar DAPI wait quirk) while the write landed; read-back confirmed every
   time. The d.ts says "keep THIS instance … consensus-populated system
   fields included", but clients must not depend on it: for `like` (no
   `$createdAt`) rebuild the tuple from known values — proven working; for
   `$createdAt` types use the D2a query recovery — proven working. Worth an
   upstream issue.
2. indexOnly documents cannot be fetched by `$id`; acceptance/existence reads
   go through the entry indexes (`postId == X AND $ownerId == me` on byPost).
   Synthesized `$id`s differ per covering index — correlate query results by
   property values, never by id (confirms the plan's cache-key warning).
3. Query results synthesize *projections* of the covering index: the
   byAuthorTime hit carried `postAuthor`, `$createdAt`, `$ownerId` — and
   nothing else. Plan client reads accordingly.
4. Deletes go through the ordinary `documents.delete({ document })` facade
   with a full `Document` instance (the wasm builder picks the
   `indexOnlyDelete` kind from the doctype's storage mode); an id-only delete
   of an indexOnly type is refused client-side with guidance.
5. Rejected-but-broadcast writes are `PaidConsensusError`s and charge ~0.9M
   credits — budget for them in UX flows that probe (though batched
   membership makes probing unnecessary).

## What this feeds into (Phase-1 exit decisions)

- **D1: resolved — `''` sentinel is safe.** Adopt.
- **D2: recommend (a)** with the index spelled `byAuthorTimePost [postAuthor,
  $createdAt, postId] terminal $ownerId` (collision-free, richer projection).
  Tuple persistence is *not* the mechanism — query recovery is (and today it
  is the only mechanism the JS SDK supports).
- **v4 spec change required:** `like.byAuthor [postAuthor]` → `byAuthorPost
  [postAuthor, postId]` (+preallocated). Creator leaderboard and per-author
  like totals drop out of the consensus-served feature set (client-side
  aggregation over pinned ranked pages, or an upstream feature ask:
  prefix-level count/ranked reads).
- **D3/D4 fee inputs:** every additional index on the like doctype costs both
  the likers (per-entry tree updates) and — if preallocated — every poster
  (~17M credits/index/post). The beat/tip decisions should price against the
  measured ~58M steady-state like, not the old baseline.
- **Fee headline for the plan:** indexOnly + preallocation delivers *uniform*
  and *provable-at-zero* likes, but at this index count only a ~13% saving
  per like, funded by a ~5.6× more expensive post. If cheap likes are the
  goal, the index set is the lever (each ranked axis and each extra index has
  a visible per-entry price).

## Reproduction

```bash
# local validation only (no network):
node scripts/experiment-indexonly.mjs --dry-run

# full battery (registers a fresh throwaway contract, ~33B credits, ~8 min):
node scripts/experiment-indexonly.mjs            # maker defaults: seed index 9
node scripts/experiment-indexonly.mjs --contract <id>   # reuse a contract
```

Needs `E2E_SEED_PHRASE` (env or `.env.local`) and warm moutai quorum
endpoints (`curl https://quorums.moutai.networks.dash.org/{quorums,previous,masternodes}`
first after idle).
