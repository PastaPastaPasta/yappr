import { describe, expect, it } from 'vitest'
import {
  MAX_BULK_KEYS_PER_LINE,
  MAX_DELIVERY_PLAINTEXT_BYTES,
  isSafeDeliveryUrl,
  planBlockers,
  decodeDelivery,
  decodeKit,
  encodeDelivery,
  encodeKit,
  isDigitalOnly,
  isReadyForBulkDelivery,
  kitsAfterDelivery,
  planDelivery,
} from './digital-delivery-plan'
import type { ItemDeliverablePayload, OrderItem } from '../../types'

const KEY = 'A'.repeat(43) + '='
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const file = (name: string, variantKey?: string) =>
  ({ kind: 'file' as const, name, size: 10, url: `ipfs://${CID}`, key: KEY, ...(variantKey ? { variantKey } : {}) })
const line = (itemId: string, quantity = 1, extra: Partial<OrderItem> = {}): OrderItem =>
  ({ itemId, itemTitle: itemId.toUpperCase(), quantity, unitPrice: 100, fulfillment: 'digital', ...extra })
const kit = (extra: Partial<ItemDeliverablePayload> = {}): ItemDeliverablePayload =>
  ({ v: 1, assets: [], deliverWhen: 'payment_confirmed', ...extra })

describe('planDelivery', () => {
  it('delivers only digital lines, with the assets of each line\'s variant', () => {
    const kits = new Map([['ebook', kit({ assets: [file('cover.png'), file('book.pdf', 'PDF'), file('book.epub', 'EPUB')], instructions: 'Enjoy' })]])
    const plan = planDelivery({ items: [line('ebook', 1, { variantKey: 'EPUB' }), line('mug', 1, { fulfillment: undefined })] }, kits, '  thanks  ')
    expect(plan.missingKits).toEqual([])
    expect(plan.delivery.message).toBe('thanks')
    expect(plan.delivery.items).toHaveLength(1)
    const [item] = plan.delivery.items
    expect(item.assets.map((asset) => asset.kind === 'file' && asset.name)).toEqual(['cover.png', 'book.epub'])
    // The buyer never sees which variant an asset was filed under.
    expect(item.assets.every((asset) => asset.variantKey === undefined)).toBe(true)
    expect(item.instructions).toBe('Enjoy')
  })

  it('takes license keys from the front of a shared pool, quantity per line', () => {
    const kits = new Map([['game', kit({ licenseKeys: ['k1', 'k2', 'k3', 'k4'] })]])
    const plan = planDelivery({ items: [line('game', 2, { variantKey: 'Std' }), line('game', 1, { variantKey: 'Deluxe' })] }, kits)
    expect(plan.delivery.items.map((item) => item.licenseKeys)).toEqual([['k1', 'k2'], ['k3']])
    expect(plan.consumedKeys.get('game')).toBe(3)
    expect(plan.shortOnKeys).toEqual([])
    expect(kitsAfterDelivery(kits, plan.consumedKeys).get('game')?.licenseKeys).toEqual(['k4'])
  })

  it('reports lines it cannot fulfil', () => {
    const kits = new Map([['game', kit({ licenseKeys: ['k1'] })]])
    const plan = planDelivery({ items: [line('game', 2), line('song')] }, kits)
    expect(plan.shortOnKeys).toEqual(['GAME'])
    expect(plan.missingKits).toEqual(['SONG'])
    expect(plan.delivery.items[0].licenseKeys).toEqual(['k1'])
  })

  it('refuses quantities that are not whole units, since the buyer writes them', () => {
    const kits = new Map([['game', kit({ licenseKeys: ['k1', 'k2'] })]])
    for (const quantity of [0, -1, 1.5, Number.NaN, 1001]) {
      const plan = planDelivery({ items: [line('game', quantity)] }, kits)
      expect(plan.invalidQuantities).toEqual(['GAME'])
      expect(plan.delivery.items).toEqual([])
      expect(plan.consumedKeys.size).toBe(0)
      expect(planBlockers(plan)).toHaveLength(1)
    }
  })

  it('leaves pools without license keys alone', () => {
    const kits = new Map([['song', kit({ assets: [file('song.mp3')] })]])
    const plan = planDelivery({ items: [line('song', 3)] }, kits)
    expect(plan.delivery.items[0].licenseKeys).toBeUndefined()
    expect(kitsAfterDelivery(kits, plan.consumedKeys).size).toBe(0)
  })
})

