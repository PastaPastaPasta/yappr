import { describe, expect, it } from 'vitest'
import {
  MAX_BULK_KEYS_PER_ITEM,
  MAX_DELIVERY_PLAINTEXT_BYTES,
  isSafeDeliveryUrl,
  normalizeLinkInput,
  splitPoolEntry,
  planBlockers,
  digitalOrders,
  hasDigitalLines,
  decodeDelivery,
  decodeKit,
  encodeDelivery,
  encodeKit,
  isDigitalOnly,
  isReadyForBulkDelivery,
  kitsAfterDelivery,
  lineProblems,
  planDelivery,
} from './digital-delivery-plan'
import type { BulkReadinessInput, ItemListing } from './digital-delivery-plan'
import type { ItemDeliverablePayload, OrderItem, OrderStatus } from '../../types'

const KEY = 'A'.repeat(43) + '='
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const file = (name: string, variantKey?: string) =>
  ({ kind: 'file' as const, name, size: 10, url: `ipfs://${CID}`, key: KEY, ...(variantKey ? { variantKey } : {}) })
const line = (itemId: string, quantity = 1, extra: Partial<OrderItem> = {}): OrderItem =>
  ({ itemId, itemTitle: itemId.toUpperCase(), quantity, unitPrice: 100, fulfillment: 'digital', ...extra })
const kit = (extra: Partial<ItemDeliverablePayload> = {}): ItemDeliverablePayload =>
  ({ v: 1, assets: [], deliverWhen: 'payment_confirmed', ...extra })
/** These items, listed as digital in store `store` (title and price as `line()` writes them). */
const listing = (itemId: string, extra: Partial<ItemListing> = {}): ItemListing =>
  ({ storeId: 'store', fulfillment: 'digital', title: itemId.toUpperCase(), basePrice: 100, currency: 'USD', ...extra })
const listed = (itemIds: string[]) => new Map(itemIds.map((itemId) => [itemId, listing(itemId)]))

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

  it('blocks a line with nothing to deliver for its variant', () => {
    const kits = new Map([['ebook', kit({ deliverWhen: 'on_order', assets: [file('book.pdf', 'PDF')] })]])
    const order = { items: [line('ebook', 1, { variantKey: 'EPUB' })] }
    const plan = planDelivery(order, kits)
    expect(plan.emptyLines).toEqual(['EBOOK'])
    expect(planBlockers(plan)).toHaveLength(1)
    expect(isReadyForBulkDelivery({ payload: order, storeId: 'store', latestStatus: undefined, alreadyDelivered: false, kits, listings: listed(['ebook']) })).toBe(false)
  })

  it('leaves pools without license keys alone', () => {
    const kits = new Map([['song', kit({ assets: [file('song.mp3')] })]])
    const plan = planDelivery({ items: [line('song', 3)] }, kits)
    expect(plan.delivery.items[0].licenseKeys).toBeUndefined()
    expect(kitsAfterDelivery(kits, plan.consumedKeys).size).toBe(0)
  })
})

describe('lineProblems', () => {
  const variants = { axes: [{ name: 'Format', options: ['PDF', 'Deluxe'] }], combinations: [{ key: 'PDF', price: 100 }, { key: 'Deluxe', price: 900 }] }
  const check = (items: OrderItem[], listings: Map<string, ItemListing>, currency = 'USD') =>
    lineProblems({ items, currency }, 'store', listings)

  it('passes a line that matches its listing, and ignores shipped lines', () => {
    expect(check([line('ebook'), line('mug', 1, { fulfillment: undefined })], listed(['ebook']))).toEqual([])
    expect(check([line('ebook', 1, { variantKey: 'Deluxe', unitPrice: 900 })], new Map([['ebook', listing('ebook', { variants })]]))).toEqual([])
  })

  it('blocks a line that names no digital product of this store', () => {
    for (const listings of [new Map(), new Map([['ebook', listing('ebook', { storeId: 'elsewhere' })]]), new Map([['ebook', listing('ebook', { fulfillment: 'shipped' })]])]) {
      expect(check([line('ebook')], listings).map((p) => p.blocking)).toEqual([true])
    }
  })

  it('blocks malformed buyer-written lines instead of throwing', () => {
    const odd = { ...line('ebook'), variantKey: 7 } as unknown as OrderItem
    const withVariants = new Map([['ebook', listing('ebook', { variants })]])
    expect(() => check([odd], withVariants)).not.toThrow()
    expect(check([odd], withVariants).map((p) => p.blocking)).toEqual([true])
    expect(check([{ ...line('ebook'), itemTitle: { x: 1 } } as unknown as OrderItem], listed(['ebook']))[0].blocking).toBe(true)
    // The well-formed line beside it is still checked, and the order is held.
    expect(check([odd, line('ebook')], withVariants).some((p) => p.blocking)).toBe(true)
  })

  it('flags a title, variant, price or currency the listing does not have, for review', () => {
    const withVariants = new Map([['ebook', listing('ebook', { variants })]])
    // The premium variant at the cheap variant's price.
    expect(check([line('ebook', 1, { variantKey: 'Deluxe', unitPrice: 100 })], withVariants)).toHaveLength(1)
    expect(check([line('ebook', 1, { variantKey: 'Gold' })], withVariants)).toHaveLength(1)
    expect(check([line('ebook')], withVariants)).toHaveLength(1)
    expect(check([line('ebook', 1, { itemTitle: 'Something else' })], listed(['ebook']))).toHaveLength(1)
    expect(check([line('ebook')], listed(['ebook']), 'EUR')).toHaveLength(1)
    expect(check([line('ebook', 1, { itemTitle: 'X', unitPrice: 5 })], listed(['ebook'])).every((p) => !p.blocking)).toBe(true)
  })
})

