# Non-social contracts: storefront, blog, DM, pollr, tips

The four feature contracts outside the social graph, re-cut for **Platform
4.2.0-beta.2 / protocol 14**, plus YAPP tipping (which needs no contract of its
own). Each JSON in `contracts/` is the source of record; `docs/` carries no
per-contract file any more.

All four are registered on the **moutai devnet** (2026-09-18), alongside social
v7 `7R7vo8DE2pka17wAgXMnUMWpSox2z8eaLLdZNYJcWraG` whose YAPP token prices the
doctypes that cost YAPP:

| Contract | moutai devnet id |
| --- | --- |
| storefront | `6D1UPEqaYDwrnzy7c7STbMM6HBmksbp3zzMgSqr68Bi1` |
| blog | `G2SebukaFvvgBWS1Q61Me8sWc3TMzAhXt2QvAktuYvvf` |
| DM | `HBwg5hptWu1Ppgi9NadLad8cAYHHoQjHpUUb1t5w4cjF` |
| pollr | `7qVgjaNoZexX5xioVgVF8aZh1RsZv7hqtuXGhLtGT9n2` |

**Testnet and production still run the previous cuts**, which is why every
client path is selected at runtime by a topology env var
(`NEXT_PUBLIC_{STOREFRONT,BLOG,DM,POLLR}_TOPOLOGY`, resolved in
`lib/constants.ts`) and why the old-topology code cannot be deleted yet.
Repointing a contract id orphans the documents in the old one — references
cannot cross contracts — so a re-cut is a fresh start, not a migration.

Note for anything writing to the social contract: **v7 removed `post.author`**
and sets `additionalProperties: false`, so a write still carrying it is rejected
with *"Additional properties are not allowed ('author' was unexpected)"*, and
`hashtag` must be omitted entirely rather than sent as `''` when untagged.

## Deploy and verify

```bash
# Inspect what will be registered (offline, full wasm validation; prints
# indexes, references, token costs and the parsed immutable lists).
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --dry-run

# Publish under a seed persona (or --bot <n> --owner <id>).
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --persona 260

# Live batteries (each also takes --self-test, which runs offline and asserts
# the checked-in JSON still declares every rule the battery relies on).
# --moderator names the contract's owner or an appointed moderator:
# maker, personal (ledger persona 900) or a persona index.
NETWORK=devnet node scripts/verify-storefront.mjs [--moderator maker]
NETWORK=devnet node scripts/verify-blog.mjs [--moderator 260]
NETWORK=devnet node scripts/verify-dm.mjs
# On the reusable pollr-test contract (--register-test-contract the first time
# on a network, or after pollr-contract.json changes); --live-contract for the
# published one. Storefront, blog and live pollr runs clean up after themselves
# (docs/TESTING.md "Test content on the public devnet").
NETWORK=devnet node scripts/verify-pollr.mjs
# YAPP tips (t1-t5) where YAPP is transferable; credit tips (c1-c2) where the
# social contract locks YAPP (v10).
NETWORK=devnet node scripts/verify-tips.mjs [--tipper 240] [--creator 241] [--amount 5] [--credits 100000000]

# Seed browsable content (deterministic and resumable; --dry-run is offline).
NETWORK=devnet node scripts/seed/seed-non-social.mjs --which storefront|blog|dm|pollr|tips
```

Contracts priced in YAPP name the **social** contract in
`tokenCost.create.contractId`; the registration script substitutes the
`SOCIAL_CONTRACT_ID` placeholder with its 32-byte array form, so the social
contract id is an input to every registration.

---

## Storefront

