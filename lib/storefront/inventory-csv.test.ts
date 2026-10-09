import { describe, expect, it } from 'vitest'
import type { ItemVariants, StoreItem } from '@/lib/types'
import { parseInventoryCSV, toStoreItemData } from '@/lib/upload/inventory-parser'
import { inventoryCsvTemplate, inventoryToCsv, optionTypesSummary } from './inventory-csv'
import { variantsFromRows, type VariantRow } from './variant-codec'

/** `value`, failing the test when it is missing. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

const COLORS = ['Red', 'Blue', 'Green']
const PACKS = ['Single Piece', 'Pack of 4']
const IMAGES = ['https://x.test/toy.jpg', 'https://x.test/red.jpg', 'https://x.test/blue.jpg']

function storeItem(fields: Partial<StoreItem> & Pick<StoreItem, 'id' | 'title'>): StoreItem {
  return { ownerId: 'owner', storeId: 'store', createdAt: new Date(0), status: 'active', currency: 'USD', ...fields }
}

/** A two-option-type toy: images on some combinations, stock and SKUs on all, one combination not offered. */
function toy(): StoreItem {
  const rows: VariantRow[] = COLORS.flatMap((color, c) => PACKS.map((pack, p) => ({
    optionNames: [color, pack], price: p === 0 ? 100 : 353, stock: c * 2 + p, sku: `TOY-${c}-${p}`, image: c < 2 ? c + 2 : undefined,
  }))).filter((row) => row.optionNames.join() !== 'Green,Pack of 4')
  const variants = defined(variantsFromRows(['Primary color', 'Pack Size'], rows).variants)
  return storeItem({ id: 'toyId', title: 'Squishy toy', description: 'Soft, "squishy", and\nwashable', category: 'Toys', tags: ['toy', 'soft'], imageUrls: IMAGES, weight: 120, variants })
}

/** The axes and combinations, compared by option names (ids are renumbered on import). */
function shapeOf(variants: ItemVariants | undefined) {
  const table = defined(variants)
  const names = new Map(table.axes.flatMap((axis) => axis.options.map((option) => [option.id, option.name] as const)))
  return {
    axes: table.axes.map((axis) => [axis.name, axis.options.map((option) => option.name)]),
    combinations: table.combinations.map(({ optionIds, price, stock, sku, weight, image }) =>
      ({ options: optionIds.map((optionId) => names.get(optionId)), price, stock, sku, weight, image })),
  }
}

describe('inventory CSV export', () => {
  it('writes one row per combination with Shopify-style option columns', () => {
    const [header, first, second] = inventoryToCsv([toy()], 'USD').csv.split('\n')
    expect(header).toBe('Group,Title,Description,Section,Category,Subcategory,Tags,SKU,Price,Quantity,Weight,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Image1,Image2,Image3,Image URL')
    expect(first).toBe('toyId,Squishy toy,"Soft, ""squishy"", and')
    expect(second).toBe('washable",,Toys,,"toy, soft",TOY-0-0,1.00,0,120,Primary color,Red,Pack Size,Single Piece,https://x.test/toy.jpg,https://x.test/red.jpg,https://x.test/blue.jpg,https://x.test/red.jpg')
  })

  it('uploads again to the same products', () => {
    const plain = storeItem({ id: 'mugId', title: 'Mug', basePrice: 900, stockQuantity: 3, sku: 'MUG', imageUrls: ['https://x.test/mug.jpg'] })
    const untracked = storeItem({
      id: 'capId', title: 'Cap',
      variants: defined(variantsFromRows(['Size'], [{ optionNames: ['M'], price: 500 }, { optionNames: ['L'], price: 600 }]).variants),
    })
    const original = [toy(), plain, untracked]

    const result = parseInventoryCSV(inventoryToCsv(original, 'USD').csv, 'USD')
    expect(result.errors).toEqual([])
    expect(result.items.flatMap((item) => [...item.errors, ...item.warnings])).toEqual([])
    const [toyBack, mugBack, capBack] = result.items

    expect(shapeOf(toyBack.variants)).toEqual(shapeOf(original[0].variants))
    expect(toStoreItemData(toyBack)).toMatchObject({ title: 'Squishy toy', description: 'Soft, "squishy", and\nwashable', category: 'Toys', tags: ['toy', 'soft'], imageUrls: IMAGES, weight: 120 })
    expect(toStoreItemData(mugBack)).toMatchObject({ title: 'Mug', basePrice: 900, stockQuantity: 3, sku: 'MUG', imageUrls: ['https://x.test/mug.jpg'] })
    expect(mugBack.variants).toBeUndefined()
    expect(shapeOf(capBack.variants)).toEqual(shapeOf(untracked.variants))
  })

  it('writes a v1–v6 combination image that is not in the gallery', () => {
    const item = toy()
    const variants = defined(item.variants)
    const first = { ...variants.combinations[0], image: undefined, imageUrl: 'https://x.test/fifth.jpg' }
    const csv = inventoryToCsv([{ ...item, variants: { ...variants, combinations: [first, ...variants.combinations.slice(1)] } }], 'USD').csv
    expect(csv).toMatch(/,https:\/\/x\.test\/fifth\.jpg\n/)
  })

  it('writes prices in the item currency', () => {
    const coin = storeItem({ id: 'c', title: 'Coin', currency: 'DASH', basePrice: 12345678 })
    expect(inventoryToCsv([coin], 'USD').csv.split('\n')[1]).toContain(',0.12345678,')
  })

  it('leaves out a listing whose options could not be read, rather than writing it as a free product', () => {
    // As the item service reads a table it cannot name: no variants, no price, no stock.
    const unreadable = storeItem({ id: 'u', title: 'Mystery box', unreadableVariants: { axes: ['Color'], selectors: [[new Uint8Array([9])]] } })
    const { csv, omitted } = inventoryToCsv([toy(), unreadable], 'USD')
    expect(omitted.map((item) => item.id)).toEqual(['u'])
    expect(csv).not.toContain('Mystery box')
    const result = parseInventoryCSV(csv, 'USD')
    expect(result.items.map((item) => item.title)).toEqual(['Squishy toy'])
  })
})

describe('inventory CSV template', () => {
  it('uploads as a two-option-type product and a single product', () => {
    const result = parseInventoryCSV(inventoryCsvTemplate())
    expect(result.errors).toEqual([])
    const [roads, base] = result.items
    expect(roads.errors).toEqual([])
    expect(optionTypesSummary(defined(roads.variants))).toBe('Color (2) × Pack Size (3) — 5 combinations')
    expect(defined(roads.variants).combinations.at(-1)?.stock).toBe(250)
    expect(base.variants).toBeUndefined()
  })
})

describe('optionTypesSummary', () => {
  it('names each option type with its option count, then the combinations', () => {
    expect(optionTypesSummary(defined(toy().variants))).toBe('Primary color (3) × Pack Size (2) — 5 combinations')
    expect(optionTypesSummary(defined(variantsFromRows(['Size'], [{ optionNames: ['M'], price: 1 }]).variants))).toBe('Size (1) — 1 combination')
  })
})
