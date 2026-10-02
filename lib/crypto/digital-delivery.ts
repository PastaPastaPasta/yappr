/**
 * Cryptography for digital product delivery (storefront v6, docs/DIGITAL_PRODUCTS.md).
 *
 * Three layers, none of which needs a server:
 *
 * 1. FILES. Each file a seller sells is encrypted in the browser under its own
 *    random 32-byte key before it is pinned to IPFS. The public CID therefore
 *    reveals nothing; the key travels only inside encrypted documents.
 *
 * 2. THE SELLER'S KIT (`itemDeliverable`). The file keys, links and license
 *    keys for an item are ECIES-encrypted to the seller's OWN encryption key,
 *    so any device holding that key can fulfil an order.
 *
 * 3. THE DELIVERY (`orderDelivery`). An order's payload is ECIES-encrypted to
 *    the seller with an ephemeral key the buyer derives deterministically
 *    (`deriveOrderEphemeralKey`). Both parties can therefore compute the same
 *    ECDH secret for that order — the seller from its private key and the
 *    ephemeral public key at the head of the order ciphertext, the buyer from
 *    the re-derived ephemeral private key and the seller's public key — and
 *    the delivery key is HKDF of that secret, salted with the order id. No
 *    lookup of the buyer's public key is needed, and the key is unique per
 *    order.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { ecdhSharedX } from './ecdh'
import { getPublicKey } from './keys'
import { bytesEqual } from '../bytes'
import { privateFeedCryptoService } from '../services/private-feed-crypto-service'

const KEY_SIZE = 32
const NONCE_SIZE = 24
const TAG_SIZE = 16
/** Compressed secp256k1 point at the head of every ECIES ciphertext. */
const EPHEMERAL_PUBKEY_SIZE = 33

/** Bytes each layer adds to its plaintext, for sizing against storage caps. */
export const FILE_CIPHERTEXT_OVERHEAD = NONCE_SIZE + TAG_SIZE
export const KIT_CIPHERTEXT_OVERHEAD = EPHEMERAL_PUBKEY_SIZE + TAG_SIZE
export const DELIVERY_CIPHERTEXT_OVERHEAD = TAG_SIZE

const FILE_AAD = 'yappr/digital-file/v1'
const DELIVERABLE_AAD = 'yappr/item-deliverable/v1'
const DELIVERY_INFO = 'yappr/order-delivery/v1'

const utf8 = (value: string) => new TextEncoder().encode(value)

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Encrypt a file under a fresh key. Output is nonce || ciphertext, written
 * into one buffer the caller can hand to `Blob` (files run to 100 MB, so the
 * cipher writes in place rather than through a concatenated copy).
 */
export function encryptDigitalFile(plaintext: Uint8Array): { ciphertext: Uint8Array<ArrayBuffer>; key: Uint8Array } {
  const key = randomBytes(KEY_SIZE)
  const ciphertext = new Uint8Array(NONCE_SIZE + plaintext.length + TAG_SIZE)
  const nonce = randomBytes(NONCE_SIZE)
  ciphertext.set(nonce)
  xchacha20poly1305(key, nonce, utf8(FILE_AAD)).encrypt(plaintext, ciphertext.subarray(NONCE_SIZE))
  return { ciphertext, key }
}

/** Decrypt a file produced by {@link encryptDigitalFile}. Throws if the key or bytes are wrong. */
export function decryptDigitalFile(ciphertext: Uint8Array, key: Uint8Array): Uint8Array<ArrayBuffer> {
  if (key.length !== KEY_SIZE) throw new Error('Invalid file key')
  if (ciphertext.length < NONCE_SIZE + TAG_SIZE) throw new Error('File is truncated')
  const nonce = ciphertext.subarray(0, NONCE_SIZE)
  const plaintext = new Uint8Array(ciphertext.length - NONCE_SIZE - TAG_SIZE)
  xchacha20poly1305(key, nonce, utf8(FILE_AAD)).decrypt(ciphertext.subarray(NONCE_SIZE), plaintext)
  return plaintext
}

