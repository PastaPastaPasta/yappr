# Storefront contract v2

Registered on moutai 2026-09-17 as `57k7LnhQV64g9UhUt2iQbA8DA1QMxtbepWTNLdutQjeC`
(a throwaway battery registration owned by a seed persona; the deployment
maker can re-publish the same JSON when the next full re-provision happens).
Built by `scripts/build-storefront-v2-contract.py` from the v1 file, published
by `scripts/register-storefront-v2.mjs`, verified live by
`scripts/verify-storefront-v2.mjs` (59 checks, all passing). Protocol 14,
Platform 4.2.0-beta.1 or later.

## What changed and why

v1 stored reviews but computed every aggregate in the browser: the store
directory paged every review of every store to show a star average, the order
pages made four requests per order, and nothing checked that a review's order
existed or that a status update came from the seller. v2 moves all of that
onto Platform features the social contract already uses.

| Doctype | v2 change | Serves |
| --- | --- | --- |
| `store` | `canBeDeleted: false` (`closed` is the tombstone) | permanentDocument target |
| `storeItem` | `canBeDeleted: false`; `storeId` refersTo store | item reviews, ghost-store rejection |
| `shippingZone` | `storeId` refersTo store | ghost-store rejection |
| `storeOrder` | permanent; `buyerId` (poster-attested); `storeId` refersTo store; `sellerId` refersTo identity; countable buyer/seller/store indexes; `storeOrderCount` ranked | order badges, "most ordered stores", agreement source for reviews and status |
| `orderStatusUpdate` | `sellerId` + `buyerId` bound to the order by propertyAgreement; `buyerStatusUpdates` index | buyer status feed; spoof filter |
| `storeReview` | `buyerId` bound to the order; `storeRating` average+count ranked; `sellerRating` average ranked; `storeRatingDistribution` grouped count; 3 YAPP | store average, distribution, top rated, most reviewed |
| `itemReview` | new, one per (order, item); `itemId` refersTo item with `{storeId}` agreement; `itemRating` and `storeItemRating` average ranked; 1 YAPP | item average, top items per store, global top items |

The client selects the topology with `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v2`
(`STOREFRONT_TOPOLOGY` in `lib/constants.ts`). On `v1` (the default, matching
the testnet contract) writes omit the attested ids, reviews carry no token
payment, and the pages skip every aggregate read, so a v1 deployment keeps
its old behaviour; on `v2` the switch must match a v2 registration or
consensus rejects the writes.

Reviews are priced in YAPP through `tokenCost.create.contractId`, which names
the social contract. The client attaches a `TokenPaymentInfo` whose
`paymentTokenContractId` is the social contract (`STOREFRONT_YAPP_TOKEN_COSTS`
in `lib/constants.ts`); without it consensus refuses the create.

## Verified purchase

`propertyAgreement` binds user properties, never `$ownerId`. So the buyer
writes `buyerId` into their own order, consensus forces every review and
status update on that order to carry the same `buyerId` (and `sellerId`,
`storeId`), and the app decides:

- a review is a **verified purchase** when `review.$ownerId == review.buyerId`;
- a status update is **genuine** when `update.$ownerId == update.sellerId`.

The battery's s4e documents the gap: a stranger can post a status update that
carries the order's own ids. It lands, and `orderStatusService.isGenuine`
drops it. A stranger cannot review someone else's order once the buyer has,
because `orderReview` is unique per order (s5h); before that they could burn
the slot, which the 3 YAPP cost discourages. Closing this fully needs an
upstream "owner agreement" on refersTo.

Rating an item publishes that the order contained it. Unreviewed orders stay
encrypted; the review modal says so before the buyer rates an item.

## Query shapes that serve, verified live

```js
// Store average: {count, sum}; the client divides.
sdk.documents.average({ dataContractId, documentTypeName: 'storeReview',
  where: [['storeId', '==', S]] }, 'rating')

// 1..5 distribution in one call (keys are hex of 0x80 + rating).
sdk.documents.count({ dataContractId, documentTypeName: 'storeReview',
  where: [['storeId', '==', S], ['rating', 'in', [1,2,3,4,5]]], groupBy: ['rating'] })

// Top stores by average; `value / valueScale` is the average.
sdk.documents.ranked({ dataContractId, documentTypeName: 'storeReview',
  groupBy: 'storeId', aggregate: { type: 'avg', property: 'rating' }, limit: 20 })

// Most ordered stores.
sdk.documents.ranked({ dataContractId, documentTypeName: 'storeOrder',
  groupBy: 'storeId', aggregate: { type: 'count' }, limit: 20 })

// Top items inside one store.
sdk.documents.ranked({ dataContractId, documentTypeName: 'itemReview',
  groupBy: 'itemId', aggregate: { type: 'avg', property: 'rating' },
  where: [['storeId', '==', S]], limit: 100 })

// Items rated 3 and up.
sdk.documents.having({ dataContractId, documentTypeName: 'itemReview',
  groupBy: 'itemId', aggregate: { type: 'avg', property: 'rating' },
  having: { operator: '>=', value: 3 }, limit: 100 })

// Buyer orders page in one proof: orders + store join + review-exists + status history.
sdk.documents.composite({ dataContractId, documentType: 'storeOrder',
  where: [['$ownerId', '==', me]], orderBy: [['$createdAt', 'desc']], limit: 50,
  subQueries: [
    { documentType: 'store', bind: { sourceProperty: 'storeId', field: '$id' } },
    { documentType: 'storeReview', bind: { sourceProperty: '$id', field: 'orderId' } },
    { documentType: 'orderStatusUpdate', bind: { sourceProperty: '$id', field: 'orderId' }, limit: 100 },
  ] })
```

Page budgets after the client migration (cold load, DAPI requests):

| Page | v1 | v2 |
| --- | --- | --- |
| `/store` directory, 50 stores | 1 + 50 × ⌈reviews/100⌉ | 1 + 50 averages (parallel, 6 at a time); ranked sorts add 1 |
| `/store/view` | ≥ 7 + ⌈reviews/100⌉ | 6 fixed (store, items, reviews page, average, distribution, ranked items) + 1 count |
| `/orders` buyer, N orders | 1 + 4N | 1 composite + N decrypts |
| `/orders/seller`, N orders | 1 + 2N | 1 + ⌈N/100⌉ + 1 DPNS batch |
| `/store/manage` badge | 1 (capped page, wrong number) | 1 count |

## Registration gotchas found on the way

1. `rankedCountable: true` on an `averageable` index is refused at
   registration with `"rangeCountable" is a required property` and then
   `"countable" is a required property`: the meta-schema's dependency rules
   run on the literal keys before the `averageable` sugar is expanded, and the
   wasm validator (`DataContract.fromJSON(.., true, ..)`) compiles that check
   out, so it passes offline and fails on chain. Spell `countable` and
   `rangeCountable` out. Upstream fix and doc: dashpay/platform#4809.
2. `tokenCost.create.contractId` must be the 32-byte array form in the
   registered JSON; base58 is refused at registration although the offline
   validator accepts it. The registration script decodes the placeholder.
3. Composite lookups on a unique index take no `limit`; lookups on a
   non-unique index take no `orderBy` (they inherit the page's direction).
4. Count sub-results are keyed by the hex of the bound identifier's bytes.

## Not in v2

- Sums of order amounts. Orders are encrypted to the seller, so revenue
  rankings would need a plaintext amount; order counts rank stores instead.
- Stock decrement on purchase. A buyer cannot edit the seller's item; an
  indexOnly reservation doctype with a sum axis is the shape if wanted.
- Consensus-bound reviewer identity (see Verified purchase).
