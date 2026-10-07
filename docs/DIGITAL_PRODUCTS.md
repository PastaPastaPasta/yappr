# Digital products (storefront v6)

Stores can sell **digital products** alongside shipped ones: links (to
wherever the seller already hosts the goods), access codes, unique codes
such as license keys, downloadable files and redemption instructions. Delivery
happens on Dash Platform, encrypted end to end, with no server. A buyer's
purchases collect in a **Library** under My Orders.

## Delivery methods

Sellers are not tied to IPFS: only uploaded files use it, and files are
optional. Every method below is encrypted to the buyer, so a secret in a link
is as private as a license key.

| Seller has | Use | Buyer sees |
| --- | --- | --- |
| A download page, cloud drive, course portal, invite or video link | **Link** (`https://…`, `http://…`) | the link, with a copy button |
| A link with the secret in it (`…/dl?q=s3cr3t`) | **Link**, as is | the same |
| A link that expires (an S3 or GCS signed URL) | the deliver modal's per-order link, made fresh for each order (a product's links are reused for months) | the same |
| A link plus a password or access code | **Link** with its access code | the link, and the code to copy |
| A code every buyer shares (voucher, password, account login) | **Code** | the code to copy |
| A different code or link per unit (license keys, gift cards, single-use invites) | **Unique codes**, one per line; `https://… PASSWORD` pairs a link with its own code | one per unit; a line that starts with a URL is a link |
| A torrent | **Link** (`magnet:?…`) | the link (opens their torrent client) |
| A file to hand over directly | **File** (needs IPFS storage connected) | a download, decrypted in the browser |
| Something only this buyer gets (a custom build, a personal invite) | the deliver modal's per-order link, code or file, plus the message | the same, for this order only |
| Steps to redeem or install | **Instructions** | the text, with every delivery |

Links accept http(s), magnet, and ipfs:// URLs that name a CID; a bare host
(`drive.google.com/…`) gets `https://`. Any other scheme (`javascript:`,
`data:`) is refused, so the seller sends such an address as a code instead.

Client gate: `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v6` (`storefrontSupportsDigital()`
in `lib/constants.ts`). Below v6 nothing changes: the digital UI is hidden, no
new property is written, and the v5 write surface is byte-identical.

## Contract changes (`contracts/yappr-storefront-contract.json`)