// ---------------------------------------------------------------------------
// Seller kits (encrypted to the seller's own key)
// ---------------------------------------------------------------------------

/** Binds a kit to its item, so one item's ciphertext cannot be replayed under another. */
const deliverableAad = (itemId: string) => utf8(`${DELIVERABLE_AAD}:${itemId}`)

export async function encryptForSelf(
  plaintext: Uint8Array,
  sellerPrivateKey: Uint8Array,
  itemId: string
): Promise<Uint8Array> {
  return privateFeedCryptoService.eciesEncrypt(getPublicKey(sellerPrivateKey), plaintext, deliverableAad(itemId))
}

export async function decryptForSelf(
  ciphertext: Uint8Array,
  sellerPrivateKey: Uint8Array,
  itemId: string
): Promise<Uint8Array> {
  return privateFeedCryptoService.eciesDecrypt(sellerPrivateKey, ciphertext, deliverableAad(itemId))
}

// ---------------------------------------------------------------------------
// Order deliveries (keyed from the order's own ECDH secret)
// ---------------------------------------------------------------------------

/** The parts of a storeOrder the delivery key depends on. */
export interface OrderKeyMaterial {
  id: string
  storeId: string
  encryptedPayload: Uint8Array
  nonce: Uint8Array
}

function deliveryKeyFromShared(sharedX: Uint8Array, orderId: string): Uint8Array {
  return hkdf(sha256, sha256(sharedX), utf8(orderId), utf8(DELIVERY_INFO), KEY_SIZE)
}

function orderEphemeralPublicKey(order: OrderKeyMaterial): Uint8Array {
  if (order.encryptedPayload.length <= EPHEMERAL_PUBKEY_SIZE) {
    throw new Error('Order payload is not ECIES-encrypted')
  }
  return order.encryptedPayload.subarray(0, EPHEMERAL_PUBKEY_SIZE)
}

/** The seller's view: ECDH(seller private key, the order's ephemeral public key). */
export function sellerOrderDeliveryKey(order: OrderKeyMaterial, sellerPrivateKey: Uint8Array): Uint8Array {
  return deliveryKeyFromShared(ecdhSharedX(sellerPrivateKey, orderEphemeralPublicKey(order)), order.id)
}

/**
 * The buyer's view: ECDH(re-derived ephemeral private key, seller public key).
 * Throws for an order whose ephemeral key was random (orders placed before the
 * deterministic derivation), which no buyer can ever re-derive.
 */
export function buyerOrderDeliveryKey(
  order: OrderKeyMaterial,
  buyerPrivateKey: Uint8Array,
  sellerPublicKey: Uint8Array
): Uint8Array {
  const ephemeralPrivateKey = privateFeedCryptoService.deriveOrderEphemeralKey(buyerPrivateKey, order.nonce, order.storeId)
  if (!bytesEqual(getPublicKey(ephemeralPrivateKey), orderEphemeralPublicKey(order))) {
    throw new Error('This order was not encrypted with a key this account can re-derive')
  }
  return deliveryKeyFromShared(ecdhSharedX(ephemeralPrivateKey, sellerPublicKey), order.id)
}

const deliveryAad = (orderId: string) => utf8(`${DELIVERY_INFO}:${orderId}`)

export function encryptOrderDelivery(
  plaintext: Uint8Array,
  deliveryKey: Uint8Array,
  orderId: string
): { encryptedPayload: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(NONCE_SIZE)
  return { encryptedPayload: xchacha20poly1305(deliveryKey, nonce, deliveryAad(orderId)).encrypt(plaintext), nonce }
}

export function decryptOrderDelivery(
  encryptedPayload: Uint8Array,
  nonce: Uint8Array,
  deliveryKey: Uint8Array,
  orderId: string
): Uint8Array {
  return xchacha20poly1305(deliveryKey, nonce, deliveryAad(orderId)).decrypt(encryptedPayload)
}
