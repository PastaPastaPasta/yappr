# Digital products (storefront v6)

Stores can sell **digital products** alongside shipped ones: downloadable
files, links, license keys and redemption instructions. Delivery happens on
Dash Platform, encrypted end to end, with no server. A buyer's purchases
collect in a **Library** under My Orders.

Client gate: `NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v6` (`storefrontSupportsDigital()`
in `lib/constants.ts`). Below v6 nothing changes: the digital UI is hidden, no
new property is written, and the v5 write surface is byte-identical.

## Contract changes (`contracts/yappr-storefront-contract.json`)

v6 is v5 plus one property and two doctypes. Nothing existing changes shape, so
v5 documents and writes stay valid under v6. A new contract id is still a fresh
start (see `docs/NON_SOCIAL_CONTRACTS.md`).

| Doctype | Shape | Serves |
| --- | --- | --- |
| `storeItem.fulfillment` | optional enum `shipped` \| `digital`; absent = `shipped` | product type; checkout skips shipping for digital lines |
| `itemDeliverable` | `itemId`→storeItem **writer-gated** `{$ownerId: $ownerId}`; `immutable [itemId]`; unique per item; mutable | the seller's private delivery kit |
| `orderDelivery` | `orderId`→storeOrder **writer-gated to the seller** `{$ownerId: buyerId, sellerId: $ownerId}`; `documentsMutable: false`; `canBeDeleted: false` | delivered goods; the buyer's library feed (`buyerDeliveries`) |

`orderDelivery` uses the same gate as `orderStatusUpdate`. Only the order's
seller can write one, and `buyerId` must be the order's real buyer. So every
delivery a buyer sees comes from their seller, and a stranger cannot plant one.
A delivery is permanent and append-only, so it doubles as the buyer's receipt.
A seller can send again (for example, to fix a broken file); every delivery
stays in the library.

## Encryption

Three layers. Each key travels only inside a ciphertext.

1. **Files.** The seller's browser encrypts each file with XChaCha20-Poly1305
   under a fresh random 32-byte key, then pins the ciphertext to IPFS through
   the connected Storacha/Pinata provider. The public CID reveals nothing. The
   buyer's browser downloads it from any gateway and decrypts it. A gateway that
   returns tampered bytes fails authentication, and the next gateway is tried.
2. **The kit** (`itemDeliverable`). The asset list, including file keys, plus
   license keys, instructions and timing, ECIES-encrypted to the **seller's own**
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

**Seller lists a product** (`/store/item/add`): picks *Digital*, uploads files
(encrypted before upload) and/or adds links, optionally pastes a pool of license
keys (one per unit sold) and instructions, and chooses the timing:
*after I confirm payment* (default) or *as soon as it is ordered*.

**Buyer checks out**: digital lines are badged. An all-digital cart skips the
shipping address, and shipping rates count only shippable lines (weight and
subtotal). Each order line records its `fulfillment` in the encrypted order
payload.

**Seller fulfils** (`/orders/seller`):
- **Deliver now** on an order opens the deliver modal. It shows each line's kit,
  lets the seller attach files or links for this order only, takes a message,
  and optionally marks the order Delivered (default on for all-digital orders).
- **Deliver all** sends every *ready* order in one pass. An order is ready when:
  - it has digital lines and nothing has been delivered;
  - it is not closed;
  - every line has a kit with enough keys;
  - every kit's timing is met;
  - no line draws more than 10 keys (larger key orders are left for the seller
    to review).

  An order whose delivery or status read failed is never ready, because a
  failed read must not pass for "nothing delivered". This is the closest a
  server-less store gets to automatic delivery: the seller's open browser is
  the fulfilment worker.
- License keys come off the front of the pool, `quantity` per line. The steps
  are ordered so a key is never sent twice:
  1. The reduced pool is saved **before** the delivery is published, at the
     revision it was read. A pool changed elsewhere (another tab or device
     delivered meanwhile) refuses the write, and nothing is sent.
  2. If the delivery then fails, the keys are put back. If even that fails, the
     seller is told exactly which keys to re-add.
  3. A bulk run re-plans each order against the pool the previous one left.
- The product editor writes the kit only when the seller changed it. It writes
  at the revision it read, so a stale editor can never restore keys that have
  since been sent.

**Buyer receives**: the order card shows *Your digital items*, and the
**Library** tab lists every delivery. Files download and decrypt in the browser,
license keys copy with one tap, and links open in a new tab. Decoding drops any
URL that is not http(s) or ipfs, so a seller cannot deliver a `javascript:` link.

## Limits

- Each encrypted payload is at most 16,000 bytes (contract cap). That holds
  roughly 300 license keys in a kit, and the client refuses a larger kit before
  writing. Files have no such cap: they live on IPFS, up to 100 MB each, because
  they are encrypted in memory.
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
- Today the Library is built from the buyer's loaded orders (`orderId in`
  queries). The `buyerDeliveries` index is there for a paginated library or
  notifications that do not start from the order list.

## Deploy

Register the re-cut contract and flip the topology together:

```bash
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-storefront-contract.json --dry-run
NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-storefront-contract.json --persona <n>
NETWORK=devnet node scripts/verify-storefront.mjs --contract <id>          # s22 covers v6
# then NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID=<id> and NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v6
```
