import { describe, expect, it, vi } from 'vitest'

// Digital products exist from storefront v6; option-targeted assets only on v7.
vi.hoisted(() => { process.env.NEXT_PUBLIC_STOREFRONT_TOPOLOGY = 'v7' })
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
  deliveredFor,
  digitalLines,
  isDigitalOnly,
  isReadyForBulkDelivery,
  kitDeliveryFitError,
  lineCoverage,
  kitsAfterDelivery,
  lineProblems,
  planDelivery,
  assetsForVariant,
  describeAssetTarget,
  retargetAxis,
  withAssetTarget,
  wholeOrderProblems,
  withHeldDeliveries,
  coverageChanged,
  deliveryCompletesOrder,
} from './digital-delivery-plan'
import type { BulkReadinessInput, ItemListing } from './digital-delivery-plan'
import type { DigitalAsset, ItemDeliverablePayload, ItemVariants, OrderItem, OrderStatus } from '../../types'

/** Products by name, each with a real 32-byte base58 id (the codecs refuse anything else). */
const NAMES = ['ebook', 'game', 'song', 'now', 'mug', 'other'] as const
const ID_LIST = NAMES.map((_, i) => bs58.encode(new Uint8Array(32).fill(i + 1)))
const IDS = new Map(ID_LIST.map((id, i) => [id, NAMES[i]]))
const [EBOOK_ID, GAME_ID, SONG_ID, NOW_ID, MUG_ID, OTHER_ID] = ID_LIST
/** A product's title, as the helpers below write it: its name in capitals. */
const titleOf = (itemId: string) => (IDS.get(itemId) ?? itemId).toUpperCase()
const KEY = 'A'.repeat(43) + '='
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const file = (name: string, optionIds?: number[]) =>
  ({ kind: 'file' as const, name, size: 10, url: `ipfs://${CID}`, key: KEY, ...(optionIds ? { optionIds } : {}) })
const line = (itemId: string, quantity = 1, extra: Partial<OrderItem> = {}): OrderItem =>
  ({ itemId, itemTitle: titleOf(itemId), quantity, unitPrice: 100, fulfillment: 'digital', ...extra })
const kit = (extra: Partial<ItemDeliverablePayload> = {}): ItemDeliverablePayload =>
  ({ v: 1, assets: [], deliverWhen: 'payment_confirmed', ...extra })
/** These items, listed as digital in store `store` (title and price as `line()` writes them). */
const listing = (itemId: string, extra: Partial<ItemListing> = {}): ItemListing =>
  ({ storeId: 'store', fulfillment: 'digital', title: titleOf(itemId), basePrice: 100, currency: 'USD', stockQuantity: undefined, ...extra })
const listed = (itemIds: string[]) => new Map(itemIds.map((itemId) => [itemId, listing(itemId)]))
const NO_LISTINGS = new Map<string, ItemListing>()

/** One axis "Format": PDF (option 1) at 100, Deluxe (option 2) at 900. */
const FORMATS: ItemVariants = {
  axes: [{ name: 'Format', options: [{ id: 1, name: 'PDF' }, { id: 2, name: 'Deluxe' }] }],
  combinations: [{ id: '1', optionIds: [1], price: 100 }, { id: '2', optionIds: [2], price: 900 }],
  nextOptionId: 3,
}
/** Color (Red 1, Blue 2) by Size (S 3, XL 4); Blue / XL is not sold. */
const TEES: ItemVariants = {
  axes: [
    { name: 'Color', options: [{ id: 1, name: 'Red' }, { id: 2, name: 'Blue' }] },
    { name: 'Size', options: [{ id: 3, name: 'S' }, { id: 4, name: 'XL' }] },
  ],
  combinations: [
    { id: '1.3', optionIds: [1, 3], price: 100 },
    { id: '1.4', optionIds: [1, 4], price: 100 },
    { id: '2.3', optionIds: [2, 3], price: 100 },
  ],
  nextOptionId: 5,
}
const withVariants = (itemId: string, variants: ItemVariants, extra: Partial<ItemListing> = {}) =>
  new Map([[itemId, listing(itemId, { variants, ...extra })]])
const names = (assets: DigitalAsset[]) => assets.map((asset) => (asset.kind === 'file' ? asset.name : asset.label))

