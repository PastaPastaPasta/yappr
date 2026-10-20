import { YAPPR_STOREFRONT_CONTRACT_ID } from '@/lib/constants'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { identityService } from '@/lib/services/identity-service'
import { storeService } from '@/lib/services/store-service'
import { getEncryptionKeyBytes } from '@/lib/secure-storage'
import { OWN_STORE_ORDER_MESSAGE, isOwnStore } from '@/lib/storefront/storefront-contract'
import type { BuyerContact, ShippingAddress, Store } from '@/lib/types'
import type { TicketDocument } from '../writes/types'

/** What the storefront modules share: checkout readiness, key lookups and input clean-up. */

/** Why checkout cannot go on to payment (web `CheckoutReadinessBlocker`). */
export type CheckoutBlocker =
  | 'own-store' | 'store-unavailable' | 'store-check-failed' | 'no-payment-methods'
  | 'missing-buyer-key' | 'missing-seller-key' | 'invalid-seller-key' | 'service-error'

const CHECKOUT_MESSAGES: Record<CheckoutBlocker, string> = {
  'own-store': OWN_STORE_ORDER_MESSAGE,
  'store-unavailable': 'This store is not accepting orders right now.',
  'store-check-failed': 'Could not confirm this store is open. Please try again.',
  'no-payment-methods': 'This store has not configured any payment methods.',
  'missing-buyer-key': 'Unlock your encryption key to continue to payment.',
  'missing-seller-key': "This store's owner hasn't set up messaging yet, so this store can't take orders.",
  'invalid-seller-key': "This store's encryption key is invalid. Contact the store owner.",
  'service-error': 'Could not verify store encryption key. Please try again later.',
}

/** 33-byte compressed or 65-byte uncompressed secp256k1 point (web's `normalizeKeyData`). */
const isSecpPoint = (bytes: Uint8Array) =>
  (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) || (bytes.length === 65 && bytes[0] === 0x04)

/** A seller's encryption public key, or null when the identity has none. Throws when the read fails. */
export async function sellerEncryptionKey(sellerId: string): Promise<Uint8Array | null> {
  return resolveEncryptionPublicKey(sellerId, async () => (await identityService.getIdentity(sellerId))?.publicKeys ?? null)
}

export interface CheckoutReadiness {
  blocker: CheckoutBlocker | null
  sellerKey: Uint8Array | null
  buyerKey: Uint8Array | null
}

/**
 * Web `validateCheckoutReadiness`, in the same order: own store, the store
 * re-read past the cache (paused or closed since), payment methods, the
 * buyer's key on this device, the seller's encryption key.
 */
export async function checkoutReadiness(store: Store, viewer: string): Promise<CheckoutReadiness> {
  const blocked = (blocker: CheckoutBlocker, buyerKey: Uint8Array | null = null): CheckoutReadiness => ({ blocker, sellerKey: null, buyerKey })
  if (isOwnStore(store, viewer)) return blocked('own-store')
  let current: Store | null
  try {
    current = await storeService.getCurrent(store.id)
  } catch {
    return blocked('store-check-failed')
  }
  if (current?.status !== 'active') return blocked('store-unavailable')
  if (!store.paymentUris?.length) return blocked('no-payment-methods')
  const buyerKey = getEncryptionKeyBytes(viewer)
  if (!buyerKey) return blocked('missing-buyer-key')
  try {
    const sellerKey = await sellerEncryptionKey(store.ownerId)
    if (!sellerKey) return blocked('missing-seller-key', buyerKey)
    if (!isSecpPoint(sellerKey)) return blocked('invalid-seller-key', buyerKey)
    return { blocker: null, sellerKey, buyerKey }
  } catch {
    return blocked('service-error', buyerKey)
  }
}

export const checkoutBlockerMessage = (blocker: CheckoutBlocker | null): string | null => (blocker ? CHECKOUT_MESSAGES[blocker] : null)

/** The address with every field trimmed, as checkout keeps it. */
export function cleanAddress(address: ShippingAddress): ShippingAddress {
  return {
    name: address.name.trim(),
    street: address.street.trim(),
    city: address.city.trim(),
    ...(address.state?.trim() ? { state: address.state.trim() } : {}),
    postalCode: address.postalCode.trim(),
    country: address.country.trim().toUpperCase(),
  }
}

export function cleanContact(contact: BuyerContact | null | undefined): BuyerContact {
  return {
    ...(contact?.email?.trim() ? { email: contact.email.trim() } : {}),
    ...(contact?.phone?.trim() ? { phone: contact.phone.trim() } : {}),
  }
}

/** A storefront document a ticket names. */
export function storefrontDoc(type: string, id: string, action: TicketDocument['action'], confirmed = false): TicketDocument {
  return { contractId: YAPPR_STOREFRONT_CONTRACT_ID, type, id, action, confirmed }
}