describe('isReadyForBulkDelivery', () => {
  const kits = new Map([['song', kit()], ['now', kit({ deliverWhen: 'on_order' })]])

  it('waits for payment unless every kit delivers on order', () => {
    expect(isReadyForBulkDelivery({ items: [line('song')] }, undefined, false, kits)).toBe(false)
    expect(isReadyForBulkDelivery({ items: [line('song')] }, 'pending', false, kits)).toBe(false)
    expect(isReadyForBulkDelivery({ items: [line('song')] }, 'payment_received', false, kits)).toBe(true)
    expect(isReadyForBulkDelivery({ items: [line('now')] }, undefined, false, kits)).toBe(true)
    expect(isReadyForBulkDelivery({ items: [line('now'), line('song')] }, 'pending', false, kits)).toBe(false)
  })

  it('never re-delivers, delivers a closed order, or delivers without a kit', () => {
    expect(isReadyForBulkDelivery({ items: [line('now')] }, undefined, true, kits)).toBe(false)
    expect(isReadyForBulkDelivery({ items: [line('now')] }, 'refunded', false, kits)).toBe(false)
    expect(isReadyForBulkDelivery({ items: [line('other')] }, 'payment_received', false, kits)).toBe(false)
    expect(isReadyForBulkDelivery({ items: [line('mug', 1, { fulfillment: undefined })] }, 'payment_received', false, kits)).toBe(false)
  })

  it('leaves a large key order for the seller to review', () => {
    const pool = Array.from({ length: 50 }, (_, i) => `k${i}`)
    const many = new Map([['game', kit({ deliverWhen: 'on_order', licenseKeys: pool })]])
    expect(isReadyForBulkDelivery({ items: [line('game', MAX_BULK_KEYS_PER_LINE)] }, undefined, false, many)).toBe(true)
    expect(isReadyForBulkDelivery({ items: [line('game', MAX_BULK_KEYS_PER_LINE + 1)] }, undefined, false, many)).toBe(false)
  })

  it('holds an order whose key pool has run out', () => {
    const empty = new Map([['game', kit({ deliverWhen: 'on_order', licenseKeys: [] })]])
    expect(isReadyForBulkDelivery({ items: [line('game')] }, undefined, false, empty)).toBe(false)
  })
})

describe('wire format', () => {
  it('round-trips a kit and a delivery', () => {
    const original = kit({ assets: [file('a.zip', 'Pro'), { kind: 'link', label: 'Site', url: 'https://example.com' }], licenseKeys: ['X'], instructions: 'hi', deliverWhen: 'on_order' })
    expect(decodeKit(encodeKit(original))).toEqual(original)
    const delivery = { v: 1 as const, items: [{ itemId: 'a', itemTitle: 'A', assets: [file('a.zip')], licenseKeys: ['X'] }], message: 'm' }
    expect(decodeDelivery(encodeDelivery(delivery))).toEqual(delivery)
  })

  it('drops assets a buyer\'s browser must not open', () => {
    const hostile = new TextEncoder().encode(JSON.stringify({
      v: 1,
      items: [{
        itemId: 'a', itemTitle: 'A',
        assets: [
          { kind: 'link', label: 'x', url: 'javascript:alert(1)' },
          { kind: 'link', label: 'y', url: 'data:text/html,hi' },
          { kind: 'file', name: 'f', size: 1, url: 'ipfs://cid', key: 'short' },
          { kind: 'script', url: 'https://example.com' },
          { kind: 'link', label: 'ok', url: 'https://example.com/ok' },
        ],
        licenseKeys: ['k', 5, ''],
      }],
    }))
    const [item] = decodeDelivery(hostile).items
    expect(item.assets).toEqual([{ kind: 'link', label: 'ok', url: 'https://example.com/ok' }])
    expect(item.licenseKeys).toEqual(['k'])
  })

  it('accepts only http(s) URLs and ipfs:// URLs that name a CID', () => {
    expect(isSafeDeliveryUrl('https://example.com/a')).toBe(true)
    expect(isSafeDeliveryUrl(`ipfs://${CID}/book.pdf`)).toBe(true)
    expect(isSafeDeliveryUrl('ipfs://evil.example#')).toBe(false)
    expect(isSafeDeliveryUrl(`ipfs://${CID}?x=1`)).toBe(false)
    expect(isSafeDeliveryUrl('javascript:alert(1)')).toBe(false)
  })

  it('refuses a delivery past the contract\'s payload cap', () => {
    const delivery = { v: 1 as const, items: [], message: 'x'.repeat(MAX_DELIVERY_PLAINTEXT_BYTES) }
    expect(() => encodeDelivery(delivery)).toThrow(/too large/)
  })
})

describe('isDigitalOnly', () => {
  it('is true only for a non-empty all-digital order', () => {
    expect(isDigitalOnly([])).toBe(false)
    expect(isDigitalOnly([line('a')])).toBe(true)
    expect(isDigitalOnly([line('a'), line('b', 1, { fulfillment: undefined })])).toBe(false)
  })
})