describe('isReadyForBulkDelivery', () => {
  const kits = new Map([['song', kit({ assets: [file('song.mp3')] })], ['now', kit({ deliverWhen: 'on_order', assets: [file('now.zip')] })]])
  const ready = (items: OrderItem[], latestStatus?: OrderStatus, extra: Partial<BulkReadinessInput> = {}) =>
    isReadyForBulkDelivery({ payload: { items }, storeId: 'store', latestStatus, alreadyDelivered: false, kits, listings: listed(['song', 'now', 'game']), ...extra })

  it('waits for payment unless every kit delivers on order', () => {
    expect(ready([line('song')])).toBe(false)
    expect(ready([line('song')], 'pending')).toBe(false)
    expect(ready([line('song')], 'payment_received')).toBe(true)
    expect(ready([line('now')])).toBe(true)
    expect(ready([line('now'), line('song')], 'pending')).toBe(false)
  })

  it('never re-delivers, delivers a closed order, or delivers without a kit', () => {
    expect(ready([line('now')], undefined, { alreadyDelivered: true })).toBe(false)
    expect(ready([line('now')], 'refunded')).toBe(false)
    expect(ready([line('other')], 'payment_received', { listings: listed(['other']) })).toBe(false)
    expect(ready([line('mug', 1, { fulfillment: undefined })], 'payment_received')).toBe(false)
  })

  it('only trusts the seller\'s listing, not the buyer-written line', () => {
    // An item from another of the seller's stores.
    expect(ready([line('now')], undefined, { listings: new Map([['now', listing('now', { storeId: 'other-store' })]]) })).toBe(false)
    // Switched back to shipped: its old kit is still there.
    expect(ready([line('now')], undefined, { listings: new Map([['now', listing('now', { fulfillment: 'shipped' })]]) })).toBe(false)
    // Not found (or its read failed).
    expect(ready([line('now')], undefined, { listings: new Map() })).toBe(false)
    // An expensive product dressed as a cheap one: the id decides what is sent.
    expect(ready([line('now', 1, { itemTitle: 'CHEAP THING' })])).toBe(false)
    expect(ready([line('now', 1, { unitPrice: 1 })])).toBe(false)
  })

  it('holds an order with a malformed digital line without throwing', () => {
    const odd = { ...line('now'), variantKey: 7 } as unknown as OrderItem
    expect(() => ready([odd])).not.toThrow()
    expect(ready([odd])).toBe(false)
    expect(ready([odd, line('now')])).toBe(false)
  })

  it('leaves a large key order for the seller to review, however its lines are split', () => {
    const pool = Array.from({ length: 50 }, (_, i) => `k${i}`)
    const many = new Map([['game', kit({ deliverWhen: 'on_order', licenseKeys: pool })]])
    expect(ready([line('game', MAX_BULK_KEYS_PER_ITEM)], undefined, { kits: many })).toBe(true)
    expect(ready([line('game', MAX_BULK_KEYS_PER_ITEM + 1)], undefined, { kits: many })).toBe(false)
    expect(ready([line('game', MAX_BULK_KEYS_PER_ITEM), line('game', MAX_BULK_KEYS_PER_ITEM)], undefined, { kits: many })).toBe(false)
  })

  it('holds an order whose key pool has run out', () => {
    const empty = new Map([['game', kit({ deliverWhen: 'on_order', licenseKeys: [] })]])
    expect(ready([line('game')], undefined, { kits: empty })).toBe(false)
  })

  it('holds an order whose delivery would not fit the contract\'s payload cap', () => {
    const huge = new Map([['now', kit({ deliverWhen: 'on_order', instructions: 'x'.repeat(MAX_DELIVERY_PLAINTEXT_BYTES) })]])
    expect(ready([line('now')], undefined, { kits: huge })).toBe(false)
  })
})

