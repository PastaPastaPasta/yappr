import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { sealStatus } from '../../scripts/seed/non-social/storefront.mjs'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  buyerOrderDeliveryKey,
  decryptDigitalFile,
  decryptForSelf,
  decodeOrderStatusNote,
  decryptOrderDelivery,
  decryptOrderStatusNote,
  encodeOrderStatusNote,
  encryptDigitalFile,
  encryptForSelf,
  encryptOrderDelivery,
  encryptOrderStatusNote,
  ORDER_STATUS_NOTE_LABEL,
  sellerOrderDeliveryKey,
} from './digital-delivery'
import { getPublicKey } from './keys'
import { privateFeedCryptoService } from '../services/private-feed-crypto-service'

const utf8 = (value: string) => new TextEncoder().encode(value)
const ORDER_AAD = utf8('yappr/order/v1')

/** An order encrypted exactly as checkout encrypts one (deterministic ephemeral ECIES). */
async function placeOrder(buyerPrivateKey: Uint8Array, sellerPublicKey: Uint8Array, id = 'order-1') {
  const nonce = randomBytes(24)
  const storeId = 'store-1'
  const ephemeral = privateFeedCryptoService.deriveOrderEphemeralKey(buyerPrivateKey, nonce, storeId)
  const encryptedPayload = await privateFeedCryptoService.eciesEncryptWithEphemeralKey(ephemeral, sellerPublicKey, utf8('{"items":[]}'), ORDER_AAD)
  return { id, storeId, nonce, encryptedPayload }
}

describe('digital files', () => {
  it('round-trips under the generated key', () => {
    const plaintext = randomBytes(1000)
    const { ciphertext, key } = encryptDigitalFile(plaintext)
    expect(ciphertext.length).toBe(1000 + 24 + 16)
    expect(decryptDigitalFile(ciphertext, key)).toEqual(plaintext)
  })

  it('handles an empty file', () => {
    const { ciphertext, key } = encryptDigitalFile(new Uint8Array())
    expect(decryptDigitalFile(ciphertext, key)).toEqual(new Uint8Array())
  })

  it('refuses the wrong key, tampered bytes and truncated input', () => {
    const { ciphertext, key } = encryptDigitalFile(randomBytes(64))
    expect(() => decryptDigitalFile(ciphertext, randomBytes(32))).toThrow()
    const tampered = ciphertext.slice()
    tampered[40] ^= 1
    expect(() => decryptDigitalFile(tampered, key)).toThrow()
    expect(() => decryptDigitalFile(ciphertext.subarray(0, 30), key)).toThrow()
  })
})

describe('seller kits', () => {
  it('round-trips under the seller key and is bound to its item', async () => {
    const seller = randomBytes(32)
    const sealed = await encryptForSelf(utf8('kit'), seller, 'item-a')
    expect(new TextDecoder().decode(await decryptForSelf(sealed, seller, 'item-a'))).toBe('kit')
    await expect(decryptForSelf(sealed, seller, 'item-b')).rejects.toThrow()
    await expect(decryptForSelf(sealed, randomBytes(32), 'item-a')).rejects.toThrow()
  })
})

describe('order delivery key', () => {
  it('is the same for the seller and the buyer, and unique per order', async () => {
    const buyer = randomBytes(32)
    const seller = randomBytes(32)
    const order = await placeOrder(buyer, getPublicKey(seller))
    const sellerKey = sellerOrderDeliveryKey(order, seller)
    expect(buyerOrderDeliveryKey(order, buyer, getPublicKey(seller))).toEqual(sellerKey)

    const other = await placeOrder(buyer, getPublicKey(seller), 'order-2')
    expect(sellerOrderDeliveryKey(other, seller)).not.toEqual(sellerKey)
  })

  it('lets the buyer open what the seller sealed, bound to the order id', async () => {
    const buyer = randomBytes(32)
    const seller = randomBytes(32)
    const order = await placeOrder(buyer, getPublicKey(seller))
    const { encryptedPayload, nonce } = encryptOrderDelivery(utf8('goods'), sellerOrderDeliveryKey(order, seller), order.id)
    const buyerKey = buyerOrderDeliveryKey(order, buyer, getPublicKey(seller))
    expect(new TextDecoder().decode(decryptOrderDelivery(encryptedPayload, nonce, buyerKey, order.id))).toBe('goods')
    expect(() => decryptOrderDelivery(encryptedPayload, nonce, buyerKey, 'another-order')).toThrow()
  })

  it('refuses a stranger, and an order whose ephemeral key the buyer cannot re-derive', async () => {
    const buyer = randomBytes(32)
    const seller = randomBytes(32)
    const order = await placeOrder(buyer, getPublicKey(seller))
    expect(() => buyerOrderDeliveryKey(order, randomBytes(32), getPublicKey(seller))).toThrow()

    // Orders from before the deterministic derivation used a random ephemeral key.
    const legacy = { ...order, encryptedPayload: await privateFeedCryptoService.eciesEncrypt(getPublicKey(seller), utf8('{}'), ORDER_AAD) }
    expect(() => buyerOrderDeliveryKey(legacy, buyer, getPublicKey(seller))).toThrow(/re-derive/)
  })
})

