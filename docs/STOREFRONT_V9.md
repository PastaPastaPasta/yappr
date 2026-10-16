# Storefront v9: shipping zones per item

Storefront v9 (client topology `v9`) adds one optional property to
`contracts/yappr-storefront-contract.json`: `storeItem.shippingZoneIds`, the
store's shipping zones a product ships under. Everything else is storefront v8
(docs/NON_SOCIAL_CONTRACTS.md#storefront): no index, required list, rule,
reference or fee changes.

## Why

A store operator asked for country zones per item rather than per store, and
for the inventory import and export to carry them. Before v9 every shipped
product in a store shipped under all of its zones: a seller who ships wallets
worldwide but furniture only domestically had to open a second store.

## The property

```text
shippingZoneIds?: identifier[1..16]   unique   position 16   the store's zones this item ships under
```

```json
"shippingZoneIds": {"type": "array", "position": 16, "minItems": 1, "maxItems": 16, "uniqueItems": true, "items": {"type": "identifier"}}
```

Zones stay store-level definitions (name, countries, postal patterns, rates).
An item only picks some of them:

- **absent**: the item ships under every zone of its store, exactly as before
  v9. The client never writes an empty list (`minItems: 1` refuses one); "all
  zones" is the property's absence.
- **listed**: the item ships only under those zones. Ids that are not (or no
  longer) the store's zones are ignored. An item whose listed zones are all
  gone ships nowhere until the seller picks again.
- a **digital** item never ships, so the client never writes the property on
  one and drops it when a product turns digital.

### Why no `refersTo`

A reference would make a zone's delete break every item naming it: either
the delete is refused while an item names it, or the item becomes unwritable
(any replace re-sends a dangling id). Zones are edited and replaced far more
often than items, so the ids are plain identifiers and the client resolves
them against `shippingZoneService.getByStore(storeId)`. A forged id (another
store's zone) gains nothing: it is not one of the store's zones, so it is
ignored. Deleting a zone in the store manager warns how many products are
limited to it and how many name no other zone (those stop shipping).

## Checkout

`shippingZoneService.quoteShipping(zones, lines, address)` prices a cart:

1. each shipped line's candidate zones are its item's `shippingZoneIds`
   filtered to the store's zones (in the store's order), or every zone when
   the item names none; of those, the ones covering the address (country and
   postal patterns) are its matches, by priority. A line with no match is
   **unshippable**;
2. the cart is kept to as few shipments as it can be: lines with the fewest
   matches choose first, and each takes the highest-priority zone an earlier
   line already chose if one of its matches is such a zone, else its own
   highest-priority match. For example, with Domestic ($5, priority 1) and
   North America ($15, priority 2), an unrestricted mug and a belt limited to
   North America shipped to the US are one North America shipment, $15, not
   $5 + $15;
3. the lines a zone takes are one shipment, priced with
   `calculateRate(zone, { totalWeight, subtotal })` over that group's weight
   and subtotal; the shipping cost is the sum of the shipments.

With no item naming zones every line has the same matches and takes the
first, so the quote is exactly the one-zone price of the whole cart (a unit
test pins this). An unshippable line blocks the shipping step with a message
naming it: "Leather Wallet doesn't ship to Canada. Remove it from your cart
to continue." When a line that may use any zone ships nowhere, the store does
not serve the address at all, and the old "We cannot ship to this address"
stays.

Placing the order checks shipping again, fresh: the lines are re-read
uncached (`getShippingLines`) and the zones queried again (`getByStore` reads
no cache), then `checkShipping` runs on them, because a seller may limit an
item or delete a zone while the buyer is on the payment step, which re-runs
nothing there. `finalShippingCheck(previousCost, fresh)` decides: the same cost
places the order; a different cost updates the quote and stops with "Shipping
changed to <amount>. Please review your order.", so the buyer submits again; a
line that no longer ships, or shipping that cannot be checked, sends the buyer
back to the details step with that message.

The listings are read fresh for the quote (`cartService.getShippingLines`,
`storeItemService.getManyOrThrow`), before the zones, and a failed read **blocks** the shipping
step ("We couldn't check shipping for your cart. Please try again."; trying
again reads them again): a line priced without its item would ship under
every zone, so a limited item could slip through on a transient error. An
item that no longer exists weighs nothing and ships under every zone; the
cart's availability check refuses it before an order is placed.

A store with no zones, or zones that failed to load, still checks out without
a shipping charge, but only for lines no zone limits
(`checkShipping(zones, lines, address)`, the pure verdict both the shipping
step and order placement use). With no zones, a limited line ships nowhere
and is named like any other unshippable line; with the zones unreadable, its
limit cannot be checked, so checkout shows "We couldn't check shipping for
your cart" and reads again on the next try.

The ship-to restriction is enforced by the app, not by consensus: the
property has no `refersTo`, and the order's address and lines travel in the
encrypted order payload, which the contract cannot read.

## Client

- `lib/constants.ts`: `storefrontSupportsItemZones()` (v9 and later). Below
  v9 the editor section, the "Ships to" hints and the CSV column are hidden,
  and nothing writes the field (v8 refuses the unknown property, 10101).
- `lib/services/store-item-service.ts`: reads the list as base58
  (`decodeIdentifierList`), writes 32-byte ids (`encodeIdentifierList`),
  deduped, at most 16 (`ITEM_SHIPPING_ZONE_LIMIT`, read off the contract);
  an empty list clears it. A replace re-sends the zones it read on every
  build, so a build still on `v8` editing an item of an updated contract
  keeps them.
- The item editor offers "All of the store's shipping zones" (writes nothing)
  or "Only these zones" with a checkbox per store zone; at least one must be
  ticked. A stored id that is no longer a store zone is dropped from the
  selection shown, but an edit writes `shippingZoneIds` only when the seller
  touched these controls (`zoneUpdateFor`): otherwise the key is left out and
  the stored list stays, stale ids included, so a save never quietly lifts a
  limit it could not show. A product limited only to zones that no longer
  exist (or whose zones could not be loaded) gets a notice and a "Ship it
  under every zone" button, which counts as a change. A create writes the
  choice.
- The zone editor refuses `;` and `|` in a new or renamed zone name (the CSV
  separates names with them).
- The buyer's item page and the store manager's product list show "Ships to:
  Zone A, Zone B" for a limited item.

## Inventory CSV

On v9 the export has a `Shipping Zones` column right after `Weight`: the
item's zone NAMES joined with `; ` (a name may contain a comma), the same on
every row of the item, blank for every zone. Ids that are no longer the
store's are left out. The import reads `Shipping Zones` (also `Shipping Zone`,
`Zones`, `Ships To`) against the store's zone names (`readZoneCell`): the
cell is split on `;` and `|`, and every way to group consecutive parts
(re-joined with their own separators, trimmed) into zone names, exactly else
ignoring case, is tried, so an older zone name holding `;` or `|` still
reads. A blank part is tried both as a stray separator and as the start of a
name that begins with one (`;US`), so zones `US` and `;US` make `;US` read two
ways, and a reading of no zones at all (a cell of only separators) never
counts: a non-empty cell that names no zone is an error, never "every zone". One complete reading is used. More than one (zones "US", "Canada" and
"US; Canada" make "US; Canada" read two ways) is an error on that product,
"can be read more than one way…; rename that zone", never a guess, and the
export warns about such products. With no complete reading, the names no zone
has are reported as unknown. A product takes its first non-empty cell
(later rows that disagree are a warning); an unknown name or more than 16
zones is an error on that product. Below v9 the column is not exported and an
uploaded one is ignored with one file-level warning. An exported file parses
back to the same zone ids, except an item limited only to deleted zones: its
cell is blank (every zone), and the export says so.

## Size

The contract grows by 207 B: 16,208 → 16,415 B serialized, about 16,315 →
16,522 B signed as a create (cap 20,480). An item limited to `n` zones carries
about `19 + 34·n` more bytes.

## Updating v8 in place

v9 only adds an optional property at the next free position (16) of a type
whose `additionalProperties` is false, so a registered v8 contract takes it as
a data contract update (version 2): no document changes, no new ids. The
`--probes` run of `scripts/validate-contract-offline.mjs` checks the update
against wasm-dpp2's `validateUpdate` ("storefront v9 update"), and
`scripts/verify-storefront.mjs` s26 checks it live (skipped on a contract that
does not declare the property yet).
