import { describe, expect, it, vi } from 'vitest'
import type { ItemVariants } from '@/lib/types'
import { encodeVariants, variantLabel, variantsFromRows, type VariantRow } from '@/lib/storefront/variant-codec'
import { encodeLegacyVariants } from '@/lib/storefront/legacy-variants'
import { platformValueBytes } from '@/lib/storefront/storefront-contract'
import { parseInventoryCSV, toStoreItemData } from './inventory-parser'

/** `value`, failing the test when it is missing. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

const COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Black', 'White', 'Natural']
const PACKS = ['Single Piece', 'Pack of 4']
const imageOf = (color: string) => `ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55f${color.toLowerCase()}`
const skuOf = (color: string, pack: string) => `TOY-${color.slice(0, 3).toUpperCase()}-${pack === 'Single Piece' ? '1' : '4'}`

/** The seller's file that outgrew v6: 7 primary colours × 2 pack sizes in one compound variant column. */
function sellerCsv(): string {
  const rows = COLORS.flatMap((color, c) => PACKS.map((pack) =>
    `squishy,Squishy toy,"Primary color: ${color} · Pack Size: ${pack}",${pack === 'Single Piece' ? '1.00' : '3.53'},${10 + c},${skuOf(color, pack)},${imageOf(color)}`))
  return ['Group,Item Name,Variant,Price,Quantity,SKU,Image1', ...rows].join('\n')
}

/** The only product a parse produced, with its variants. */
function onlyVariants(content: string | ReturnType<typeof parseInventoryCSV>): { variants: ItemVariants; warnings: string[]; errors: string[] } {
  const result = typeof content === 'string' ? parseInventoryCSV(content) : content
  expect(result.errors).toEqual([])
  expect(result.items).toHaveLength(1)
  const [item] = result.items
  return { variants: defined(item.variants), warnings: item.warnings, errors: item.errors }
}

const axesOf = (variants: ItemVariants) => variants.axes.map((axis) => [axis.name, axis.options.map((option) => option.name)])
const labelsOf = (variants: ItemVariants) => variants.combinations.map((combination) => variantLabel(variants, combination))

/** Parse with the storefront topology set to `topology` (it is read when the module loads). */
async function parseUnder(topology: string, content: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology)
  const parser = await import('./inventory-parser')
  vi.unstubAllEnvs()
  return parser.parseInventoryCSV(content)
}

describe('inventory CSV currency units', () => {
  it.each([
    ['DASH', '1.25', 125000000],
    ['DASH', '0.00000001', 1],
    ['BTC', '0.12345678', 12345678],
    ['USD', '1.25', 125],
    ['EUR', '19.99', 1999],
  ])('imports %s %s in its smallest unit', (currency, price, expected) => {
    const result = parseInventoryCSV(`Item Name,Price,Quantity\nQA parcel,${price},2`, currency)
    expect(result.errors).toEqual([])
    expect(toStoreItemData(result.items[0])).toMatchObject({
      title: 'QA parcel', currency, basePrice: expected, stockQuantity: 2,
    })
  })

  it('preserves every variant price and derives the minimum in duffs', () => {
    const result = parseInventoryCSV(
      'Group,Item Name,Variant,Price,Quantity\nparcel,QA parcel,Small,0.12345678,2\nparcel,QA parcel,Large,1.25,0',
      'DASH',
    )
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(1)
    expect(result.items[0].basePrice).toBe(12345678)
    expect(result.items[0].variants?.combinations.map(variant => variant.price)).toEqual([12345678, 125000000])
  })

  it.each(['Infinity', '1e100', '90071992.54740993'])('rejects an unsafe DASH amount %s', (price) => {
    const result = parseInventoryCSV(`Item Name,Price\nQA parcel,${price}`, 'DASH')
    expect(result.items).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].column).toBe('price')
  })
})

