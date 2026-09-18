# Storefront contract v2

**Not currently deployed.** The 2026-09-17 registration
(`57k7LnhQV64g9UhUt2iQbA8DA1QMxtbepWTNLdutQjeC`, 59/59 battery checks) went with
the moutai wipe, and the JSON has since been re-cut for **4.2.0-beta.2** — see
"beta.2 re-cut" below. Built by `scripts/build-storefront-v2-contract.py` from
the v1 file, published by `scripts/register-feature-contract.mjs`, verified live
by `scripts/verify-storefront-v2.mjs`. Protocol 14, Platform 4.2.0-beta.2 or
later.

## beta.2 re-cut

beta.2 lets the **referring** side of a `propertyAgreement` be `$ownerId` — the
writer — which turns a reference into a **write gate**: only the identity the
referenced document names may create, or replace, the referring document. It is
checked on create and on every replace, so a gate cannot be slipped past by
writing first and editing later.

Four rules the client could previously only *ask* for are now consensus:

| Declaration | Rule |
| --- | --- |
| `storeItem.storeId`, `shippingZone.storeId` → `{$ownerId: $ownerId}` | only a store's owner may list an item or a zone under it |
| `orderStatusUpdate.orderId` → `{$ownerId: sellerId}` | only the order's seller may post a status update (verified: `createStatusUpdate` has exactly one caller, the seller page — buyers never post one, not even to cancel) |
| `storeReview.orderId`, `itemReview.orderId` → `{$ownerId: $ownerId}` | only the identity that placed an order may review it |
| `storeOrder.storeId` → `{sellerId: $ownerId}` | `sellerId` is the store's real owner |

That last one is a value pair rather than a gate, and it is strictly stronger
than the `refersTo: {type: identity}` it replaces: "an identity that exists"
was passed by *any* real identity, while "the store's `$ownerId`" is the one
right answer. The separate identity reference is therefore gone — an identity
that owns a document necessarily exists.

With the gates in place, three attested copies are pure duplication and are
**dropped**: `storeOrder.buyerId` (it is the order's `$ownerId`, and every
buyer-side index already keys on `$ownerId`), `orderStatusUpdate.sellerId`
(the writer IS the seller; `sellerStatusUpdates` already indexes `$ownerId`)
and `storeReview.buyerId` / `itemReview.buyerId`.

`storeItem` and `shippingZone` also declare `immutable: [storeId]`, so an edit
cannot move a listing or a zone to another store; and every aggregate flag set
drops the `countable` key `rangeCountable` now implies.

## What changed and why

v1 stored reviews but computed every aggregate in the browser: the store
directory paged every review of every store to show a star average, the order
pages made four requests per order, and nothing checked that a review's order
existed or that a status update came from the seller. v2 moves all of that
onto Platform features the social contract already uses.

| Doctype | v2 change | Serves |
| --- | --- | --- |
| `store` | `canBeDeleted: false` (`closed` is the tombstone) | permanentDocument target |
| `storeItem` | `canBeDeleted: false`; `storeId` refersTo store, WRITER-GATED; `immutable [storeId]` | item reviews, ghost-store rejection, seller-only listings |
| `shippingZone` | `storeId` refersTo store, WRITER-GATED; `immutable [storeId]` | ghost-store rejection, seller-only zones |
| `storeOrder` | permanent; `storeId` refersTo store with `{sellerId: $ownerId}`; countable buyer/seller/store indexes; `storeOrderCount` ranked | order badges, "most ordered stores", consensus-true seller, agreement source for reviews and status |
| `orderStatusUpdate` | `orderId` WRITER-GATED to the order's seller; `buyerId` bound to the order's `$ownerId`; `buyerStatusUpdates` index | buyer status feed that carries only the seller's own updates |
| `storeReview` | `orderId` WRITER-GATED to the order's owner; `storeRating` average+count ranked; `sellerRating` average ranked; `storeRatingDistribution` grouped count; 3 YAPP | store average, distribution, top rated, most reviewed |
| `itemReview` | new, one per (order, item); `itemId` refersTo item with `{storeId}`; `orderId` WRITER-GATED; `itemRating` and `storeItemRating` average ranked; 1 YAPP | item average, top items per store, global top items |

