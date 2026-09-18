# Blog contract v2

**Not currently deployed.** The 2026-09-17 registration
(`4pSFqC9Q5amtmrJtL1oC8nWTW15e8LiZ7WqevB3AbEpB`, 32/32 battery checks) went with
the moutai wipe, and the JSON has since been re-cut for **4.2.0-beta.2** — see
"beta.2 re-cut" below. Built by `scripts/build-blog-v2-contract.py` from the v1
file, published by `scripts/register-feature-contract.mjs --file
yappr-blog-contract.json`, verified live by `scripts/verify-blog.mjs`.
Protocol 14, Platform 4.2.0-beta.2 or later.

## beta.2 re-cut

Three changes, all of them the same idea: say it once, on chain.

- **`blogComment.blogPostId` agrees `{blogPostOwnerId: "$ownerId"}`**, not
  `{blogPostOwnerId: "author"}`. beta.2 lets the REFERENCED side of a
  `propertyAgreement` name the referenced document's own `$ownerId`, so the
  notification key binds to the identity that actually signed the post.
- **`blogPost.author` is gone.** It existed only to be that agreement source,
  no index used it, and it came with a hole consensus could not close. Its
  removal takes 32 bytes off every post, a required field off the create path,
  and the resolution plumbing out of `blog-comment-service.ts`.
- **`blogPost` freezes `immutable: [blogId, publishedAt]`** with `publishedAt`
  under `immutableAllowSetting`, and `COUNT_FLAGS` drops the `countable` key
  `rangeCountable` now implies.

## What changed and why

v1 could not tell you how many comments a post had without downloading them,
could not tell you which blogs people actually read, and let anyone write a
comment claiming any `blogPostOwnerId` — the key the notification source reads
— on a post id that need not exist. v2 puts all of that on Platform features
the social contract already uses.

| Doctype | v2 change | Serves |
| --- | --- | --- |
| `blog` | unchanged (already `canBeDeleted: false` + `documentsKeepHistory`) | permanentDocument target |
| `blogPost` | `blogId` refersTo blog; `immutable [blogId, publishedAt]`, `publishedAt` write-once | ghost-blog rejection; a post cannot change blogs or be re-dated |
| `blogComment` | `blogPostId` refersTo blogPost with `propertyAgreement {blogPostOwnerId: '$ownerId'}`; ranked `commentCount [blogPostId]`; `postOwnerAndTime`; 1 YAPP | exact comment counts, "most discussed posts", unforgeable "comments on my posts" |
| `blogFollow` | `blogId` refersTo blog; ranked `followerCount [blogId]`; `followersByDay [$createdAt, blogId]` on the daily grid | exact follower counts, "most followed blogs", "trending today" |

The client selects the topology with `NEXT_PUBLIC_BLOG_TOPOLOGY=v2`
(`blogIsV2()` in `lib/constants.ts`). On `v1` (the default, matching the
testnet contract) comments carry no token payment and
counts fall back to the page scans the old client did; on `v2` the switch must
match a v2 registration or consensus rejects the writes. Unlike
`STOREFRONT_TOPOLOGY`, the gate reads `process.env` at call time (like
`getContractTopology`) so unit tests can stub it; `NEXT_PUBLIC_*` is inlined at
build time either way.

Comments are priced in YAPP through `tokenCost.create.contractId`, which names
the **social** contract. The client attaches a `TokenPaymentInfo` whose
`paymentTokenContractId` is that contract (`BLOG_YAPP_TOKEN_COSTS` in
`lib/constants.ts`, wired through `resolveTokenPayment` in
`state-transition-service.ts`); without it consensus refuses the create
("Required token payment info not set on token …", battery b3c).

## The forged-notification-key hole, closed

Consensus forces every comment to carry the post's real owner in
`blogPostOwnerId`:

```
the document's blogPostOwnerId does not agree with the referenced document's
$ownerId (propertyAgreement on blogPostId)                        [40127]
```

That is what makes `postOwnerAndTime [blogPostOwnerId, $createdAt]` safe to
read as a notification source: nobody can inject a row into someone else's
notification feed. Comments on posts that do not exist are impossible for the
same reason (`referenced permanent document … not found for path blogPostId`,
40120).

