# Storefront ranking resilience

Sakura rehearsal evidence on 2026-10-18 records global `storeReview` average
rankings failing with GroveDB `indexed target chain: primary entry … is missing`
after retired stores lost their reviews. Positive-average HAVING failed too.
Ordinary active-store listings and most-ordered queries still worked. Seven
archived-review pins restored the rehearsal rankings; leave those pins alone.

## Isolated reproduction result

**The final-document hypothesis did not reproduce in fresh scratch contracts.**
A minimal mutable `review { groupId: identifier, rating: integer 1..5 }` used
exactly the `storeRating` flags:

```json
{
  "name": "rating",
  "properties": [{ "groupId": "asc" }],
  "summable": "rating",
  "averageable": "rating",
  "rangeCountable": true,
  "rangeSummable": true,
  "rangeAverageable": true,
  "rankedAverageable": true
}
```

Three groups held ratings A=[3,5], B=[4], C=[2]. Each write was read back before
querying. The sequence was: initial ranking, update A's 3 to 4, delete A's first
review, delete A's final review, reinsert A, move B's sole review to C, then move
it back. Both ranked and positive-average HAVING succeeded, omitted drained
groups, and returned the expected remaining values. Per-group averages worked.

Ten scratch contracts covered 68 query stages. The same sequence also passed with a shared `[groupId,$createdAt]` listing
index, a shared `[groupId,rating]` countable distribution, and all four
`storeReview` index shapes together (including the unique order index).
Appointed-moderator deletion passed both with the single average index and with
all four indexes; the latter used random group identifiers. An immutable
single-index variant also survived final deletion (updates were refused, as
expected). The ranked-count and ranked-sum controls survived both deletion and group movement.
Without `rankedAverageable`, ranked/HAVING were correctly refused for missing
index support; ordinary per-group averages survived deletion.

Thus neither final deletion, the average/range/ranking flags alone, shared index
prefixes, immutability, nor moderation alone isolated the recorded failure.
Updates did not produce it either. This does **not** clear the original
contract or establish that all deletion histories are safe. The missing
prerequisite remains unknown; no new failing standalone reproducer was found.
All broadcasts were to throwaway Sakura contracts from reserved corpus
identities, never the maker. No testnet/mainnet writes were made.

Private evidence and a ready-to-file upstream issue (not filed) are under
`~/.local/share/yappr-release-audit-20261016/`: `aggregate-index-evidence.json`,
`devnet-cutover/aggregate-index-repro.mjs`, and
`upstream-issue-aggregate-index.md`. The issue distinguishes the recorded
rehearsal failure from the negative isolated experiments.

## Platform beta.6 versus rc.4

No relevant fix was identified in rc.4. This is a **source comparison**, not a
live rc.4 reproduction or proof that the unknown trigger survives the upgrade.
Do not treat rc.4 as release clearance for this issue.

- Platform [beta.6, 28fcb529](https://github.com/dashpay/platform/commit/28fcb529bbfb4670aa33cc838e7dabcc7589f7f3)
  and [rc.4, 5b41ca37](https://github.com/dashpay/platform/commit/5b41ca376b310a1792ddd9f3106e1224f9c275b6)
  have identical `packages/rs-drive/src/drive/document` trees (Git tree
  `370dff5d4a76ec0d66c2b97de8b0ca904e2910b7`), including index insertion,
  replacement, deletion, and ranked-tree selection. The moderator-to-document
  deletion conversion is unchanged too.
- [Platform 9ddd4322](https://github.com/dashpay/platform/commit/9ddd4322ec38c02284e4a1759e32c0c8ecebd49c)
  bumps GroveDB from `5cb0962afdd3df8d58cd9f40cc723ce1f475aeb5` to
  `fc7028d83114d86f88222e7ff09fc47ae75360f0`. The indexed-tree operations,
  delete operations, and indexed-axis proof paths are identical at those refs.
- The substantive GroveDB batch change is
  [7ea60eee](https://github.com/dashpay/grovedb/commit/7ea60eeef1406eeaf908fb182d8796e3084b0d7f),
  which fixes same-batch sum-item reference hashes and replacement flags. It
  does not add ranked-secondary cleanup or repair an already missing primary.
  GroveDB's `operations/proof/indexed_axis/target_chain.rs` is where the
  secondary's target is resolved and the recorded missing-primary error is
  emitted.

## Client behavior and exposure

- **Store directory:** Top rated and Most ordered fall back to the ordinary
  newest active stores when ranking fails. A quiet status line explains the
  order. A successful empty ranking remains empty. A failed fallback shows
  neutral unavailable copy, rather than claiming there are no stores.
- **Store categories and item rankings:** failed reads remain empty and never
  poison the ranking cache. Categories/suggestions disappear; items remain
  listed without a ranked rating. `itemReview.storeItemRating` has the same
  average flags, scoped to a store, so deleting its last item review is a
  potential exposure even though the isolated probes did not reproduce it.
  Per-store and per-item point averages are separate reads; the directory's
  optional rating summaries already fail independently per store.
- **Store orders and categories:** ranked counts, not averages. Orders are
  permanent, while status/category updates can drain a category. The directory
  fallback protects both tabs; category suggestions remain optional.
- **Social v17:** likes, hashtag/creator counters, follows, live-author post
  counts, and reply rankings use ranked counts (some backed by
  `summableOffCountIndex`), not average indexes. Unlike/unfollow, tombstoning,
  and rolling-window expiry can drain groups. There is structural deletion
  exposure to ranked storage, but no reproduced failure of these shapes.
  Existing fail-soft reads and strict feed error/retry handling remain;
  regression tests inject the exact missing-primary signature and prove retry.
- **Blog v9:** followers, trending follows, and discussed posts use ranked
  counts. Unfollow/moderation can drain groups; no average index exists.
  Discovery now requests strict ranking errors so its existing list error
  state shows neutral unavailable copy instead of false empty claims. Failures
  are not cached; other service callers keep fail-soft behavior.
- **Pollr:** no averageable/ranked index and no ranked/HAVING read. Ballot
  counters are not the global ranked-average shape; no change is needed.
- **HAVING:** there is no application HAVING read in the current source. The
  rehearsal HAVING probe is not a safe fallback: it uses the same ranked axis.

Unit tests cover directory fallback/recovery, successful empty rankings,
ranking order and closed/missing-store filtering, fallback failure, and exact
missing-primary failures/recovery across storefront, blog, and social reads.

## Owner decision before release

**Proposal, not an implemented policy:** keep review deletion available and
ship the client fallback, accepting temporarily unavailable rankings while the
upstream trigger is investigated. Retaining abusive reviews solely to keep an
index alive is a poor moderation policy. A client-only "never delete the last
review" guard cannot constrain direct SDK users and is not a consensus fix.

The owner must decide whether this residual uncertainty gates release or is
accepted with degraded rankings. A last-review moderator warning or a contract
restriction would be a separate owner-approved policy change, covering item
reviews as well as store reviews. This PR changes neither deletion rights nor
the archived rehearsal pins and does not file the upstream issue.
