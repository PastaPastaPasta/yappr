import { describe, expect, it } from 'vitest'
import bs58 from 'bs58'
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
  digitalLines,
  isDigitalOnly,
  isReadyForBulkDelivery,
  kitsAfterDelivery,
  lineProblems,
  planDelivery,
} from './digital-delivery-plan'
import type { BulkReadinessInput, ItemListing } from './digital-delivery-plan'
import type { ItemDeliverablePayload, OrderItem, OrderStatus } from '../../types'

/** Products by name, each with a real 32-byte base58 id (the codecs refuse anything else). */
const NAMES = ['ebook', 'game', 'song', 'now', 'mug', 'other'] as const
const ID_LIST = NAMES.map((_, i) => bs58.encode(new Uint8Array(32).fill(i + 1)))
const IDS = new Map(ID_LIST.map((id, i) => [id, NAMES[i]]))
const [EBOOK_ID, GAME_ID, SONG_ID, NOW_ID, MUG_ID, OTHER_ID] = ID_LIST
/** A product's title, as the helpers below write it: its name in capitals. */
const titleOf = (itemId: string) => (IDS.get(itemId) ?? itemId).toUpperCase()
const KEY = 'A'.repeat(43) + '='
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const file = (name: string, variantKey?: string) =>
  ({ kind: 'file' as const, name, size: 10, url: `ipfs://${CID}`, key: KEY, ...(variantKey ? { variantKey } : {}) })
const line = (itemId: string, quantity = 1, extra: Partial<OrderItem> = {}): OrderItem =>
  ({ itemId, itemTitle: titleOf(itemId), quantity, unitPrice: 100, fulfillment: 'digital', ...extra })
const kit = (extra: Partial<ItemDeliverablePayload> = {}): ItemDeliverablePayload =>
  ({ v: 1, assets: [], deliverWhen: 'payment_confirmed', ...extra })
/** These items, listed as digital in store `store` (title and price as `line()` writes them). */
const listing = (itemId: string, extra: Partial<ItemListing> = {}): ItemListing =>
  ({ storeId: 'store', fulfillment: 'digital', title: titleOf(itemId), basePrice: 100, currency: 'USD', ...extra })
const listed = (itemIds: string[]) => new Map(itemIds.map((itemId) => [itemId, listing(itemId)]))

describe('planDelivery', () => {
  it('delivers only digital lines, with the assets of each line\'s variant', () => {
    const kits = new Map([[EBOOK_ID, kit({ assets: [file('cover.png'), file('book.pdf', 'PDF'), file('book.epub', 'EPUB')], instructions: 'Enjoy' })]])
    const plan = planDelivery({ items: [line(EBOOK_ID, 1, { variantKey: 'EPUB' }), line(MUG_ID, 1, { fulfillment: undefined })] }, kits, '  thanks  ')
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
    const kits = new Map([[GAME_ID, kit({ licenseKeys: ['k1', 'k2', 'k3', 'k4'] })]])
    const plan = planDelivery({ items: [line(GAME_ID, 2, { variantKey: 'Std' }), line(GAME_ID, 1, { variantKey: 'Deluxe' })] }, kits)
    expect(plan.delivery.items.map((item) => item.licenseKeys)).toEqual([['k1', 'k2'], ['k3']])
    expect(plan.consumedKeys.get(GAME_ID)).toBe(3)
    expect(plan.shortOnKeys).toEqual([])
    expect(kitsAfterDelivery(kits, plan.consumedKeys).get(GAME_ID)?.licenseKeys).toEqual(['k4'])
  })

  it('reports lines it cannot fulfil', () => {
    const kits = new Map([[GAME_ID, kit({ licenseKeys: ['k1'] })]])
    const plan = planDelivery({ items: [line(GAME_ID, 2), line(SONG_ID)] }, kits)
    expect(plan.shortOnKeys).toEqual(['GAME'])
    expect(plan.missingKits).toEqual(['SONG'])
    expect(plan.delivery.items[0].licenseKeys).toEqual(['k1'])
  })

  it('refuses quantities that are not whole units, since the buyer writes them', () => {
    const kits = new Map([[GAME_ID, kit({ licenseKeys: ['k1', 'k2'] })]])
    for (const quantity of [0, -1, 1.5, Number.NaN, 1001]) {
      const plan = planDelivery({ items: [line(GAME_ID, quantity)] }, kits)
      expect(plan.invalidQuantities).toEqual(['GAME'])
      expect(plan.delivery.items).toEqual([])
      expect(plan.consumedKeys.size).toBe(0)
      expect(planBlockers(plan)).toHaveLength(1)
    }
  })

  it('blocks a line with nothing to deliver for its variant', () => {
    const kits = new Map([[EBOOK_ID, kit({ deliverWhen: 'on_order', assets: [file('book.pdf', 'PDF')] })]])
    const order = { items: [line(EBOOK_ID, 1, { variantKey: 'EPUB' })] }
    const plan = planDelivery(order, kits)
    expect(plan.emptyLines).toEqual(['EBOOK'])
    expect(planBlockers(plan)).toHaveLength(1)
    expect(isReadyForBulkDelivery({ payload: order, storeId: 'store', latestStatus: undefined, alreadyDelivered: false, kits, listings: listed([EBOOK_ID]) })).toBe(false)
  })

  it('leaves pools without license keys alone', () => {
    const kits = new Map([[SONG_ID, kit({ assets: [file('song.mp3')] })]])
    const plan = planDelivery({ items: [line(SONG_ID, 3)] }, kits)
    expect(plan.delivery.items[0].licenseKeys).toBeUndefined()
    expect(kitsAfterDelivery(kits, plan.consumedKeys).size).toBe(0)
  })
})

