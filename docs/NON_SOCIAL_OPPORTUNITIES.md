# Non-social contract opportunities on Platform 4.2

Review date: 2026-09-17; re-cut for `v4.2.0-beta.2` on 2026-09-18 (see
"Status" below). Scope: every Yappr contract and user surface that is
not the social contract (`yappr-social-contract-v6.json`), assessed against
what Platform `v4.2.0-beta.1` (protocol 14) can do and what the social side
already exploits. Sources: the checked-in contracts, the deployed devnet
bundle (`lib/contracts/bundled/devnet-moutai.json`), the services under
`lib/services/`, the upstream meta-schema
(`packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json` at
`v4.2.0-beta.1`), the rs-drive query dispatchers, and the Aug–Sep 2026
session transcripts.

## Status

Everything ranked below as worth doing has been **built** and lives in
`contracts/` + `scripts/build-*-contract.py`, re-cut against
**`v4.2.0-beta.2`**. Nothing is registered: moutai was wiped and reset to
beta.2, so the contracts here are validated offline only and phase 2
(registration, batteries, seeding) is pending a new social contract id.

| Area | State | Doc |
| --- | --- | --- |
| Storefront v2 | built; writer gates, frozen `storeId`, three attested id copies dropped | `docs/STOREFRONT_V2.md` |
| Blog v2 | built; comments bind to the post's `$ownerId`, `author` dropped, `blogId`/`publishedAt` frozen | `docs/BLOG_V2.md` |
| DM v4 | built; count flags + `immutable` lists, nothing else (cost directive) | `docs/DM_V4.md` |
| Pollr v4 | built; ballots bind to the poll's `$ownerId`, `author` dropped | `docs/POLLR_V4.md` |
| Tips on YAPP | built (social contract token transfers) | `docs/TIPS_YAPP.md` |
| Key exchange v3 | **abandoned** — indexOnly measured +42% fees | — |

beta.2 changed three things this plan was written around, all of them for the
better:

- **`propertyAgreement` can name system fields.** The referenced side may be
  the referenced document's `$ownerId`/`$creatorId`, and the *referring* side
  may be `$ownerId` — the writer — which makes the pair a **write gate**. That
  retires the whole "poster-attested id + client check" pattern §2 and §4
  below describe as unavoidable, and with it four documented gaps (a forged
  blog-post author, a forged poll author, a spoofed order status update, a
  stranger burning an order's review slot).
- **`immutable` / `immutableAllowSetting`** freeze chosen properties of a
  MUTABLE doctype, so structural fields (`storeItem.storeId`,
  `blogPost.blogId`, `directMessage.conversationId`) stop being editable
  without freezing the whole document.
- **`rangeCountable: true` implies `countable: "countable"`**, one link of the
  #4809 spell-it-all-out chain relaxed. The `ranked*` prerequisites still run
  on the literal keys.

## 1. Where things stand

The social contract went through six cuts (v3 topology → v6b) and now uses
`refersTo` + `propertyAgreement`, indexOnly `like`/`likeReply`/`beat`,
preallocated trees, `rankedCountable` (boolean and `{at}` forms),
timeRange buckets with `ttl`, ranked-below-bucket windows, chained and
composite queries, count trees on every relation, and YAPP `tokenCost`.

**None of the other nine contracts use any of it.** A scan of the storefront,
blog, DM, Pollr, profile, vault, auth-vault, key-exchange and key-backup
schemas finds zero `refersTo`, `propertyAgreement`, `summable`,
`averageable`, `rankedCountable`, `timeRange`, `indexOnly`, `tokenCost` or
`requiredSince`. The only aggregate flag anywhere is Pollr v3's
`countable: true` on `vote.choiceCounts`. Blog is the only one with
`documentsKeepHistory` (unused by the client). In the client,
`documents.composite` is called only from the social feed/homepage paths, and
contract-bound encryption keys are explicitly disabled
(`lib/services/identity-update-builder.ts:196`).

Consequences visible today:

| Surface | What the client does | DAPI cost |
| --- | --- | --- |
| `/store` discovery | loads 50 stores, then pages every review of every store to compute averages in JS (`store-review-service.ts:161`) | 1 + 50 × ⌈reviews/100⌉ before first paint |
| `/store/view` | store + 100 items + 20 reviews + full review scan + key + profile + DPNS | ≥ 7 + ⌈reviews/100⌉ |
| `/orders` (buyer) | per order: latest status, store, review-exists, seller identity | 1 + 4 N |
| `/orders/seller` | per order: latest status + DPNS | 1 + 2 N |
| `/store/manage` | "pending" badge = `.length` of a 100-capped page of all orders | wrong number |
| Blog home | comment count per post and follower count via `paginateCount` (100/page, cap 1000) | ⌈comments/100⌉ per post |
| Blog discovery | crawls every blog on `ownerAndTime`, sorts client-side | ⌈blogs/100⌉ |
| Messages list | fetches 100 messages per conversation to count unread in JS | 2 + N + ⌈N/100⌉, then 1 per 3 s |
| Poll card | already on count trees (grouped `choice in [...]`) | 3 |
| Tips | no record; a reply with `tip:<credits>` text, unverified | — |

## 2. Capabilities the non-social side has not touched

Everything below is in the beta.1 meta-schema and has a JS surface in
`@dashevo/evo-sdk` unless marked otherwise. Index flags cannot be added by
contract update (no backfill), so each of these means a fresh contract
registration for the affected contract.

**Sum and average axes.** `summable: "<intProp>"` / `rangeSummable` and the
sugar `averageable` / `rangeAverageable` turn an index's value trees into
SumTrees. `sdk.documents.sum(query, prop)` and `sdk.documents.average(query,
prop)` return per-group `bigint` sums or `{count, sum}` pairs with proofs.
`rankedSummable` / `rankedAverageable` add an ordered secondary keyed by the
group's sum or average so `documents.ranked({aggregate: {type: 'avg',
property}})` answers "top K groups by average" in O(log n + k). Upstream's own
fixture for this is literally a restaurant-review contract
(`packages/rs-drive/tests/supporting_files/contract/restaurants/restaurants-contract.json`).
The tree behind average ranking is `ProvableCountProvableSumIndexedTree`;
there is no separately named "screaming" or "stats" tree, and MIN/MAX are
wire-reserved but rejected.

Constraints: the averaged property must be a `required` integer; string
group keys on an average-ranked index cap at 59 chars (61 for count/sum);
ranking is not allowed on unique indexes; a compound ranked index whose
leading prefix terminates another countable/summable index is rejected
(`ranked_prefix_overlap.rs`), so "sum per store per day" and "rank stores by
sum" cannot share a prefix without a NonCounted sibling shape.

**HAVING.** `documents.having({groupBy, aggregate, having: {operator,
value}, limit})` returns every group whose aggregate is inside one contiguous
bound, with a completeness proof. Good for "items rated ≥ 4" or "blogs with
≥ 100 followers". One clause only, no offset, tie-cut pages cannot continue.

**Cross-contract composite sub-queries.** A composite page may bind
sub-queries into *any* contract, so an item list can pull review counts (needs
a `countable` index) and seller profiles (profile contract) under one merged
proof. Count sub-queries need a countable index that no documents sub-query
also descends.

**`documentsKeepHistory` + `documents.history`.** Already declared on
`blog`/`blogPost`; nothing reads it. PV14 now rejects `documentsKeepHistory:
true` with `canBeDeleted: true`, which blog already satisfies.

**`refersTo` on every foreign key.** Storefront, blog, DM and Pollr all carry
client-supplied ids (`storeId`, `orderId`, `blogPostId`, `blogPostOwnerId`,
`pollId`, `pollOwnerId`, `recipientId`) that consensus never checks. Anyone
can post an `orderStatusUpdate` against any order id, a review against a
nonexistent order, a comment with a forged post-owner id, or a vote on a
missing poll. `permanentDocument` targets need `canBeDeleted: false`
(tombstone-by-edit, as the social contract does). ~~`propertyAgreement` binds
user properties only, never `$ownerId`; the social contract's poster-attested
`author` field is the pattern to copy.~~ **beta.2:** an agreement may name the
referenced document's `$ownerId`/`$creatorId`, and may put `$ownerId` on the
referring side as a write gate — so the attested-copy pattern is obsolete and
the re-cuts drop those copies rather than adding more.

**`tokenCost` with a foreign `contractId`.** `documentActionTokenCost` takes
an optional `contractId`, so storefront/blog/Pollr doctypes can charge YAPP
from the social contract without minting a token each. `gasFeesPaidBy: 1`
(contract owner pays gas) plus `effect: 0` (token to contract owner) enables
sponsored writes. There is still no "pay the referenced document's owner"
effect, so atomic tips/superchats remain unbuildable.

**`tradeMode: 1` / `transferable: 1` / `documents.setPrice` /
`documents.purchase`.** Direct-purchase documents with credits moving to the
seller atomically. Protocol 13 added `keepsPurchaseHistory` /
`keepsPricingHistory`. No doctype uses any of it.

**`timeRange` + `ttl`** (≤ 1 week, billed as ephemeral bytes, auto-drained)
for windowed counts, rate limits (`unique` with `range == step`), and
self-expiring handshake documents.

**beta.1 identity features (query-only in JS today).** Contract groups are
already used at deployment (all ten contracts are members of
`DYDGmjxw…`). Contract-bound AUTHENTICATION keys, group-bound keys, and
per-key `totalBudget` / `expiresAt` are live in consensus, but the wasm-sdk
has no options to *create* a V1 key or group-bound key yet; only
`identities.keysRemainingBudgets` and `contractGroups.*` reads exist.

## 3. Opportunities by area

Each entry: what changes in the contract, what query replaces the scan, what
the user gets, and the catch. "Re-cut" means a fresh registration of that
contract on devnet (cheap now; the same shapes carry to a testnet re-cut
later).

### 3.1 Storefront reviews: proved averages and rankings

Contract (`storeReview`):

```json
{"name": "storeReviews", "properties": [{"storeId": "asc"}, {"$createdAt": "asc"}]},
{"name": "storeRating", "properties": [{"storeId": "asc"}],
 "averageable": "rating", "rangeAverageable": true,
 "rankedAverageable": true, "rankedCountable": true},
{"name": "storeRatingDistribution", "properties": [{"storeId": "asc"}, {"rating": "asc"}],
 "countable": "countable", "rangeCountable": true},
{"name": "sellerRating", "properties": [{"sellerId": "asc"}],
 "averageable": "rating", "rangeAverageable": true, "rankedAverageable": true}
