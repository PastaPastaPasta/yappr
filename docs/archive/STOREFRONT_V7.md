# Storefront v7: variants as a typed table

Storefront v7 (client topology `v7`) changes one thing in
`contracts/yappr-storefront-contract.json`: `storeItem.variants` stops being a
JSON string and becomes a **typed table**, parallel lists the contract keeps
aligned. Everything else is storefront v6 (docs/NON_SOCIAL_CONTRACTS.md#storefront):
moderation, action fees (store 1,000M, item 50M, store review 16M, item
review 8M), references, digital doctypes and indexes are unchanged. There is
no migration: v6 stores and items on sakura are abandoned, and a listing is
recreated on v7.

## Why

v6 capped the variants JSON at 5,120 bytes, and a real seller hit it with
14 combinations: 7 primary colours × 2 pack sizes, imported with compound
labels such as "Primary color: Red · Pack Size: Single Piece", prices 100 and
353, and stock, a SKU and an image per combination. The JSON repeats every
label and URL, so it grows fast:

| Listing | v6 JSON | v7 table, stored | v7 table, in the transition |
| --- | --- | --- | --- |
| 7 × 2 = 14 combinations, as the v6 import wrote it (one axis of compound labels, an image URL each) | 3,582 B | 469 B | 541 B |
| the same, as two axes | 2,638 B | | |
| 5 axes, 100 combinations, stock and SKU each | 9,669 B (cannot be stored) | 2,942 B | 2,691 B |

`Value::has_data_larger_than` applies the 5,120-byte cap to each value, not to
a list, so the table has no cap of its own. Its practical limit is the
20,480-byte state transition, which the client checks before signing.

## The table

```text
variants: {                         required: axes, options, optionIds, optionAxes, nextOptionId, selectors, prices
  axes:         string[1..5]        unique, ≤ 32 chars      option types in display order ("Color")
  options:      string[1..64]       ≤ 40 chars              option names, axis by axis ("Red")
  optionIds:    u8[1..64]           unique, 1–254           a stable id per option, never reused
  optionAxes:   u8[1..64]           0–4                     the axis of each option
  nextOptionId: u8                  2–255                   the next id to hand out
  selectors:    bytes(1..5)[1..256] unique                  one per combination: an option id per axis, in axis order
  prices:       u64[1..256]         ≤ 2^53−1                per combination, in the item currency's smallest unit
  stocks?:      u32[]                                       present when the item tracks stock (every combination or none)
  skus?:        string[]            ≤ 32 chars              '' for none
  weights?:     u32[]               grams                   0 = the item's weight
  images?:      u8[]                0–12                    1-based index into imageUrls; 0 = the item's first image
}
```

`imageUrls` rises from 8 to 12, so a colour can have its own photo. Arrays in
Platform hold scalars only (no objects, no lists of lists), which is why a
combination is a row across parallel lists rather than an object.

Descriptions are omitted on the new members and the inherited ones are cut to
120 characters, so the contract is 17,661 B serialized, about 17,768 B signed
(v6 was 17,103 B; the cap is 20,480).

### Rules (10422)

| Rule | Holds when |
| --- | --- |
| `pricedHasCurrency` | a priced item (basePrice or variants) names its currency (v6's rule, kept) |
| `onePrice` | not both `basePrice` and `variants` |
| `oneStock` | not both `stockQuantity` and `variants` |
| `optionTable` | `optionIds` and `optionAxes` have one entry per option |
| `comboTable` | `selectors` and `prices` have one entry per combination |
| `comboStocks`, `comboSkus`, `comboWeights`, `comboImages` | each list is absent or has one entry per combination |

The JSON schema (10101) adds what the rules don't cover: the `required` list
inside `variants`, `additionalProperties: false`, unique axis names, option
ids and selectors (so a combination can't be listed twice), selector length
1–5 and every bound above. The client checks the rest: each selector names one
option of each axis in axis order, option names are unique within an axis,
ids sit below `nextOptionId`, images point at real URLs, and the whole
transition fits.

An item SKU and weight may stand beside the table, as a parent SKU and a
default weight.

## Identity

- An **option** keeps its id for the life of the listing. New options take
  `nextOptionId`, which only grows, so a deleted option's id never comes back.
  Without that, deleting "Purple" and adding "Teal" would quietly turn every
  cart line naming Purple into Teal.
- A **combination** is identified by its option-id set, written sorted and
  dot-joined: `"3.9"`. Carts, order lines, digital kit receipts and the item
  page all use this canonical id. No separate id list or counter is stored.
  - Renaming or reordering options, or reordering axes, keeps every id.
  - Adding or removing an axis makes a different product grid, so every
    combination gets a new id. A cart line naming an old one reads "Selected
    option is no longer available".
- Five option types and option ids 1–254 are the app's identity bounds on
  every topology: they keep a variant id short ("254.254.254.254.254", at
  most 19 characters) for carts, orders and receipts. A v1–v6 JSON table past
  them is read as unreadable (it cannot be bought, its options cannot be
  edited, and other edits write it back as stored). v7's storage caps (name and
  SKU lengths, 64 options, all-or-none stock) apply to v7 only.
- Ids are never renumbered, since that would give an old cart line or kit
  target another combination's id. A listing that has used all 254 (options
  added over its life, not at once) takes no more options; the seller lists
  the product again.
- For the same reason a listing saved with options keeps its table: the
  `nextOptionId` counter lives in it, and a fresh table would start again at
  1. The seller can remove options and option types down to one option, but
  not turn options off; to sell the product without them, they list it again.

## Orders, carts and kits

- **Cart lines and order lines** carry `variantId` and `variantLabel`
  ("Red / 4 Pack", at most 120 characters) and `sku` snapshots, taken when the
  line is added, like its price. The order copies them into the encrypted
  payload, so a past order reads without the listing, and checkout reads
  nothing between its pre-payment size check and the order.
- **On v1–v6** option ids are numbered by position on every read, so a cart
  line there must match its label too, and kit assets cannot target options
  (only untargeted assets are delivered).
- **Checkout** charges the combination's price. Shipping weighs each line by
  its combination's weight, else the item's.
- **Digital kit assets** target an option-id subset. An asset applies to every
  variant whose combination contains all of its ids: one id means every "Red";
  one id per axis means exactly one variant; no ids means every variant.
- **Receipts** (`orderDelivery`) name the variant by its canonical id. The id
  is at most 19 characters, so a receipt's size never depends on the
  listing's names.

## Client

- **`lib/storefront/variant-codec.ts`** (pure, Vitest): the model (`ItemVariants`:
  axes of `{id, name}` options and combinations of `{id, optionIds, price,
  stock?, sku?, weight?, image?}`). It covers:
  - encoding and tolerant decoding;
  - lookups;
  - the buyer's per-axis picker (`selectableOptionIds` only offers options
    that complete an in-stock combination, and never invents one);
  - price ranges;
  - `variantProblems` (sentences for the seller);
  - the editing operations;
  - `variantsFromRows` for the import.