describe('lineProblems', () => {
  const variants = { axes: [{ name: 'Format', options: ['PDF', 'Deluxe'] }], combinations: [{ key: 'PDF', price: 100 }, { key: 'Deluxe', price: 900 }] }
  const check = (items: OrderItem[], listings: Map<string, ItemListing>, currency = 'USD') =>
    lineProblems({ items, currency }, 'store', listings)

  it('passes a line that matches its listing, and ignores shipped lines', () => {
    expect(check([line(EBOOK_ID), line(MUG_ID, 1, { fulfillment: undefined })], listed([EBOOK_ID]))).toEqual([])
    expect(check([line(EBOOK_ID, 1, { variantKey: 'Deluxe', unitPrice: 900 })], new Map([[EBOOK_ID, listing(EBOOK_ID, { variants })]]))).toEqual([])
  })

  it('blocks a line that names no digital product of this store', () => {
    for (const listings of [new Map(), new Map([[EBOOK_ID, listing(EBOOK_ID, { storeId: 'elsewhere' })]]), new Map([[EBOOK_ID, listing(EBOOK_ID, { fulfillment: 'shipped' })]])]) {
      expect(check([line(EBOOK_ID)], listings).map((p) => p.blocking)).toEqual([true])
    }
  })

  it('blocks malformed buyer-written lines instead of throwing', () => {
    const odd = { ...line(EBOOK_ID), variantKey: 7 } as unknown as OrderItem
    const withVariants = new Map([[EBOOK_ID, listing(EBOOK_ID, { variants })]])
    expect(() => check([odd], withVariants)).not.toThrow()
    expect(check([odd], withVariants).map((p) => p.blocking)).toEqual([true])
    expect(check([{ ...line(EBOOK_ID), itemTitle: { x: 1 } } as unknown as OrderItem], listed([EBOOK_ID]))[0].blocking).toBe(true)
    // The well-formed line beside it is still checked, and the order is held.
    expect(check([odd, line(EBOOK_ID)], withVariants).some((p) => p.blocking)).toBe(true)
  })

  it('blocks an item id that is not a document id, which would fail a batched lookup', () => {
    for (const itemId of ['not base58 0OIl', 'abc', '']) {
      const odd = line(EBOOK_ID, 1, { itemId })
      expect(digitalLines({ items: [odd, line(EBOOK_ID)] }).map((l) => l.itemId)).toEqual([EBOOK_ID])
      expect(check([odd], listed([EBOOK_ID])).map((p) => p.blocking)).toEqual([true])
    }
    // A valid order beside it is unaffected.
    expect(check([line(EBOOK_ID)], listed([EBOOK_ID]))).toEqual([])
  })

  it('blocks a malformed currency instead of throwing', () => {
    const payload = { items: [line(EBOOK_ID)], currency: Object.create(null) as unknown as string }
    expect(() => lineProblems(payload, 'store', listed([EBOOK_ID]))).not.toThrow()
    expect(lineProblems(payload, 'store', listed([EBOOK_ID])).map((p) => p.blocking)).toEqual([true])
  })

  it('flags a title, variant, price or currency the listing does not have, for review', () => {
    const withVariants = new Map([[EBOOK_ID, listing(EBOOK_ID, { variants })]])
    // The premium variant at the cheap variant's price.
    expect(check([line(EBOOK_ID, 1, { variantKey: 'Deluxe', unitPrice: 100 })], withVariants)).toHaveLength(1)
    expect(check([line(EBOOK_ID, 1, { variantKey: 'Gold' })], withVariants)).toHaveLength(1)
    expect(check([line(EBOOK_ID)], withVariants)).toHaveLength(1)
    expect(check([line(EBOOK_ID, 1, { itemTitle: 'Something else' })], listed([EBOOK_ID]))).toHaveLength(1)
    expect(check([line(EBOOK_ID)], listed([EBOOK_ID]), 'EUR')).toHaveLength(1)
    expect(check([line(EBOOK_ID, 1, { itemTitle: 'X', unitPrice: 5 })], listed([EBOOK_ID])).every((p) => !p.blocking)).toBe(true)
  })
})