describe('merged tags fit storefront v4 (docs/SOCIAL_V9.md)', () => {
  it('keeps at most 32 tags of at most 64 characters and warns about the rest', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`).join(',')
    const long = 'x'.repeat(65)
    const result = parseInventoryCSV(`Item Name,Price,Tags\nParcel,1.00,"${many},${long}"`)
    const [item] = result.items
    expect(item.tags).toHaveLength(32)
    expect(item.tags).not.toContain(long)
    expect(item.warnings.join(' ')).toMatch(/longer than 64 characters.*kept the first 32 of 40 tags/)
    expect(toStoreItemData(item).tags).toHaveLength(32)
  })
})

describe('the seller file that outgrew v6 (compound labels), imported on v7', () => {
  it('splits "Primary color: Red · Pack Size: Single Piece" into two option types and 14 combinations', async () => {
    const { variants, warnings, errors } = onlyVariants(await parseUnder('v7', sellerCsv()))
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(axesOf(variants)).toEqual([['Primary color', COLORS], ['Pack Size', PACKS]])
    expect(variants.combinations).toHaveLength(14)
    expect(labelsOf(variants)).toEqual(COLORS.flatMap((color) => PACKS.map((pack) => `${color} / ${pack}`)))
    expect(variants.combinations.map((combination) => combination.price)).toEqual(COLORS.flatMap(() => [100, 353]))
    expect(variants.combinations.map((combination) => combination.stock)).toEqual(COLORS.flatMap((_, c) => [10 + c, 10 + c]))
    expect(variants.combinations.map((combination) => combination.sku)).toEqual(COLORS.flatMap((color) => PACKS.map((pack) => skuOf(color, pack))))
  })

  it('gathers the row images into the listing and points each combination at its colour', async () => {
    const [item] = (await parseUnder('v7', sellerCsv())).items
    expect(item.imageUrls).toEqual(COLORS.map(imageOf))
    expect(defined(item.variants).combinations.map((combination) => combination.image)).toEqual(COLORS.flatMap((_, c) => [c + 1, c + 1]))
  })

  it('uploads per-combination prices only: no single price, stock or SKU beside the table', async () => {
    const data = toStoreItemData((await parseUnder('v7', sellerCsv())).items[0])
    expect(data.basePrice).toBeUndefined()
    expect(data.stockQuantity).toBeUndefined()
    expect(data.sku).toBeUndefined()
    expect(data.variants?.combinations).toHaveLength(14)
  })

  it('stores the table in fewer bytes on v7 than the v6 JSON did', async () => {
    const { variants } = onlyVariants(await parseUnder('v7', sellerCsv()))
    const images = COLORS.map(imageOf)
    // What the v6 importer wrote: one "Option" type whose options are the whole compound labels.
    const flattened: VariantRow[] = COLORS.flatMap((color, c) => PACKS.map((pack) => ({
      optionNames: [`Primary color: ${color} · Pack Size: ${pack}`], price: pack === 'Single Piece' ? 100 : 353, stock: 10 + c, sku: skuOf(color, pack), image: c + 1,
    })))
    const v6Flattened = new TextEncoder().encode(encodeLegacyVariants(defined(variantsFromRows(['Option'], flattened).variants), images)).length
    const v6 = new TextEncoder().encode(encodeLegacyVariants(variants, images)).length
    const v7 = platformValueBytes(encodeVariants(variants))
    expect(v7).toBeLessThan(v6)
    expect(v6).toBeLessThan(v6Flattened)
  })
})

describe('option types from Shopify-style columns', () => {
  it('reads Option1–Option2 in number order, with names and titles given on the first row only', () => {
    const csv = [
      'Handle,Title,option1 name,Option 1 Value,OPTION2 NAME,Option2 Value,Variant SKU,Variant Price,Variant Inventory Qty',
      'tee,Logo tee,Size,S,Colour,Black,TEE-S-B,20.00,3',
      'tee,,,M,,Black,TEE-M-B,20.00,4',
      'tee,,,L,,White,TEE-L-W,22.00,0',
    ].join('\n')
    const { variants, errors } = onlyVariants(csv)
    expect(errors).toEqual([])
    expect(axesOf(variants)).toEqual([['Size', ['S', 'M', 'L']], ['Colour', ['Black', 'White']]])
    expect(labelsOf(variants)).toEqual(['S / Black', 'M / Black', 'L / White'])
    expect(variants.combinations.map((combination) => [combination.price, combination.stock, combination.sku]))
      .toEqual([[2000, 3, 'TEE-S-B'], [2000, 4, 'TEE-M-B'], [2200, 0, 'TEE-L-W']])
  })

  it('takes a lone "Default Title" row as a product without options', () => {
    const [item] = parseInventoryCSV('Title,Option1 Name,Option1 Value,Price\nMug,Title,Default Title,9.00').items
    expect(item.variants).toBeUndefined()
    expect(item.basePrice).toBe(900)
  })

  it('takes Shopify option columns over the variant column', () => {
    const { variants } = onlyVariants('Group,Item Name,Variant,Option1 Name,Option1 Value,Price\ng,Cap,ignored,Size,M,5.00\ng,Cap,ignored too,Size,L,5.00')
    expect(axesOf(variants)).toEqual([['Size', ['M', 'L']]])
  })
})

describe('option types from the variant / subVariant columns', () => {
  it('names each option type after a specific header', () => {
    const { variants } = onlyVariants('Group,Item Name,Colour,Size,Price\ng,Shirt,Red,S,10.00\ng,Shirt,Red,M,10.00\ng,Shirt,Blue,S,11.00')
    expect(axesOf(variants)).toEqual([['Color', ['Red', 'Blue']], ['Size', ['S', 'M']]])
    expect(labelsOf(variants)).toEqual(['Red / S', 'Red / M', 'Blue / S'])
  })

  it('calls generic headers "Option" and "Option 2"', () => {
    const { variants } = onlyVariants('Group,Item Name,Variant,Sub Variant,Price\ng,Shirt,Red,S,10.00\ng,Shirt,Blue,M,10.00')
    expect(variants.axes.map((axis) => axis.name)).toEqual(['Option', 'Option 2'])
  })

  it('adds the subVariant column as one more option type after a compound split', () => {
    const { variants } = onlyVariants('Group,Item Name,Variant,Size,Price\ng,Toy,Color: Red | Finish: Matte,S,1.00\ng,Toy,Color: Red | Finish: Gloss,L,1.00')
    expect(axesOf(variants)).toEqual([['Color', ['Red']], ['Finish', ['Matte', 'Gloss']], ['Size', ['S', 'L']]])
  })

  it('splits on ";" and a middle dot without spaces', () => {
    const { variants } = onlyVariants('Group,Item Name,Variant,Price\ng,Toy,Color:Red;Pack: 1,1.00\ng,Toy,Color: Blue·Pack: 4,2.00')
    expect(axesOf(variants)).toEqual([['Color', ['Red', 'Blue']], ['Pack', ['1', '4']]])
  })

  it('keeps inconsistent compound labels whole, as one option type, and says so', () => {
    const { variants, warnings, errors } = onlyVariants([
      'Group,Item Name,Variant,Price',
      'g,Squishy toy,Color: Red · Pack: Single,1.00',
      'g,Squishy toy,Pack: Single · Color: Blue,1.00',
      'g,Squishy toy,Green,1.00',
    ].join('\n'))
    expect(errors).toEqual([])
    expect(axesOf(variants)).toEqual([['Option', ['Color: Red · Pack: Single', 'Pack: Single · Color: Blue', 'Green']]])
    expect(warnings).toEqual(['"Squishy toy": the variant names could not be split into option types, so they were kept whole.'])
  })

  it('does not warn about plain option names', () => {
    expect(onlyVariants('Group,Item Name,Variant,Price\ng,Toy,Red,1.00\ng,Toy,Blue,1.00').warnings).toEqual([])
  })
})

describe('rows become combinations', () => {
  it('refuses a product that lists a combination twice, and only that product', () => {
    const result = parseInventoryCSV('Group,Item Name,Color,Size,Price\ng,Shirt,Red,S,10.00\ng,Shirt,Red,S,12.00\nh,Hat,Red,M,5.00')
    expect(result.errors).toEqual([])
    const [shirt, hat] = result.items
    expect(shirt.variants).toBeUndefined()
    expect(shirt.errors).toEqual(['"Shirt" lists "Red / S" more than once. Keep one row for each combination.'])
    expect(hat.errors).toEqual([])
    expect(hat.variants?.combinations).toHaveLength(1)
  })

  it('on v7 sets blank quantities to 0 when some rows have one, and says so', async () => {
    const [item] = (await parseUnder('v7', 'Group,Item Name,Size,Price,Quantity\ng,Shirt,S,10.00,4\ng,Shirt,M,10.00,\ng,Shirt,L,10.00,')).items
    expect(defined(item.variants).combinations.map((combination) => combination.stock)).toEqual([4, 0, 0])
    expect(item.warnings).toEqual(['"Shirt": 2 rows have no quantity, so they were set to 0.'])
  })

  it('on v1–v6 keeps each row\'s own quantity, a blank one untracked, and round-trips it', async () => {
    const { variants, warnings } = onlyVariants('Group,Item Name,Size,Price,Quantity\ng,Shirt,S,10.00,4\ng,Shirt,M,10.00,')
    expect(variants.combinations.map((combination) => combination.stock)).toEqual([4, undefined])
    expect(warnings).toEqual([])
    const { inventoryToCsv } = await import('@/lib/storefront/inventory-csv')
    const exported = inventoryToCsv([{ id: 'g', ownerId: 'o', storeId: 's', createdAt: new Date(0), status: 'active', currency: 'USD', title: 'Shirt', variants }], 'USD')
    const [again] = parseInventoryCSV(exported).items
    expect(defined(again.variants).combinations.map((combination) => combination.stock)).toEqual([4, undefined])
  })

  it('tracks no stock when no row has a quantity', () => {
    const { variants, warnings } = onlyVariants('Group,Item Name,Size,Price,Quantity\ng,Shirt,S,10.00,\ng,Shirt,M,10.00,')
    expect(variants.combinations.every((combination) => combination.stock === undefined)).toBe(true)
    expect(warnings).toEqual([])
  })

  it('works out quantity formulas against SKUs in any product, chained', () => {
    const result = parseInventoryCSV([
      'Group,Item Name,Size,SKU,Price,Quantity',
      'r,Roads,1,R-1,1.00,10',
      'r,Roads,50,R-50,20.00,(R-10)/5',
      'r,Roads,10,R-10,5.00,(R-1)*3',
      ',Road box,,BOX,9.00,(R-50)+1',
    ].join('\n'))
    const [roads, box] = result.items
    expect(defined(roads.variants).combinations.map((combination) => combination.stock)).toEqual([10, 6, 30])
    expect(box.stockQuantity).toBe(7)
  })

  it('refuses a row that does not name its option', () => {
    const [item] = parseInventoryCSV('Group,Item Name,Size,Price\ng,Shirt,S,10.00\ng,Shirt,,10.00').items
    expect(item.errors).toEqual(['"Shirt": row 3 is missing a value for "Size".'])
  })

  it('refuses several rows of one group with nothing to tell them apart', () => {
    const [item] = parseInventoryCSV('Group,Item Name,Price\ng,Shirt,10.00\ng,Shirt,12.00').items
    expect(item.errors[0]).toMatch(/^"Shirt" has 2 rows but no options to tell them apart/)
  })

  it('on v7 shortens a SKU past 32 characters and says so; v1–v6 keep it whole', async () => {
    const long = 'S'.repeat(40)
    const csv = `Group,Item Name,Size,SKU,Price\ng,Shirt,S,${long},10.00\ng,Shirt,M,OK,10.00`
    const [typed] = (await parseUnder('v7', csv)).items
    expect(defined(typed.variants).combinations.map((combination) => combination.sku)).toEqual(['S'.repeat(32), 'OK'])
    expect(typed.warnings).toEqual(['"Shirt": 1 SKU is longer than 32 characters, so it was shortened.'])
    const { variants, warnings } = onlyVariants(csv)
    expect(variants.combinations.map((combination) => combination.sku)).toEqual([long, 'OK'])
    expect(warnings).toEqual([])
  })

  it('reports what the v7 table cannot store as errors for that product (the v1–v6 JSON has no such cap)', async () => {
    const csv = `Group,Item Name,Size,Price\ng,Shirt,${'L'.repeat(41)},10.00`
    const [typed] = (await parseUnder('v7', csv)).items
    expect(typed.errors).toEqual(['"Shirt": Option names can be at most 40 characters ("LLLLLLLLLLLLLLLLLLLL…" is longer).'])
    expect(parseInventoryCSV(csv).items[0].errors).toEqual([])
  })

  it('on v1–v6 keeps a combination photo past the gallery cap as its own URL, and round-trips it', async () => {
    const rows = ['Red', 'Orange', 'Yellow', 'Green', 'Blue'].map((color) => `g,Toy,${color},1.00,https://x.test/${color}.jpg`)
    const csv = ['Group,Item Name,Color,Price,Image URL', ...rows].join('\n')
    const [item] = parseInventoryCSV(csv).items
    expect(item.imageUrls).toHaveLength(4)
    const blue = defined(item.variants).combinations[4]
    expect(blue.image).toBeUndefined()
    expect(blue.imageUrl).toBe('https://x.test/Blue.jpg')
    const { inventoryToCsv } = await import('@/lib/storefront/inventory-csv')
    const exported = inventoryToCsv([{ id: 'g', ownerId: 'o', storeId: 's', createdAt: new Date(0), status: 'active', currency: 'USD', title: 'Toy', imageUrls: item.imageUrls, variants: item.variants }], 'USD')
    const [again] = parseInventoryCSV(exported).items
    expect(defined(again.variants).combinations.map((combination) => combination.image ?? combination.imageUrl)).toEqual([1, 2, 3, 4, 'https://x.test/Blue.jpg'])
    // v7 names images by index only.
    const [typed] = (await parseUnder('v7', csv)).items
    expect(defined(typed.variants).combinations.every((combination) => combination.imageUrl === undefined)).toBe(true)
  })

  it('reads every OptionN column: six option types round-trip on v1–v6, and v7 reports its cap of 5', async () => {
    const header = ['Group', 'Item Name', 'Price', ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`Option${n} Name`, `Option${n} Value`])].join(',')
    const row = (last: string) => ['g', 'Kit', '1.00', ...['A', 'B', 'C', 'D', 'E'].flatMap((axis) => [axis, `${axis}1`]), 'F', last].join(',')
    const csv = [header, row('F1'), row('F2')].join('\n')
    const [legacy] = parseInventoryCSV(csv).items
    expect(legacy.errors).toEqual([])
    expect(defined(legacy.variants).axes.map((axis) => axis.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(defined(legacy.variants).combinations).toHaveLength(2)
    const { inventoryToCsv } = await import('@/lib/storefront/inventory-csv')
    const exported = inventoryToCsv([{ id: 'g', ownerId: 'o', storeId: 's', createdAt: new Date(0), status: 'active', currency: 'USD', title: 'Kit', variants: legacy.variants }], 'USD')
    const [again] = parseInventoryCSV(exported).items
    expect(defined(again.variants).axes).toHaveLength(6)
    expect(defined(again.variants).combinations).toHaveLength(2)
    const [typed] = (await parseUnder('v7', csv)).items
    expect(typed.errors.join(' ')).toMatch(/at most 5 option types/)
  })

  it('puts one weight on the product when the rows agree', () => {
    const [item] = parseInventoryCSV('Group,Item Name,Size,Price,Weight\ng,Shirt,S,10.00,200\ng,Shirt,M,10.00,200').items
    expect(item.weight).toBe(200)
    expect(defined(item.variants).combinations.every((combination) => combination.weight === undefined)).toBe(true)
  })

  it('weighs each combination on v7 when the rows differ, and keeps the first weight before it', async () => {
    const csv = 'Group,Item Name,Size,Price,Weight\ng,Shirt,S,10.00,200\ng,Shirt,M,10.00,250.4'
    const [typed] = (await parseUnder('v7', csv)).items
    expect(typed.weight).toBeUndefined()
    expect(defined(typed.variants).combinations.map((combination) => combination.weight)).toEqual([200, 250])
    const [legacy] = (await parseUnder('v6', csv)).items
    expect(legacy.weight).toBe(200)
    expect(legacy.warnings).toEqual(['"Shirt": the rows have different weights, but this store keeps one weight per product, so the first one was used.'])
  })

  it('points a combination at its Image URL when the file has that column', () => {
    const [item] = parseInventoryCSV([
      'Group,Item Name,Size,Price,Image1,Image2,Image URL',
      'g,Shirt,S,10.00,https://x.test/a.jpg,https://x.test/b.jpg,https://x.test/b.jpg',
      'g,Shirt,M,10.00,,,',
    ].join('\n')).items
    expect(item.imageUrls).toEqual(['https://x.test/a.jpg', 'https://x.test/b.jpg'])
    expect(defined(item.variants).combinations.map((combination) => combination.image)).toEqual([2, undefined])
  })
})
