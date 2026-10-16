/**
 * The inventory CSV the seller downloads: one row per combination, with
 * Shopify-style option columns, in the format the import reads
 * (lib/upload/inventory-parser.ts), so a file parses back to the same option
 * types, options and combinations. Uploading it creates NEW listings (the
 * import never edits existing ones). Also the blank template and the one-line
 * summary of a product's option types. Pure apart from the storefront cut:
 * from v9 a `Shipping Zones` column names the store zones a product is
 * limited to (docs/STOREFRONT_V9.md).
 */
import type { ItemVariants, ShippingZone, StoreItem } from '@/lib/types'
import { storefrontSupportsItemZones } from '@/lib/constants'
import { findOption } from './variant-codec'
import { formatPriceInput } from './variant-editor-model'
import { itemZones } from './item-zones'

const ITEM_COLUMNS = ['Group', 'Title', 'Description', 'Section', 'Category', 'Subcategory', 'Tags', 'SKU', 'Price', 'Quantity', 'Weight']
/** v9: the zone names a product ships under, after `Weight`; blank = every zone. */
const ZONES_COLUMN = 'Shipping Zones'
/** Between zone names in one cell: names may hold commas, so not a comma. */
const ZONE_SEPARATOR = '; '

/** A value as one CSV cell, quoted when it needs to be. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Rows of cells as CSV text. */
function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

/** The header row for files with up to `axisCount` option types and `imageCount` images per product. */
function headerRow(axisCount: number, imageCount: number): string[] {
  const options = Array.from({ length: axisCount }, (_, index) => [`Option${index + 1} Name`, `Option${index + 1} Value`]).flat()
  const images = Array.from({ length: imageCount }, (_, index) => `Image${index + 1}`)
  return [...ITEM_COLUMNS, ...(storefrontSupportsItemZones() ? [ZONES_COLUMN] : []), ...options, ...images, 'Image URL']
}

/** The `Shipping Zones` cell (v9; nothing before): the names of the store zones `item` is limited to, blank for all of them. */
function zoneCells(item: StoreItem, zones: readonly Pick<ShippingZone, 'id' | 'name'>[]): string[] {
  if (!storefrontSupportsItemZones()) return []
  return [(itemZones(item, zones) ?? []).map((zone) => zone.name).join(ZONE_SEPARATOR)]
}

const text = (value: number | string | undefined) => (value === undefined ? '' : String(value))

/** An inventory export: the CSV text, and the listings it leaves out. */
export interface InventoryExport {
  csv: string
  /**
   * Listings whose options could not be read (`unreadableVariants`): as rows
   * they would come back as free, unlimited products without options, so they
   * are not exported.
   */
  omitted: StoreItem[]
  /**
   * v9 listings limited only to zones the store no longer has (they ship
   * nowhere): their `Shipping Zones` cell is blank, which an upload reads as
   * every zone, so the caller should say so.
   */
  zonesGone: StoreItem[]
}

/**
 * `items` as an inventory CSV. A product with options is one row per
 * combination (grouped by the listing id), naming each option type and its
 * option; the listing's images go on its first row, in order, and each row's
 * `Image URL` is the combination's own image. Prices are written in the
 * item's currency (else `defaultCurrency`), as the seller types them. On v9
 * each row names the product's zones among `zones` (the store's); an id that
 * is not one of them is left out.
 */
