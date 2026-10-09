import { describe, expect, it } from 'vitest'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  buyerOrderDeliveryKey,
  decryptDigitalFile,
  decryptForSelf,
  decryptOrderDelivery,
  encryptDigitalFile,
  encryptForSelf,
  encryptOrderDelivery,
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
