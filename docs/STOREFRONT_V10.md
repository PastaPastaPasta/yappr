# Storefront v10: the testnet production cut

Storefront v10 (client topology `v10`) is `contracts/yappr-storefront-contract.json` re-cut in place over v9 ([STOREFRONT_V9.md](STOREFRONT_V9.md)) for the testnet release, together with social v17 ([SOCIAL_V17.md](SOCIAL_V17.md)). It is registered fresh on testnet, so a removed property is simply gone: no v9 contract is updated. Everything not listed here is v9's (per-item shipping zones included), and the JSON-in-string fields stay JSON text (D19: the app validates `contactMethods`, `postalPatterns` and `tiers`, and filters `paymentUris` on read).

| # | Decision | What changes |
| --- | --- | --- |
| 1 | **No plaintext tracking or seller notes** (R-M3) | `orderStatusUpdate` drops `trackingNumber`, `trackingCarrier` and `message`. The type is permanent, unmoderated and readable by anyone through the buyer (`buyerFeed [orderId.$ownerId, $createdAt]`, kept for buyer notifications, D16), so a parcel number or a seller's note in clear was public and undeletable. They travel in an optional sealed note instead: `encryptedPayload` (1–2,560 B) and `nonce` (24 B), together or not at all (rule `sealed`). A status with no tracking and no note carries neither. |
| 2 | **A store's items by status** (D18) | `storeItem.storeStatusAndTime [storeId, status, $createdAt]`, beside `storeAndTime`. The store page reads its active items straight off it instead of filtering every status client-side. No cross-store discovery index (a later doctype can add one). |
| 3 | **https or ipfs images** (D14) | `storeItem.imageUrls` items: `^(https|ipfs)://.+$` (v9 also took `http://`). Store logos and banners already were. |
| 4 | **Reports** (owner decision) | A `report` type mirroring social's: exactly one of `storeId`, `itemId` (both `moderatedDocument`), `storeReviewId`, `itemReviewId` (`deletableDocument`: a review is owner-deletable), a `targetOwnerId` the reference checks (40127) and never the reporter (10419), `reason` 0–31 (8 needs a `note`), `note` ≤ 500 characters / 1,500 B, moderator-only `status`/`resolution` (`changeDocumentFields`), withdrawable only while unresolved (40147), a 90-day `ttl` and a moderators action fee (20M since D41, row 5; 50M before). One report per reporter and target (`byStore`, `byItem`, `byStoreReview`, `byItemReview`, unique); `byStatus` and `byModerator` serve the queue. `report` joins `moderatedDocumentTypes` with `deleteDocuments` and `changeDocumentFields`. |
| 5 | **Moderation parameters** (D41) | `ownerProtected` is false in the elected declaration. `actionFees.create.moderators` (pricing `feeMultiplier`): store 500,000,000, storeItem 20,000,000, storeReview 10,000,000, itemReview 5,000,000, report 20,000,000 credits (before: 1,000M, 50M, 16M, 8M, 50M). Storefront keeps single-moderator removal (no settled rule). The signed size is unchanged. The Sakura measurements below predate it and include the earlier fees. |

## The sealed note

Keyed like `orderDelivery` ([DIGITAL_PRODUCTS.md](DIGITAL_PRODUCTS.md)): both sides derive the order key from the order's own ECDH secret (`sellerOrderDeliveryKey` / `buyerOrderDeliveryKey`), and the note takes its own subkey so it can never be confused with a delivery:

- subkey = HKDF-SHA256(the order key, salt = the order id, info = `yappr/order-status/v1`, 32 B);
- XChaCha20-Poly1305 with a random 24-byte nonce and AAD `yappr/order-status/v1:<orderId>`;
- plaintext: UTF-8 JSON `{ "v": 1, "trackingNumber"?, "trackingCarrier"?, "message"? }`, read defensively.

`lib/crypto/digital-delivery.ts` (`encryptOrderStatusNote`, `decryptOrderStatusNote`, the codec) and `lib/services/order-status-service.ts` (`createStatusUpdate` with the order key; `openStatusNote`, `openStatusNotesAsSeller`, `openStatusNotesAsBuyer`) implement it. The seller's status form says the details go to the buyer privately; a note the seller cannot seal (no messaging key on the device) or that is over the cap is refused before signing, in plain words. A buyer whose key cannot open a note sees no tracking line rather than an error.

## Client: topology `v10`

`NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v10`. `storefrontStatusIsSealed()` and `storefrontIsV10()` in `lib/constants.ts` gate the sealed note, the active-items read and the report type: below v10 every write and read is v9's, byte for byte, and `lib/moderated-contracts.ts` leaves `report` out of the storefront's moderated and deletable types (the registered v9 contract has none). The report form and the storefront report queue are WP4; `moderatedContract('storefront').reportTargets()` and `reportsResolved()` are their plumbing.

## The file

| | Storefront v10 |
| --- | --- |
| sha256 | `69daf9799cb4f34552e4fce3ec7963a66f6f492f37d45baee4f6c83880bf05dc` |
| Signed create | ~18,704 B (v9 ~16,522 B), testnet and mainnet renderings, `--strict-size` |
| Registration fee | 60.00e9 by the fee table (11 types, 28 indexes); **60.72e9 measured on sakura** (3,643¢) |

## Sakura probe

Throwaway `5ASqUSu2maK1ibbmD3Go6L1MGypsTuvmSKN9LNcNA3XS` (owner corpus:81), 2026-10-17, every case as expected (first writes on a fresh contract):

| Proved | Outcome | Fee |
| --- | --- | --- |
| a store (1,000M action fee included); an active and a paused item | accepted | 1,101.5M; 120.9M / 104.4M |
| an item with an `http://` image | refused 10101 | 0 |
| active items, paused items (`storeStatusAndTime`); every item (`storeAndTime`) | one each; both | — |
| an order | accepted | 95.4M |
| a status with a sealed note; without one; a 2,560 B note | accepted | 61.5M; 40.1M; 111.1M |
| a payload without its nonce; a plaintext `trackingNumber`; a 2,561 B payload | refused 10422 `sealed`; 10101; refused before execution | 0 |
| a status written by the buyer | refused 40127 (only the seller) | 1.0M |
| the buyer's feed (`buyerFeed`) | the seller's updates | — |
| a store review | accepted | 105.5M |
| reports of the store, an item, a review (50M action fee included) | accepted | 61.3M / 61.4M / 61.5M |
| reporting one's own store; naming two targets | refused 10419; 10422 `oneTarget` | 0 |
| the interim moderator resolving a report | accepted | 4.8M |

## What WP4 still has to do

- The storefront report form and queue (store, listing, review), with product-specific copy.
- A note sealed while the messaging key is locked only opens after a reload once the key is unlocked.