export function inventoryToCsv(allItems: readonly StoreItem[], defaultCurrency: string, zones: readonly Pick<ShippingZone, 'id' | 'name'>[] = []): InventoryExport {
  const omitted = allItems.filter((item) => item.unreadableVariants !== undefined)
  const items = allItems.filter((item) => item.unreadableVariants === undefined)
  const axisCount = Math.max(0, ...items.map((item) => item.variants?.axes.length ?? 0))
  const imageCount = Math.max(0, ...items.map((item) => item.imageUrls?.length ?? 0))
  const rows: string[][] = [headerRow(axisCount, imageCount)]
  const zonesGone = storefrontSupportsItemZones() ? items.filter((item) => item.fulfillment !== 'digital' && itemZones(item, zones)?.length === 0) : []

  for (const item of items) {
    const currency = item.currency || defaultCurrency
    const price = (amount: number) => formatPriceInput(amount, currency)
    const images = item.imageUrls ?? []
    const itemCells = (group: string) => [group, item.title, item.description ?? '', item.section ?? '', item.category ?? '', item.subcategory ?? '', item.tags?.join(', ') ?? '']
    const shipsUnder = zoneCells(item, zones)
    const imageCells = (first: boolean) => Array.from({ length: imageCount }, (_, index) => (first ? images[index] ?? '' : ''))

    const variants = item.variants
    if (!variants || variants.combinations.length === 0) {
      rows.push([
        ...itemCells(''), item.sku ?? '', price(item.basePrice ?? 0), text(item.stockQuantity), text(item.weight), ...shipsUnder,
        ...Array.from({ length: axisCount * 2 }, () => ''), ...imageCells(true), '',
      ])
      continue
    }
    // Rows in the options' display order, so an upload (which numbers options in
    // the order rows first name them) keeps the seller's order.
    const position = new Map(variants.axes.flatMap((axis) => axis.options.map((option, index) => [option.id, index] as const)))
    const ordered = [...variants.combinations].sort((a, b) => {
      const axis = a.optionIds.findIndex((optionId, axisIndex) => optionId !== b.optionIds[axisIndex])
      return axis < 0 ? 0 : (position.get(a.optionIds[axis]) ?? 0) - (position.get(b.optionIds[axis]) ?? 0)
    })
    for (const [index, combination] of ordered.entries()) {
      const options = Array.from({ length: axisCount }, (_, axisIndex) => {
        const axis = variants.axes[axisIndex]
        const optionId = combination.optionIds[axisIndex]
        return axis ? [axis.name, findOption(variants, optionId)?.option.name ?? ''] : ['', '']
      }).flat()
      rows.push([
        ...itemCells(item.id), combination.sku ?? '', price(combination.price), text(combination.stock), text(combination.weight ?? item.weight), ...shipsUnder,
        ...options, ...imageCells(index === 0), combination.image ? images[combination.image - 1] ?? '' : combination.imageUrl ?? '',
      ])
    }
  }
  return { csv: toCsv(rows), omitted, zonesGone }
}

/**
 * A sample file showing every column: a product with two option types and a
 * single product. On v9 the first ships only under two example zones and the
 * second under all of the store's.
 */
export function inventoryCsvTemplate(): string {
  const zoneCell = (names: string) => (storefrontSupportsItemZones() ? [names] : [])
  const roads = (sku: string, color: string, pack: string, price: string, quantity: string, weight: string, image: string, listingImage = '') => [
    'CATAN-ROADS', 'Catan Roads', 'Replacement roads for Catan', 'Games', 'Board Games', 'Catan', 'catan, roads', sku, price, quantity, weight,
    ...zoneCell(`Domestic${ZONE_SEPARATOR}Europe`), 'Color', color, 'Pack Size', pack, listingImage, image,
  ]
  return toCsv([
    headerRow(2, 1),
    roads('C-ROAD-BLUE-1', 'Blue', 'Single', '0.69', '100', '5', 'https://example.com/road-blue.jpg', 'https://example.com/roads.jpg'),
    roads('C-ROAD-BLUE-10', 'Blue', '10-Pack', '5.99', '50', '50', 'https://example.com/road-blue.jpg'),
    roads('C-ROAD-GREEN-1', 'Green', 'Single', '0.69', '100', '5', 'https://example.com/road-green.jpg'),
    roads('C-ROAD-GREEN-10', 'Green', '10-Pack', '5.99', '50', '50', 'https://example.com/road-green.jpg'),
    roads('C-ROAD-GREEN-50', 'Green', '50-Pack', '24.99', '(C-ROAD-GREEN-10)*5', '250', 'https://example.com/road-green.jpg'),
    ['', 'Catan Base Set - Red', 'Complete red player set', 'Games', 'Board Games', 'Catan', 'catan, set, red', 'C-BASE-RED', '6.50', '25', '100', ...zoneCell(''), '', '', '', '', 'https://example.com/base-red.jpg', ''],
  ])
}

/** A product's option types for a preview: "Primary color (7) × Pack Size (2) — 14 combinations". */
export function optionTypesSummary(variants: ItemVariants): string {
  const types = variants.axes.map((axis) => `${axis.name} (${axis.options.length})`).join(' × ')
  const count = variants.combinations.length
  return `${types} — ${count} combination${count === 1 ? '' : 's'}`
}
