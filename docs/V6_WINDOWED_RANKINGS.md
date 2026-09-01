# Contract v6 — windowed rankings (what yappr needs next)

`contracts/yappr-social-contract-v6.json` is a **design fixture, not a
deployable contract**. It is v5 (live on moutai, `verify-v5.mjs` 91/91) plus
four time-bucketed indexes on `like`, written in the grammar we expect
time-bucketed rankings to use. Regenerate with
`python3 scripts/build-v6-contract.py`; `--self-test` asserts the committed
JSON (28 checks).

On protocol v14 it is rejected at contract validation:

```
invalid contract structure: a timeRange index cannot be ranked
(rankedCountable / rankedSummable / rankedAverageable): ranked queries have no
time-bucket semantics, so the ranked secondaries would be maintained but never
servable
```

That is the only rule it breaks — every other index, property and limit
(≤10 indexes per doctype, overlap factor ≤24, `$createdAt` in `required`,
`timeRange.on` leading the property list, ranked axes over a `terminal`
index with `countable` + `rangeCountable`) already validates today.

## Why yappr cannot use the documented workaround

The `timeRange` module doc prescribes, for windowed trending, a grouped count
in the newest bucket with the client ordering the returned groups. yappr
cannot ship that: the response carries **one entry per distinct group in the
window** — every hashtag used today, every author who was liked today — and the
client sorts it to show 20 rows. That is fine in a test and degrades badly in
production, so windowed trending is currently not built at all rather than
built on client-side sorting.

What we need is the same thing the all-time surfaces already get: the server
returns the top K, ordered, proved.

## The four indexes and the queries they must serve

Each windowed index is a twin of an all-time v5 index that is live and in use
today — same properties, same `terminal`, same at-levels, with a bucketed
`$createdAt` prepended. The all-time twin stays in the contract; the windowed
one answers the same question inside a time bound.

| Index | Grid | Query it must serve | All-time twin (works today) |
|---|---|---|---|
| `byDayPost` | day, k=1 | Most-liked posts **today** — pin newest bucket, rank at terminal `postId`, top 20 | `byPost` → Explore "Top" tab |
| `byDayHashtagPost` | day, k=1 | **Trending hashtags today** — pin newest bucket, rank at `hashtag`, top 20 | `byHashtagPost` → trending widget |
| `byDayHashtagPost` | day, k=1 | **Top posts for #tag today** — pin newest bucket **and** `hashtag`, rank at `postId` | `byHashtagPost` → tag page "Top" toggle |
| `byDayAuthorPost` | day, k=1 | **Top creators today** — pin newest bucket, rank at `postAuthor` | `byAuthorPost` → Explore "Creators" |
| `byDayAuthorPost` | day, k=1 | **Top posts by one author today** — pin bucket + `postAuthor`, rank at `postId` | `byAuthorPost` → profile "Top" tab |
| `byDayAuthorPost` | day, k=1 | **Most-liked recent posts by people I follow** — pin bucket + `postAuthor` **In** (my follows), rank at `postId` | *no equivalent — see below* |
| `byRollingHashtagPost` | 24h/6h, k=4 | Same as `byDayHashtagPost`, on an **overlapping** grid | — (test material only) |

`likeReply` would take the same treatment symmetrically; it is left out of the
fixture to keep the diff readable.

## On the two objections in the rejection message

Both concerns recorded in the validation comment are about rankings *keyed by*
bucket. Every query above **pins** the bucket instead:

1. *"the ranked secondaries would be maintained but never servable"* — true
   while ranked queries accept no where clauses. All seven queries need the
   bucket selected the way `IN_TIME_RANGE(..., "newest")` already selects it
   for grouped counts, i.e. resolved from committed block time server-side and
   re-derived by the verifier. The ranking is then read at a level *below* the
   pinned bucket, which is the shape prefix at-level rankings already serve.
2. *"ranking groups keyed by bucket starts would score each document
   `overlap_factor` times"* — that double count only arises if a ranking spans
   buckets. Within one pinned bucket a document appears exactly once, whatever
   the overlap factor, because overlap replicates a document *across* buckets
   and never *within* one. `byRollingHashtagPost` is in the fixture so this can
   be tested rather than argued: its per-bucket rankings should be identical to
   what a k=1 grid over the same window produces.

If pinned-bucket ranked reads are the tractable subset, `range == step`
(non-overlapping) alone would already unblock everything yappr ships — the
three `byDay*` indexes. The overlapping index is separable.

## The pin-set case (`postAuthor In [...]`)

"Most liked recent posts by people I follow" is the one row above with no
all-time equivalent, because it needs something ranked queries cannot do even
without a time bound: **pins drawn from a set**. The per-author rankings are
already materialized on chain — the server would k-way-merge F already-sorted
lists and return the top K. That is the same merged-proof machinery
`prove_query_many` grew for chained document queries (#4547), so the storage
and proof substrate exists; what is missing is ranked routing that accepts an
`In` pin.

Worth designing the predicate surface once — single pin, `In` pin set, and
time bucket — rather than special-casing the windowed form, since yappr needs
all three and they compose (the query above uses two of them at once).

## Secondary ask: `skipIfAbsent` under a timeRange

`skipIfAbsent` requires its trigger to be the **first** index property, which
the timeRange source now occupies, so the windowed hashtag indexes lose it —
untagged likes (the majority) write a null entry they do not write in the
all-time `byHashtagPost`. Relaxing the rule to "first property after the
timeRange source" would restore parity. Not a blocker; a cost item.

## Cost note

All three shipping indexes use `range == step` (overlap factor 1), where a
document lands in exactly one bucket and the index is priced like an ordinary
one. Rolling-window UX, if wanted, is better assembled client-side from
consecutive daily buckets than bought with a k>1 grid, which multiplies that
index's write cost by k.
