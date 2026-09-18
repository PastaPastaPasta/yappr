# Blog contract v2

Registered on moutai 2026-09-17 as `4pSFqC9Q5amtmrJtL1oC8nWTW15e8LiZ7WqevB3AbEpB`
(a throwaway battery registration owned by a seed persona; the deployment maker
can re-publish the same JSON when the next full re-provision happens). Built by
`scripts/build-blog-v2-contract.py` from the v1 file, published by
`scripts/register-feature-contract.mjs --file yappr-blog-contract-v2.json`,
verified live by `scripts/verify-blog-v2.mjs` (27 checks, all passing on the
first run). Protocol 14, Platform 4.2.0-beta.1 or later.

## What changed and why

v1 could not tell you how many comments a post had without downloading them,
could not tell you which blogs people actually read, and let anyone write a
comment claiming any `blogPostOwnerId` — the key the notification source reads
— on a post id that need not exist. v2 puts all of that on Platform features
the social contract already uses.

| Doctype | v2 change | Serves |
| --- | --- | --- |
| `blog` | unchanged (already `canBeDeleted: false` + `documentsKeepHistory`) | permanentDocument target |
| `blogPost` | required poster-attested `author`; `blogId` refersTo blog | the comment agreement source; ghost-blog rejection |
| `blogComment` | `blogPostId` refersTo blogPost with `propertyAgreement {blogPostOwnerId: 'author'}`; ranked `commentCount [blogPostId]`; `postOwnerAndTime`; 1 YAPP | exact comment counts, "most discussed posts", forge-proof "comments on my posts" |
| `blogFollow` | `blogId` refersTo blog; ranked `followerCount [blogId]`; `followersByDay [$createdAt, blogId]` on the daily grid | exact follower counts, "most followed blogs", "trending today" |

The client selects the topology with `NEXT_PUBLIC_BLOG_TOPOLOGY=v2`
(`blogIsV2()` in `lib/constants.ts`). On `v1` (the default, matching the
testnet contract) posts omit `author`, comments carry no token payment, and
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

`propertyAgreement` binds user properties, never `$ownerId`. So the post author
writes `author` into their own post (poster-attested; the app writes
`author = $ownerId` and reads it back the same way), and consensus then forces
every comment on that post to carry exactly that value in `blogPostOwnerId`:

```
the document's blogPostOwnerId does not agree with the referenced document's
author (propertyAgreement on blogPostId)                          [40127]
```

That is what makes `postOwnerAndTime [blogPostOwnerId, $createdAt]` safe to
read as a notification source: nobody can inject a row into someone else's
notification feed. Comments on posts that do not exist are impossible for the
same reason (`referenced permanent document … not found for path blogPostId`,
40120).

The residual gap is the mirror of storefront v2's: consensus cannot check that
a post's `author` equals its own `$ownerId`. A hand-rolled post could name
someone else as author, which would route its comments into that person's
notifications. The app always writes `author = $ownerId`, and
`blog-comment-service.ts` reads the post's attested `author` (not the caller's
opinion) before commenting, so the two always agree. Closing it fully needs an
upstream "owner agreement" on `refersTo`.

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

// Comments on my posts since last seen (notification source).
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
| "Comments on my posts" notifications | not possible (forgeable key, no index) | 1 page + 1 by-id post batch |

## Gotchas found on the way

1. `rankedCountable: true` must be spelled out alongside `countable:
   "countable"` and `rangeCountable: true`. The meta-schema's dependency rules
   run on the literal keys and the offline wasm validator compiles that check
   out, so a short spelling passes `DataContract.fromJSON` and fails at
   registration (dashpay/platform#4809). `COUNT_FLAGS` in the build script is
   the full spelling; with it, registration succeeded on the first attempt.
2. `timeRange` (including `ttl`) is accepted on an **ordinary** doctype — it
   does not require `indexOnly`. `blogFollow` is a normal, deletable doctype
   and `followersByDay` registered and served fine. The ttl drains that index's
   entries after seven days; the follow documents themselves stay (only an
   `indexOnly` doctype self-deletes).
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
   `extractContentFields` now converts `blogId`/`author` back to raw bytes so an
   edit does not rewrite a required identifier in the wrong encoding.

## Not in v2

- No `authorAndTime [author, $createdAt]` index. `author` is required to equal
  `$ownerId`, so the existing `ownerAndTime` index already answers "posts by
  this author" — a second index would only add write cost.
- No `refersTo: {type: 'identity'}` on `blogPost.author`. The writer is
  necessarily a real identity and the value must equal `$ownerId`, so the check
  would cost something and prove nothing.
- Comment counts on the post view still come from the comment page the view
  loads anyway; there is no separate count request.
- The blog-home composite (page posts + bound comment counts in one proof) is
  not wired up; the grouped count is already one request and the composite
  would not reduce it below that.