```

Queries:

- Store card: `documents.average({where: [['storeId','==',S]]}, 'rating')` → one `{count, sum}`; the client divides. Replaces the full review scan.
- Distribution: `documents.count({where: [['storeId','==',S], ['rating','in',[1,2,3,4,5]]], groupBy: ['rating']})` → five buckets in one call.
- Discovery: `documents.ranked({groupBy: 'storeId', aggregate: {type: 'avg', property: 'rating'}, limit: 20})` for "top-rated stores"; `aggregate: {type: 'count'}` for "most reviewed"; `documents.having({... having: {operator: '>=', value: 4}})` for "4 stars and up".
- `/store` page drops from 1 + 50 × scans to 2 requests (one ranked page, one `$id in` store fetch), the same pattern as Explore Top.

Catch: `storeRating` and `storeRatingDistribution` share the `storeId`
prefix, and the ranked one is single-property, so the prefix-overlap rule
does not fire (it only rejects a *compound* ranked index whose prefix
terminates an aggregating index). Confirm on registration. Averages on
`rating` alone are not per-item; items are not first-class review targets
today (see 3.3).

### 3.2 Verified purchase reviews and referential integrity

Contract:

- `store`, `storeItem`, `storeOrder`: `canBeDeleted: false` (add a `deleted`/`status` flag; storefront already has `status`).
- `storeItem.storeId`: `refersTo: {type: 'permanentDocument', documentType: 'store'}`.
- `storeOrder.storeId` → store; add `buyerId` (poster-attested, like `post.author`).
- `storeOrder.sellerId`: `refersTo: {type: 'identity'}`.
- `orderStatusUpdate.orderId` → storeOrder with `propertyAgreement: {$ownerId: 'sellerId'}` — the **writer gate**: only the order's seller may write one, so no `sellerId` copy and no client check. (As planned at beta.1 this was `{sellerId: 'sellerId'}` plus a client comparison; see `docs/STOREFRONT_V2.md`.)
- `storeReview.orderId` → storeOrder with `propertyAgreement: {storeId: 'storeId', sellerId: 'sellerId', buyerId: 'buyerId'}`; client checks `review.$ownerId == review.buyerId` for the "verified purchase" badge.
- `shippingZone.storeId` → store.

What it fixes: spoofed status updates, reviews of orders that never existed,
reviews aimed at the wrong store, ghost stores on items. Write errors surface
as consensus codes 40120–40127, which the app already maps for the social
contract (`isReferenceNotFoundError`).

~~Catch: `propertyAgreement` cannot bind `$ownerId`, so buyer identity is
self-attested at order time and the review-owner check stays client-side. A
forger could front-run the real buyer's single allowed review on the unique
`orderReview` index; a cheap mitigation is a YAPP `tokenCost` on reviews.~~
**Resolved in beta.2:** the writer gate `{$ownerId: $ownerId}` on
`storeReview.orderId` admits only the order's owner, so the front-run is
refused at write time and the buyer identity is not attested at all. The YAPP
cost stayed, for its own reasons.

### 3.3 Item-level ratings and sales signals

Reviews are per order today; an order can span several items and the review
does not name them. Options:

- Add `itemId` (refersTo storeItem, `propertyAgreement: {storeId: 'storeId'}`) to `storeReview` for single-item orders, with a compound `[storeId, itemId]` `rankedAverageable` index → "best-rated items in this store" (`groupBy: 'itemId'`, `where: [['storeId','==',S]]`).
- Or a separate `itemReview` doctype keyed by `(orderId, itemId)` unique.

Sales volume: `storeOrder` bodies are encrypted to the seller, so on-chain
sums of amounts would need a plaintext `amount` field (privacy trade-off).
Order *counts* are free: `countable` + `rankedCountable` on `storeOrders
[storeId]` → "most ordered stores"; on an indexOnly `sale [itemId]` doctype
written beside the order → "best sellers". A timeRange grid on
`[$createdAt, storeId]` → "trending stores this week".

Stock: consensus cannot decrement a seller-owned `stockQuantity` on a buyer
write. The closest shape is an indexOnly `reservation` doctype
(`itemId` refersTo storeItem, `summable: 'quantity'`, `preallocated`) so
`available = stockQuantity − sum(reservations)` is one proved call; spam
needs a token cost. Today stock is never decremented at all
(`cart-service.ts:292`, no write path), which is a correctness bug
independent of this.

### 3.4 Orders and status without N+1

Client-only (no re-cut):

- Buyer/seller order pages: one `orderStatusUpdate` query with `orderId in [...ids]` on `orderAndTime` (≤ 100 ids), pick the latest per order in JS; one `storeReview` query with `orderId in [...]` on `orderReview`; one `$id in` store batch. 1 + 4 N becomes 4.
- Manage-page badge: count only orders whose latest status is pending (still a scan until the contract changes).

Contract:

- `countable` on `sellerOrders`, `buyerOrders`, `storeOrders` → exact badge numbers and "orders this week" via a timeRange sibling.
- Composite on the buyer's orders page: page `storeOrder where $ownerId == me`, sub-queries: `store` by `$id` join on `storeId` (needs refersTo), `storeReview` lookup on `orderId`, `orderStatusUpdate` lookup on `orderId` (limit 1 desc is not allowed inside composite ordering rules, so latest-status stays a separate query or becomes a single mutable `orderStatus` doc with `documentsKeepHistory` and a unique `[orderId]` index, which also gives a provable status timeline through `documents.history`).

### 3.5 Blog

Contract (blog re-cut):

- `countable` on `blogComment.postAndTime` and `blogFollow.followers`; `rankedCountable` on a `[blogId]` follower index and on `blogComment [blogPostId]` → "most followed blogs", "most discussed posts"; a `[$createdAt, blogId]` timeRange index on `blogFollow` or `blogComment` → "trending blogs this week". Discovery stops crawling every blog.
- `refersTo`: `blogPost.blogId` → blog; `blogComment.blogPostId` → blogPost with `propertyAgreement: {blogPostOwnerId: 'author'}` after adding a poster-attested `author` to `blogPost`; `blogFollow.blogId` → blog. Comments on ghost posts with forged owner ids (which feed notifications) become impossible.
- Composite for blog home: page `blogPost where blogId == B`, sub-query `blogComment` counts bound on `blogPostId`, cross-contract profile lookups for comment authors.
- Optional `tokenCost` on `blogComment`.

Client-only: surface `documents.history` on `blogPost` ("edited", view
revisions). The data is already stored; nothing reads it.

### 3.6 Direct messages

The deployed DM contract (v3: `conversationInvite`, `directMessage`,
`readReceipt`) is not what `contracts/yappr-dm-contract.json` shows; the
checked-in file is the v1 schema with `read`/`recipientId`. Snapshot the live
schema into the repo before changing it.

Contract:

- `countable` + `rangeCountable` on `directMessage.conversation [conversationId, $createdAt]` → unread = `count where conversationId == C and $createdAt > lastReadAt`, one call, no ciphertext download. Grouped over `conversationId in [...]` for the whole list (IN + range counts are served on the no-proof path only; fine in trusted mode, otherwise per-conversation).
- `refersTo: {type: 'identity'}` on `conversationInvite.recipientId`; `refersTo: identityPublicKey` with `keyIdProperty` if the invite names the recipient's encryption key, so a disabled key is rejected at write time.
- `requiresIdentityDecryptionBoundedKey` on `directMessage` + a contract-bound ENCRYPTION key: re-test on beta.1; it was disabled for SDK bugs on 4.1.
- A timeRange index with `ttl` on an indexOnly `presence`/`typing` doctype if ephemeral state is wanted; the first legitimate TTL user outside rankings.
- Global unread badge and DM notifications become a count query per poll instead of a full list load.

### 3.7 Polls (Pollr v3, externally owned contract)

**Shipped** as Pollr v4 (`HRuWcjcG…` on moutai, `docs/POLLR_V4.md`), with two
corrections to the sketch below: `preallocated` cannot cover `[pollId, choice]`
(`choice` is neither the refersTo property nor an agreement key), so it lands on
the plain `vote.byPoll`/`byPollOwner` and nowhere on `multiVote`; and the
trending-polls timeRange index was dropped, which let `$createdAt` leave
`required` and made the unvote tuple a single hop. The standalone Pollr repo
still needs the same cut.

Already on count trees; remaining gaps need a Pollr v4:

- `vote.pollId` `refersTo: permanentDocument poll` (poll is immutable; add `canBeDeleted: false`) with `propertyAgreement: {pollOwnerId: 'author'}` after adding poster-attested `author` to `poll`.
- Make `vote`/`multiVote` `indexOnly` with `terminal: '$ownerId'` and `preallocated: true` on `[pollId, choice]`: poll creator pays the count trees, every vote is flat-priced and body-less, like social likes. Note: indexOnly types cannot carry `unique` indexes; single-choice is then structural on `[pollId] → $ownerId` (one entry per voter per poll), which is exactly the one-per-author trap the social side documented, here used on purpose.
- `rankedCountable` on `[pollId, choice]` → winner with `limit: 1`; a `[$createdAt, pollId]` timeRange index on votes → "trending polls today".
- `endsAt` stays advisory; consensus cannot read it.

### 3.8 Tips

Today a tip is a credit transfer plus a reply whose text says `tip:<n>`; the
amount is unverifiable and there are no totals. Options in order of
strength:

1. IndexOnly `tip` doctype in the social contract: `postId` refersTo post with `propertyAgreement: {recipient: 'author'}`, `amount` integer, `summable: 'amount'` + `rankedSummable` on `[postId]` and `[recipient]` → per-post totals, per-creator totals, "most tipped" leaderboard. Amount is still self-reported (no transition id from the SDK to cross-check).
2. Tip in YAPP via `tokens.transfer` with the token's transfer history enabled; the transfer itself is the record. Needs a history query surface check.
3. Atomic pay-to-referenced-owner remains an upstream ask.

### 3.9 Profile, DPNS, keys

- Retire the duplicate `profile` doctype path (`profile-service.ts` targets the social contract; the unified service targets the profile contract); fold profile into the social contract at the next clean deploy, as discussed in August.
- `getUserStats` stubs return zeros; wire the existing count-tree follower counts or delete them.
- `authVault`/`vault`: `documentsKeepHistory: true` (with `canBeDeleted: false`) so a bad bundle overwrite is recoverable via `documents.history`. `countable` on `authVaultAccess [$ownerId, kind, status]` for `countActivePasskeys`. Delete the callerless full-table scan `getAllActivePasskeyAccesses`.
- ~~`loginKeyResponse`: make the QR handshake doctype indexOnly with a timeRange index carrying `ttl`, so responses self-expire.~~ **Tried and dropped (2026-09-18).** An indexOnly document cannot self-expire: IN_TIME_RANGE document reads are refused on indexOnly types and raw where-clauses never route to a bucketed index, so the payload has to live in a permanent index anyway and the TTL only buys an aggregate. Measured on moutai: one response cost 93.8M credits on the indexOnly cut against 66.3M on the stored v2 contract (+42%), with no storage refund to offset it. v2 stays.
- Scoped app keys (beta.1): a wallet-granted AUTHENTICATION key bound to the Yappr contract group with `totalBudget` and `expiresAt` is the right long-term login primitive ("this app may spend up to X credits until date Y on Yappr only"). Blocked on wasm-sdk key-creation options; worth filing.

### 3.10 Notifications and badges

With `countable` flags on `storeOrder.sellerOrders`, `storeReview.sellerReviews`,
`blogComment [blogPostOwnerId]` (new index), `conversationInvite.inbox` and
`directMessage.conversation`, each badge is a count since a timestamp
instead of a document page, and the seven-source social composite can gain
order/review/comment/DM siblings. `orderStatusUpdate` lacks a buyer key; a
`buyerId` copied under `propertyAgreement` from the order fixes that.

### 3.11 Token economics beyond the social contract

- Price spam-prone writes with YAPP via `tokenCost.create` + `contractId` pointing at the social contract: `storeReview`, `blogComment`, `vote`, `conversationInvite`. Every priced doctype must be added to `YAPP_TOKEN_COSTS` in `lib/constants.ts` or creates are rejected.
- Sponsored writes: `gasFeesPaidBy: 1` lets a store owner pay gas for customer reviews.
- Sellable documents: `tradeMode: 1` + `transferable: 1` on a `collectible` or `ticket` doctype with `keepsPurchaseHistory` gives an atomic marketplace with a provable sale history, which nothing in Yappr exercises.

## 4. Not possible at 4.2 (do not design around)

- ~~Binding `$ownerId` through `propertyAgreement`; buyer/reviewer identity stays poster-attested.~~ **Shipped in beta.2** — this is what the 2026-09-18 re-cut adopts.
- Consensus-enforced poll expiry, stock decrement on another owner's document, or any cross-owner mutation.
- Pay-to-referenced-owner token effect; two-party atomic transitions (batch cap is one document transition).
- Ranked reads with an arbitrary pin set ("top stores among those I follow").
- Unique indexes on indexOnly types; MIN/MAX; multi-clause HAVING; cursors on ranked/having/composite.
- Creating budgeted or contract-bound authentication keys from the JS SDK.
- Adding index flags to a live contract; every change above is a re-cut.

## 5. Suggested sequencing (as planned; items 2-6 are built)

1. **Client-only wins, no re-cut** (days): `in`-batched order status and review-exists lookups; `$id in` store batch on order pages; blog edit history UI; delete dead vault scan; wire or drop `getUserStats`; snapshot the live DM schema into `contracts/`.
2. **Storefront v2 re-cut** (the "average tree" milestone): review average/count/distribution/ranked indexes, `refersTo` chain across store → item → order → status/review, countable order indexes, composite store and order pages. Battery script in the style of `scripts/verify-v5.mjs`.
3. **Blog v2 re-cut**: countable comments/followers, ranked discovery, refersTo, edit history surfaced, composite blog home.
4. **DM v4 re-cut**: countable unread, refersTo recipient/key, re-test contract-bound decryption keys.
5. **Pollr v4** (separate repo): refersTo, indexOnly preallocated ballots, ranked winner, trending polls.
6. **Tips**: indexOnly `tip` with sum axes in the next social cut, or YAPP transfer tips; file the pay-referenced-owner ask upstream with the superchat use case.
7. **Scoped session keys**: file the wasm-sdk gap; prototype through rs-sdk.