describe('isReadyForBulkDelivery', () => {
  const kits = new Map([[SONG_ID, kit({ assets: [file('song.mp3')] })], [NOW_ID, kit({ deliverWhen: 'on_order', assets: [file('now.zip')] })]])
  const ready = (items: OrderItem[], latestStatus?: OrderStatus, extra: Partial<BulkReadinessInput> = {}) =>
    isReadyForBulkDelivery({ payload: { items }, storeId: 'store', latestStatus, alreadyDelivered: false, kits, listings: listed([SONG_ID, NOW_ID, GAME_ID]), ...extra })

  it('waits for payment unless every kit delivers on order', () => {
    expect(ready([line(SONG_ID)])).toBe(false)
    expect(ready([line(SONG_ID)], 'pending')).toBe(false)
    expect(ready([line(SONG_ID)], 'payment_received')).toBe(true)
    expect(ready([line(NOW_ID)])).toBe(true)
    expect(ready([line(NOW_ID), line(SONG_ID)], 'pending')).toBe(false)
  })

  it('never re-delivers, delivers a closed order, or delivers without a kit', () => {
    expect(ready([line(NOW_ID)], undefined, { alreadyDelivered: true })).toBe(false)
    expect(ready([line(NOW_ID)], 'refunded')).toBe(false)
    expect(ready([line(OTHER_ID)], 'payment_received', { listings: listed([OTHER_ID]) })).toBe(false)
    expect(ready([line(MUG_ID, 1, { fulfillment: undefined })], 'payment_received')).toBe(false)
  })

  it('only trusts the seller\'s listing, not the buyer-written line', () => {
    // An item from another of the seller's stores.
    expect(ready([line(NOW_ID)], undefined, { listings: new Map([[NOW_ID, listing(NOW_ID, { storeId: 'other-store' })]]) })).toBe(false)
    // Switched back to shipped: its old kit is still there.
    expect(ready([line(NOW_ID)], undefined, { listings: new Map([[NOW_ID, listing(NOW_ID, { fulfillment: 'shipped' })]]) })).toBe(false)
    // Not found (or its read failed).
    expect(ready([line(NOW_ID)], undefined, { listings: new Map() })).toBe(false)
    // An expensive product dressed as a cheap one: the id decides what is sent.
    expect(ready([line(NOW_ID, 1, { itemTitle: 'CHEAP THING' })])).toBe(false)
    expect(ready([line(NOW_ID, 1, { unitPrice: 1 })])).toBe(false)
  })

  it('holds an order with a malformed digital line without throwing', () => {
    const odd = { ...line(NOW_ID), variantKey: 7 } as unknown as OrderItem
    expect(() => ready([odd])).not.toThrow()
    expect(ready([odd])).toBe(false)
    expect(ready([odd, line(NOW_ID)])).toBe(false)
  })

  it('leaves a large key order for the seller to review, however its lines are split', () => {
    const pool = Array.from({ length: 50 }, (_, i) => `k${i}`)
    const many = new Map([[GAME_ID, kit({ deliverWhen: 'on_order', licenseKeys: pool })]])
    expect(ready([line(GAME_ID, MAX_BULK_KEYS_PER_ITEM)], undefined, { kits: many })).toBe(true)
    expect(ready([line(GAME_ID, MAX_BULK_KEYS_PER_ITEM + 1)], undefined, { kits: many })).toBe(false)
    expect(ready([line(GAME_ID, MAX_BULK_KEYS_PER_ITEM), line(GAME_ID, MAX_BULK_KEYS_PER_ITEM)], undefined, { kits: many })).toBe(false)
  })

  it('holds an order whose key pool has run out', () => {
    const empty = new Map([[GAME_ID, kit({ deliverWhen: 'on_order', licenseKeys: [] })]])
    expect(ready([line(GAME_ID)], undefined, { kits: empty })).toBe(false)
  })

  it('holds an order whose delivery would not fit the contract\'s payload cap', () => {
    const huge = new Map([[NOW_ID, kit({ deliverWhen: 'on_order', instructions: 'x'.repeat(MAX_DELIVERY_PLAINTEXT_BYTES) })]])
    expect(ready([line(NOW_ID)], undefined, { kits: huge })).toBe(false)
  })
})

describe('wire format', () => {
  it('never quotes malformed plaintext in its decode errors', () => {
    const secret = new TextEncoder().encode('{"v":1,"licenseKeys":["SECRET-CODE"')
    for (const decode of [decodeKit, decodeDelivery]) {
      const error = (() => { try { decode(secret); return null } catch (e) { return e as Error } })()
      expect(error?.message).toBe('Malformed encrypted payload')
      expect(String(error?.cause ?? '')).not.toMatch(/SECRET/)
    }
  })

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