- **`lib/storefront/storefront-contract.ts`**: `VARIANT_LIMITS`, read off the
  contract JSON, and the whole-transition budget.
  - `platformValueBytes` sizes a document the way the transition serializes
    it: a one-byte tag, then a varint length or varint integer, keys
    included. Measured against the beta.3 SDK, it is exact up to a constant
    154–159 B envelope.
  - `itemSizeError` refuses a listing above 19,900 B before signing. The
    contract's own maximum (5 axes, 256 combinations, every list at its
    largest values) is 17,498 B unsigned, so it fits.
- **`lib/storefront/legacy-variants.ts`**: converts to and from the v1–v6 JSON
  string. Testnet production and the /testing build still run storefront v1,
  so `store-item-service` reads and writes either shape, and every other
  surface sees the one model. Per-combination weights are v7 only.
- **The item editor** (`components/store/variant-editor.tsx`) handles:
  - up to 5 option types, with rename, reorder and remove for types and
    options;
  - a combinations table with price, stock, SKU, weight and image;
  - "stop offering" and "add the missing combinations";
  - bulk "set every price/stock", for all combinations or every combination
    with one option.
- **The CSV import** (`lib/upload/inventory-parser.ts`) reads:
  - Shopify-style `OptionN Name`/`OptionN Value` columns;
  - the `variant`/`subVariant` columns;
  - compound labels, split on `·`, `|` or `;` into `Axis: Value` pieces. A
    split is accepted only when every row of a product yields the same axes;
    otherwise the value is kept whole, with a warning.

  One row is one combination. A combination is never invented, and a repeated
  one is an error. The export writes the same columns, so a round trip
  reproduces the table.

