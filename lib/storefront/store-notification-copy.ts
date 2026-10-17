import type { OrderStatus, StoreNotificationDetail, StoreNotificationType } from '@/lib/types'

/**
 * How a store notification reads and where it goes, shared by the web
 * notifications page and the mobile engine. Pure: types only, no imports
 * that read the build env.
 */

const STORE_NOTIFICATION_TYPES: readonly StoreNotificationType[] = ['storeOrder', 'storeReview', 'itemReview', 'orderStatus']

export function isStoreNotificationType(type: string): type is StoreNotificationType {
  return (STORE_NOTIFICATION_TYPES as readonly string[]).includes(type)
}

/** What the seller did, said of the buyer's order ("Alice shipped your order"). */
const STATUS_PHRASES: Record<OrderStatus, string> = {
  pending: 'updated your order',
  payment_received: 'confirmed payment for your order',
  processing: 'is preparing your order',
  shipped: 'shipped your order',
  delivered: 'marked your order as delivered',
  cancelled: 'cancelled your order',
  refunded: 'refunded your order',
  disputed: 'marked your order as disputed',
}

/** The sentence after the actor's name. */
export function storeNotificationPhrase(type: StoreNotificationType, store: StoreNotificationDetail | undefined): string {
  switch (type) {
    case 'storeOrder': return 'placed an order at your store'
    case 'storeReview': return 'reviewed your store'
    case 'itemReview': return store?.itemTitle ? `reviewed “${store.itemTitle}”` : 'reviewed one of your items'
    case 'orderStatus': return (store?.status && STATUS_PHRASES[store.status]) || 'updated your order'
  }
}

function stars(rating: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(rating)))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

/**
 * The preview under the sentence: a review's stars and text, or the seller's
 * note on a status change. Null when there is nothing public to show (a new
 * order's contents are encrypted).
 */
export function storeNotificationSnippet(type: StoreNotificationType, store: StoreNotificationDetail | undefined): string | null {
  const text = store?.text?.trim() || null
  if ((type === 'storeReview' || type === 'itemReview') && store?.rating !== undefined) {
    return text ? `${stars(store.rating)} ${text}` : stars(store.rating)
  }
  return type === 'orderStatus' ? text : null
}

/** Where a tap goes: the seller's or the buyer's orders, or the reviewed store or item. */
export function storeNotificationPath(type: StoreNotificationType, store: StoreNotificationDetail | undefined): string | null {
  switch (type) {
    case 'storeOrder': return '/orders/seller'
    case 'orderStatus': return '/orders'
    case 'itemReview':
      if (store?.itemId) return `/item?id=${encodeURIComponent(store.itemId)}`
      break
    case 'storeReview':
      break
  }
  return store?.storeId ? `/store/view?id=${encodeURIComponent(store.storeId)}` : null
}

/** The link's label when there is no snippet to show. */
export function storeNotificationLinkLabel(type: StoreNotificationType): string {
  if (type === 'itemReview') return 'View item'
  if (type === 'storeReview') return 'View store'
  return 'View order'
}