`contracts/yappr-storefront-contract.json` — `store`, `storeItem`,
`shippingZone`, `itemDeliverable`, `storeOrder`, `orderStatusUpdate`,
`orderDelivery`, `storeReview`, `itemReview`, `savedAddress`. Client gate:
`NEXT_PUBLIC_STOREFRONT_TOPOLOGY` (`v1`–`v10`, resolved in `lib/constants.ts`).
**The file is storefront v10**, the testnet production cut ([STOREFRONT_V10.md](../STOREFRONT_V10.md)): v9 with the order tracking and the seller's note sealed to the order instead of plaintext, a store's items listed by status, https/ipfs-only item images and a `report` type. v9 is v8 plus `storeItem.shippingZoneIds`, the store zones an item ships under ([STOREFRONT_V9.md](../STOREFRONT_V9.md)), an update a registered v8 contract takes in place; `/devnet` runs v9. v8 is the 5.0.0-beta.5 re-cut (below, [PLATFORM_V5_BETA5_UPGRADE.md](PLATFORM_V5_BETA5_UPGRADE.md)). v7 is v6 (below) with `storeItem.variants` as a typed
table instead of a JSON string, and up to 12 image URLs per item
([STOREFRONT_V7.md](STOREFRONT_V7.md)). v6, the 5.0.0-beta.2 mainnet-ready cut
that also carries digital products (docs/DIGITAL_PRODUCTS.md, PR #638), was
registered on sakura as `5qh1gpJY36bkEXb4PMPJ2E1VhRxZZ796FHFGWu3oCmhk` after
the 2026-10-08 beta.3 wipe ([SAKURA_BETA3_DEPLOY.md](SAKURA_BETA3_DEPLOY.md));
its stores and items are abandoned with the v7 cut (no migration). v7 is live
on sakura as `2P2KqWzZXqULWMD1e2tL1dr67YAjNqUTP8cyNGkekzdz` (maker nonce 12,
2026-10-09) and serves `/devnet`.

| Doctype | Shape | Serves |
| --- | --- | --- |
| `store` | `canBeDeleted: false` (`closed` is the tombstone), `moderatorAbilities.delete`; required `category` slug; `byStatus [status, $createdAt]`; `byCategory [status, category, $createdAt]` rangeCountable, ranked at `category`; 1000M action fee | "newest stores", per-category newest, "top categories"; moderatedDocument target |
| `storeItem` | `canBeDeleted: false`, `moderatorAbilities.delete`; `storeId`→store (moderatedDocument) **writer-gated**; `immutable [storeId]`; `fulfillment` (`shipped`/`digital`); v9 `shippingZoneIds` (1–16 unique zone ids, no reference; absent = every zone); v7 `variants` table (options with stable ids, a byte-array selector and a price per combination, optional stock/SKU/weight/image lists; 9 alignment rules); 50M action fee | item reviews, ghost-store rejection, seller-only listings, variant pickers |
| `shippingZone` | `storeId`→store (moderatedDocument) **writer-gated**; `immutable [storeId]` | seller-only zones |
| `itemDeliverable` | one per item; `itemId`→storeItem (moderatedDocument) **writer-gated**; `immutable [itemId]`; seller-encrypted kit (≤ 5,120 B) | digital products |
| `storeOrder` | permanent; `storeId`→store `{$ownerId: sellerId, status: {const: active}}` (v8); `sellerId` distinctFrom `$ownerId`; `buyerOrders [$ownerId, $createdAt]` rangeCountable; `storeOrders [storeId, $createdAt]` rangeCountable, ranked at `storeId`; payload ≤ 5,120 B | buyer and seller order lists and counts, "most ordered stores" |
| `orderStatusUpdate` | `orderId`→storeOrder **writer-gated to the seller**; neither deletable nor mutable; `buyerFeed [orderId.$ownerId, $createdAt]` (derived) | the order's history; buyer notifications carrying only the seller's updates |
| `orderDelivery` | `orderId`→storeOrder **writer-gated to the seller**; permanent, append-only; `buyerDeliveries [orderId.$ownerId, $createdAt]` (derived); payload ≤ 5,120 B | encrypted digital delivery, buyer library |
| `storeReview` | `orderId`→storeOrder **writer-gated to the buyer**; `storeRating` avg ranked; `storeRatingDistribution` grouped count; 16M action fee | averages, distribution, top rated |
| `itemReview` | one per (order, item); `itemId`→storeItem `{storeId}`; `orderId` **writer-gated**; `storeItemRating [storeId, itemId]` avg+count, avg ranked; 8M action fee | item averages and counts within a store, top items in a store |

### What v10 changed (from v9)

- **No plaintext on a status update**: `orderStatusUpdate` drops `trackingNumber`, `trackingCarrier` and `message` and carries them as an optional note sealed to the order (`encryptedPayload` ≤ 2,560 B + `nonce`, rule `sealed`), keyed like `orderDelivery`. `buyerFeed` stays.
- **`storeItem.storeStatusAndTime [storeId, status, $createdAt]`**: a store's active items without reading the rest.
- **`storeItem.imageUrls`** take `https://` or `ipfs://` only.
- **Reports**: a `report` type (store, listing, store review or item review) the storefront's moderators resolve, as social's. Signed size 18,704 B (v9 16,522 B). See [STOREFRONT_V10.md](../STOREFRONT_V10.md).

### What v9 changed (from v8)

- **An item may name the store zones it ships under**: `storeItem.shippingZoneIds`, 1–16 unique identifiers at position 16, optional, with no `refersTo` (a zone delete must never make an item unwritable; the client ignores ids that are not the store's zones). Checkout prices each zone's lines as their own shipment; the inventory CSV carries a `Shipping Zones` column. Signed size 16,522 B (v8 16,315 B). See [STOREFRONT_V9.md](../STOREFRONT_V9.md).

### What v8 changed (from v7)

- **An order's store must be active through a `where` condition**: `storeId.where.status: {"const": "active"}` (5.0.0-beta.5). `storeOrder.storeStatus`, the copy of the store's status, and its `storeIsOpen` rule are gone. An order at a paused or closed store is 40127 (v7: 10422 `storeIsOpen`, or 40127 on a stale copy). The client writes no `storeStatus` on v8 and says "This store isn't taking orders right now". Signed size 16,316 B (v7 16,606 B).

### What v7 changed (from v6)

- **Variants are a typed table** (`storeItem.variants`, an object of parallel
  lists). Options have stable ids, and a combination is one byte-array
  selector (an option id per axis) with its price and, optionally, its stock,
  SKU, weight and image index. The table holds up to 5 axes, 64 options and
  256 combinations; the real cap is the 20,480-byte transition, which the
  client checks before signing.
  - The JSON schema requires the core lists and keeps option ids and
    selectors unique (10101).
  - Rules keep the lists aligned and a variant item free of `basePrice` and
    `stockQuantity` (`onePrice`, `oneStock`, `optionTable`, `comboTable`,
    `comboStocks`, `comboSkus`, `comboWeights`, `comboImages`, all 10422).
- **Carts, orders and kits name a variant by its canonical id**, the sorted
  option-id set ("3.9"). Orders carry a label and SKU snapshot. A digital
  asset targets an option-id subset.
- **`imageUrls` holds up to 12** (a combination names one by index).
- **Descriptions** are omitted on the new members and cut to 120 characters
  elsewhere: 17,661 B serialized, about 17,768 B signed.
- The seller's 7 × 2 listing that outgrew v6's 5,120-byte JSON (3,582 B as
  imported) stores in 469 B. A 5-axis, 100-combination listing (9,669 B of
  JSON, which v6 could not hold) stores in 2,942 B.

Full design, live checks and fees: [STOREFRONT_V7.md](STOREFRONT_V7.md).

### What v6 changed (from v5)

- **Moderation is elected** per contract, exactly as blog v7 and social v13:
  `seatContestable`, a 30-day `challengeCoolDown`, a 7-day join window and a
  3-day vote window, `maxAddedModerators: 10`, `ownerProtected`. The file's
  interim team is the contract owner; registration picks the network's interim
  (`withInterim` in `scripts/register-lib.mjs`): devnet keeps the owner,
  mainnet registers `notYetUsable`, and `--interim <kind>` overrides it.
- **Stores and items are moderator-deletable** (`moderatorAbilities.delete`;
  their owners still cannot delete them), so every reference at them is a
  `moderatedDocument` reference, #638's `itemDeliverable.itemId` included.
  After a takedown the reference resolves to the removal record.
- **No YAPP.** The review `tokenCost` is gone (so is the `SOCIAL_CONTRACT_ID`
  placeholder). Creates of `store` (1000M credits, about 60¢ at $60/DASH),
  `storeItem` (50M), `storeReview` (16M) and `itemReview` (8M) pay a
  `feeMultiplier` moderators fee and must carry an `$actionFeeAgreement`
  naming exactly that (40132 without one, 40133 for another amount). The
  client reads the amounts off the committed JSON
  (`lib/storefront/storefront-contract.ts`) and the write path attaches the
  agreement (`declaredActionFeeFor` in `lib/transition-agreements.ts`). Orders,
  status updates, deliveries, kits, shipping zones, saved addresses and every
  edit are unpriced.
- **No self-orders.** `storeOrder.sellerId` is distinctFrom `$ownerId`
  (10419), so a seller cannot pad their order counts or reach the review step
  on their own store. The client never offers it (cart, item page and
  checkout say why).
- **No stored buyer.** `orderStatusUpdate.buyerId` and `orderDelivery.buyerId`
  are gone; `buyerFeed` and `buyerDeliveries` index `orderId.$ownerId`, read
  through the order (a cursor walk must pin it with `==`). Status updates are
  now undeletable as well as immutable: an order's updates ARE its history.
- **Store categories.** `store.category` is required: a free-form lowercase
  slug (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 20 characters; the form normalises
  "Vintage Clothing" to `vintage-clothing`). `byStatus` lists the newest
  active stores in one query (replacing the owner-order scan the app sorted
  client-side), `byCategory` the newest in one category, and its ranked count
  at `category` with `status` pinned is "top categories" in one proved query.
- **Seller lists and counts ride `storeId`** (one store per owner):
  `sellerOrders`, `sellerOrderCount` and `storeOrderCount` are gone, and
  `storeOrders` is rangeCountable and ranked at `storeId`. `buyerOrderCount`
  folds into `buyerOrders` (rangeCountable).
- **Item ratings only per store.** `itemRating [itemId]` is gone; an item's
  average and count read `storeItemRating` with its store pinned. There is no
  global "top items" ranking any more.
- **Dropped:** `storeItem.ownerAndTime`/`statusAndTime`/`categoryAndTime`,
  `orderStatusUpdate.sellerStatusUpdates`, `storeReview.sellerReviews`/
  `buyerReviews`/`sellerRating`, `itemReview.buyerItemReviews`, and the
  ranked count on `storeRating` ("most reviewed stores").
- **Bounds.** Encrypted payloads (order, kit, delivery) cap at 5,120 B, and
  `variants` (still a JSON string on v6) at 5,120 characters and bytes; the
  client refuses either before signing (checkout, add-item, CSV import). Logo and banner URLs must be
  https:// or ipfs://; currencies are free text of at most 10 characters;
  prices may reach 2^53−1 and weight and stock are u32; `fulfillment` is at
  most 7 characters.
- **Label.** A review on chain proves its author placed the order, not that
  it was paid or delivered, so the badge reads "Ordered", not "Verified
  purchase".

### Earlier cuts

v5 (beta.7) added `storeOrder.storeStatus` (QA D-25: only an active store
takes orders, `storeIsOpen`); v4 (beta.4) a warning list, typed
`tags`/`imageUrls` arrays and `storeReview.sellerId` distinct from the
reviewer; v3 (beta.3) moderator-deletable reviews; v2 (beta.2) the rating
trees and writer gates below. v2–v5 priced reviews in YAPP from the social
contract (3 for a store review, 1 for an item review), copied `buyerId` into
status updates, kept per-seller indexes beside the store ones, and had no
category: discovery scanned stores in owner order.

**Writer gates.** beta.2 lets the *referring* side of a `propertyAgreement` be
`$ownerId`, which turns a reference into a gate: only the identity the
referenced document names may create — or replace — the referring document.
Checked on create and on every replace, so it cannot be slipped past by writing
first and editing later. The four declarations are
`storeItem.storeId`/`shippingZone.storeId` → `{$ownerId: $ownerId}` (only a
store's owner lists under it), `orderStatusUpdate.orderId` → `{$ownerId:
sellerId}` (only the seller posts a status), `storeReview.orderId`/
`itemReview.orderId` → `{$ownerId: $ownerId}` (only the buyer reviews), and
`storeOrder.storeId` → `{sellerId: $ownerId}` (`sellerId` is the store's real
owner).

Consequences the client no longer enforces: every review on chain comes from
the order's buyer; a stranger cannot burn an order's single review slot; `getLatestStatus`
is one row rather than a walk through pages of spoofable updates; and the
attested copies `storeOrder.buyerId`, `orderStatusUpdate.sellerId` and
`storeReview.buyerId`/`itemReview.buyerId` are gone.

```js
// Store average: {count, sum}; the client divides.
sdk.documents.average({ dataContractId, documentTypeName: 'storeReview',
  where: [['storeId', '==', S]] }, 'rating')
// 1..5 distribution in one call (keys are hex of 0x80 + rating).
sdk.documents.count({ dataContractId, documentTypeName: 'storeReview',
  where: [['storeId', '==', S], ['rating', 'in', [1,2,3,4,5]]], groupBy: ['rating'] })
// Top stores by average (`value / valueScale`). Same grammar with
// aggregate {type:'count'} on storeOrder = most ordered stores; on itemReview
// with groupBy 'itemId' + where storeId = top items in one store.
sdk.documents.ranked({ dataContractId, documentTypeName: 'storeReview',
  groupBy: 'storeId', aggregate: { type: 'avg', property: 'rating' }, limit: 20 })
// v6: top categories among active stores, and the newest in one category.
sdk.documents.ranked({ dataContractId, documentTypeName: 'store',
  where: [['status', '==', 'active']], groupBy: 'category', aggregate: { type: 'count' }, limit: 20 })
sdk.documents.query({ dataContractId, documentTypeName: 'store',
  where: [['status', '==', 'active'], ['category', '==', 'books']],
  orderBy: [['status', 'asc'], ['category', 'asc'], ['$createdAt', 'desc']], limit: 50 })
// v6: an item's average and the per-item counts pin the store (storeItemRating).
sdk.documents.average({ dataContractId, documentTypeName: 'itemReview',
  where: [['storeId', '==', S], ['itemId', '==', I]] }, 'rating')
// v6: the buyer's library (and status feed) through the order's owner.
sdk.documents.query({ dataContractId, documentTypeName: 'orderDelivery',
  where: [['orderId.$ownerId', '==', me]], orderBy: [['orderId.$ownerId', 'asc'], ['$createdAt', 'asc']], limit: 100 })
// documents.having takes the same shape plus having:{operator:'>=',value:3}.
// Buyer orders page in one proof: orders + store join + review-exists + status.
sdk.documents.composite({ dataContractId, documentType: 'storeOrder',
  where: [['$ownerId', '==', me]], orderBy: [['$createdAt', 'desc']], limit: 50,
  subQueries: [
    { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } },
    { documentType: 'storeReview', bind: { sourceProperty: '$id', field: 'orderId' } },
    { documentType: 'orderStatusUpdate', bind: { sourceProperty: '$id', field: 'orderId' }, limit: 100 },
  ] })
```

Cold-load DAPI budgets: `/store` directory 1 + 50 review scans → 1 + 50 averages
(6 at a time; v6 replaces the up-to-10-query owner scan with one `byStatus`
page, plus one ranked read for the category picker); `/store/view` ≥ 7 +
⌈reviews/100⌉ → 7 fixed; `/orders` 1 + 4N → 1 composite + N decrypts;
`/orders/seller` 1 + 2N → 1 + ⌈N/100⌉ + 1 DPNS batch (v6: + 1 store lookup);
manage badge 1 capped (wrong) page → 1 count.

Not adopted: sums of order amounts (orders are encrypted to the seller, so there
is no plaintext amount — order counts rank stores instead); stock decrement on
purchase; buyer-initiated status updates, which would need a second doctype
gated the other way rather than a loosened gate; `immutable` on
`store`/`savedAddress`, every property of which the owner edits.

---

## Blog

`contracts/yappr-blog-contract.json` — `blog`, `blogPost`, `blogComment`,
`blogFollow`, and from v9 `report`. Client gate: `NEXT_PUBLIC_BLOG_TOPOLOGY` (`v1`–`v9`, resolved
in `lib/constants.ts` at call time so unit tests can stub it). **The file is
blog v9**, the testnet production cut ([below](#what-v9-changed-from-v8-1)). Blog v8, the 5.0.0-beta.5 re-cut (below, [PLATFORM_V5_BETA5_UPGRADE.md](PLATFORM_V5_BETA5_UPGRADE.md)), runs `/devnet` on sakura's beta.6 genesis. v7, the 5.0.0-beta.2 mainnet-ready cut, is registered on sakura as
`4F1Wi4dim7j6eWrFQ3aHWEB9az5dHcJBmdvMvpx7sx1j` (re-registered after the
2026-10-08 beta.3 wipe); `/devnet` runs it ([SAKURA_BETA3_DEPLOY.md](SAKURA_BETA3_DEPLOY.md)).

| Doctype | Shape | Serves |
| --- | --- | --- |
| `blog` | `canBeDeleted: true`, `moderatorAbilities.delete`; `timeline [$createdAt]`; 80M action fee | "new blogs" newest first; deletableDocument target |
| `blogPost` | `blogId`→blog (deletableDocument, only the blog's owner posts); `timeline [live, $createdAt]`; `immutable [blogId, {publishedAt when present}, {deleted when present}]`; the tombstone rules; `retractedWhen {present: deleted}`; 80M action fee | "latest posts" across blogs; an author's delete (a tombstone) |
| `blogComment` | `blogPostId`→blogPost (moderatedDocument, `where {commentsEnabled: {notEqual: {const: false}}}` on v8); `postAndTime [blogPostId, $createdAt]` rangeCountable; `postOwnerAndTime [blogPostId.$ownerId, $createdAt]`; ranked `discussedRecent [$createdAt, blogPostId]` (72h window, a new one every 24h, 7-day ttl); 16M action fee | comment lists and exact counts, "most discussed (3 days)", unforgeable "comments on my posts" |
| `blogFollow` | `blogId`→blog (deletableDocument); unique `ownerAndBlog`; `followers [blogId, $createdAt]` rangeCountable, ranked at `blogId`; ranked `followersTrend [$createdAt, blogId]` (72h / 24h / 7-day ttl) | a reader's follows, exact follower counts, "most followed", "trending (3 days)" |

### What v9 changed (from v8)

The testnet production cut (R-S2, R-S3, D14 and the owner's decision to take reports), registered fresh on testnet with social v17 ([SOCIAL_V17.md](../SOCIAL_V17.md)):

- **Owner amendments (2026-10-17)**: a blog's author can delete the blog; its posts remain stored, but its public page becomes unavailable and discovery omits posts whose blog is missing. `blogPost.blogId`, `blogFollow.blogId` and `report.blogId` use `deletableDocument`; the post's author gate stays. Blog posts and comments have social v17's seven-day moderation window and settled deletion (`leader: true, approvals: 3`). Removal records keep the parent id and `$createdAt`. Storefront is unchanged. See [BLOG_V9.md](../BLOG_V9.md) for the reference rules and live proof.
- **Owner access after deletion:** v9 restores `blogPost.ownerAndTime` as `[$ownerId, live, $createdAt]` with `skipIfAbsent`, and `blogComment.ownerAndTime` as `[$ownerId, $createdAt]`. The **My posts** pane can list and retract an author’s posts without a parent blog. Cleanup reads the comment owner index directly, including comments on third-party tombstoned posts.
- **A live marker** (R-S2): `blogPost.live` (`const: true`, position 13) with social's rule (`countPresent(deleted, live) == 1`) and freeze (`{property: live, when: {absent: deleted}}`). `blogPost.timeline` is `[live, $createdAt]` and `blogAndTime` `[live, blogId, $createdAt]`, both `skipIfAbsent`: an author's tombstone and a moderator's removal leave "latest posts" and the blog's own page. Every read pins `live == true` (an unpinned one is refused); `blogAndSlug` still finds a tombstone, so its URL keeps resolving to a "deleted" stub.
- **`publishedAt` is required**: there are no drafts on chain (Yappr always wrote it; drafts stay on the device). It is now frozen outright, and `publishedNotAhead` has no absent case. Creation order is publication order, so the timeline stays on `$createdAt`: a backdated import keeps its date on the post but is listed when it arrived.
- **Byte caps** (R-S3, 3 bytes a character for text, so a full-length CJK value fits): `blog.name` 192 B, `description` 768 B, `blogPost.title` 384 B, `subtitle` 768 B, `blogComment.content` 1,500 B; the image URLs 256 B (already `https`/`ipfs` only).
- **Reports**: a `report` type mirroring social's: exactly one of `blogId` (`deletableDocument`), `blogPostId` (`moderatedDocument`) or `blogCommentId` (`deletableDocument`: a comment is owner-deletable), `targetOwnerId` checked against it (40127) and never the reporter (10419), `reason` 0–31 (8 needs a `note`), moderator-only `status`/`resolution`, withdrawable only while unresolved (40147), a 90-day `ttl`, a 50M moderators fee, one per reporter and target (`byBlog`, `byPost`, `byComment`). It joins `moderatedDocumentTypes` (`deleteDocuments`, `changeDocumentFields`).
- Client (`blogIsV9()`): a post is written with `live: true` and keeps it through an edit; the tombstone drops it; the timeline and a blog's listing pin it. Below v9 nothing changes, and the registered v8 contract's moderation answers leave `report` out. The report form and queue are WP4 (`moderatedContract('blog').reportTargets()` is their plumbing).
- Signed size after the owner amendments: 9,247 B (original v9 8,852 B; v8 6,658 B). Registration 38.00e9 by the fee table (5 types, 18 indexes); 38.405e9 measured on sakura (2,304.3¢).
- **Proved on sakura** (throwaway `BPY9ctr6CeJhix8y7jN5sv6DDXyVje5kuA7kKYgDzxRX`, 2026-10-17, every case as expected): a blog 148.6M (incl. the 80M action fee); posts 169.7M / 137.8M; a post without `publishedAt` refused 10101, without `live` 10422, with an `http://` cover 10101; a tombstone (refund 29.9M) leaves the timeline and the blog page, and the slug lookup still finds it; unpinned timeline refused; a comment 86.4M; reports of a post and of the blog 60.5M / 60.4M (incl. 50M); a second report of the post refused 40105; "something else" without a note 10422; reporting one's own comment 10419; naming the wrong owner 40127; the interim moderator's resolution 4.3M; withdrawing it afterwards refused 40147, a pending one withdrawn (3.6M).

### What v8 changed (from v7)

- **Comments-off is a `where` condition**: `blogPostId.where.commentsEnabled: {"notEqual": {"const": false}}` (5.0.0-beta.5). `blogComment.postCommentsEnabled`, the copy of the post's flag, and its `commentsOpen` rule are gone. A post that leaves the flag out or sets it true takes comments; one with comments off (a tombstone included) refuses them with 40127 (v7: 10422 `commentsOpen`). The client sends neither copy nor pre-read on v8. Signed size 6,659 B (v7 6,756 B).

### What v7 changed (from v6)

- **Moderation is elected** per contract: `seatContestable`, a 30-day
  `challengeCoolDown`, a 7-day join window and a 3-day vote window,
  `maxAddedModerators: 10` and `ownerProtected`. The file declares the
  contract owner as the interim team, and registration picks the network's
  interim the way social v13 does (`withInterim` in `scripts/register-lib.mjs`):
  devnet keeps the owner, mainnet registers `notYetUsable` (nobody moderates
  and the moderated types stay closed until a team is seated), and
  `--interim <kind>` overrides it.
- **No YAPP.** The comment `tokenCost` is gone (so is the `SOCIAL_CONTRACT_ID`
  placeholder). Creates of `blog` (80M), `blogPost` (80M) and `blogComment`
  (16M) pay a `feeMultiplier` moderators fee and must carry an
  `$actionFeeAgreement` naming exactly that (40132 without one, 40133 for
  another amount). The client reads the amounts off the committed JSON
  (`lib/blog/blog-contract.ts`) and the write path attaches the agreement
  like it does for social posts (`declaredActionFeeFor` in
  `lib/transition-agreements.ts`). Follows, edits and deletes are unpriced.
- **Timelines.** `blog.timeline` and `blogPost.timeline [$createdAt]` list new
  blogs and the latest posts everywhere in one query per page, replacing the
  owner-order scan the app sorted client-side.
- **Merged count twins.** `commentCount` folds into `postAndTime`
  (rangeCountable) and `followerCount` into `followers` (rangeCountable,
  ranked at `blogId`). The app's count queries do not change: a `blogPostId ==`
  or `blogId ==` pin is the index's prefix total, and the grouped `in` count
  serves a post list as before.
- **Windows.** `followersByDay` (a daily grid) becomes `followersTrend`, and
  `discussedRecent` ranks posts by comments, both on a 72h window stepping
  every 24h, read with `selector: 'oldest'` so a page covers ~48–72h. There is
  no all-time comment ranking any more.
- **Dropped in v7 (the post/comment owner indexes return in v9 above):** `blogPost.ownerAndTime`, `blogComment.ownerAndTime`,
  `blogFollow.following` (a reader's follows ride `ownerAndBlog`).
- **Post tombstone.** An author deletes a post by replacing it with
  `{ deleted: true, commentsEnabled: false }` plus `blogId`, `slug` and
  `publishedAt` (`tombstoneIsBlank` requires `commentsEnabled` present and
  false and every content field absent; `hasBody` requires a live post to
  carry a title and a body). `deleted` is frozen once set, so a tombstone
  cannot be undone or refilled. `retractedWhen` lets a banned or suspended
  author still write it, and nothing else. The slug stays taken and the link
  resolves to "this post was deleted"; a comment on it is refused
  (`commentsOpen`, or 40127 for a lying copy).
- **Bounds.** `publishedAt` may run at most 10 minutes past `$updatedAt`
  (`publishedNotAhead`; `$updatedAt` is required), so a backdated import is
  fine and a post dated into the future is refused. The slug pattern is
  `lib/utils/slug.ts`'s, and avatar, header and cover URLs must be https://
  or ipfs://.

### Earlier cuts

v6 (5.0.0-beta.1) was v5 in the 5.0 grammar: `moderatedDocument` references,
a conditional `immutable` entry for `publishedAt`, and no copied
`blogPostOwnerId` (`postOwnerAndTime` derives the post's owner through
`blogPostId`); see [PLATFORM_V5_BETA1_UPGRADE.md](PLATFORM_V5_BETA1_UPGRADE.md).
v5 (beta.6) copied `commentsEnabled` into comments and gated posting to the
blog's owner; v4 (beta.4) added a warning list and typed `labels` arrays; v3
(beta.3) was the moderated cut, which dropped `documentsKeepHistory` (Drive
refuses moderator deletes on a history-keeping type), so `$revision > 1`
still marks an edited post but no earlier revision is stored. v2–v6 priced a
comment at 1 YAPP from the social contract, kept count-only twins
(`commentCount`, `followerCount`) and a daily `followersByDay`, and had no
timeline: discovery paged blogs in owner order and sorted them client-side.

`blogPost` carries no `author`: the author IS `$ownerId`. Up to v5 a comment
copied it into `blogPostOwnerId`, bound to the referenced post's `$ownerId`
(40127); from v6 `postOwnerAndTime` indexes `blogPostId.$ownerId`, read from
the post itself. Either way that index is safe to read as a notification
source, and a comment on a post that does not exist is impossible (40120).
`blog-comment-service.ts` still reads the post before commenting, to copy its
`commentsEnabled` and to refuse a closed or deleted post before signing. There
is deliberately **no writer gate** on comments: anyone may comment on anyone's
post.

```js
// Comment count for one post, and for a whole post list in one request
// (v7: the postAndTime prefix total; v2–v6: commentCount).
sdk.documents.count({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId', '==', P]] })
sdk.documents.count({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId', 'in', [P1, P2]]], groupBy: ['blogPostId'] })
// Most followed blogs (all time), and trending (3 days) on v7.
sdk.documents.ranked({ dataContractId, documentTypeName: 'blogFollow',
  groupBy: 'blogId', aggregate: { type: 'count' }, direction: 'desc', limit: 20,
  timeRange: [{ field: '$createdAt', selector: 'oldest', grid: { range: 259200, step: 86400 } }] })
// Most discussed posts (3 days): the same shape on blogComment / blogPostId.
// The latest posts everywhere, and the newest blogs (v7 timelines).
sdk.documents.query({ dataContractId, documentTypeName: 'blogPost',
  where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']], limit: 20 })
// The blogs a reader follows (v7: ownerAndBlog; v2–v6: following).
sdk.documents.query({ dataContractId, documentTypeName: 'blogFollow',
  where: [['$ownerId', '==', me]], orderBy: [['$ownerId', 'asc'], ['blogId', 'asc']] })
// Comments on my posts since last seen (notification source; v2-v5 name the
// copied 'blogPostOwnerId' instead of the derived 'blogPostId.$ownerId').
sdk.documents.query({ dataContractId, documentTypeName: 'blogComment',
  where: [['blogPostId.$ownerId', '==', me], ['$createdAt', '>', lastSeen]],
  orderBy: [['blogPostId.$ownerId', 'asc'], ['$createdAt', 'desc']], limit: 100 })
```

Client surfaces on v7: `/blog` discovery gains a Blogs / Posts switch. Blogs
lists Newest (paged on `blog.timeline`), Most followed and Trending (3 days);
Posts lists Latest posts (paged on `blogPost.timeline`) and Most discussed
(3 days). Explore's blog tab reads the post timeline directly. An author's
dashboard has a Delete action on each post (the tombstone); readers see a
deleted post's link as "this post was deleted", with no comments.

Validation: `node scripts/validate-contract-offline.mjs
contracts/yappr-blog-contract.json --network mainnet --cost` (create size
~7,010 B signed; documentCreateCost blog 248.5M, blogPost 492.6M, blogComment
90.6M, blogFollow 72.6M credits for new index values), `--constraints` for the
tombstone and `publishedNotAhead` cases (`scripts/property-constraint-cases.mjs`),
and `node scripts/verify-blog.mjs --self-test`. The live battery adds b9 (a
wrong fee amount), b22 (the tombstone), b23 (a banned author's retraction) and
b24 (a comment on a tombstone); it has not been run, since v7 is not
registered. `scripts/seed/non-social/blog.mjs` still seeds the v6 shape (YAPP
comments, `commentCount`), and needs the same agreement plumbing before it can
seed a v7 contract.

---

## Direct messages

`contracts/yappr-dm-contract.json` — `conversationInvite`, `directMessage`,
`readReceipt`. Client gate: `NEXT_PUBLIC_DM_TOPOLOGY=v4`.

**DMs must stay cheap**, and that constraint — not a lack of ideas — is what
makes this the smallest re-cut: two additive flags, no new doctypes, no ranked
or timeRange indexes, no indexOnly rewrite, no token costs. Deliberately not
adopted for the same reason: `refersTo`/`propertyAgreement` on
`directMessage`/`readReceipt` (a read per write on the hottest path), ranked and
`timeRange` indexes, an ephemeral `presence` doctype, `immutableAllowSetting`
anywhere, and a `countable` flag on `conversationInvite.inbox`.

| Doctype | Change | Frozen |
| --- | --- | --- |
| `conversationInvite` | `recipientId` refersTo `{type: identity}` — a ghost recipient is refused at write time (40120) | `recipientId`, `conversationId`, `senderPubKey` |
| `directMessage` | `conversation [conversationId, $createdAt]` gains `rangeCountable` | `conversationId`, `encryptedContent` |
| `readReceipt` | — | `conversationId`, so a replace can only move `$updatedAt` |

`immutable` is checked only when a replace is validated: it adds nothing to the
create path every message takes, which is why it is the one beta.2 feature DMs
adopt. `senderPubKey` is frozen plain rather than allow-setting, so a sender who
later rotates to a hash160 key cannot add it to an existing invite (40128 on an
add) and must delete and recreate — an invite whose sender key appears later is
a different claim about a moment that has passed.

```js
// Total messages, and unread after the viewer's read receipt. One call each.
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', '==', C]] })
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', '==', C], ['$createdAt', '>', lastReadAt]] })
// Totals for the whole list in one call — NO range clause (see rule 3 below).
sdk.documents.count({ dataContractId, documentTypeName: 'directMessage',
  where: [['conversationId', 'in', [C1, C2]]], groupBy: ['conversationId'] })
// conversationId is a plain 10-byte array, so operands are base64 and
// grouped-count keys are the hex of those bytes.
```

The switch changes **reads only** — v4 writes are byte-identical to v3's — so a
mismatch is never rejected by consensus, and is not harmless either: pointing
`v4` at a contract without the count flags makes every count fail, so unread
reads as 0 and the badge silently never appears. `countUnreadByConversation`
logs a warning naming that cause.

**Unread is not exactly v3's unread.** The `conversation` index carries no
`$ownerId`, so a count cannot exclude the viewer's own messages; adding that
axis would mean a second index branch on every message write, which is the cost
DMs are not allowed to pay. Two things keep it honest: a conversation whose
newest message is the viewer's own reports 0 (the count is skipped), and
otherwise the count can exceed the truth only by the messages the viewer sent
since their last receipt. With read receipts **disabled** no receipt exists at
all and the count would be the whole history, so `getUnreadTotal` returns 0 and
the global badge stays hidden; it returns **`null`**, not 0, when it cannot tell
(any count or page failed), since publishing 0 would read as "all caught up".
The badge rides the existing 30 s notification poll — no second timer — is
skipped while the tab is hidden, and never decrypts or resolves identities,
because `decryptMessage` prompts for a private key.

**Contract-bound encryption keys remain unusable**, and the note in
`lib/services/identity-update-builder.ts` blaming "SDK/tooling bugs" misplaces
the cause: Drive refuses a `SingleContract`-bounded ENCRYPTION key with
*"contract: key bounds expected but not present"* because such a key is only
accepted against a contract that declares `requiresIdentityEncryptionBoundedKey`
— and no identity can hold one until the contract requires it. Turning either
`requiresIdentity{Encryption,Decryption}BoundedKey` on would therefore break DMs
for every existing identity on the day of the cut, so both stay unset. The
battery probes this and never fails on it.

---

## Polls (Pollr)

`contracts/pollr-contract.json` is **pollr v8**, the testnet production cut: pollr v7 (below) with no poll indexes. v7 is the 5.0.0-beta.5 re-cut (below, [PLATFORM_V5_BETA5_UPGRADE.md](PLATFORM_V5_BETA5_UPGRADE.md)): `poll` and one `vote` doctype, one ballot per voter, and runs `/devnet`. Client gate: `NEXT_PUBLIC_POLLR_TOPOLOGY=v8` (or `v7`; both read and write the same documents); the client no longer reads v5/v6 ballots, so `/devnet` has polls off until v7 is registered. v6, v5 plus the owner's delete before the first ballot (below), runs on sakura as
`Fq5yTk2YqJZ2wa7uESKB119nX3ea23QP2gUsLqGtEu8c` since the 2026-10-08 beta.3
wipe (`/devnet`); `verify-pollr.mjs` passed 64/64 there, the `noBallots`
delete refusals (40147) included ([SAKURA_BETA3_DEPLOY.md](SAKURA_BETA3_DEPLOY.md)).
v5 (`BX94nj87…` on the pre-wipe chain, [SAKURA_V13_DEPLOY.md](SAKURA_V13_DEPLOY.md))
replaced the v4 cut (indexOnly `vote`/`multiVote`; recover both from git history). Testnet runs v3 (`GBCR8Jqt…`, externally owned).

| Doctype | Shape | Serves |
| --- | --- | --- |
| `poll` | immutable, `canBeDeleted: true` with `deleteConstraints.noBallots`, no moderation; `question` (1-280 chars, 560 B), `options[]` (2-10 unique, each 1-80 chars / 160 B), `multiChoice`, `endsAt` (all required) | a fixed question, choices, mode and close time that every ballot's rules read; its owner may delete it until the first ballot |
| `vote` | stored, mutable, `canBeDeleted: false`; `immutable: [pollId]`; `pollId` → deletableDocument poll `where {endsAt: {greaterThanOrEqual: $updatedAt}}`; optional `choices` (1-10 distinct of 0-9; absent = withdrawn); rules `choicesAreOptions`, `choicesAreOptionsHigh`, `singleChoice` reading the poll; unique `byPollVoter [pollId, $ownerId]`; `byPollChoice [pollId, choices]` countable per element; `byPoll [pollId]` countable | one editable ballot per voter, tallied in O(1) per option, and counted in O(1) per poll for `noBallots` |

Ballots are free — no `tokenCost`.

### What v8 changed (from v7)

- **No poll indexes** (D15): `poll.byCreatedAt` and `poll.ownerAndTime` are gone. Yappr reads a poll only by its id, through the post that embeds it, and a chronological listing would have been a global browse of unmoderated, mostly undeletable poll text. Ballots, rules and the owner's delete before the first ballot are v7's (`noBallots` still counts `vote.byPoll`).
- The standalone Pollr app listed polls through those indexes; D15 retires the `POLLR_APP_*` links unless that app moves to its own contract.
- Signed size 3,568 B (v7 3,705 B); registration 17.00e9 by the fee table (2 types, 3 indexes; v7 19.00e9), 17.14e9 measured on sakura (1,028¢).
- **Proved on sakura** (throwaway `7XxAZfo5k2uWEigXdQymzhNPQVmqgJR9wMUveoUfJ3y1`, 2026-10-17): a poll 19.4M (1.2¢; v7's estimate 60.9M) and a ballot 76.6M; the poll read by id; listing polls by time or by owner refused (no index); the per-option tally (`containsAny`, grouped) answers; deleting a poll with a ballot refused 40147, one without deleted.

### What v7 changed (from v6)

- **One ballot per voter**: `choices` holds every selected option; no `slot`/`choice`, and no copied `pollOptionCount`/`pollMultiChoice`/`pollEndsAt`. A multi-choice voter changes their selection with one replace.
- **The close is a `where` condition** on `pollId` (`endsAt >= $updatedAt`, checked on every replace): a late create, change or withdrawal is 40127 (v6: 10422 `writtenBeforeClose`).
- **Rules read the poll** (`referenced`): every element names an option the poll has (`choicesAreOptions` for options+0…3, `choicesAreOptionsHigh` for +4…7), and a single-choice poll takes at most one (`singleChoice`). `poll.optionCount` and `optionCountMatches` are gone.
- **Tallies are per element**: `byPollChoice [pollId, choices]` enters a ballot once per choice; the client reads one grouped `containsAny` count. Group keys of these unsigned values are plain bytes on PV14 (`00`…`09`).
- Unchanged: editable until the close and final after, the owner's delete only before the first ballot (withdrawn ones count), `endsAt` within 31 days. Signed size 3,706 B (v6 4,173 B).

### What v6 changed (from v5)

The product rule: a poll's owner may delete it only before the first vote, and
after that it can never be deleted. Votes stay editable until the close and
final after. There is no pollr moderation.

```json
"poll": { "canBeDeleted": true,
  "deleteConstraints": { "noBallots": { "equal": [{ "countOf": ["vote", { "pollId": "$id" }] }, 0] } } },
"vote.pollId.refersTo.type": "deletableDocument",
"vote.indices": [ …, { "name": "byPoll", "properties": [{ "pollId": "asc" }], "countable": "countable" } ]
```

- **`noBallots`** is judged on the owner's delete only, against the stored
  state. A broken rule is `DocumentDeleteConstraintViolatedError`, a paid
  **40147**. Ballots are undeletable and a withdrawal is a replace that keeps
  the document, so a withdrawn ballot still counts: once anyone votes, the poll
  is permanent. A ballot earlier in the same block counts too.
- **`byPoll`** is required: a `countOf` total needs a plain countable index
  whose properties are exactly the filter's keys, and `byPollChoice`
  (`[pollId, choice]`, skipping absent choices) is not one. Without it beta.3
  refuses the contract ("no countable index … exactly those keys").
- **`deletableDocument`**: a `permanentDocument` reference at a deletable type
  parses in dpp but is refused at registration (40122). A ballot cast after the
  delete is refused 40120 (the poll is not found); with `deletableDocument`
  every ballot write re-reads the poll, a small processing cost.
- **Size and fees.** 4,150 B serialized on the beta.3 validator (v5's schemas
  are 3,897 B there; +146 B for the rules and index, the rest descriptions).
  The extra index costs every ballot: the estimator says +13.9M credits on a
  poll's first ballot and +8.8M on later ones, so about +6-10M live (≈0.4-0.6¢
  at $60/DASH). Measure it on registration day.

**Client (v6).** `pollrPollService.deletePoll(poll, me)` counts the ballots off
`byPoll` first and refuses without a write (`voted`) if there are any, so a
voted poll costs nothing to refuse; a ballot landing between the count and the
delete comes back as 40147 and is reported the same way. `PollCard` offers
"Delete poll" only to the signed-in owner, and only once the count reads 0 (a
tally with any selection already proves a ballot; an unreadable count, or a
ballot write of the owner's still pending, offers nothing), and stops offering
it the moment the owner votes, even if a count read before the vote comes back
later. A poll once known to have a ballot is never offered again
(`lib/services/pollr-known-ballots.ts`, kept in localStorage, so no reload,
card or tab resets it): the services record the
evidence where they see it, as a positive count, a 40147, a tallied selection,
any own ballot document read (a withdrawn one included), a stored ballot
replace record (it targets a ballot read off the chain; recorded whenever the
records are loaded, before any is pruned, and loaded by both delete paths, so a
closed poll's records count too), or a confirmed ballot write,
even when a later write of the same vote fails. `deletePoll` re-checks the set
after its count, so evidence seen meanwhile still stops the write, and sends
nothing (`pending`) while an own ballot write on the poll may still land. Its
last check runs under the identity's write lock, once every earlier
transition of the owner's has settled and before a nonce is reserved
(`withSdkSignedWrite`'s `precondition`): no known ballot and a fresh count of
0, with no own ballot write on the poll that may still land, so a vote queued
ahead of the delete in another card or tab stops it. These guards spare the
owner a paid refusal; consensus enforces `noBallots` whatever they say. The
card asks `pollrVoteService.deleteEligible` afresh after every load and every
submission, and only the latest answer applies, so a vote that was never sent
gives the delete back. A vote refused before
any write, or left unconfirmed, proves nothing, so the next load counts again;
a write that is really out keeps its reservation, which reads as a pending
(or, if the read fails, unreadable) ballot state and holds the delete back
(`ownBallotMayBePending`). Ballots are permanent, and a lagging node can still
count 0. Post embeds name the poll in their own fields, not through a reference,
so a post outlives its poll: when `fetchPoll` proves a natively embedded poll
absent on v6 twice, 2.5 s apart (a node a block behind proves a just-published
poll absent too; `pollMissingMeansDeleted`), the card says "This poll was
deleted." A failed read still says the poll could not be loaded. A ballot sent
to a poll deleted after the card loaded (40120) re-reads it instead of keeping
the ballot open. `categorizeError` words any other 40147 as "This can't be
deleted anymore."

**Battery (`verify-pollr.mjs` p8).** A ballot delete is refused
(`canBeDeleted: false`); deleting a poll with ballots is 40147; a fresh poll
with no ballots (byPoll count 0) is refused to a stranger (40102), deleted by
its owner, and a ballot on it after is 40120; a fresh poll with one ballot is
40147 and still reads back; a fresh poll whose only ballot was withdrawn leaves
the tally empty, still counts 1 on byPoll, and is 40147. `--self-test` pins the
`noBallots` rule body, `poll.canBeDeleted`, the `deletableDocument` reference
and `byPoll`.

### Rules, ballots and reads (v7)

**Rules (`propertyConstraints`, 10422).** On `poll`: `endsAfterCreation`
(`endsAt > $createdAt`) and `endsWithin31Days` (`endsAt - $createdAt <= 31
days`), so every poll closes and none is born closed. On `vote`, every rule
reads the poll the ballot names (`referenced`): `choicesAreOptions` and
`choicesAreOptionsHigh` (no element is `options.length + 0…3`, or `+ 4…7`; the
elements are 0-9 and a poll has 2-10 options, so that covers every element a
poll lacks) and `singleChoice` (at most one element unless `multiChoice`). A
ghost poll is 40120. `scripts/property-constraint-cases.mjs` holds the cases;
no SDK pre-check reads a referenced document, so the vote cases are judged on
the node (`verify-pollr.mjs` p10) and were checked with rs-dpp 5.0.0-beta.5.

**Ballots are editable until the close and final after.** The pollId `where`
condition `endsAt >= $updatedAt` is checked on every create and replace
(`$updatedAt` is the write's block time), so a write landing after the close
is 40127, and nothing deletes a ballot. One ballot per voter (`byPollVoter`):
the first vote creates it with `choices`; changing the vote, on either kind of
poll, replaces `choices`; withdrawing replaces it with `choices` left out.
`byPollChoice` enters a ballot once per element and none for a withdrawn
ballot, so the tally counts current selections: on a single-choice poll the
total is the number of voters, on a multi-choice poll the selections.

What the design could not do: a tally index can only be `preallocated` on an
indexOnly type, and an indexOnly ballot has no stored row to replace, so the
ballot trees are not preallocated (the first ballot on a poll pays for its
branch). A ballot that could be deleted would let its voter free the poll for
deletion again, so ballots stay undeletable and a withdrawal is a replace.

```js
// Per-option tally, one group per element (keys: plain bytes on PV14, 00…09;
// older chains 0x80 + choice — the client reads both).
sdk.documents.count({ dataContractId, documentTypeName: 'vote',
  where: [['pollId', '==', P], ['choices', 'containsAny', [0, 1, 2]]], groupBy: ['choices'] })
// The voter's ballot on one poll (a withdrawn one included, with its revision).
sdk.documents.query({ dataContractId, documentTypeName: 'vote',
  where: [['pollId', '==', P], ['$ownerId', '==', me]],
  orderBy: [['pollId', 'asc'], ['$ownerId', 'asc']], limit: 1 })
// Every ballot on a poll, withdrawn ones included (byPoll), as noBallots counts them.
sdk.documents.count({ dataContractId, documentTypeName: 'vote', where: [['pollId', '==', P]] })
```

**Client (`lib/services/pollr-vote-service.ts`, `lib/pollr-rules.ts`).**
The service is the one source of truth for a voter's ballots:
`getBallotState(poll, me)` returns `{ choices, pending }`. `pending` is true
while an earlier write to this voter's ballots on this poll could still execute
(`pollrWriteMayStillExecute`): an unconfirmed create until Platform shows its
nonce consumed (it landed, another transition took it, or it fell out of the
window behind the tip; a signed transition has no deadline, so no clock ends
it), a ballot replace until a verdict, the ballot reaching the revision it
writes (it can never execute after that) or the poll's close — tracked in its
own record (`recordBallotReplace`), because the nonce store forgets an
SDK-signed replace once its 15-minute reservation lifetime passes, which is a
write-availability policy and not a protocol deadline — and anything when the
reservation store or the nonce cannot be read. The ballots
are read only after that check, so a write landing during it is in the read. Ballot writes are reserved with their poll's
scope (`pollr-vote:<pollId>`, an optional field on the nonce reservation), so a
pending write on one poll does not hold back another; an entry with no scope (a
poll create, or one stored before scopes) counts for every poll. Before
anything, the replaces Platform shows landed are released
(`settlePendingPollrReplaces`, over `settlePendingWrites`); `createPoll`
runs that too.

While `pending`, the card shows the results read-only with "Confirming your
vote… Check again", which re-reads that state; editing comes back once nothing
is pending. If a submission did not go through, "Vote again" opens the editor
on what the voter last asked for, with the options the chain does not show
marked "not sent yet" (`editorStart`); nothing is resent until the voter
submits.

`setVote(poll, wanted, me)` refuses to plan while anything is pending
(`heldBack`, nothing sent; an unreadable store refuses too). Otherwise it reads
the ballot fresh and makes at most one write (`planBallotWrite`): a create, or
a replace of `choices` (left out to withdraw), reserved with the poll's scope.
A 40127 (the close condition) is reported as "This poll has closed"; a stale
revision (40106) or a ballot another tab created first (40105) as `stale`, and
the card reloads; a 40120 as `gone` (the owner deleted the poll). After a
refused write it re-reads the ballot and reports what the chain shows. A write
whose confirmation timed out comes back `unconfirmed`, with no re-read (one
this soon would likely predate the write), and the card shows the ballot as
pending. Every submission is a fresh plan against the chain. Optimistic
tallies move down as well as up.
`tallyIsFinal` is true only for a tally read off the chain after `endsAt`
(plus a 30 s margin for the device clock against block time); the card says
"Final results" only then. The poll editor offers 1, 3, 7, 14 and 30 days
(default 1 day) — 30, not 31, because the close time comes from the device
clock and the rule judges block time — and enforces the character and byte
limits and distinct options.

**v3 and v4.** v3 (testnet) keeps its immutable, one-document-per-selection
ballots and the time-bounded "final results" read. v4 is **read-only** in the
client: its polls, tallies and the voter's own choices still load, but its
indexOnly write path (affected-state confirmation, entry probes, the keyset
tally fallback and the ranked winner) is gone. A deployment still on v4 shows
results but takes no votes. v5/v6 slot ballots are no longer read: those
contracts went with the beta.3/beta.4 sakura chain.

**The standalone Pollr app needs the same cut.** The testnet contract
(`GBCR8Jqt…`) is externally owned and is what
`https://pastapastapasta.github.io/pollr` reads; only the devnet clone is ours.
A v7 poll stores `options[]` rather than `option0..9`, and a v7 ballot is one
`choices` list, so that app needs both its poll and its ballot paths changed
before it can read or write a v7 contract.

---

## Tips (YAPP token transfers, no contract of its own)

A tip is a **YAPP token transfer**, and the badge is read back off chain (it
used to be a DASH credit transfer plus a `reply` whose text said
`tip:<credits>` — a number nothing backed).

YAPP's token config sets `keepsTransferHistory`, so consensus writes an
immutable, undeletable `transfer` document into the system token-history
contract (`43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF`, the same id on every
chain) as part of applying the transfer. Its `$ownerId` (sender),
`toIdentityId`, `amount`, `tokenId`, `$createdAt` and `publicNote` are therefore
facts, not claims.

`lib/tip-note.ts` encodes the note (max 2048 on the doctype):

```
yappr:tip:v1:post:<base58 postId>
yappr:tip:v1:reply:<base58 replyId>[\n<message up to 280 chars>]
```

Anything that does not start with exactly `yappr:tip:v1:`, names an unknown
kind, or names something that is not a 32-byte base58 identifier is ignored, so
an ordinary "thanks!" transfer never becomes a tip on a post. A profile tip
carries the bare message or no note.
What is **not** proved, and is said so in the UI: nothing binds a transfer to a
post (consensus never reads `publicNote` — the attribution is the sender's
signed assertion); self-tipping from a second identity is possible, which is why
the strip shows who each tip came from rather than only a total; totals are the
sum over one bounded page (the newest 100 on an index), because the system
contract has no count/sum trees; a tip note is attacker-controlled text stapled
permanently under someone else's post for the 1 YAPP minimum (`post-tips.tsx`
withholds notes from blocked identities but still counts the amounts — the
transfer did happen); and a profile's "YAPP received / sent" is every incoming
transfer, not a tip total.

```json
{ "dataContractId": "43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF",
  "documentTypeName": "transfer",
  "where": [["tokenId", "==", "<YAPP token id>"], ["toIdentityId", "==", "<identity>"]],
  "orderBy": [["tokenId", "asc"], ["toIdentityId", "asc"], ["$createdAt", "desc"]],
  "limit": 100 }
```

Every index on `transfer` is prefixed by `tokenId`, and `orderBy` must name the
index fields in order including the equality-constrained ones; tips **sent** is
the same shape on `$ownerId`. Tips on one post are not a query — there is no
index on `publicNote` — so `getTipsForPost` reads the author's newest 100
incoming transfers and parses each note, which is why it runs on the post detail
page only and never per feed card.

**Signing.** A batch carrying a token transition requires a **CRITICAL**
authentication key, which Yappr does not hold for wallet-login users, so the
flow has two paths mirroring buy-YAPP: local (`tipService.sendYappTipLocal`)
when this browser holds one or the user pastes one, otherwise an unsigned
`TokenTransferTransition` in a `dash-st:` QR for a remote wallet. Wallet success
is detected by polling the `from` index for *this tip's own transfer document*,
not by watching the balance fall (which would also fire if the user posted from
another tab). The unsigned transition embeds the sender's next
identity-contract nonce, so build it right before showing the QR.

**Never retry a tip blindly.** DAPI 504s on transitions that landed, and a tip
is money, so "the SDK threw" must never become a Try Again button. Every
confirmation-shaped failure funnels into `tipService.confirmYappTip`, which
polls the chain and otherwise reports a distinct `UNCONFIRMED` state whose only
actions are Close and Check again. The automatic polls carry a 60 s clock-skew
time floor so an identical earlier tip cannot pass for this one; the Check-again
buttons deliberately carry none, so a chain clock behind the browser's cannot
hide a real tip and prompt a second send. See `tip-service.ts` for the details.

A deployment whose social contract has no YAPP token has no YAPP tips: the
`/testing` social contract predates the token, so its YAPP tab reads 0.

---

## Platform rules these cuts established

1. **`rankedCountable: true` on an `averageable` index is refused at
   registration** with `"rangeCountable" is a required property`. The
   meta-schema's dependency rules run on the literal keys before the sugar is
   expanded, and the wasm validator (`DataContract.fromJSON(.., true, ..)`)
   compiles that check out — so it passes offline and fails on chain. Spell the
   `range*` axes out. Upstream: dashpay/platform#4809. beta.2 relaxes exactly
   one link: `rangeCountable: true` now implies `countable: "countable"`.
   Assume every other flag is required until the meta-schema says otherwise.
2. **`tokenCost.create.contractId` must be the 32-byte array form** in the
   registered JSON; base58 is refused at registration although the offline
   validator accepts it.
3. **`IN` + a range in one grouped count returns an EMPTY map, not an error.**
   Served on the no-proof path only; on the proved path it answers with no
   groups at all. A silent zero is worse than a rejection, so the client never
   uses that shape. The IN-only grouped count is proved and correct.
4. **A writer gate fails as the SAME consensus error a value pair does** —
   `ReferencedDocumentPropertyMismatchError`, state code 40127 — with the
   signing identity on the referring side. `$ownerId` on the LEFT is what tells
   them apart, which is how `isWriteGateError` in `lib/error-utils.ts`
   classifies it: a value mismatch means stale data (reload and retry), a gate
   means the wrong signer (retrying never helps).
5. **`immutable` rejects a replace that removes or adds a frozen property**, not
   only one that changes it (40128); `immutableAllowSetting` is the single
   exception and fires once. Audit every replace path before freezing anything:
   `update()` merges into a full replace and hands identifiers back as base58,
   so a re-encoded identifier is now rejected outright.
6. **`timeRange` (including `ttl`) is accepted on an ordinary doctype** — it
   does not require `indexOnly`; the ttl drains the index entries, the documents
   stay. Proved rather than assumed: an unfollow drops the all-time count, the
   ranked page and the windowed page together, and on a scratch registration
   with a 60 s grid / 120 s ttl a delete *after* the windowed count had fallen
   to 0 was **accepted and decremented the all-time count** — Drive does not
   require the drained entry to exist, so an unfollow a week later cannot
   strand a user.
7. **A ranked read on a bucket nothing landed in fails proof generation**
   instead of proving an empty ranking: *"a single-path axis read must produce
   exactly one axis descent"*. That error IS the empty answer; the stats
   services map it to `[]`.
8. **`preallocated` cannot cover an index with a non-reference property.** The
   flag promises the whole index path is a pure function of one referenced
   document, so every property must be the refersTo property or a
   `propertyAgreement` key (rs-dpp `index::preallocation`). Measured: a v4 poll
   create costs ~18M credits more than the same poll on the v3 clone.
9. **A ranked index's prefix may not also terminate an aggregating index**, and
   **`rangeCountable` does not give you a prefix count** — a bare
   `count where pollId == P` is refused on both ballot doctypes. The
   `rankedCountable: {at: […]}` form that social v5 uses is unavailable when a
   plain index terminates at the `at` level.
10. **A terminal must be `$ownerId` or a refersTo identifier**, so no index can
    be keyed (poll, voter) → choice.
11. **Composite lookups on a unique index take no `limit`**; lookups on a
    non-unique index take no `orderBy` (they inherit the page's direction).
    Count sub-results are keyed by the hex of the bound identifier's bytes.
12. **The prefix-overlap rule does not fire for a single-property ranked index**
    sitting beside a plain compound one (`commentCount [blogPostId]` next to
    `postAndTime [blogPostId, $createdAt]`).
13. **An indexOnly document cannot self-expire.** Tried on the key-exchange
    contract and dropped: IN_TIME_RANGE reads are refused on indexOnly types and
    raw where-clauses never route to a bucketed index, so the payload must live
    in a permanent index anyway and the TTL only buys an aggregate. Measured on
    moutai: 93.8M credits per response against 66.3M on the stored v2 contract
    (+42%), with no storage refund. `key-exchange-v2.json` stays.

## Not possible at 4.2 — do not design around these

Consensus-enforced poll expiry; stock decrement on another owner's document, or
any cross-owner mutation; pay-to-referenced-owner token effects and two-party
atomic transitions (the batch cap is one document transition); ranked reads with
an arbitrary pin set ("top stores among those I follow"); unique indexes on
indexOnly types; MIN/MAX; multi-clause HAVING; cursors on ranked/having/
composite; creating budgeted or contract-bound authentication keys from the JS
SDK; adding index flags to a live contract — every change above is a re-cut.

## Deferred

Sellable documents (`tradeMode`/`transferable` with `keepsPurchaseHistory`) and
sponsored writes (`gasFeesPaidBy`) are unexercised anywhere in Yappr. Scoped app
keys — a wallet-granted AUTHENTICATION key bound to the Yappr contract group
with `totalBudget` and `expiresAt` — are the right long-term login primitive but
are blocked on wasm-sdk key-creation options. `authVault`/`vault` would benefit
from `documentsKeepHistory` so a bad bundle overwrite is recoverable.
