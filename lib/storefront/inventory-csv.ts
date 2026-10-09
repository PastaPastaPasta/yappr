/**
 * The inventory CSV the seller downloads: one row per combination, with
 * Shopify-style option columns, in the format the import reads
 * (lib/upload/inventory-parser.ts), so a file parses back to the same option
 * types, options and combinations. Uploading it creates NEW listings (the
 * import never edits existing ones). Also the blank template and the one-line
 * summary of a product's option types. Pure.
 */
import type { ItemVariants, StoreItem } from '@/lib/types'
import { fromSmallestUnit, getCurrencyDecimals } from '@/lib/utils/format'
import { findOption } from './variant-codec'

const ITEM_COLUMNS = ['Group', 'Title', 'Description', 'Section', 'Category', 'Subcategory', 'Tags', 'SKU', 'Price', 'Quantity', 'Weight']

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
  return [...ITEM_COLUMNS, ...options, ...images, 'Image URL']
}

const text = (value: number | string | undefined) => (value === undefined ? '' : String(value))

/**
 * `items` as an inventory CSV. A product with options is one row per
 * combination (grouped by the listing id), naming each option type and its
 * option; the listing's images go on its first row, in order, and each row's
 * `Image URL` is the combination's own image. Prices are written in the
 * item's currency (else `defaultCurrency`), as the seller types them.
 */
export function inventoryToCsv(items: readonly StoreItem[], defaultCurrency: string): string {
  const axisCount = Math.max(0, ...items.map((item) => item.variants?.axes.length ?? 0))
  const imageCount = Math.max(0, ...items.map((item) => item.imageUrls?.length ?? 0))
  const rows: string[][] = [headerRow(axisCount, imageCount)]

  for (const item of items) {
    const currency = item.currency || defaultCurrency
    const price = (amount: number) => fromSmallestUnit(amount, currency).toFixed(getCurrencyDecimals(currency))
    const images = item.imageUrls ?? []
    const itemCells = (group: string) => [group, item.title, item.description ?? '', item.section ?? '', item.category ?? '', item.subcategory ?? '', item.tags?.join(', ') ?? '']
    const imageCells = (first: boolean) => Array.from({ length: imageCount }, (_, index) => (first ? images[index] ?? '' : ''))

    const variants = item.variants
    if (!variants || variants.combinations.length === 0) {
      rows.push([
        ...itemCells(''), item.sku ?? '', price(item.basePrice ?? 0), text(item.stockQuantity), text(item.weight),
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
        ...itemCells(item.id), combination.sku ?? '', price(combination.price), text(combination.stock), text(combination.weight ?? item.weight),
        ...options, ...imageCells(index === 0), combination.image ? images[combination.image - 1] ?? '' : '',
      ])
    }
  }
  return toCsv(rows)
}

/** A sample file showing every column: a product with two option types and a single product. */
export function inventoryCsvTemplate(): string {
  const roads = (sku: string, color: string, pack: string, price: string, quantity: string, weight: string, image: string, listingImage = '') => [
    'CATAN-ROADS', 'Catan Roads', 'Replacement roads for Catan', 'Games', 'Board Games', 'Catan', 'catan, roads', sku, price, quantity, weight,
    'Color', color, 'Pack Size', pack, listingImage, image,
  ]
  return toCsv([
    headerRow(2, 1),
    roads('C-ROAD-BLUE-1', 'Blue', 'Single', '0.69', '100', '5', 'https://example.com/road-blue.jpg', 'https://example.com/roads.jpg'),
    roads('C-ROAD-BLUE-10', 'Blue', '10-Pack', '5.99', '50', '50', 'https://example.com/road-blue.jpg'),
    roads('C-ROAD-GREEN-1', 'Green', 'Single', '0.69', '100', '5', 'https://example.com/road-green.jpg'),
    roads('C-ROAD-GREEN-10', 'Green', '10-Pack', '5.99', '50', '50', 'https://example.com/road-green.jpg'),
    roads('C-ROAD-GREEN-50', 'Green', '50-Pack', '24.99', '(C-ROAD-GREEN-10)*5', '250', 'https://example.com/road-green.jpg'),
    ['', 'Catan Base Set - Red', 'Complete red player set', 'Games', 'Board Games', 'Catan', 'catan, set, red', 'C-BASE-RED', '6.50', '25', '100', '', '', '', '', 'https://example.com/base-red.jpg', ''],
  ])
}

/** A product's option types for a preview: "Primary color (7) × Pack Size (2) — 14 combinations". */
export function optionTypesSummary(variants: ItemVariants): string {
  const types = variants.axes.map((axis) => `${axis.name} (${axis.options.length})`).join(' × ')
  const count = variants.combinations.length
  return `${types} — ${count} combination${count === 1 ? '' : 's'}`
}