## Verified live (sakura, 5.0.0-beta.3)

These were checked on a throwaway probe contract (`7fvpDkA1rTqNZTJyULmf96hARsk1Tq1Ra81c7ippkhPB`,
owned by bot 2, carrying exactly v7's `variants` object and rules) before the
cut was frozen:

- **The node enforces the nested `required` list.** A table missing
  `nextOptionId`, `axes` or `options` is refused with 10101 `"… is a required
  property, path: /variants"`, and an unknown key with 10101 `additionalProperties`.
- **Typed integer lists can be written from plain JS numbers** through the
  facade create (`sdk.documents.create`), the hand-built batch the client
  sends for a priced create, and the facade replace (`sdk.documents.replace`).
  All of them read back value for value, empty SKU strings included.
- **`uniqueItems` holds on a list of byte arrays.** Two equal selectors are
  refused with 10101 `"… has non-unique elements, path: /variants/selectors"`.
  The same goes for a repeated option id, a six-byte selector and an option id
  of 255.
- **The rules hold on the node.** Each of `comboTable`, `optionTable`,
  `comboStocks`, `onePrice` and `oneStock` refused its case with 10422.

`scripts/verify-storefront.mjs` s25 repeats all of this on the registered
contract, and s20 broadcasts every refused rule case.

## Fees

At $60/DASH, 1M credits ≈ 0.06¢. The probe contract had none of storeItem's
other fields and no action fee, so these are network fees only:

| Write | Credits |
| --- | --- |
| create, 14 combinations (stock and SKU) | 40.19M (2.4¢) |
| create, 5 axes × 100 combinations (stock and SKU) | 105.27M (6.3¢) |
| replace every stock cell of the 14-combination item | 2.45M (0.15¢) |

A real `storeItem` create adds the 50M (3¢) action fee and its other fields.
s25 measures the registered contract's fees.

## Registered (sakura, 2026-10-09)

Storefront v7 is live on sakura as `2P2KqWzZXqULWMD1e2tL1dr67YAjNqUTP8cyNGkekzdz`, at maker nonce 12 in the devnet
contract group, and serves `/devnet` ([SAKURA_BETA3_DEPLOY.md](SAKURA_BETA3_DEPLOY.md)). It is pinned to this file
at sha256 `dac95112a0ffe7fa083484faf21452af923f84f1692d45d4f51ea42519afed0b`: 17,767 B signed, 17,661 B on chain.
The create cost 51,687,225,460 credits (about 3,101¢).

The storefront seed wrote 246 documents on it: 7 stores, 51 items and 28 orders, including the seller's
14-combination toy and a 5-axis × 100-combination cube. All 155 checks of `scripts/verify-storefront.mjs` pass on it,
s14 and s23 after a re-run. All of s25 passes, and every v7 rule case in s20 is refused with 10422. Measured by s25
on the registered contract (action fee included):

| Write | Credits |
| --- | --- |
| create, 14 combinations (stock, SKU, weight, image) | 107.32M (6.44¢) |
| create, 5 axes × 100 combinations | 161.06M (9.66¢) |
| replace every stock cell of the 14-combination item | 4.89M (0.29¢) |