The client selects the topology with `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v2`
(`STOREFRONT_TOPOLOGY` in `lib/constants.ts`). On `v1` (the default, matching
the testnet contract) reviews carry no token payment and the pages skip every
aggregate read, so a v1 deployment keeps its old behaviour; on `v2` the switch
must match a v2 registration or consensus rejects the writes.

Reviews are priced in YAPP through `tokenCost.create.contractId`, which names
the social contract. The client attaches a `TokenPaymentInfo` whose
`paymentTokenContractId` is the social contract (`STOREFRONT_YAPP_TOKEN_COSTS`
in `lib/constants.ts`); without it consensus refuses the create.

## Verified purchase, and the spoof filter that is no longer needed

Every review on chain is a verified purchase: the writer gate on `orderId`
admits only the identity that placed the order, so `verifiedPurchase` is a
property of the contract rather than a comparison the client makes.

The same gate retired two client defences:

- **`orderStatusService.isGenuine` is gone.** On beta.1 a stranger could post a
  status update carrying the order's own ids (old battery case s4e); it landed,
  and the client dropped it on read. Worse, `getLatestStatus` had to walk
  newest-first through *pages* of such updates — spoofs were cheap and
  unbounded — to find the seller's real one. It is now a single row.
- **Burning a review slot is impossible.** A stranger used to be able to write
  the order's one review before the buyer did (only the 3 YAPP price
  discouraged it, and `orderReview`'s uniqueness then locked the buyer out).
  The gate refuses the write itself.

Battery cases s4d/s4e and s5c are the old gaps re-asserted as rejections.

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
   registration with `"rangeCountable" is a required property`: the
   meta-schema's dependency rules run on the literal keys before the
   `averageable` sugar is expanded, and the wasm validator
   (`DataContract.fromJSON(.., true, ..)`) compiles that check out, so it
   passes offline and fails on chain. Spell the `range*` axes out. Upstream fix
   and doc: dashpay/platform#4809. beta.2 relaxes exactly one link in that
   chain: `rangeCountable: true` now implies `countable: "countable"`, so
   `AVERAGE_FLAGS` no longer spells `countable`. Nothing else in the chain is
   inferred — assume a flag is required until the meta-schema says otherwise.
2. `tokenCost.create.contractId` must be the 32-byte array form in the
   registered JSON; base58 is refused at registration although the offline
   validator accepts it. The registration script decodes the placeholder.
3. Composite lookups on a unique index take no `limit`; lookups on a
   non-unique index take no `orderBy` (they inherit the page's direction).
4. Count sub-results are keyed by the hex of the bound identifier's bytes.
5. A writer gate fails as the SAME consensus error a value pair does —
   `ReferencedDocumentPropertyMismatchError`, state code 40127 — with the
   signing identity on the referring side: *"the document's $ownerId does not
   agree with the referenced document's sellerId (propertyAgreement on
   orderId)"*. `$ownerId` on the LEFT is what tells the two apart, which is how
   `lib/error-utils.ts` `isWriteGateError` classifies it: a value mismatch means
   stale data (reload and retry), a gate means the wrong signer (retrying never
   helps).
6. `immutable` rejects a replace that *removes* or *adds* a frozen property, not
   only one that changes it (code 40128). Every edit path here re-sends `storeId`
   verbatim, which is why the freeze was safe to add — audit the replace paths
   before freezing anything.

## Not in v2

- Sums of order amounts. Orders are encrypted to the seller, so revenue
  rankings would need a plaintext amount; order counts rank stores instead.
- Stock decrement on purchase. A buyer cannot edit the seller's item — now by
  consensus, not just by convention; an indexOnly reservation doctype with a sum
  axis is the shape if wanted.
- Buyer-initiated status updates (a self-service cancel). The writer gate on
  `orderStatusUpdate` deliberately excludes the buyer, matching what the app
  does today; a cancel flow would need a second doctype gated the other way
  rather than a loosened gate.
- `immutable` on `store` or `savedAddress`. Every property on both is something
  the owner edits.
