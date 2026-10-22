# Social v18, blog v10 and storefront v11: hide, don't delete

Social v18, blog v10 and storefront v11 re-cut the three moderated contracts of the testnet release set ([SOCIAL_V17.md](SOCIAL_V17.md), [BLOG_V9.md](BLOG_V9.md), [STOREFRONT_V10.md](STOREFRONT_V10.md)) for the owner's moderation redesign of 2026-10-21/22. **Moderators can never delete.** They hide content by setting a moderator-only field, and they restrict accounts instead of banning them. Nothing anyone writes ever leaves state because of a moderator. Everything in these files is frozen once registered: indexes, required properties, references, rules and the moderation declaration.

The decisions are the owner's (`DECISIONS-FINAL.md` in the release audit's `moderation-redesign/`, which overrides the option papers beside it). [TESTNET_RELEASE.md](TESTNET_RELEASE.md) records them as D42–D44.

**Status.** Not registered on testnet. Throwaway copies of the exact files were registered on sakura and run through the battery below ([Sakura proof](#sakura-proof)). The registration tooling appends the three as new members of the existing App Connect group `4MjVAxDY…` under app `D8benQGn…` ([Registering it](#registering-it-on-testnet)). The client still reads v17 until its own branch moves to the flags below.

| # | Decision | What changes |
| --- | --- | --- |
| 1 | **No moderator delete** (D43) | No type in social, blog or storefront declares `moderatorAbilities.delete`, and the elected set grants no `deleteDocuments`. `moderatorDeleteDocument` is refused (41115, measured). There are no removal records and no restore. |
| 2 | **Hide with `mod`** (D43) | Each moderated content type gets `mod` (1 hidden, 2 legal hold) and `modLabel` (1–63, the charter reason or a label class). Both are listed under `moderatorAbilities.changeFields`, so only the team writes them: a create or replace by anyone else that sets, changes or drops one is refused (41124). The `modReason` rule (`anyOf [absent mod, present modLabel]`) requires a reason on every hide; the schema bounds the values. `modLabel` alone labels a listed document. A hide or unhide has no window and no approvals: any one seated member, reversibly, stamped `$moderatedBy`/`$moderatedAt`. |
| 3 | **Every listing carries the `mod` lane** (D43) | Listings are keyed `[live, mod, …]`, or `[…, mod, …]` where there is no `live`. `mod` sits before the ranked-at property, so counts and ranks hold only listed documents. yap.pr reads `live == 1, mod == null`. `skipIfAbsent` names `live` only (`true` would also skip `mod` and drop every unmoderated document). See [Reading the lanes](#reading-the-lanes). |
| 4 | **A moderation log on every moderated type** | `moderated [mod, $moderatedAt]` with `skipIfAbsent: ["mod"]`, so an author's write pays nothing for it. Restrictions keep `log [state, $moderatedAt]`; reports keep `byModerator`. |
| 5 | **Permanent references** | With no moderator delete, post, reply, blog post, store and item are permanent types, so every reference into them is `permanentDocument` (Platform admits one kind per target): like, reply like, bookmark, quotes, a reply's root and parent, reports, a blog comment's post, and every storefront reference at a store or an item. `deleteKeepsFields` is gone. |
| 6 | **Restrict, never ban** (D44) | No banlist and no suspension list; the warning list stays. A moderator-only `restriction` document (social and blog) marks an author restricted (`state` 1) or lifted (2). `live` becomes the integer lane 1 (listed) or 2 (posted while restricted), and `restrictedLane` forces it on create. See [Restriction](#restriction). |
| 7 | **No `retractedWhen`** | It names the replace a barred owner may still make; with no banlist and no suspension list nobody is ever barred, and Platform refuses the keyword (10231). A tombstone is an ordinary replace. |
| 8 | **Likes copy the post's lane** | `like.postLive` (1 or 2, required) is bound to the post's `live` by the reference `where`, and sits second in both trend windows: `byTrendPost [$createdAt, postLive, postId]`, `byTrendHashtagPost [$createdAt, postLive, tags, postId]`. `byTrendPost` drops `outlivesDelete`, so an unlike leaves the 72 h window. A like of a tombstone (no `live`) is refused (40127). |
| 9 | **Elected, closed until seated** | Interim `notYetUsable`: post, reply, profile, report and restriction (and the blog's and storefront's moderated types) are refused until a team is seated (41200 on a post, measured). The D41 action fees stay. `challengeCoolDown` is 1,209,600 s in the files. The election windows and delay are registration flags (`--election-windows`, `--election-delay`), still the owner's choice: 24 h/24 h/24 h as v17, or 1 h/1 h/1 h. |
| 10 | **Unchanged** | Sponsorship (D4), follows, follow requests, private feeds, YAPP (D3), self-like refusal (D6), the quote rules, byte caps, URL patterns, tags (D7), the notification windows, reports' rules and their 90-day ttl. Blocks, DM v5, pollr v8 and the passkey vault are not re-cut. |

## The files

| | Social v18 | Blog v10 | Storefront v11 |
| --- | --- | --- | --- |
| File | `contracts/yappr-social-contract-v18.json` | `contracts/yappr-blog-contract-v10.json` | `contracts/yappr-storefront-contract-v11.json` |
| sha256 | `94e477a6de447069dc263198441be408092febc9560c76ab98efb3266ae23921` | `8a169b979ff6e138035ff7aabc0e226b626d59ae64d5edfffddc44cc617d4159` | `eb35635f507d09a52c0ae6fffc23185eebaeb15cd2d8c6f67b4c05ea717b9a0e` |
| Signed create (`validate-contract-offline --strict-size`, testnet rendering) | **19,836 B** (v17: 18,054 B) | **10,773 B** (v9: 9,247 B) | **19,978 B** (v10: 18,704 B) |
| Document types | 13: `restriction` is new | 6: `restriction` is new | 11 |
| Registration fee, sakura measured | 99.80e9 (5,988¢) | 46.44e9 (2,786¢) | 64.74e9 (3,884¢) |
| Registration estimate, testnet | 101.09e9 (≈6,065¢) | 47.18e9 (≈2,831¢) | 66.10e9 (≈3,966¢) |

All three are under the 20,000 B budget and the 20,480 B cap. Storefront is the tightest, 22 B under the budget. The blog v9 and storefront v10 files stay as they are: they are the registered, abandoned members' sources, and their pins must keep matching.

## Reading the lanes

Drive serves a `skipIfAbsent` index only to a read that pins its skip property, and `mod` sits before the property a listing ranges over. So every listing read pins `live == 1` (social, blog posts) and `mod == null` first; a v17-shaped read without `mod` is refused (the conformance spec pins that). A null pin on `mod` reaches the empty key an absent value is indexed under. It works for documents, counts, grouped counts and both rankings, and next to the `replyToReplyId == null` pin (two null pins in one count), all proved on sakura.

| yap.pr read | `where` | `orderBy` |
| --- | --- | --- |
| Recent, For You, search, the new-posts poll | `live == 1`, `mod == null`, `$createdAt > t` | `$createdAt desc` |
| A tag page | `live == 1`, `mod == null`, `tags contains tag`, `$createdAt > 0` | `$createdAt desc` |
| An author's posts / replies, post counts, top authors (ranked at `$ownerId`) | `live == 1`, `mod == null`, `$ownerId ==` | `$createdAt desc` |
| A thread, a reply's children, direct replies, reply counts, grouped counts, most replied (ranked at `rootPostId`) | `live == 1`, `mod == null`, `rootPostId ==` (or `in`), then `replyToReplyId` as on v17 | as on v17 |
| Mentions | `mentionedUserIds contains me`, `mod == null`, `$createdAt > t` | `$createdAt desc` |
| Trending posts, trending tags, top in a tag | `postLive == 1` in the window | ranked as on v17 |
| My standing before a compose | `restriction`: `target == me` | — |

A hidden post's likes still count in `byPost`, `byHashtagPost` and `byAuthorPost` (accepted), and a ranked list can return a hidden post id: the client already hydrates ranked ids, and it skips any with `mod` set (DECISIONS-FINAL, Trending). Quote lists (`quotesOfPost`/`quotesOfReply`), the reply notification windows, follows and bookmarks are not laned: one read returns every lane, and the client drops hidden items when it hydrates them.

### Archive and moderation-log queries

The owner's archival / "uncensored" frontend support (env flags, off on every yap.pr build) reads every lane of each listing with the same order and its own `startAfter` cursor, and k-way merges the pages. A count is the sum of its lanes. The moderation log reads the `moderated` index of each type (newest action first), the restriction log, and the warning list. These are the exact reads, from `scripts/hide-moderation-queries.mjs`: `lib/contract-query-conformance.test.ts` judges every one of them, in every lane, against the committed files, and `scripts/prove-v18-moderation.mjs catalogue` ran every one on sakura, proved (179/179). `L` is a `live` lane, `M` a `mod` lane, `S` a restriction state.

**social, listings (yap.pr reads L = 1, M = null; an archive reads every lane)**

| Index and read | Kind | `where` | Order / group | Lanes |
| --- | --- | --- | --- | --- |
| post.timeline (Recent) | documents | `live == L`, `mod == M`, `$createdAt > 0` | $createdAt desc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| post.timeline count (live posts) | count | `live == L`, `mod == M` | — | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| post.tagAndTime (a tag page) | documents | `live == L`, `mod == M`, `tags contains 't'`, `$createdAt > 0` | $createdAt desc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| post.ownerAndTime (an author's posts) | documents | `live == L`, `mod == M`, `$ownerId == A`, `$createdAt > 0` | $createdAt desc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| post.ownerAndTime count (an author's post count) | count | `live == L`, `mod == M`, `$ownerId == A` | — | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| post.ownerAndTime ranked at $ownerId (top authors by post count) | ranked | `live == L`, `mod == M` | group $ownerId | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| post.mentionedUserAndTime (mentions of me) | documents | `mentionedUserIds contains ME`, `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| reply.ownerAndTime (an author's replies) | documents | `live == L`, `mod == M`, `$ownerId == A`, `$createdAt > 0` | $createdAt desc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.repliesOf (a thread page) | documents | `live == L`, `mod == M`, `rootPostId == P` | replyToReplyId asc, $createdAt asc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.repliesOf (direct replies, replyToReplyId == null) | documents | `live == L`, `mod == M`, `rootPostId == P`, `replyToReplyId == null` | $createdAt asc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.repliesOf (a reply's children) | documents | `live == L`, `mod == M`, `rootPostId == P`, `replyToReplyId == R` | $createdAt asc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.repliesOf count (a thread's replies) | count | `live == L`, `mod == M`, `rootPostId == P` | — | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.repliesOf count (direct replies, two null pins) | count | `live == L`, `mod == M`, `rootPostId == P`, `replyToReplyId == null` | — | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.repliesOf grouped count (several threads) | count | `live == L`, `mod == M`, `rootPostId in [P, R]` | group rootPostId | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.repliesOf ranked at rootPostId (most replied) | ranked | `live == L`, `mod == M` | group rootPostId | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| reply.mentionedUserAndTime (reply mentions of me) | documents | `mentionedUserIds contains ME`, `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| like.byTrendPost (trending posts, 72h) | ranked | `postLive == L` | group postId, window | L ∈ {1, 2} |
| like.byTrendHashtagPost (trending tags, 24h) | ranked | `postLive == L` | group tags, window | L ∈ {1, 2} |
| like.byTrendHashtagPost (top in a tag, 24h) | ranked | `postLive == L`, `tags contains 't'` | group postId, window | L ∈ {1, 2} |

**social, moderation log**

| Index and read | Kind | `where` | Order / group | Lanes |
| --- | --- | --- | --- | --- |
| post.moderated (hidden posts, newest action first) | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| reply.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| yapprProfile.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| restriction.log (restrictions in force / lifted, newest action first) | documents | `state == S`, `$moderatedAt > 0` | $moderatedAt desc | S ∈ {1, 2} |
| report.byModerator (reports one moderator resolved) | documents | `$moderatedBy == ME`, `$moderatedAt > 0` | $moderatedAt desc | — |

**social, other**

| Index and read | Kind | `where` | Order / group | Lanes |
| --- | --- | --- | --- | --- |
| restriction.byTarget (my standing, before a compose) | documents | `target == T` | — | — |

**blog, listings (yap.pr reads L = 1, M = null; an archive reads every lane)**

| Index and read | Kind | `where` | Order / group | Lanes |
| --- | --- | --- | --- | --- |
| blog.timeline (newest blogs) | documents | `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| blogPost.timeline (latest posts) | documents | `live == L`, `mod == M`, `$createdAt > 0` | $createdAt desc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| blogPost.blogAndTime (a blog's posts) | documents | `live == L`, `mod == M`, `blogId == B`, `$createdAt > 0` | $createdAt desc | L ∈ {1, 2} × M ∈ {null, 1, 2} |
| blogComment.postAndTime (a post's comments) | documents | `blogPostId == BP`, `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| blogComment.postAndTime count (a post's comment count) | count | `blogPostId == BP`, `mod == M` | — | M ∈ {null, 1, 2} |

**blog, moderation log**

| Index and read | Kind | `where` | Order / group | Lanes |
| --- | --- | --- | --- | --- |
| blog.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| blogPost.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| blogComment.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| restriction.log (blog) | documents | `state == S`, `$moderatedAt > 0` | $moderatedAt desc | S ∈ {1, 2} |

**storefront, listings (yap.pr reads L = 1, M = null; an archive reads every lane)**

| Index and read | Kind | `where` | Order / group | Lanes |
| --- | --- | --- | --- | --- |
| store.byStatus (newest active stores) | documents | `status == 'active'`, `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| store.byCategory (a category's stores) | documents | `status == 'active'`, `mod == M`, `category == 'other'`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| store.byCategory ranked at category (top categories) | ranked | `status == 'active'`, `mod == M` | group category | M ∈ {null, 1, 2} |
| storeItem.storeAndTime (a store's items) | documents | `storeId == S`, `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| storeItem.storeStatusAndTime (a store's active items) | documents | `storeId == S`, `mod == M`, `status == 'active'`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| storeReview.storeReviews (a store's reviews) | documents | `storeId == S`, `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| storeReview.storeRating (a store's average rating) | average | `mod == M`, `storeId == S` | avg rating | M ∈ {null, 1, 2} |
| storeReview.storeRating ranked (top rated stores) | ranked | `mod == M` | group storeId | M ∈ {null, 1, 2} |
| storeReview.storeRatingDistribution (stars histogram) | count | `storeId == S`, `mod == M`, `rating in [1, 2, 3, 4, 5]` | group rating | M ∈ {null, 1, 2} |
| itemReview.itemReviews (an item's reviews) | documents | `itemId == I`, `mod == M`, `$createdAt > 0` | $createdAt desc | M ∈ {null, 1, 2} |
| itemReview.storeItemRating (an item's average rating) | average | `mod == M`, `storeId == S`, `itemId == I` | avg rating | M ∈ {null, 1, 2} |
| itemReview.storeItemRating ranked (top items in a store) | ranked | `mod == M`, `storeId == S` | group itemId | M ∈ {null, 1, 2} |

**storefront, moderation log**

| Index and read | Kind | `where` | Order / group | Lanes |
| --- | --- | --- | --- | --- |
| store.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| storeItem.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| storeReview.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |
| itemReview.moderated | documents | `mod == M`, `$moderatedAt > 0` | $moderatedAt desc | M ∈ {1, 2} |

**Warnings** are not a document query. Read them with `sdk.contracts.moderationEntriesWithProof({ contractId, list: 'warnings', startAfter?, limit })`: one page of the warning list in identity-id order, each entry carrying every warning (`warnedAt`, `reason`) oldest first; `nextStartAfter` pages on. The log merges them by `warnedAt`. A warning entry stores no moderator id (only the transition that wrote it names its signer), so the log shows "warned by the team". One identity's status is `moderationStatusWithProof({ contractId, identityId, lists: ['warnings'] })`.

Per-lane reads are admissible on every listing (`mod == 1` and `mod == 2` are plain equalities). An `in` over the lanes (`mod in [1, 2]`, ordered `mod asc, $createdAt desc`) is admissible only where `mod` is last or before-last: `post.timeline`, both `mentionedUserAndTime` and `blog.timeline`. Elsewhere read one lane at a time.

## Restriction

A restricted author can still post and reply: the chain files what they write in lane 2, which yap.pr does not list. Social v18 and blog v10 each carry the type:

```json
"restriction": {
  "documentsMutable": false, "canBeDeleted": false,
  "properties": { "target": identifier → identity, "state": 1 | 2, "reason": 1–63 },
  "required": ["$createdAt", "target"],
  "moderatorAbilities": { "changeFields": ["state", "reason"] },
  "propertyConstraints": { "moderatorsOnly": { "allOf": [{ "present": "state" }, { "present": "reason" }] } },
  "indices": [ "byTarget [target] unique", "standing [target, state] countable", "log [state, $moderatedAt]" ]
}
```

- **Only the seated team creates one.** `state` is a moderator field, so a non-moderator's create carrying it is refused (41124), and `moderatorsOnly` refuses one without it (10422). A moderator's create is stamped `$moderatedBy`/`$moderatedAt`, so the log lists it from the start. `byTarget` is unique: a re-restriction flips the same document.
- **The lane rule** on `post`, `reply` and `blogPost`:

  ```json
  "restrictedLane": { "ifThen": [
    { "equal": ["$revision", 1] },
    { "equal": ["live", { "add": [1, { "min": [{ "countOf": ["restriction", { "target": "$ownerId", "state": 1 }] }, 1] }] }] }
  ] }
  ```

  On a create, `live` is 2 while the author has a restriction in force and 1 otherwise; the other lane is refused (10422). The `$revision == 1` guard matters: a rule that reads a total is judged again on every replace and every moderator change, so without it a moderator could not hide a post its author wrote before being restricted, and the author could not tombstone it. Both were proved accepted.
- **A lift** is one `state` flip to 2 by any member. Posts written while restricted stay in lane 2 (`live` is frozen while not deleted), so there is no re-listing. Setting `state` to null is refused.
- **Cost to authors.** Nothing measurable: the `countOf` is a point read in a count tree (v18 post and reply fees match v17 within ±1%; see [Fees](#fees)).

## Blog v10

Blog v9 with the same model:

- `blog`, `blogPost` and `blogComment` get `mod`/`modLabel`/`modReason` and the `moderated` log; `report` keeps `changeFields` on `status` and `resolution` only.
- `blog.timeline` is `[mod, $createdAt]`. `blogPost.timeline` is `[live, mod, $createdAt]` and `blogAndTime` is `[live, mod, blogId, $createdAt]`, both `skipIfAbsent: ["live"]`. `blogComment.postAndTime` is `[blogPostId, mod, $createdAt]`, still `rangeCountable` (grouped comment counts over several posts are served).
- `blogPost.ownerAndTime [$ownerId, live, $createdAt]` is unchanged: it is the author's **My posts** pane and shows them every lane. `discussedRecent`, `postOwnerAndTime` and the comment `ownerAndTime` are unchanged (the client drops hidden comments when it hydrates them).
- `blogPost.live` is the 1/2 lane with `restrictedLane` over the blog's own `restriction` type, and `retractedWhen` is gone.
- `blogComment.blogPostId` and `report.blogPostId` are `permanentDocument`. A blog stays author-deletable, so references to it stay `deletableDocument`.
- Comments carry no `live`, so a restricted author's comments are not laned; the team hides them one by one.

## Storefront v11

Storefront v10 with the same model; a store is one per owner, so hiding it removes a seller from discovery, and items are reached only through their store.

- `store`, `storeItem`, `storeReview` and `itemReview` get `mod`/`modLabel`/`modReason` and the `moderated` log.
- `store.byStatus [status, mod, $createdAt]`, `byCategory [status, mod, category, $createdAt]` (ranked at `category`). `storeItem.storeAndTime [storeId, mod, $createdAt]`, `storeStatusAndTime [storeId, mod, status, $createdAt]`.
- `storeReview.storeReviews [storeId, mod, $createdAt]`; the rating trees are `storeRating [mod, storeId]` (summable, averageable, ranked) and `storeRatingDistribution [storeId, mod, rating]`; `itemReview.itemReviews [itemId, mod, $createdAt]` and `storeItemRating [mod, storeId, itemId]`. A hidden review leaves the average, the histogram and the ranking (proved: 6/2 → 5/1).
- Every reference at a store or an item (`storeItem.storeId`, `shippingZone.storeId`, `itemDeliverable.itemId`, `storeOrder.storeId`, both reviews, `report.storeId`/`itemId`) is `permanentDocument`. Reviews stay author-deletable, so `report.storeReviewId`/`itemReviewId` stay `deletableDocument`.
- No restriction type: storefront has no `live` lane to force.
- An order to a hidden store is still accepted on chain (a reference cannot be told to refuse it without an owner decision; see [Owner decisions](#owner-decisions)); yap.pr blocks checkout.

## Client: topology v18, blog v10, storefront v11

`NEXT_PUBLIC_CONTRACT_TOPOLOGY=v18`, `NEXT_PUBLIC_BLOG_TOPOLOGY=v10`, `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v11`. The descriptor is v17's, and the tombstone preserve set adds `mod` and `modLabel` to post and reply (`tombstonePreservationFor`): a tombstone that drops a moderator field is refused 41124 (proved). The new predicates:

| Predicate | File | True on |
| --- | --- | --- |
| `listingsCarryModLane()` | `lib/contract-topology.ts` | social v18 |
| `moderatorsCannotDelete()` | `lib/contract-topology.ts` | social v18 |
| `authorsCanBeRestricted()` | `lib/contract-topology.ts` | social v18 (`live` is 1 or 2) |
| `likesCarryPostLive()` | `lib/contract-topology.ts` | social v18 |
| `blogListingsCarryModLane()` | `lib/constants.ts` | blog v10 |
| `blogAuthorsCanBeRestricted()` | `lib/constants.ts` | blog v10 |
| `storefrontListingsCarryModLane()` | `lib/constants.ts` | storefront v11 |

Existing helpers already read the file: `moderatorDeletableTypes()` is empty and `moderationListsKept()` is `['warnings']` on v18. The client work: write `live: 1 | 2` (read `restriction.byTarget` before a compose), `postLive` on a like, pin `mod == null` after `live == 1` in every listing builder, carry `mod`/`modLabel` through tombstones, replace removal and restore with hide/unhide (`moderatorChangeDocumentFields`) and bans with restrictions, and skip hidden ids in ranked lists.

## Tooling

- **`scripts/app-connect-set.mjs`** appends `socialV18`, `blogV10` and `storefrontV11` after the eight members registered on 2026-10-21; they take the social, blog and storefront env variables. The v17 social, v9 blog and v10 storefront keep their pins, with `envKey: null` and `replacedBy`: they stay in the group for good, unused. `TESTNET_REGISTERED_THROUGH` is `passkeyVault`.
- **`scripts/register-app-connect-contracts.mjs --append-after <entry>`** creates only the entries after it, each joining the existing group in its own create. Platform 5.0.0-rc.4 allows that to the group's owner or an admin (`data_contract_create/state/v1`: the group must exist, `ContractGroupNotFoundError` otherwise, and `may_add_members` must hold, `IdentityNotContractGroupOwnerOrAdminError` otherwise); a wallet key bound to the group covers members added later. `--plan` builds and audits only the new creates. `--dry-run` proves the group (owner the maker, no admins), every registered member at its planned id (owner, document types, membership), that no new id exists, and that the maker's next nonce is the first new entry's. `--live` resumes the set's journal (every entry through the named one must be verified there) and records the new batch's rendering under `appends`, apart from the original set's.
- **`scripts/hide-moderation-queries.mjs`**: the read catalogue above, shared by the conformance spec and the sakura battery.
- **`scripts/prove-v18-moderation.mjs`**: the devnet battery (register, social, blog, storefront, catalogue, fees, elected). Its moderation cases replace the v17 batteries' removal, restore and ban cases for this cut: hide, unhide, restrict, lift, warn, and a moderator delete, ban or suspension that must be refused.
- **Offline (Gate G1).** `validate-contract-offline.mjs --strict-size --network testnet` and `--network mainnet` pass for all three files. `--probes` adds 33 v18-set probes (348 pass in total) and `--constraints` 327 v18-set cases (all pass). One probe records a finding: a reference `where` may bind the *referenced* document's moderator-only `mod` (only a type's own `changeFields` may not be read by its references), so refusing likes, replies or orders on hidden content is possible in the grammar; it is not used, by the owner's decision, and is unproved on a node.

## Sakura proof

Run 2026-10-22 05:36–06:00Z on devnet sakura (Platform 5.0.0-beta.6, PV14; the query, index, moderation and fee paths are byte-identical to rc.4, and rc.4 → rc.5, which testnet's nodes now report, changes none of them). Throwaway copies of the **exact** committed files, registered by the sakura maker `9RPq2Ju…` and battery bots, never the deployed /devnet set. The battery copies render the elected declaration with two appointed interim moderators (corpus:64 and corpus:65) so the cases could run at once; the `elected` copy keeps `notYetUsable` with 1 h windows and a 1 h election delay. Every write was read back, every read used the SDK's proved path (heights 36277–36336, proofs 1.1–3.7 KB).

| Copy | Id | Signed | Fee |
| --- | --- | ---: | ---: |
| social v18 (battery) | `GRSyjxTzDDFyibqL4TePFmw9pDPS5ueirVaXjucQMURH` | 19,862 B | 99.81e9 |
| social v18 (`notYetUsable`, 1 h windows) | `9JKi3tZXpci2RRNDGgu2DnzW9o7ksWP6f3oGoCEni7HL` | 19,796 B | 99.80e9 |
| blog v10 | `HbQynvbYteGhPP3u7L75z3wJ4FDm4UHXsXpRjYma7XnQ` | 10,799 B | 46.44e9 |
| storefront v11 | `67giuqWec4PvMwprq24kTkMhNVJFZMJTGfWx9uNMdV5N` | 20,004 B | 64.74e9 |
| social v17 (fee baseline) | `9a4XJ7NfoCtWGvDRGFri9dhDTYNKyea67JMScDrzTWiJ` | 18,085 B | 91.76e9 |

The registrations themselves prove the shape registers: `restriction`, `countOf` over it, `$revision` in a rule, `mod` as a `changeFields` field inside `[live, mod, …]` listings, `permanentDocument` references, `postLive` in the trend windows, and the warnings-only elected declaration.

| Proved | Result |
| --- | --- |
| Every listing, count, grouped count and rank on the default lane before, during and after hides (social 97, blog 29, storefront 45 reads) | **PASS** |
| The whole catalogue, every lane (179 reads: social 106, blog 29, storefront 44) | **PASS**, all served and proved |
| Hide: the post and a reply leave the timeline, tag page, author list and count, top authors, mentions, thread, both thread counts, grouped counts and most replied; they enter `mod == 1` and the `moderated` log; the post keeps its content, lane and stamps, `$revision` +1 | **PASS** |
| Unhide by the other moderator: everything back, the log empty | **PASS** |
| The author (a non-moderator) changing `mod`: 41101; a create, replace or self-unhide writing `mod`: 41124; a hide without a reason: 10422 `modReason` | **PASS** |
| A moderator delete of a post, reply, blog post, comment, store or review: 41115, nothing removed | **PASS** |
| A tombstone of a hidden post dropping `mod`: 41124; carrying it: accepted, out of every lane, still in the log | **PASS** |
| Restriction: a non-moderator's create 41124; a moderator's accepted; a second one 40105; the restricted author's `live: 1` refused 10422, `live: 2` post and reply accepted, listed only in lane 2; `state: null` refused 10422; the lift accepted; after it `live: 2` refused and `live: 1` listed; the lane-2 post stays in lane 2 | **PASS** |
| The `$revision` guard: a moderator hides, and the restricted author tombstones, replies written before the restriction | **PASS** |
| Likes: `postLive` 1 on a listed post, 2 on a restricted one; the wrong lane 40127; a like of a tombstone 40127; a like of a hidden post accepted (accepted gap); trending laned 1/2 | **PASS** |
| Warnings: a warn accepted and read back by `moderationEntries`; a ban and a suspension refused 41100 (no such list) | **PASS** |
| Blog: blog, post and comment hide/unhide across `blog.timeline`, `blogPost.timeline`, `blogAndTime`, comments and their (grouped) counts, and the three logs; the blog restriction lanes a restricted blogger's post | **PASS** |
| Storefront: store, item, store review and item review hide/unhide across `byStatus`, `byCategory` and its ranking, both item listings, reviews, the average (6/2 → 5/1), the histogram, the ranked average and the four logs; an order at a hidden store is accepted | **PASS** |
| `notYetUsable`: a post before any team is seated | **PASS**, refused 41200 |
| Seating a sole-contender team with `file-release-charters.mjs`, then posting | pending: the charter is filed once the 1 h election delay passes (06:39Z) and seats after the 1 h join window |

The run's harness errors (byte arrays sent as plain number lists, an empty tag list on an untagged like) were fixed and re-run; they are not contract outcomes. A `yapprProfile` hide was not exercised (it needs a DashPay profile); its log read is served.

### Fees

Balance deltas of the signer, 1M credits ≈ 0.06¢. Both social copies carry the D41 action fees (post 20M, reply 10M), and each writer made three warm-up posts first, so the rows compare like with like. One sample per row; earlier runs put sample noise at about ±0.3M on a post and a few M on first-in-tree writes.

| Write | Social v17 | Social v18 | Δ |
| --- | ---: | ---: | ---: |
| Post, no tags | 104.05M (6.24¢) | 104.87M (6.29¢) | +0.8M (+0.8%) |
| Post, 1 new tag | 161.55M (9.69¢) | 158.41M (9.50¢) | −3.1M |
| Post, 4 new tags | 295.22M (17.71¢) | 296.30M (17.78¢) | +1.1M (+0.4%) |
| Post, 1 known tag | 136.53M (8.19¢) | 136.81M (8.21¢) | +0.3M (+0.2%) |
| Reply, first on a post | 120.28M (7.22¢) | 120.31M (7.22¢) | ≈0 |
| Reply, second | 68.74M (4.12¢) | 68.71M (4.12¢) | ≈0 |
| Like, untagged post | 15.50M (0.93¢) | 16.80M (1.01¢) | +1.3M |
| Like, 1 tag | 20.81M (1.25¢) | 21.39M (1.28¢) | +0.6M |
| Like, 4 tags | 30.50M (1.83¢) | 32.86M (1.97¢) | +2.4M |
| Post tombstone (refund) | −48.28M | −48.29M | ≈0 |
| Reply tombstone (refund) | −28.73M | −28.59M | ≈0 |

Moderator writes on v18 (paid by the moderator; v17's removal cost 16.5–18.7M and its restore 53–68M):

| Write | Fee |
| --- | ---: |
| Hide, 4-tag post / unhide | 195.51M (11.73¢) / 134.43M (8.07¢) |
| Hide, 2-tag post with a mention / re-hide / unhide | 186.36M (11.18¢) / 176.57M (10.59¢) / 116.89M (7.01¢) |
| Hide, untagged post / unhide | 90.30M (5.42¢) / 41.77M (2.51¢) |
| Hide, reply / unhide | 96.73M (5.80¢) / 92.80M (5.57¢) |
| Restrict / lift / re-restrict | 62.00M (3.72¢) / 36.62M (2.20¢) / 12.58M (0.75¢) |
| Warn | 9.74M (0.58¢) |
| Blog: hide post / comment / blog | 93.41M / 57.38M / 49.15M |
| Storefront: hide review / item / item review / store | 118.47M / 82.61M / 98.24M / 92.11M |

A hide re-keys every listing the document is in, count and rank trees included, so it costs 5–12¢, well above the 10–25M the plans estimated. Authors pay nothing more: the `mod` level and the `countOf` read are inside the noise.

## Registering it on testnet

The production maker `hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A` is at nonce 64 (proved, height 638098, PV14, the answering node on Drive 5.0.0-rc.5), with 1,025.53e9 credits. The read-only plan and dry-run, with no key read and nothing signed:

```sh
NETWORK=testnet node scripts/register-app-connect-contracts.mjs --dry-run --append-after passkeyVault \
  --maker hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A --start-nonce 57 \
  --interim notYetUsable --election-windows <join>,<vote> --election-delay <seconds> --challenge-cool-down 1209600
```

prove the anchor `D8benQGn…`, the group `4MjVAxDY…` (owner the maker, no admins) and all eight registered members, and plan:

| Nonce | Entry | Predicted id | Estimate |
| ---: | --- | --- | ---: |
| 65 | social v18 | `CzXucVEss3NUrKQ9q4ZMnRhhb6zjiLxXxTNUyEkpaVCi` | 101.09e9 (≈6,065¢) |
| 66 | blog v10 | `FTr4yygzDjbwo997hPKNaf1ebHAPfuGLvRaoXspExsPy` | 47.18e9 (≈2,831¢) |
| 67 | storefront v11 | `HAiJRqxw5NsEM4M4CPwWp1DnwA5fca8r2LNv5WgjM49r` | 66.10e9 (≈3,966¢) |
| | **Total** | | **214.37e9 (≈12,862¢)**; the balance gate passes |

The ids hold only if the maker spends no other nonce first. The estimate does not depend on the windows (86400 or 3600 render to within 6 B). On sakura the same three cost 210.99e9. The live run is the same command with `--live --production --journal <the 2026-10-21 journal> --maker-key-file … --maker-key-id 2`; the activation PR then points `.env.testnet` at the new ids and the new YAPP token (`tokens.calculateId(socialV18, 0)`), and the charters are filed on the new targets only.

## Accepted gaps

From DECISIONS-FINAL, as built: likes by restricted users still count toward trending; a hidden post's likes still count toward its tags' totals; likes, replies, quotes, bookmarks and orders of hidden content are accepted on chain; illegal text stays in state (media is off-chain); a new identity evades a restriction; restricted authors still spend sponsored gas. Also, from the cut: a profile's owner can delete it and create a new one without `mod`; a restricted author's blog comments and storefront reviews are not laned; the v17 social, v9 blog and v10 storefront stay in the group (never file charters on them, never point builds at them).

## Owner decisions

- **Election windows and delay for the testnet registration** (registration flags): 24 h/24 h/24 h or 1 h/1 h/1 h. Frozen at registration.
- **The moderator hide cost** (5–12¢ per hide, 2–8¢ per unhide), paid by the team; the pot accrues 20M per post and 10M per reply.
- **Blocking interactions with hidden content** is possible in the grammar after all (a reference `where` on the target's `mod`); DECISIONS-FINAL says no. It is frozen into the cut either way.
- **Restriction in storefront** (no `live` lane) and **blog comments** (no `live` lane): left unlaned.