describe('order status notes', () => {
  const note = { trackingCarrier: 'UPS', trackingNumber: '1Z999', message: 'On its way' }
  const open = (sealed: { encryptedPayload: Uint8Array; nonce: Uint8Array }, key: Uint8Array, orderId: string) =>
    decodeOrderStatusNote(decryptOrderStatusNote(sealed.encryptedPayload, sealed.nonce, key, orderId))

  it('round-trips for the seller and, through the shared order key, the buyer', async () => {
    const buyer = randomBytes(32)
    const seller = randomBytes(32)
    const order = await placeOrder(buyer, getPublicKey(seller))
    const sealed = encryptOrderStatusNote(encodeOrderStatusNote(note), sellerOrderDeliveryKey(order, seller), order.id)
    expect(sealed.nonce).toHaveLength(24)
    expect(open(sealed, sellerOrderDeliveryKey(order, seller), order.id)).toEqual(note)
    expect(open(sealed, buyerOrderDeliveryKey(order, buyer, getPublicKey(seller)), order.id)).toEqual(note)
  })

  it('uses a fresh nonce each time', () => {
    const key = randomBytes(32)
    const a = encryptOrderStatusNote(encodeOrderStatusNote(note), key, 'order-1')
    const b = encryptOrderStatusNote(encodeOrderStatusNote(note), key, 'order-1')
    expect(a.nonce).not.toEqual(b.nonce)
  })

  it('is bound to the order id and the order key', () => {
    const key = randomBytes(32)
    const sealed = encryptOrderStatusNote(encodeOrderStatusNote(note), key, 'order-1')
    expect(() => open(sealed, key, 'order-2')).toThrow()
    expect(() => open(sealed, randomBytes(32), 'order-1')).toThrow()
    const tampered = sealed.encryptedPayload.slice()
    tampered[0] ^= 1
    expect(() => decryptOrderStatusNote(tampered, sealed.nonce, key, 'order-1')).toThrow()
  })

  it('cannot be confused with a delivery, in either direction', () => {
    const key = randomBytes(32)
    const status = encryptOrderStatusNote(encodeOrderStatusNote(note), key, 'order-1')
    expect(() => decryptOrderDelivery(status.encryptedPayload, status.nonce, key, 'order-1')).toThrow()
    const delivery = encryptOrderDelivery(encodeOrderStatusNote(note), key, 'order-1')
    expect(() => decryptOrderStatusNote(delivery.encryptedPayload, delivery.nonce, key, 'order-1')).toThrow()
    expect(ORDER_STATUS_NOTE_LABEL).toBe('yappr/order-status/v1')
  })

  it('encodes only what is given, as version 1 JSON', () => {
    expect(JSON.parse(new TextDecoder().decode(encodeOrderStatusNote({ message: 'Hi', trackingNumber: '' })))).toEqual({ v: 1, message: 'Hi' })
  })

  it('decodes defensively: ignores unknown keys and non-strings, rejects garbage and other versions', () => {
    const decode = (value: unknown) => decodeOrderStatusNote(utf8(typeof value === 'string' ? value : JSON.stringify(value)))
    expect(decode({ v: 1, message: 'Hi', extra: 'x', trackingNumber: 5, trackingCarrier: null })).toEqual({ message: 'Hi' })
    expect(decode({ v: 1 })).toEqual({})
    expect(() => decode({ v: 2, message: 'Hi' })).toThrow()
    expect(() => decode({ message: 'Hi' })).toThrow()
    expect(() => decode('not json')).toThrow()
    expect(() => decode('[1]')).toThrow()
    expect(() => decode('null')).toThrow()
    expect(() => decodeOrderStatusNote(new Uint8Array([0xff, 0xfe]))).toThrow()
  })
})


describe('storefront seeder status notes', () => {
  it('opens the seeded note using the client keys for both parties and binds it to its order', async () => {
    const buyerPriv = new Uint8Array(32).fill(1)
    const sellerPriv = new Uint8Array(32).fill(2)
    const sellerPub = getPublicKey(sellerPriv)
    const key = 'compat-order'
    const nonce = sha256(utf8(`yappr/storefront-seed/v1/nonce/${key}`)).slice(0, 24)
    const storeId = 'compat-store'
    const id = 'compat-order-id'
    const ephemeral = privateFeedCryptoService.deriveOrderEphemeralKey(buyerPriv, nonce, storeId)
    const encryptedPayload = await privateFeedCryptoService.eciesEncryptWithEphemeralKey(ephemeral, sellerPub, utf8('{}'), ORDER_AAD)
    const order = { id, storeId, nonce, encryptedPayload }
    const note = { message: 'Shipped', trackingNumber: '123', trackingCarrier: 'test' }
    const sealed = sealStatus({ key }, 'shipped', note, { buyerPriv, sellerPriv, sellerPub }, storeId, id)
    for (const deliveryKey of [sellerOrderDeliveryKey(order, sellerPriv), buyerOrderDeliveryKey(order, buyerPriv, sellerPub)]) {
      expect(decodeOrderStatusNote(decryptOrderStatusNote(sealed.encryptedPayload, sealed.nonce, deliveryKey, id))).toEqual(note)
      expect(() => decryptOrderStatusNote(sealed.encryptedPayload, sealed.nonce, deliveryKey, 'another-order')).toThrow()
    }
  })
})