**The residual gap is gone.** On beta.1 the agreement could only name a user
property, so the post carried an attested `author` copy that consensus could
not check against its own `$ownerId` — a hand-rolled post naming someone else
as author was accepted (old battery case b2c), and its comments would have
landed in the victim's feed. Two client rules used to close it: the writer
always set `author = $ownerId`, and `notification-service.ts` re-checked every
named post's ownership before showing a row. beta.2's system-field agreement
makes both unnecessary, and both are gone: a row on `postOwnerAndTime` is by
construction a comment on a post this user signed. `blog-comment-service.ts`
still fetches the post before commenting — not to decide whom to trust, but
because the write must carry the owner's id verbatim and the caller's copy may
be stale.

## Query shapes that serve, verified live

```js
// Comment count for one post — one proved read, no page scan.
sdk.documents.count({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId', '==', P]] })

// Comment counts for a whole post list in one request.
sdk.documents.count({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId', 'in', [P1, P2, …]]], groupBy: ['blogPostId'] })

// Follower count for one blog.
sdk.documents.count({ dataContractId, documentTypeName: 'blogFollow',
  where: [['blogId', '==', B]] })

// Most discussed posts / most followed blogs.
sdk.documents.ranked({ dataContractId, documentTypeName: 'blogComment',
  groupBy: 'blogPostId', aggregate: { type: 'count' }, direction: 'desc', limit: 20 })
sdk.documents.ranked({ dataContractId, documentTypeName: 'blogFollow',
  groupBy: 'blogId', aggregate: { type: 'count' }, direction: 'desc', limit: 20 })

// Trending blogs today: the same ranked chain under the daily bucket.
sdk.documents.ranked({ dataContractId, documentTypeName: 'blogFollow',
  groupBy: 'blogId', aggregate: { type: 'count' }, direction: 'desc', limit: 20,
  timeRange: [{ field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 86400 } }] })

// Comments on my posts since last seen (notification source). Verified in
// both directions (b4d); the client reads newest first.
sdk.documents.query({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostOwnerId', '==', me], ['$createdAt', '>', lastSeen]],
  orderBy: [['blogPostOwnerId', 'asc'], ['$createdAt', 'desc']], limit: 100 })

// Every stored revision of a post: Map<bigint timestampMs, Document>.
sdk.documents.history({ dataContractId, documentTypeName: 'blogPost', documentId: P })
```

Page budgets after the client migration (cold load, DAPI requests):

| Surface | v1 | v2 |
| --- | --- | --- |
| Blog home, N posts | 1 posts page + 1 bundled comment probe + 1 full cursor scan per post with 100+ comments | 1 posts page + 1 grouped count per 100 posts |
| Blog home follower badge | ⌈followers / 100⌉ | 1 count |
| `/blog` discovery, "Most followed" / "Trending today" | not possible (would be 1 + one follower scan per blog) | 1 ranked + 1 by-id batch |
| Post view comment count | the 100-comment page it already loads | unchanged (the page is rendered anyway) |
| "Comments on my posts" notifications | not possible (forgeable key, no index) | 1 page + 1 by-id post batch (which also proves ownership) |

## Gotchas found on the way