describe('wire format', () => {
  it('keeps each unique code once in a kit\'s pool', () => {
    expect(decodeKit(encodeKit(kit({ licenseKeys: ['A', 'B', 'A'] }))).licenseKeys).toEqual(['A', 'B'])
  })

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

  it('accepts http(s) URLs (secrets in the query included), magnet links and ipfs:// URLs that name a CID', () => {
    expect(isSafeDeliveryUrl('https://example.com/a')).toBe(true)
    expect(isSafeDeliveryUrl('https://files.example.com/dl?q=s3cr3t&expires=1700000000#page')).toBe(true)
    expect(isSafeDeliveryUrl('magnet:?xt=urn:btih:abc123&dn=course')).toBe(true)
    expect(isSafeDeliveryUrl(`ipfs://${CID}/book.pdf`)).toBe(true)
    expect(isSafeDeliveryUrl('ipfs://evil.example#')).toBe(false)
    expect(isSafeDeliveryUrl(`ipfs://${CID}?x=1`)).toBe(false)
    expect(isSafeDeliveryUrl('javascript:alert(1)')).toBe(false)
  })

  it('round-trips links with access codes and standalone codes, none of which need IPFS', () => {
    const original = kit({
      assets: [
        { kind: 'link', label: 'Download', url: 'https://example.com/dl?q=s3cr3t' },
        { kind: 'link', label: 'Members area', url: 'https://example.com/members', code: 'OPEN-SESAME' },
        { kind: 'link', label: 'Torrent', url: 'magnet:?xt=urn:btih:abc123' },
        { kind: 'code', label: 'Gift card', code: 'GIFT-1234', variantKey: 'Gold' },
      ],
    })
    expect(decodeKit(encodeKit(original))).toEqual(original)
  })

  it('adds https:// to a bare host, and leaves anything with a scheme alone', () => {
    expect(normalizeLinkInput(' drive.google.com/file/d/abc?usp=sharing ')).toBe('https://drive.google.com/file/d/abc?usp=sharing')
    expect(normalizeLinkInput('http://example.com')).toBe('http://example.com')
    expect(normalizeLinkInput('magnet:?xt=urn:btih:abc')).toBe('magnet:?xt=urn:btih:abc')
    expect(normalizeLinkInput('javascript:alert(1)')).toBe('javascript:alert(1)')
    expect(normalizeLinkInput('not a link')).toBe('not a link')
  })

  it('reads a unique-code entry as a link (with its own access code) or a code', () => {
    expect(splitPoolEntry('XXXX-YYYY')).toEqual({ code: 'XXXX-YYYY' })
    expect(splitPoolEntry('https://example.com/invite/abc')).toEqual({ url: 'https://example.com/invite/abc' })
    expect(splitPoolEntry('https://example.com/invite/abc  PASS 123')).toEqual({ url: 'https://example.com/invite/abc', code: 'PASS 123' })
    expect(splitPoolEntry('user@example.com hunter2')).toEqual({ code: 'user@example.com hunter2' })
    expect(splitPoolEntry('javascript:alert(1) x')).toEqual({ code: 'javascript:alert(1) x' })
  })

  it('drops a code with nothing in it and a file that points at a magnet link', () => {
    const decoded = decodeKit(new TextEncoder().encode(JSON.stringify({
      v: 1,
      deliverWhen: 'on_order',
      assets: [
        { kind: 'code', label: 'Empty', code: '' },
        { kind: 'code', code: 'X' },
        { kind: 'file', name: 'f', size: 1, url: 'magnet:?xt=urn:btih:abc', key: KEY },
      ],
    })))
    expect(decoded.assets).toEqual([{ kind: 'code', label: 'Code', code: 'X' }])
  })

  it('refuses a delivery past the contract\'s payload cap', () => {
    const delivery = { v: 1 as const, items: [], message: 'x'.repeat(MAX_DELIVERY_PLAINTEXT_BYTES) }
    expect(() => encodeDelivery(delivery)).toThrow(/too large/)
  })
})

describe('malformed order payloads', () => {
  it('count as having no digital lines instead of throwing', () => {
    for (const payload of [{ items: null }, { items: 'x' }, {}, { items: [null, 5, { fulfillment: 'digital', itemId: 'a', itemTitle: 'A', quantity: 1 }] }]) {
      const cast = payload as unknown as { items: OrderItem[] }
      expect(() => hasDigitalLines(cast)).not.toThrow()
      expect(() => planDelivery(cast, new Map())).not.toThrow()
    }
    expect(hasDigitalLines({ items: null } as unknown as { items: OrderItem[] })).toBe(false)
    expect(digitalOrders([{ id: 'o' }], new Map([['o', { items: 7 } as unknown as { items: OrderItem[] }]]))).toEqual([])
    expect(isDigitalOnly(null as unknown as OrderItem[])).toBe(false)
  })
})

describe('isDigitalOnly', () => {
  it('is true only for a non-empty all-digital order', () => {
    expect(isDigitalOnly([])).toBe(false)
    expect(isDigitalOnly([line('a')])).toBe(true)
    expect(isDigitalOnly([line('a'), line('b', 1, { fulfillment: undefined })])).toBe(false)
  })
})
