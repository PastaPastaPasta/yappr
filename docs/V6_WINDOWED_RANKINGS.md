# Contract v6 — windowed rankings (what yappr needs next)

`contracts/yappr-social-contract-v6.json` is v5 (live on moutai, `verify-v5.mjs`
91/91) plus server-ordered **time-bounded** rankings, written in the grammar
that landed upstream on 2026-09-01. Regenerate with
`python3 scripts/build-v6-contract.py`; `--self-test` asserts the committed
JSON.

## Status (2026-09-03) — LIVE on moutai

| Layer | State |
|---|---|
| Platform | **4.2.0-dev.8** (cut by us 2026-09-02: dashpay/platform#4591 → tag `v4.2.0-dev.8`), carrying #4578 (ranked below timeRange) + #4574 (`byStart`). moutai: 13/13 masternodes on dev.8, no wipe |
| Contract | **Registered**: `DNNibJtgEEkQkLfDZXh9xkbfdVHWu6CtJcgcpicMAuHZ` (this file's shape, verbatim). YAPP token `AwyQ6rGrrZviBoYfqykyQ8Nhau5xjsxFQsQCj8vrV9pW` |
| Client | `.env.devnet` → v6; `windowedRankingsAvailable()`; like of a tagged post writes its `beat` in the **same batch transition** (`createDocumentPair`); Today \| All time switch on Explore Top / trending / Creators, tag page Top, profile Top |
| Battery | `scripts/verify-v5.mjs` gains d1–d3 (windowed like axes, beat + propertyAgreement + grid disambiguation, cold bucket) |
| Seeder | `--topology v6`: a beat companion beside every tagged like |
| Known dev.8 edge | a proved ranked read on a **never-populated** bucket fails proof generation instead of proving empty → **dashpay/platform#4592**. Client maps that error to an empty ranking until fixed |
| TTL / cheaper bytes | dashpay/platform#4581 still open — not assumed |

## Two validation rules the dev.7 blanket rejection had been hiding

Probing the original fixture against HEAD surfaced two rules that only
become reachable once ranked-under-timeRange is admitted:

1. **`preallocated` is illegal on a bucketed index** — bucket paths derive
   from the like's own `$createdAt` at write time, so they cannot be created
   ahead of time from the referenced post. The windowed twins drop the flag
   (their all-time twins keep it).
2. **An optional property may only be the FIRST property of a `skipIfAbsent`
   index.** `like.hashtag` is optional since v5 (that is what killed the `''`
   sentinel), and under a timeRange the first position is the timestamp, so
   a windowed hashtag index on `like` is rejected: *"absence would strand the
   prefix levels above it"*. Both escape hatches were probed and are also
   rejected — `skipIfAbsent` with `$createdAt` first (*"system properties are
   always present"*), and making `hashtag` required again (then v5's own
   `byHashtagPost` *"could never skip"*).

So the windowed hashtag rankings cannot live on `like`. They live on a new
tagged-only doctype instead — **`beat`**: indexOnly, `hashtag` **required**,
`postId` refersTo `post` with `propertyAgreement {hashtag: hashtag}` (so
consensus enforces `beat.hashtag == post.hashtag`, exactly as it does for
`like.hashtag`). The client writes one `beat` beside each like of a tagged
post, in the same batch transition; untagged likes write no beat — the
`skipIfAbsent` economy by other means. This is the shape upstream's own
`yappr-likes` fixture uses for its windowed hashtag index (its `beat`
doctype), which is reassuring.

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
| `beat.byDayHashtagPost` | day, k=1 | **Trending hashtags today** — pin newest bucket, rank at `hashtag`, top 20 | `byHashtagPost` → trending widget |
| `beat.byDayHashtagPost` | day, k=1 | **Top posts for #tag today** — pin newest bucket **and** `hashtag`, rank at `postId` | `byHashtagPost` → tag page "Top" toggle |
| `byDayAuthorPost` | day, k=1 | **Top creators today** — pin newest bucket, rank at `postAuthor` | `byAuthorPost` → Explore "Creators" |
| `byDayAuthorPost` | day, k=1 | **Top posts by one author today** — pin bucket + `postAuthor`, rank at `postId` | `byAuthorPost` → profile "Top" tab |
| `byDayAuthorPost` | day, k=1 | **Most-liked recent posts by people I follow** — pin bucket + `postAuthor` **In** (my follows), rank at `postId` | *no equivalent — see below* |
| `beat.byRollingHashtagPost` | 24h/6h, k=4 | Same as `byDayHashtagPost`, on an **overlapping** grid | — (test material only) |

`likeReply` would take the same treatment symmetrically; it is left out of the
fixture to keep the diff readable.

## The two objections in the old rejection message — resolved upstream

#4578 replaced the blanket ban with the one real rule: ranked levels sit
strictly **below** the bucketed level. Its rationale is the argument this
document originally made: a bucket start is just another prefix value, a
document appears exactly once inside any single bucket's subtree, so
per-window rankings are exact regardless of grid overlap. Still rejected, on
purpose: ranking the windows *themselves* ("busiest days") — a single-property
bucketed ranked index, or an `at` chain naming the timestamp.

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

## Cost

Measured, not modelled: a least-squares fit of per-op credit cost over the
2026-09-01 devnet re-seed (426 ops across 10 identities on the live v5
contract, per-identity balance deltas from `.seed-report.local.json`,
residual 0.1%):

| Op (v5, live) | Credits | DASH |
|---|---|---|
| post / quote | ~188 M | 0.0019 |
| reply | ~175 M | 0.0018 |
| **like** | **~59 M** | **0.0006** |
| likeReply | ~54 M | 0.0005 |
| repost | ~66 M | 0.0007 |
| follow | ~46 M | 0.0005 |

(A like was ~228 M on v4; #4528's re-key-as-replaced-bytes and the indexOnly
shape cut it ~4×. Old plan-doc figures are stale.)

A like on v5 pays for five index entries, three of them ranked chains
(`byPost` terminal, `byHashtagPost` and `byAuthorPost` multi-at). v6 adds:

| Write | Adds | Estimated like cost | vs v5 |
|---|---|---|---|
| untagged like | `byDayPost` (2 levels, ranked terminal) + `byDayAuthorPost` (3 levels, ranked at 2) — the structural twins of `byPost` + `byAuthorPost` plus one bucket level each | **~85–95 M** | +45–60% |
| tagged like | the above **plus a `beat` entry**: its own indexOnly row + `byDayHashtagPost` (3 levels, ranked at 2) + plain `byPost` | **~125–140 M** | +110–140% |

Estimate basis: each new windowed twin costs about what its all-time twin
does plus one bucket level (~12–15 M per ranked twin at 27,000 cr/byte
storage + 400 cr/byte processing, ~500 B per entry chain). `range == step`
everywhere, so one bucket per write; the k=4 `byRollingHashtagPost` on `beat`
would multiply that index by 4 and is **not** in the shipping shape (it stays
in the fixture as overlap test material for platform).

At the YAPP layer nothing changes (1 YAPP/like); the credit cost is what the
identity pays. Even the tagged case stays under the cost of a reply today.

**If #4581 (TTL + ephemeral-bytes pricing) lands**, every byte under the
windowed indexes bills to processing at 270 cr/byte instead of 27,000 —
roughly a 100× cut on the *added* cost, pulling v6 likes back to within
~5% of v5. The devnet would then also stop accumulating dead daily windows.
Not required for v6; it makes v6 nearly free.