1. `rankedCountable: true` must be spelled out alongside `rangeCountable:
   true`. The meta-schema's dependency rules run on the literal keys and the
   offline wasm validator compiles that check out, so a short spelling passes
   `DataContract.fromJSON` and fails at registration
   (dashpay/platform#4809). `countable` is the one part of that chain beta.2
   infers: `rangeCountable: true` now implies `countable: "countable"` in the
   meta-schema and in the structural parser alike, so `COUNT_FLAGS` no longer
   spells it.
2. `timeRange` (including `ttl`) is accepted on an **ordinary** doctype — it
   does not require `indexOnly`. `blogFollow` is a normal, deletable doctype
   and `followersByDay` registered and served fine. The ttl drains that index's
   entries after seven days; the follow documents themselves stay (only an
   `indexOnly` doctype self-deletes).

   This is the first stored, deletable doctype in this codebase carrying a
   TTL'd windowed index (every previous one — `like.byDayPost`,
   `beat.byDayHashtagPost` — sits on an `indexOnly` type that self-deletes), so
   the delete interaction was proved explicitly rather than assumed:

   - **warm bucket**: battery b11 unfollows and asserts the all-time count, the
     ranked page and the windowed page all drop to the new value;
   - **drained bucket**: a scratch registration of the same JSON with a 60-second
     grid and a 120-second ttl (`A1TjAxphoHwtnLKx5qihArQEJfZf5iauSdy4gskbgd2a`)
     was followed, left until the windowed count fell from 1 to 0 while the
     all-time count stayed 1, and then deleted. **The delete was accepted and
     the all-time count decremented to 0.** Drive does not require the drained
     index entry to exist, so an unfollow a week later cannot strand a user.
3. A ranked read on a daily bucket no document ever landed in fails proof
   generation instead of proving an empty ranking: *"a single-path axis read
   must produce exactly one axis descent"*. That error IS the empty answer —
   `blog-stats-service.ts` maps it to `[]`, same as `ranked-likes.ts` does for
   the social contract.
4. The prefix-overlap rule does not fire for a single-property ranked index
   (`commentCount [blogPostId]`) sitting beside a plain compound one
   (`postAndTime [blogPostId, $createdAt]`) — the same shape storefront v2 runs
   as `storeOrderCount`/`storeOrders`.
5. `tokenCost.create.contractId` must be the 32-byte array form in the
   registered JSON; the registration script substitutes the
   `SOCIAL_CONTRACT_ID` placeholder.
6. Deleting a comment decrements the count tree (battery b10), so the counts
   stay honest even though `blogComment` is deletable while posts and blogs are
   not.
7. `update()` merges the transform's output into a full replace, and the
   transform hands identifiers back as base58. `blog-post-service.ts`
   `extractContentFields` converts `blogId` back to raw bytes so an edit does
   not rewrite a required identifier in the wrong encoding. Since beta.2 that
   is enforced, not merely tidy: `blogId` is `immutable`, so a replace carrying
   a re-encoded value is rejected outright (40128) instead of silently
   rewriting the reference.
8. `immutable` freezes a property against *change, removal and late addition*
   alike — a replace that simply omits `publishedAt` is the same 40128 as one
   that re-dates it (battery b12c). Every edit path here re-sends the stored
   value because `update()` merges, but a hand-built replace must too.
   `immutableAllowSetting` is the single exception and it fires ONCE: a draft
   (no `publishedAt`) can be published, and after that the date is frozen like
   everything else (b12d/b12e).

## Not in v2

- No `author` property and no `authorAndTime` index. The author IS `$ownerId`,
  which comments bind to directly and which `ownerAndTime` already indexes.
- No writer gate on `blogComment.blogPostId`. Anyone may comment on anyone's
  post — that is the feature — so `{$ownerId: $ownerId}` would be wrong here,
  unlike on the storefront where only a store's owner may list under it.
- Comment counts on the post view still come from the comment page the view
  loads anyway; there is no separate count request.
- `blogStatsService.mostDiscussedPosts()` is proved (battery b5a) and exposed,
  but has no page: the app has no cross-blog post feed to rank, and the ranked
  axis is global so it cannot be pinned to one blog. It is the ready-made read
  for such a surface when one exists.
- The blog-home composite (page posts + bound comment counts in one proof) is
  not wired up; the grouped count is already one request and the composite
  would not reduce it below that.

## Operational notes

- Registration is pending: publish under the deployment maker and set
  `NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID` in `.env.devnet`. `tokenCost` names the
  social contract, so the new social contract id is an input.
- Repointing that id orphans any v1 blogs and posts: they live in the old
  contract, and a comment cannot reference across contracts. Acceptable on
  moutai; not a migration path.
- Commenting costs YAPP on v2. `components/blog/blog-comments.tsx` labels the
  button with the cost and routes an insufficient-balance failure into the
  shared Buy-YAPP modal, the same as posts and storefront reviews.
