import { describe, expect, it } from 'vitest'
import {
  isOrderStatus,
  isStoreNotificationType,
  storeNotificationLinkLabel,
  storeNotificationPath,
  storeNotificationPhrase,
  storeNotificationSnippet,
} from './store-notification-copy'

describe('store notification copy', () => {
  it('knows the store types from the rest', () => {
    expect(['storeOrder', 'storeReview', 'itemReview', 'orderStatus'].every(isStoreNotificationType)).toBe(true)
    expect(isStoreNotificationType('like')).toBe(false)
    expect(isStoreNotificationType('toString')).toBe(false)
  })

  it('knows the contract\'s order statuses', () => {
    expect(isOrderStatus('payment_received')).toBe(true)
    expect(isOrderStatus('teleported')).toBe(false)
    expect(isOrderStatus('constructor')).toBe(false)
    expect(isOrderStatus(undefined)).toBe(false)
  })

  it('words each event after the actor\'s name', () => {
    expect(storeNotificationPhrase('storeOrder', { storeId: 'S' })).toBe('placed an order at your store')
    expect(storeNotificationPhrase('storeReview', { rating: 4 })).toBe('reviewed your store')
    expect(storeNotificationPhrase('itemReview', { itemTitle: 'Blue mug' })).toBe('reviewed “Blue mug”')
    expect(storeNotificationPhrase('itemReview', {})).toBe('reviewed one of your items')
    expect(storeNotificationPhrase('itemReview', { itemTitle: 'A'.repeat(200) })).toBe(`reviewed \u201c${'A'.repeat(59)}\u2026\u201d`)
    expect(storeNotificationPhrase('orderStatus', { status: 'shipped' })).toBe('shipped your order')
    expect(storeNotificationPhrase('orderStatus', { status: 'refunded' })).toBe('refunded your order')
    expect(storeNotificationPhrase('orderStatus', undefined)).toBe('updated your order')
  })

  it('previews reviews with their stars and a status change with the seller\'s note, and a new order with nothing', () => {
    expect(storeNotificationSnippet('storeReview', { rating: 4, text: 'Great' })).toBe('★★★★☆ Great')
    expect(storeNotificationSnippet('itemReview', { rating: 2 })).toBe('★★☆☆☆')
    expect(storeNotificationSnippet('orderStatus', { status: 'shipped', text: 'On its way' })).toBe('On its way')
    expect(storeNotificationSnippet('orderStatus', { status: 'shipped' })).toBeNull()
    expect(storeNotificationSnippet('storeOrder', { storeId: 'S', text: 'never shown' })).toBeNull()
  })

  it('links to the orders, the reviewed item, or the reviewed store', () => {
    expect(storeNotificationPath('storeOrder', { storeId: 'S' })).toBe('/orders/seller')
    expect(storeNotificationPath('orderStatus', { status: 'shipped' })).toBe('/orders')
    expect(storeNotificationPath('storeReview', { storeId: 'S' })).toBe('/store/view?id=S')
    expect(storeNotificationPath('itemReview', { storeId: 'S', itemId: 'I' })).toBe('/item?id=I')
    expect(storeNotificationPath('itemReview', { storeId: 'S' })).toBe('/store/view?id=S')
    expect(storeNotificationPath('storeReview', {})).toBeNull()
    expect(storeNotificationLinkLabel('storeOrder')).toBe('View order')
    expect(storeNotificationLinkLabel('itemReview')).toBe('View item')
  })
})