describe('planDelivery', () => {
  it('delivers only digital lines, with the assets of each line\'s variant', () => {
    const kits = new Map([[EBOOK_ID, kit({ assets: [file('cover.png'), file('book.pdf', [1]), file('book.epub', [2])], instructions: 'Enjoy' })]])
    const order = { items: [line(EBOOK_ID, 1, { variantId: '2', variantLabel: 'Deluxe' }), line(MUG_ID, 1, { fulfillment: undefined })] }
    const plan = planDelivery(order, kits, withVariants(EBOOK_ID, FORMATS), '  thanks  ')
    expect(plan.missingKits).toEqual([])
    expect(plan.delivery.message).toBe('thanks')
    expect(plan.delivery.items).toHaveLength(1)
    const [item] = plan.delivery.items
    expect(names(item.assets)).toEqual(['cover.png', 'book.epub'])
    // The buyer never sees which options an asset was filed under.
    expect(item.assets.every((asset) => asset.optionIds === undefined)).toBe(true)
    expect(item.variantId).toBe('2')
    expect(item.variantLabel).toBe('Deluxe')
    expect(item.instructions).toBe('Enjoy')
  })

  it('before v7, where option ids are numbered by position, sends only untargeted assets', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v6')
    try {
      const legacy = await import('./digital-delivery-plan')
      const kits = new Map([[EBOOK_ID, kit({ assets: [file('cover.png'), file('book.pdf', [1]), file('book.epub', [2])] })]])
      const plan = legacy.planDelivery({ items: [line(EBOOK_ID, 1, { variantId: '2', variantLabel: 'Deluxe' })] }, kits, withVariants(EBOOK_ID, FORMATS))
      expect(names(plan.delivery.items[0].assets)).toEqual(['cover.png'])
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('takes license keys from the front of a shared pool, quantity per line', () => {
    const kits = new Map([[GAME_ID, kit({ licenseKeys: ['k1', 'k2', 'k3', 'k4'] })]])
    const plan = planDelivery({ items: [line(GAME_ID, 2, { variantId: '1' }), line(GAME_ID, 1, { variantId: '2' })] }, kits, withVariants(GAME_ID, FORMATS))
    expect(plan.delivery.items.map((item) => item.licenseKeys)).toEqual([['k1', 'k2'], ['k3']])
    expect(plan.consumedKeys.get(GAME_ID)).toBe(3)
    expect(plan.shortOnKeys).toEqual([])
    expect(kitsAfterDelivery(kits, plan.consumedKeys).get(GAME_ID)?.licenseKeys).toEqual(['k4'])
  })

  it('names a variant in a receipt by its id, with its label cut to a fixed length', () => {
    const kits = new Map([[EBOOK_ID, kit({ assets: [file('book.pdf')] })]])
    const order = line(EBOOK_ID, 1, { variantId: '1', variantLabel: 'V'.repeat(5000) })
    const [item] = planDelivery({ items: [order] }, kits, withVariants(EBOOK_ID, FORMATS)).delivery.items
    expect(item.variantId).toBe('1')
    expect(item.variantLabel).toHaveLength(60)
    expect(JSON.stringify(item)).not.toContain('V'.repeat(61))
    // Receipts still match their own line, and only that one.
    expect(deliveredFor(item, order)).toBe(true)
    expect(deliveredFor(item, line(EBOOK_ID, 1, { variantId: '2' }))).toBe(false)
    expect(deliveredFor(item, line(EBOOK_ID))).toBe(false)
    expect(decodeDelivery(encodeDelivery({ v: 1, items: [item] })).items[0]).toEqual(item)
  })

  it('labels a receipt from the listing when the line carries no label', () => {
    const kits = new Map([[EBOOK_ID, kit({ assets: [file('book.pdf')] })]])
    const [item] = planDelivery({ items: [line(EBOOK_ID, 1, { variantId: '2' })] }, kits, withVariants(EBOOK_ID, FORMATS)).delivery.items
    expect(item.variantLabel).toBe('Deluxe')
  })

  it('treats a line whose variant id is not a short canonical one as malformed', () => {
    for (const variantId of ['1.2.3.4.5.6.7.8.9.10', 'Red', '1..2', '', 7]) {
      const odd = { ...line(EBOOK_ID), variantId } as unknown as OrderItem
      expect(digitalLines({ items: [odd] })).toEqual([])
    }
    expect(digitalLines({ items: [line(EBOOK_ID, 1, { variantId: '254.254.254.254.254' })] })).toHaveLength(1)
  })

  it('takes no new codes for lines the seller re-sends without asking for them', () => {
    const kits = new Map([[GAME_ID, kit({ licenseKeys: ['k1', 'k2'] })], [SONG_ID, kit({ licenseKeys: ['s1'] })]])
    const resent = line(GAME_ID)
    const plan = planDelivery({ items: [resent, line(SONG_ID)] }, kits, NO_LISTINGS, undefined, (l) => l === resent)
    expect(plan.delivery.items[0].licenseKeys).toBeUndefined()
    expect(plan.delivery.items[1].licenseKeys).toEqual(['s1'])
    expect([...plan.consumedKeys]).toEqual([[SONG_ID, 1]])
  })

  it('reports lines it cannot fulfil', () => {
    const kits = new Map([[GAME_ID, kit({ licenseKeys: ['k1'] })]])
    const plan = planDelivery({ items: [line(GAME_ID, 2), line(SONG_ID)] }, kits, NO_LISTINGS)
    expect(plan.shortOnKeys).toEqual(['GAME'])
    expect(plan.missingKits).toEqual(['SONG'])
    expect(plan.delivery.items[0].licenseKeys).toEqual(['k1'])
  })

  it('refuses quantities that are not whole units, since the buyer writes them', () => {
    const kits = new Map([[GAME_ID, kit({ licenseKeys: ['k1', 'k2'] })]])
    for (const quantity of [0, -1, 1.5, Number.NaN, 1001]) {
      const plan = planDelivery({ items: [line(GAME_ID, quantity)] }, kits, NO_LISTINGS)
      expect(plan.invalidQuantities).toEqual(['GAME'])
      expect(plan.delivery.items).toEqual([])
      expect(plan.consumedKeys.size).toBe(0)
      expect(planBlockers(plan)).toHaveLength(1)
    }
  })

  it('blocks a line with nothing to deliver for its variant', () => {
    const kits = new Map([[EBOOK_ID, kit({ deliverWhen: 'on_order', assets: [file('book.pdf', [1])] })]])
    const order = { items: [line(EBOOK_ID, 1, { variantId: '2', unitPrice: 900 })] }
    const listings = withVariants(EBOOK_ID, FORMATS)
    const plan = planDelivery(order, kits, listings)
    expect(plan.emptyLines).toEqual(['EBOOK'])
    expect(planBlockers(plan)).toHaveLength(1)
    expect(isReadyForBulkDelivery({ payload: order, storeId: 'store', latestStatus: undefined, alreadyDelivered: false, kits, listings })).toBe(false)
  })

  it('leaves pools without license keys alone', () => {
    const kits = new Map([[SONG_ID, kit({ assets: [file('song.mp3')] })]])
    const plan = planDelivery({ items: [line(SONG_ID, 3)] }, kits, NO_LISTINGS)
    expect(plan.delivery.items[0].licenseKeys).toBeUndefined()
    expect(kitsAfterDelivery(kits, plan.consumedKeys).size).toBe(0)
  })
})

describe('targeting assets at options', () => {
  const all = file('all.zip')
  const red = file('red.zip', [1])
  const xl = file('xl.zip', [4])
  const redXl = file('red-xl.zip', [4, 1])

  it('applies an asset to every variant that has all of its options', () => {
    const assets = [all, red, xl, redXl]
    expect(names(assetsForVariant(assets, [1, 4]))).toEqual(['all.zip', 'red.zip', 'xl.zip', 'red-xl.zip'])
    expect(names(assetsForVariant(assets, [1, 3]))).toEqual(['all.zip', 'red.zip'])
    expect(names(assetsForVariant(assets, [2, 3]))).toEqual(['all.zip'])
    // A variant that cannot be resolved gets only what every variant gets.
    expect(names(assetsForVariant(assets, undefined))).toEqual(['all.zip'])
    expect(names(assetsForVariant([{ ...all, optionIds: [] }], undefined))).toEqual(['all.zip'])
  })

  it('resolves each line\'s options from the listing', () => {
    const kits = new Map([[GAME_ID, kit({ assets: [all, red, xl, redXl] })]])
    const order = { items: [line(GAME_ID, 1, { variantId: '1.4' }), line(GAME_ID, 1, { variantId: '2.3' }), line(GAME_ID, 1, { variantId: '2.4' })] }
    const plan = planDelivery(order, kits, withVariants(GAME_ID, TEES))
    expect(plan.delivery.items.map((item) => names(item.assets))).toEqual([
      ['all.zip', 'red.zip', 'xl.zip', 'red-xl.zip'],
      ['all.zip'],
      // Blue / XL is not sold: its line gets only the untargeted asset.
      ['all.zip'],
    ])
    // Without the listing, nothing targeted applies.
    expect(planDelivery(order, kits, NO_LISTINGS).delivery.items.map((item) => names(item.assets))).toEqual([['all.zip'], ['all.zip'], ['all.zip']])
  })

  it('edits a target axis by axis, dropping options the listing no longer has', () => {
    expect(retargetAxis(TEES, undefined, 0, 1)).toEqual([1])
    expect(retargetAxis(TEES, [1], 1, 4)).toEqual([1, 4])
    expect(retargetAxis(TEES, [1, 4], 0, 2)).toEqual([4, 2])
    expect(retargetAxis(TEES, [1, 4], 1, undefined)).toEqual([1])
    expect(retargetAxis(TEES, [99, 4], 0, 1)).toEqual([4, 1])
    expect(withAssetTarget(red, [])).toEqual(file('red.zip'))
    expect(withAssetTarget(all, [2])).toEqual(file('all.zip', [2]))
  })

  it('describes a target for the seller', () => {
    expect(describeAssetTarget(TEES, undefined)).toEqual({ label: 'All variants', matchesNone: false })
    expect(describeAssetTarget(TEES, [4, 1])).toEqual({ label: 'Red / XL', matchesNone: false })
    expect(describeAssetTarget(TEES, [4])).toEqual({ label: 'XL', matchesNone: false })
    expect(describeAssetTarget(TEES, [2, 4])).toEqual({ label: 'Blue / XL', matchesNone: true })
    expect(describeAssetTarget(TEES, [1, 99])).toEqual({ label: 'Red / Removed option', matchesNone: true })
  })
})

describe('lineProblems', () => {
  const check = (items: OrderItem[], listings: Map<string, ItemListing>, currency = 'USD') =>
    lineProblems({ items, currency }, 'store', listings)
  const formats = withVariants(EBOOK_ID, FORMATS)

  it('passes a line that matches its listing, and ignores shipped lines', () => {
    expect(check([line(EBOOK_ID), line(MUG_ID, 1, { fulfillment: undefined })], listed([EBOOK_ID]))).toEqual([])
    expect(check([line(EBOOK_ID, 1, { variantId: '2', variantLabel: 'Deluxe', unitPrice: 900 })], formats)).toEqual([])
  })

  it('blocks a line that names no digital product of this store', () => {
    for (const listings of [new Map(), new Map([[EBOOK_ID, listing(EBOOK_ID, { storeId: 'elsewhere' })]]), new Map([[EBOOK_ID, listing(EBOOK_ID, { fulfillment: 'shipped' })]])]) {
      expect(check([line(EBOOK_ID)], listings).map((p) => p.blocking)).toEqual([true])
    }
  })

  it('blocks malformed buyer-written lines instead of throwing', () => {
    const odd = { ...line(EBOOK_ID), variantId: 7 } as unknown as OrderItem
    expect(() => check([odd], formats)).not.toThrow()
    expect(check([odd], formats).map((p) => p.blocking)).toEqual([true])
    expect(check([{ ...line(EBOOK_ID), variantLabel: 7 } as unknown as OrderItem], formats)[0].blocking).toBe(true)
    expect(check([{ ...line(EBOOK_ID), itemTitle: { x: 1 } } as unknown as OrderItem], listed([EBOOK_ID]))[0].blocking).toBe(true)
    // The well-formed line beside it is still checked, and the order is held.
    expect(check([odd, line(EBOOK_ID)], formats).some((p) => p.blocking)).toBe(true)
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

  it('blocks an order that repeats an item and variant, so one receipt cannot count twice', () => {
    expect(check([line(EBOOK_ID), line(EBOOK_ID)], listed([EBOOK_ID])).map((p) => p.blocking)).toEqual([true])
    const tees = withVariants(EBOOK_ID, TEES)
    expect(check([line(EBOOK_ID, 1, { variantId: '1.3' }), line(EBOOK_ID, 1, { variantId: '2.3' })], tees)).toEqual([])
    expect(check([line(EBOOK_ID, 1, { variantId: '1.3' }), line(EBOOK_ID, 1, { variantId: '1.3' })], tees).map((p) => p.blocking)).toEqual([true])
  })

  it('finds repeated lines and invalid quantities over the whole order, whichever part is delivered', () => {
    expect(wholeOrderProblems({ items: [line(EBOOK_ID), line(SONG_ID), line(EBOOK_ID)] })).toHaveLength(1)
    expect(wholeOrderProblems({ items: [line(EBOOK_ID), line(SONG_ID, 0)] })).toHaveLength(1)
    expect(wholeOrderProblems({ items: [line(EBOOK_ID), line(SONG_ID, -2)] })).toHaveLength(1)
    expect(wholeOrderProblems({ items: [line(EBOOK_ID), line(SONG_ID)] })).toEqual([])
    expect(wholeOrderProblems({ items: [line(EBOOK_ID, 1, { variantId: '1' }), line(EBOOK_ID, 1, { variantId: '2' })] })).toEqual([])
  })

  it('blocks an invalid order quantity whatever is delivered of it', () => {
    for (const quantity of [1.5, 0, 1001]) {
      expect(check([line(EBOOK_ID, quantity)], listed([EBOOK_ID])).map((p) => p.blocking)).toEqual([true])
    }
  })

  it('blocks a malformed currency instead of throwing', () => {
    const payload = { items: [line(EBOOK_ID)], currency: Object.create(null) as unknown as string }
    expect(() => lineProblems(payload, 'store', listed([EBOOK_ID]))).not.toThrow()
    expect(lineProblems(payload, 'store', listed([EBOOK_ID])).map((p) => p.blocking)).toEqual([true])
  })

  it('flags a product no longer on sale for review, and holds it from bulk delivery', () => {
    for (const status of ['paused', 'sold_out', 'deleted'] as const) {
      const listings = new Map([[EBOOK_ID, listing(EBOOK_ID, { status })]])
      expect(check([line(EBOOK_ID)], listings).map((p) => p.blocking)).toEqual([false])
      expect(isReadyForBulkDelivery({ payload: { items: [line(EBOOK_ID)] }, storeId: 'store', latestStatus: undefined, alreadyDelivered: false, kits: new Map([[EBOOK_ID, kit({ deliverWhen: 'on_order', assets: [file('a.zip')] })]]), listings })).toBe(false)
    }
    expect(check([line(EBOOK_ID)], new Map([[EBOOK_ID, listing(EBOOK_ID, { status: 'active' })]]))).toEqual([])
  })

  it('flags a quantity beyond tracked stock for review, as checkout reads stock, and holds it from bulk delivery', () => {
    const onOrder = new Map([[EBOOK_ID, kit({ deliverWhen: 'on_order', assets: [file('a.zip')] })]])
    const bulk = (items: OrderItem[], listings: Map<string, ItemListing>) =>
      isReadyForBulkDelivery({ payload: { items }, storeId: 'store', latestStatus: undefined, alreadyDelivered: false, kits: onOrder, listings })
    // Base stock: out of stock, or less than ordered.
    for (const [stockQuantity, quantity] of [[0, 1], [2, 3]]) {
      const listings = new Map([[EBOOK_ID, listing(EBOOK_ID, { stockQuantity })]])
      expect(check([line(EBOOK_ID, quantity)], listings).map((p) => p.blocking)).toEqual([false])
      expect(bulk([line(EBOOK_ID, quantity)], listings)).toBe(false)
    }
    // Enough stock, or untracked: nothing to review.
    expect(check([line(EBOOK_ID, 2)], new Map([[EBOOK_ID, listing(EBOOK_ID, { stockQuantity: 2 })]]))).toEqual([])
    expect(bulk([line(EBOOK_ID, 2)], new Map([[EBOOK_ID, listing(EBOOK_ID, { stockQuantity: 2 })]]))).toBe(true)
    expect(check([line(EBOOK_ID, 5)], listed([EBOOK_ID]))).toEqual([])
    // A variant's own stock decides, untracked (unlimited) when it has none.
    const stocked: ItemVariants = { ...FORMATS, combinations: [{ id: '1', optionIds: [1], price: 100 }, { id: '2', optionIds: [2], price: 900, stock: 0 }] }
    const withStock = withVariants(EBOOK_ID, stocked, { stockQuantity: 0 })
    expect(check([line(EBOOK_ID, 1, { variantId: '2', unitPrice: 900 })], withStock).map((p) => p.text)).toEqual(['"EBOOK" is out of stock.'])
    expect(bulk([line(EBOOK_ID, 1, { variantId: '2', unitPrice: 900 })], withStock)).toBe(false)
    expect(check([line(EBOOK_ID, 3, { variantId: '1' })], withStock)).toEqual([])
  })

  it('flags a title, variant, price or currency the listing does not have, for review', () => {
    // The premium variant at the cheap variant's price.
    expect(check([line(EBOOK_ID, 1, { variantId: '2', unitPrice: 100 })], formats).map((p) => p.text)).toEqual(['The order\'s price for "EBOOK" differs from your listing.'])
    // A variant the listing no longer offers, named by the order's own label.
    expect(check([line(EBOOK_ID, 1, { variantId: '3', variantLabel: 'Gold' })], formats).map((p) => p.text)).toEqual(['"EBOOK" has no option "Gold" any more.'])
    expect(check([line(EBOOK_ID, 1, { variantId: '3' })], formats)).toHaveLength(1)
    // A variant on an item without variants, and no variant on one with them.
    expect(check([line(EBOOK_ID, 1, { variantId: '1' })], listed([EBOOK_ID]))).toHaveLength(1)
    expect(check([line(EBOOK_ID)], formats)).toHaveLength(1)
    expect(check([line(EBOOK_ID, 1, { itemTitle: 'Something else' })], listed([EBOOK_ID]))).toHaveLength(1)
    expect(check([line(EBOOK_ID)], listed([EBOOK_ID]), 'EUR')).toHaveLength(1)
    expect(check([line(EBOOK_ID, 1, { itemTitle: 'X', unitPrice: 5 })], listed([EBOOK_ID])).every((p) => !p.blocking)).toBe(true)
  })

  it('checks a variant line against its price as the listing has it now', () => {
    const repriced = withVariants(EBOOK_ID, { ...FORMATS, combinations: [{ id: '1', optionIds: [1], price: 150 }, { id: '2', optionIds: [2], price: 900 }] })
    expect(check([line(EBOOK_ID, 1, { variantId: '1' })], repriced)).toHaveLength(1)
    expect(check([line(EBOOK_ID, 1, { variantId: '1', unitPrice: 150 })], repriced)).toEqual([])
  })
})

describe('lineCoverage', () => {
  const sent = (licenseKeys: string[], unconfirmed = false, variantId?: string) =>
    ({ unconfirmed, payload: { v: 1 as const, items: [{ itemId: GAME_ID, itemTitle: 'GAME', ...(variantId ? { variantId } : {}), assets: [], licenseKeys }] } })

  it('counts confirmed and pending codes apart', () => {
    const coverage = lineCoverage(line(GAME_ID, 3), [sent(['k1']), sent(['k2'], true)])
    expect(coverage).toEqual({ possibly: true, confirmed: true, possiblyCodes: 2, confirmedCodes: 1 })
  })

  it('treats a receipt it cannot read as possibly holding every code, never as confirmed', () => {
    expect(lineCoverage(line(GAME_ID, 3), [{ unconfirmed: false, payload: undefined }])).toEqual({ possibly: true, confirmed: false, possiblyCodes: 3, confirmedCodes: 0 })
  })

  it('matches receipts by item and variant id', () => {
    expect(lineCoverage(line(GAME_ID, 1, { variantId: '2' }), [sent(['k1'])]).possibly).toBe(false)
    expect(lineCoverage(line(GAME_ID, 1, { variantId: '2' }), [sent(['k1'], false, '2')]).confirmedCodes).toBe(1)
    expect(lineCoverage(line(GAME_ID, 1, { variantId: '1' }), [sent(['k1'], false, '2')]).possibly).toBe(false)
    expect(lineCoverage(line(GAME_ID), [sent(['k1'], false, '2')]).possibly).toBe(false)
  })
})

describe('re-checking receipts before a delivery', () => {
  const receipt = (n: number, licenseKeys: string[], unconfirmed = false) =>
    ({ nonce: new Uint8Array([n]), unconfirmed, payload: { v: 1 as const, items: [{ itemId: GAME_ID, itemTitle: 'GAME', assets: [], licenseKeys }] } })

  it('keeps a held receipt a lagging read does not show, and takes the read\'s copy once it does', () => {
    const pending = receipt(2, ['k2'], true)
    expect(withHeldDeliveries([receipt(1, ['k1'])], [receipt(1, ['k1']), pending])).toEqual([receipt(1, ['k1']), pending])
    expect(withHeldDeliveries([receipt(1, ['k1']), receipt(2, ['k2'])], [pending])).toEqual([receipt(1, ['k1']), receipt(2, ['k2'])])
    // Receipts are append-only: a confirmed one missing from the read is a lagging node, never a removal.
    expect(withHeldDeliveries([], [receipt(1, ['k1'])])).toEqual([receipt(1, ['k1'])])
  })

  it('completes a split order once an earlier part confirms, judged from the receipts just read', () => {
    const product = (itemId: string, licenseKeys?: string[]) =>
      ({ itemId, itemTitle: titleOf(itemId), assets: [], ...(licenseKeys ? { licenseKeys } : {}) })
    const part = (n: number, items: ReturnType<typeof product>[], unconfirmed = false) =>
      ({ nonce: new Uint8Array([n]), unconfirmed, payload: { v: 1 as const, items } })
    const lines = [line(EBOOK_ID), line(SONG_ID)]
    // Sending the song now; the ebook went out earlier.
    const songNow = [{ selected: false, sellsCodes: false, codes: 0 }, { selected: true, sellsCodes: false, codes: 0 }]
    const pending = [part(1, [product(EBOOK_ID)], true)]
    const confirmed = [part(1, [product(EBOOK_ID)])]
    // The form opened while the ebook's part was pending: not complete.
    expect(deliveryCompletesOrder(lines, pending, songNow)).toBe(false)
    // It confirmed since: the pre-send read sees it, and this delivery finishes the order.
    expect(coverageChanged(lines, pending, confirmed)).toBe(false)
    expect(deliveryCompletesOrder(lines, confirmed, songNow)).toBe(true)
    // A code line needs all its codes in confirmed receipts plus this one.
    const codeLine = [line(GAME_ID, 3)]
    const twoSent = [part(2, [product(GAME_ID, ['k1', 'k2'])])]
    expect(deliveryCompletesOrder(codeLine, twoSent, [{ selected: true, sellsCodes: true, codes: 1 }])).toBe(true)
    expect(deliveryCompletesOrder(codeLine, twoSent, [{ selected: true, sellsCodes: true, codes: 0 }])).toBe(false)
    expect(deliveryCompletesOrder(codeLine, [part(2, [product(GAME_ID, ['k1', 'k2'])], true)], [{ selected: true, sellsCodes: true, codes: 1 }])).toBe(false)
    // An invalid quantity is never complete.
    expect(deliveryCompletesOrder([line(EBOOK_ID, 0)], confirmed, [{ selected: true, sellsCodes: false, codes: 0 }])).toBe(false)
  })

  it('notices a delivery made elsewhere, but not a pending one confirming', () => {
    const lines = [line(GAME_ID, 2)]
    expect(coverageChanged(lines, [], [receipt(1, ['k1'])])).toBe(true)
    expect(coverageChanged(lines, [receipt(1, ['k1'])], [receipt(1, ['k1']), receipt(2, ['k2'])])).toBe(true)
    expect(coverageChanged(lines, [{ unconfirmed: false, payload: undefined }], [{ unconfirmed: false, payload: undefined }])).toBe(false)
    expect(coverageChanged(lines, [receipt(1, ['k1'], true)], [receipt(1, ['k1'])])).toBe(false)
    expect(coverageChanged([line(SONG_ID)], [], [receipt(1, ['k1'])])).toBe(false)
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

  it('delivers a variant line with the assets for its options', () => {
    const tees = withVariants(NOW_ID, TEES)
    const targeted = new Map([[NOW_ID, kit({ deliverWhen: 'on_order', assets: [file('red.zip', [1])] })]])
    expect(ready([line(NOW_ID, 1, { variantId: '1.4' })], undefined, { kits: targeted, listings: tees })).toBe(true)
    // Blue gets nothing from this kit: held, not sent empty.
    expect(ready([line(NOW_ID, 1, { variantId: '2.3' })], undefined, { kits: targeted, listings: tees })).toBe(false)
  })

  it('holds an order with a malformed digital line without throwing', () => {
    const odd = { ...line(NOW_ID), variantId: 7 } as unknown as OrderItem
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
    const original = kit({ assets: [file('a.zip', [3, 7]), { kind: 'link', label: 'Site', url: 'https://example.com' }], licenseKeys: ['X'], instructions: 'hi', deliverWhen: 'on_order' })
    expect(decodeKit(encodeKit(original))).toEqual(original)
    const delivery = { v: 1 as const, items: [{ itemId: 'a', itemTitle: 'A', variantId: '3.7', variantLabel: 'Red / XL', assets: [file('a.zip')], licenseKeys: ['X'] }], message: 'm' }
    expect(decodeDelivery(encodeDelivery(delivery))).toEqual(delivery)
  })

  it('reads a target of whole option ids from 1 to 254 once each; a target with any unreadable member matches no variant', () => {
    const decoded = decodeKit(new TextEncoder().encode(JSON.stringify({
      v: 1,
      deliverWhen: 'on_order',
      assets: [
        { kind: 'code', label: 'A', code: 'A', optionIds: [3, 254, 3] },
        { kind: 'code', label: 'F', code: 'F', optionIds: [3, '4'] },
        { kind: 'code', label: 'G', code: 'G', optionIds: [3, 0, 255, 1.5] },
        { kind: 'code', label: 'B', code: 'B', optionIds: [0, 'x'] },
        { kind: 'code', label: 'C', code: 'C', optionIds: 'nope', variantKey: 'Gold' },
        { kind: 'code', label: 'D', code: 'D', variantKey: 'Gold' },
        { kind: 'code', label: 'E', code: 'E', optionIds: [] },
      ],
    })))
    expect(decoded.assets).toEqual([
      { kind: 'code', label: 'A', code: 'A', optionIds: [3, 254] },
      // One bad member voids the whole target: dropping it would widen who gets the asset.
      { kind: 'code', label: 'F', code: 'F', optionIds: [0] },
      { kind: 'code', label: 'G', code: 'G', optionIds: [0] },
      // Written for some variants, but not in a way this client reads: never sent to every buyer.
      { kind: 'code', label: 'B', code: 'B', optionIds: [0] },
      { kind: 'code', label: 'C', code: 'C', optionIds: [0] },
      { kind: 'code', label: 'D', code: 'D', optionIds: [0] },
      { kind: 'code', label: 'E', code: 'E' },
    ])
    expect(assetsForVariant(decoded.assets, [3, 254]).map((asset) => (asset.kind === 'code' ? asset.label : ''))).toEqual(['A', 'E'])
  })

  it('reads a receipt\'s variant id only when it is a short canonical one', () => {
    const receipt = (variantId: unknown) => decodeDelivery(new TextEncoder().encode(JSON.stringify({
      v: 1,
      items: [{ itemId: 'a', itemTitle: 'A', assets: [], variantId, variantLabel: 'Red / XL', variantRef: 'abc' }],
    }))).items[0]
    expect(receipt('1.4')).toEqual({ itemId: 'a', itemTitle: 'A', assets: [], variantId: '1.4', variantLabel: 'Red / XL' })
    for (const bad of ['1.2.3.4.5.6.7.8.9.10', 'Red', 7, '']) {
      expect(receipt(bad)).toEqual({ itemId: 'a', itemTitle: 'A', assets: [] })
    }
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
        { kind: 'code', label: 'Gift card', code: 'GIFT-1234', optionIds: [2] },
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

  it('sizes unique codes by their UTF-8 bytes, not their length', () => {
    const room = MAX_DELIVERY_PLAINTEXT_BYTES - 1800
    // 150 kana (450 bytes) outweigh 200 ASCII characters.
    const pool = ['a'.repeat(200), 'あ'.repeat(150)]
    expect(kitDeliveryFitError(kit({ instructions: 'x'.repeat(room - 300), licenseKeys: pool }))).toMatch(/too large/)
    expect(kitDeliveryFitError(kit({ instructions: 'x'.repeat(room - 300), licenseKeys: ['a'.repeat(200)] }))).toBeNull()
  })

  it('counts a title in multi-byte characters at its UTF-8 size', () => {
    // Fits with a 200-byte title, not with the 1,200 bytes 200 escaped control characters take.
    const instructions = 'x'.repeat(MAX_DELIVERY_PLAINTEXT_BYTES - 1000)
    expect(kitDeliveryFitError(kit({ instructions }))).toMatch(/too large/)
  })

  it('sizes the worst-case receipt with the longest variant id', () => {
    // Everything but the instructions, at its worst: a 44-character id, a title
    // and label of escaped control characters, and a 19-character variant id.
    const envelope = new TextEncoder().encode(JSON.stringify({ v: 1, items: [{
      itemId: 'x'.repeat(44), itemTitle: '\u0001'.repeat(200), variantId: '254.254.254.254.254', variantLabel: '\u0001'.repeat(60), assets: [], instructions: '',
    }] })).length
    const room = MAX_DELIVERY_PLAINTEXT_BYTES - envelope
    expect(kitDeliveryFitError(kit({ instructions: 'x'.repeat(room) }))).toBeNull()
    expect(kitDeliveryFitError(kit({ instructions: 'x'.repeat(room + 1) }))).toMatch(/too large/)
  })

  it('refuses a kit that could not go out for one unit in one delivery', () => {
    // Room left after the worst-case title (1,200 bytes), variant label (360) and the envelope.
    const room = MAX_DELIVERY_PLAINTEXT_BYTES - 1800
    expect(kitDeliveryFitError(kit({ instructions: 'x'.repeat(room) }))).toBeNull()
    expect(kitDeliveryFitError(kit({ instructions: 'x'.repeat(MAX_DELIVERY_PLAINTEXT_BYTES) }))).toMatch(/too large to send in one delivery/)
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
      expect(() => planDelivery(cast, new Map(), NO_LISTINGS)).not.toThrow()
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