Digital products add one property and two doctypes. v6 is also the mainnet
re-cut (action fees instead of YAPP, elected moderation, store categories, no
stored buyer ids, smaller payloads: see
[NON_SOCIAL_CONTRACTS.md](./NON_SOCIAL_CONTRACTS.md#what-v6-changed-from-v5)),
so v5 writes do not all carry over. A new contract id is a fresh start either
way.

| Doctype | Shape | Serves |
| --- | --- | --- |
| `storeItem.fulfillment` | optional enum `shipped` \| `digital`; absent = `shipped` | product type; checkout skips shipping for digital lines |
| `itemDeliverable` | `itemId`→storeItem (moderatedDocument) **writer-gated** `{$ownerId: $ownerId}`; `immutable [itemId]`; unique per item; mutable | the seller's private delivery kit |
| `orderDelivery` | `orderId`→storeOrder **writer-gated to the seller** `{sellerId: $ownerId}`; `documentsMutable: false`; `canBeDeleted: false`; `buyerDeliveries [orderId.$ownerId, $createdAt]` | delivered goods; the buyer's library feed |

`orderDelivery` uses the same gate as `orderStatusUpdate`. Only the order's
seller can write one, and it stores no buyer id: `buyerDeliveries` files it
under the order's own `$ownerId`, read through `orderId`. So every delivery a
buyer sees comes from their seller, and a stranger cannot plant one.
A delivery is permanent and append-only, so it doubles as the buyer's receipt.
A seller can send again (for example, to fix a broken file); every delivery
stays in the library.

## Encryption

Three layers. Each key travels only inside a ciphertext.

1. **Files** (only when the seller uploads one). The seller's browser encrypts each file with XChaCha20-Poly1305
   under a fresh random 32-byte key, then pins the ciphertext to IPFS through
   the connected Storacha/Pinata provider. The public CID reveals nothing. The
   buyer's browser downloads it from any gateway and decrypts it. A gateway that
   returns tampered bytes fails authentication, and the next gateway is tried.
2. **The kit** (`itemDeliverable`). The links, codes and files (with their
   keys), plus unique codes, instructions and timing, ECIES-encrypted to the **seller's own**
   encryption key. Any of the seller's devices can fulfil an order. The AAD binds
   each kit to its item id.
3. **The delivery** (`orderDelivery`). Checkout already encrypts an order to the
   seller with an ephemeral key derived deterministically from the buyer's key,
   the order nonce and the store id. Both parties can therefore compute the same
   per-order ECDH secret:
   - the seller from its private key and the ephemeral public key at the head of
     `storeOrder.encryptedPayload`;
   - the buyer from the re-derived ephemeral private key and the seller's public
     key.

   The delivery key is `HKDF(SHA256(shared), salt = orderId)`, and the AAD binds
   it to the order. No lookup of the buyer's public key is needed. Orders placed
   before the deterministic derivation existed cannot be delivered this way,
   because the buyer could never re-derive their key.

Code: `lib/crypto/digital-delivery.ts`, `lib/services/digital-file-service.ts`.

## Flows

**Seller lists a product** (`/store/item/add`): picks *Digital*, adds links
(each with an optional access code), codes and/or files (encrypted before
upload), optionally pastes unique codes (one per unit sold) and instructions,
and chooses the timing: *after I confirm payment* (default) or *as soon as it
is ordered*.

**Buyer checks out**: digital lines are badged. An all-digital cart skips the
shipping address, and shipping rates count only shippable lines (weight and
subtotal). Each order line records its `fulfillment` in the encrypted order
payload.

**Seller fulfils** (`/orders/seller`):
- **Deliver now** on an order opens the deliver modal. It shows each line's kit,
  lets the seller add links, codes or files for this order only, takes a message,
  and optionally marks the order Delivered (default on for all-digital orders).
  A delivery too large for one receipt goes out in parts: the seller unticks
  some lines, or sends fewer of a line's unique codes, delivers, then
  delivers the rest. Each code line defaults to the codes it may still be
  owed: codes a pending receipt (or one unreadable here) may hold are never
  issued again unless the seller raises the count. The order can be marked
  Delivered only when confirmed receipts plus this one hold every line, all
  of a code line's codes included. Goods go out under the listing's title,
  not the buyer-written one.
- **Deliver all** sends every *ready* order in one pass. An order is ready when:
  - it has digital lines and nothing has been delivered;
  - it is not closed;
  - every digital line agrees with the seller's own `storeItem`: a product
    this store currently lists as digital, with the listed title, variant,
    price and currency. The order payload is buyer-written and the kit sent is
    chosen by `itemId`, so a line's `fulfillment`, title and price prove
    nothing: an expensive product dressed as a cheap one must not go out;
  - every line has a kit with enough keys, and the delivery fits the payload
    cap;
  - every kit's timing is met;
  - no product's pool gives more than 10 keys to the order, over all its lines
    (larger key orders are left for the seller to review).

  Listings are read from Platform, never the document cache. Right before
  each order is fulfilled, "Deliver all" re-reads the listings, the order's
  latest status, its deliveries and its items' kits (decrypted), so an order
  cancelled, refunded or delivered from another device since the page
  loaded, or whose kit timing changed, is held, and so is one whose re-read
  fails. Status changes on the page wait until the batch ends.

  The deliver modal runs the same listing check. A line naming no digital
  product of the order's store (or whose listing could not be read) cannot be
  delivered; a title, variant or price that differs is shown, and the seller
  confirms they checked it before delivering.

  An order whose delivery or status read failed is never ready, because a
  failed read must not pass for "nothing delivered". This is the closest a
  server-less store gets to automatic delivery: the seller's open browser is
  the fulfilment worker.
- Unique codes (license keys and the like) come off the front of the pool, `quantity` per line. The steps
  are ordered so a key is never sent twice:
  1. The delivery is sealed (encoded and encrypted) before anything is
     written, so one that cannot be built takes no keys. The reduced pool is
     then saved **before** the delivery is published, at the revision it was
     read. A pool changed elsewhere (another tab or device
     delivered meanwhile) refuses the write, and nothing is sent.
  2. Every write whose response failed is reconciled against the chain, since a
     broadcast can land after its response times out. A kit write is
     recognised by its exact ciphertext, which is unique per attempt, so another
     tab's identical reservation is never mistaken for this one. A delivery is
     recognised by its nonce.
  3. Keys go back into the pool only when the reservation itself was the step
     that failed. A delivery that cannot be confirmed keeps its keys reserved,
     because "not seen yet" does not prove it will never land. The seller gets
     the exact keys to check (shown on screen, never logged).
  4. A broadcast whose confirmation timed out stays *pending*: the order is not
     marked Delivered and the keys stay reserved. The delivery shows in the
     buyer's library once it lands, and the seller is shown the codes it holds
     in case it never does.
  5. A bulk run re-plans each order against the pool the previous one left.
- A pool keeps each code once: a code pasted twice is stored once, so it can
  never reach two buyers.
- The product editor writes the kit only when the seller changed it. It writes
  at the revision it read, so a stale editor can never restore keys that have
  since been sent. A first save that is broadcast but not yet seen on chain is
  not taken as saved: the editor stays dirty and asks the seller to save again.
  When a failed save finds a kit on chain other than the one the draft was
  edited from, it reloads that kit (content and revision together) for review
  instead of attaching the new revision to the old draft.
- A new product whose create was broadcast but not seen is held as pending,
  not as an edit: the next save looks for that exact listing first, and the
  kit (which must reference it) is written only once it is found. If it never
  appears, the seller may choose to create it again.

**Buyer receives**: the order card shows *Your digital items*, and the
**Library** tab lists every delivery. Links open in a new tab, codes and access
codes copy with one tap, and files download and decrypt in the browser.
Decoding drops any URL that is not http(s), magnet or ipfs, so a seller cannot
deliver a `javascript:` link.

## Limits

- Each encrypted payload is at most 5,120 bytes (contract cap, read off the
  contract JSON). That holds roughly 100 unique codes in a kit, and the client refuses a larger kit before
  writing. It also refuses a kit that could not go out for one unit in one
  delivery, so every kit it saves is deliverable, one code per receipt if need
  be. A receipt's size depends on the kit alone: the title is budgeted at its
  largest (200 characters at their largest once serialized), and a receipt
  names the variant by a fixed-size reference (16 hex characters of SHA-256)
  plus a label cut to 60 characters, never by the listing's variant key. So
  no listing edit (from this device or another, at any time) can make a saved
  kit undeliverable, and the fit needs no coordination between the listing
  and the kit. Files have no such cap: they live on IPFS, up to 100 MB each,
  because they are encrypted in memory.
- "Deliver all" holds a line whose product is no longer on sale (paused, sold
  out or deleted); the seller can still deliver an earlier purchase by hand.
- Delivery is the seller's act; consensus cannot see payment. The **buyer**
  writes the order payload, including line quantities and prices. With *as
  soon as it is ordered*, delivery happens whether or not anything was paid,
  which suits free goods. Quantities must be whole numbers from 1 to 1000;
  anything else blocks delivery.
- A delivered file key cannot be revoked. A refund does not take the goods back,
  just as with any digital download.
- Bulk delivery needs the seller's page open, and the device needs the seller's
  encryption key.
- The buyer derives the delivery key with the seller's *current* encryption
  public key. If the seller rotates that key, older deliveries stop decrypting
  for the buyer until the seller sends them again.
- The Library reads the `buyerDeliveries` index page by page, so it covers
  every delivery, including orders older than the loaded order history (those
  orders are fetched for decryption).

## Moderation (open questions, not decided here)

The storefront contract keeps v5's moderation: a contract-owner banlist,
suspensions and warnings, and moderator delete on reviews only.

- A banned or suspended seller cannot write an `orderDelivery`, so orders a
  buyer already paid for cannot be delivered until the ban ends.
- Stores and items have no moderator takedown (41115), and kits and
  deliveries are encrypted, so a moderator can neither see nor remove what a
  digital product delivers. The banlist only stops the seller's future
  writes; the listing stays up.
- `itemDeliverable` and `orderDelivery` give moderators no ability, so no
  moderator removal frees their unique slot (unlike the review slots, QA U7).

## Deploy

Register the re-cut contract and flip the topology together:

```bash
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-storefront-contract.json --dry-run
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-storefront-contract.json --persona <n>
NETWORK=devnet node scripts/verify-storefront.mjs --contract <id>          # s22 covers v6
# then NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID=<id> and NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v6
```
