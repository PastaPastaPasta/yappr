/**
 * Inventory CSV Parser
 *
 * Parses inventory CSV files with support for:
 * - Group-based variant grouping (items with same group ID become variants of one listing)
 * - Formula-based quantity calculations (e.g., "(green-10)*5" references another SKU's quantity)
 * - Standard CSV parsing with proper escaping handling
 */

import type { StoreItem, ItemVariants, VariantAxis, VariantCombination } from '../types'

// CSV column mapping to internal field names
export interface InventoryCSVColumns {
  group?: string           // Group ID for variant grouping
  section?: string         // Product section
  category?: string        // Product category
  subcategory?: string     // Product subcategory
  itemName: string         // Item name/title (required)
  description?: string     // Item description
  sku?: string             // SKU
  tags?: string            // Tags (comma-separated)
  variant?: string         // Primary variant (e.g., "Blue")
  subVariant?: string      // Secondary variant (e.g., "Large")
  price: string            // Price (required)
  quantity?: string        // Stock quantity (can be formula)
  shippingCost?: string    // Per-item shipping cost
  combine?: string         // Shipping combine flag ("free", "yes", "no", "$0.05", etc.)
  weight?: string          // Item weight
  image1?: string          // Image URL 1
  image2?: string          // Image URL 2
  image3?: string          // Image URL 3
  image4?: string          // Image URL 4
}

// Parsed inventory row before grouping
export interface ParsedInventoryRow {
  group?: string
  section?: string
  category?: string
  subcategory?: string
  itemName: string
  description?: string
  sku?: string
  tags: string[]
  variant?: string
  subVariant?: string
  price: number           // Price in cents
  quantity?: number | string  // Number or formula string
  quantityFormula?: string    // Original formula if quantity was a formula
  shippingCost?: number
  combineShipping?: 'free' | 'extra' | 'no'
  combineShippingExtra?: number
  weight?: number
  imageUrls: string[]
  rowNumber: number       // Original CSV row number for error reporting
}

// Grouped inventory item ready for upload
export interface GroupedInventoryItem {
  groupId?: string
  title: string
  description?: string
  section?: string
  category?: string
  subcategory?: string
  tags: string[]
  imageUrls: string[]
  basePrice: number       // Lowest price among variants, or single price
  currency: string
  sku?: string            // SKU of base item or first variant
  stockQuantity?: number  // Stock for non-variant items
  weight?: number
  variants?: ItemVariants // Populated if item has variants
  rows: ParsedInventoryRow[]  // Original rows that make up this item
}

// Validation error
export interface InventoryParseError {
  row: number
  column?: string
  message: string
}

// Parse result
export interface InventoryParseResult {
  items: GroupedInventoryItem[]
  errors: InventoryParseError[]
  warnings: InventoryParseError[]
}

// Default column headers (case-insensitive matching)
const COLUMN_ALIASES: Record<keyof InventoryCSVColumns, string[]> = {
  group: ['group', 'group_id', 'groupid', 'listing_id', 'listingid'],
  section: ['section'],
  category: ['category', 'cat'],
  subcategory: ['subcategory', 'subcat', 'sub_category'],
  itemName: ['item name', 'item_name', 'itemname', 'name', 'title', 'product', 'product name'],
  description: ['description', 'desc', 'details'],
  sku: ['sku', 'item_sku', 'product_sku'],
  tags: ['tags', 'keywords'],
  variant: ['variant', 'option', 'option1', 'color', 'type'],
  subVariant: ['sub variant', 'sub_variant', 'subvariant', 'option2', 'size'],
  price: ['price', 'cost', 'amount'],
  quantity: ['quantity', 'qty', 'stock', 'inventory'],
  shippingCost: ['shipping cost', 'shipping_cost', 'shippingcost', 'shipping'],
  combine: ['combine', 'combine_shipping', 'combineshipping'],
  weight: ['weight', 'wt'],
  image1: ['image1', 'image 1', 'image_1', 'img1', 'picture1', 'photo1'],
  image2: ['image2', 'image 2', 'image_2', 'img2', 'picture2', 'photo2'],
  image3: ['image3', 'image 3', 'image_3', 'img3', 'picture3', 'photo3'],
  image4: ['image4', 'image 4', 'image_4', 'img4', 'picture4', 'photo4'],
}

/**
 * Parse CSV content into an array of string arrays
 */
function parseCSV(content: string): string[][] {
  const rows: string[][] = []
  const lines = content.split(/\r?\n/)

  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false

  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      const nextChar = line[i + 1]

      if (inQuotes) {
        if (char === '"' && nextChar === '"') {
          // Escaped quote
          currentField += '"'
          i++
        } else if (char === '"') {
          // End of quoted field
          inQuotes = false
        } else {
          currentField += char
        }
      } else {
        if (char === '"') {
          inQuotes = true
        } else if (char === ',') {
          currentRow.push(currentField.trim())
          currentField = ''
        } else {
          currentField += char
        }
      }
    }

    if (inQuotes) {
      // Line continues in quoted field
      currentField += '\n'
    } else {
      // End of row
      currentRow.push(currentField.trim())
      if (currentRow.some(cell => cell !== '')) {
        rows.push(currentRow)
      }
      currentRow = []
      currentField = ''
    }
  }

  // Handle last row if not empty
  if (currentRow.length > 0 || currentField !== '') {
    currentRow.push(currentField.trim())
    if (currentRow.some(cell => cell !== '')) {
      rows.push(currentRow)
    }
  }

  return rows
}

/**
 * Map CSV headers to column indices
 */
function mapHeaders(headers: string[]): Record<keyof InventoryCSVColumns, number> {
  const mapping: Partial<Record<keyof InventoryCSVColumns, number>> = {}

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].toLowerCase().trim()

    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(header) && mapping[field as keyof InventoryCSVColumns] === undefined) {
        mapping[field as keyof InventoryCSVColumns] = i
        break
      }
    }
  }

  return mapping as Record<keyof InventoryCSVColumns, number>
}

/**
 * Parse a price string into cents
 */
function parsePrice(value: string): number | null {
  if (!value) return null

  // Remove currency symbols and whitespace
  const cleaned = value.replace(/[$€£¥,\s]/g, '').trim()

  const num = parseFloat(cleaned)
  if (isNaN(num)) return null

  // Convert to cents (assuming input is in dollars/main currency unit)
  return Math.round(num * 100)
}

/**
 * Parse a quantity value (number or formula)
 */
function parseQuantity(value: string): { value: number | null; formula: string | null } {
  if (!value) return { value: null, formula: null }

  const trimmed = value.trim()

  // Check if it's a formula (contains letters or mathematical operators beyond just a number)
  const isFormula = /[a-zA-Z()*\-+/]/.test(trimmed) && !/^\d+$/.test(trimmed)

  if (isFormula) {
    return { value: null, formula: trimmed }
  }

  const num = parseInt(trimmed, 10)
  return { value: isNaN(num) ? null : num, formula: null }
}

/**
 * Parse combine shipping value
 */
function parseCombineShipping(value: string): { type: 'free' | 'extra' | 'no'; extra?: number } {
  if (!value) return { type: 'no' }

  const lower = value.toLowerCase().trim()

  if (lower === 'free' || lower === 'yes' || lower === 'true') {
    return { type: 'free' }
  }

  if (lower === 'no' || lower === 'false') {
    return { type: 'no' }
  }

  // Check for extra cost like "$0.05" or "0.05"
  const extraCost = parsePrice(value)
  if (extraCost !== null && extraCost > 0) {
    return { type: 'extra', extra: extraCost }
  }

  return { type: 'no' }
}

/**
 * Evaluate formula-based quantities
 * Formulas can reference other SKUs: (SKU-NAME)*5 or SKU-NAME+10
 */
export function evaluateQuantityFormulas(items: GroupedInventoryItem[]): void {
  // Build SKU -> quantity map
  const skuQuantities: Record<string, number> = {}

  for (const item of items) {
    for (const row of item.rows) {
      if (row.sku && typeof row.quantity === 'number') {
        skuQuantities[row.sku.toLowerCase()] = row.quantity
      }
    }
  }

  // Evaluate formulas
  for (const item of items) {
    for (const row of item.rows) {
      if (row.quantityFormula) {
        const evaluated = evaluateSingleFormula(row.quantityFormula, skuQuantities)
        if (evaluated !== null) {
          row.quantity = evaluated
        }
      }
    }
  }

  // Update item stock quantities based on evaluated rows
  for (const item of items) {
    if (!item.variants && item.rows.length === 1) {
      const qty = item.rows[0].quantity
      if (typeof qty === 'number') {
        item.stockQuantity = qty
      }
    } else if (item.variants) {
      // Update variant combination stocks
      for (const combo of item.variants.combinations) {
        const matchingRow = item.rows.find(r => {
          if (r.variant && r.subVariant) {
            return combo.key === `${r.variant}|${r.subVariant}`
          } else if (r.variant) {
            return combo.key === r.variant
          }
          return false
        })
        if (matchingRow && typeof matchingRow.quantity === 'number') {
          combo.stock = matchingRow.quantity
        }
      }
    }
  }
}

/**
 * Evaluate a single formula string
 */
function evaluateSingleFormula(formula: string, skuQuantities: Record<string, number>): number | null {
  // Replace SKU references with their quantities
  // Format: (SKU-NAME) or SKU-NAME
  let expression = formula

  // Find SKU references in parentheses first: (sku-name)
  const parenMatches = formula.match(/\(([^)]+)\)/g)
  if (parenMatches) {
    for (const match of parenMatches) {
      const sku = match.slice(1, -1).toLowerCase().trim()
      const qty = skuQuantities[sku]
      if (qty !== undefined) {
        expression = expression.replace(match, String(qty))
      }
    }
  }

  // Simple case: just multiply/divide operations
  // e.g., "(C-road-green-10)*5" -> "10*5" (if C-road-green-10 has qty 10)
  try {
    // Only allow safe mathematical operations
    if (/^[\d\s+\-*/().]+$/.test(expression)) {
      // Create function to evaluate the expression safely
      const result = Function(`"use strict"; return (${expression})`)()
      if (typeof result === 'number' && !isNaN(result) && isFinite(result)) {
        return Math.floor(result)
      }
    }
  } catch {
    // Formula evaluation failed
  }

  return null
}

/**
 * Group parsed rows into inventory items based on group ID
 */
function groupRows(rows: ParsedInventoryRow[]): GroupedInventoryItem[] {
  const groups = new Map<string, ParsedInventoryRow[]>()
  let ungroupedIndex = 0

  for (const row of rows) {
    const groupId = row.group || `__ungrouped_${ungroupedIndex++}`
    if (!groups.has(groupId)) {
      groups.set(groupId, [])
    }
    groups.get(groupId)!.push(row)
  }

  const items: GroupedInventoryItem[] = []

  for (const [groupId, groupRows] of groups) {
    const isUngrouped = groupId.startsWith('__ungrouped_')
    const firstRow = groupRows[0]

    // Collect all unique images from the group
    const allImages: string[] = []
    for (const row of groupRows) {
      for (const img of row.imageUrls) {
        if (!allImages.includes(img)) {
          allImages.push(img)
        }
      }
    }

    // Collect all unique tags
    const allTags: string[] = []
    for (const row of groupRows) {
      for (const tag of row.tags) {
        if (!allTags.includes(tag)) {
          allTags.push(tag)
        }
      }
    }

    // Determine if this is a variant item
    const hasVariants = groupRows.length > 1 || (firstRow.variant && groupRows.length === 1)

    if (hasVariants) {
      // Build variant structure
      const variantValues = new Set<string>()
      const subVariantValues = new Set<string>()

      for (const row of groupRows) {
        if (row.variant) variantValues.add(row.variant)
        if (row.subVariant) subVariantValues.add(row.subVariant)
      }

      const axes: VariantAxis[] = []
      if (variantValues.size > 0) {
        axes.push({ name: 'Option', options: Array.from(variantValues) })
      }
      if (subVariantValues.size > 0) {
        axes.push({ name: 'Size', options: Array.from(subVariantValues) })
      }

      const combinations: VariantCombination[] = groupRows.map(row => {
        let key: string
        if (row.variant && row.subVariant) {
          key = `${row.variant}|${row.subVariant}`
        } else if (row.variant) {
          key = row.variant
        } else {
          key = 'Default'
        }

        return {
          key,
          price: row.price,
          stock: typeof row.quantity === 'number' ? row.quantity : undefined,
          sku: row.sku,
          imageUrl: row.imageUrls[0]
        }
      })

      // Find lowest price for basePrice
      const prices = groupRows.map(r => r.price)
      const basePrice = Math.min(...prices)

      items.push({
        groupId: isUngrouped ? undefined : groupId,
        title: firstRow.itemName,
        description: firstRow.description,
        section: firstRow.section,
        category: firstRow.category,
        subcategory: firstRow.subcategory,
        tags: allTags,
        imageUrls: allImages.slice(0, 4),
        basePrice,
        currency: 'USD',
        sku: firstRow.sku,
        weight: firstRow.weight,
        variants: { axes, combinations },
        rows: groupRows
      })
    } else {
      // Single item without variants
      items.push({
        groupId: isUngrouped ? undefined : groupId,
        title: firstRow.itemName,
        description: firstRow.description,
        section: firstRow.section,
        category: firstRow.category,
        subcategory: firstRow.subcategory,
        tags: allTags,
        imageUrls: allImages.slice(0, 4),
        basePrice: firstRow.price,
        currency: 'USD',
        sku: firstRow.sku,
        stockQuantity: typeof firstRow.quantity === 'number' ? firstRow.quantity : undefined,
        weight: firstRow.weight,
        rows: groupRows
      })
    }
  }

  return items
}

/**
 * Parse inventory CSV content
 */
export function parseInventoryCSV(content: string, currency = 'USD'): InventoryParseResult {
  const errors: InventoryParseError[] = []
  const warnings: InventoryParseError[] = []

  const csvRows = parseCSV(content)

  if (csvRows.length < 2) {
    errors.push({ row: 0, message: 'CSV must have a header row and at least one data row' })
    return { items: [], errors, warnings }
  }

  const headers = csvRows[0]
  const columnMap = mapHeaders(headers)

  // Check for required columns
  if (columnMap.itemName === undefined) {
    errors.push({ row: 1, message: 'Missing required column: Item Name (or name, title, product)' })
  }
  if (columnMap.price === undefined) {
    errors.push({ row: 1, message: 'Missing required column: Price' })
  }

  if (errors.length > 0) {
    return { items: [], errors, warnings }
  }

  const parsedRows: ParsedInventoryRow[] = []

  for (let i = 1; i < csvRows.length; i++) {
    const row = csvRows[i]
    const rowNumber = i + 1 // 1-indexed for user display

    const getValue = (column: keyof InventoryCSVColumns): string => {
      const idx = columnMap[column]
      return idx !== undefined && row[idx] !== undefined ? row[idx] : ''
    }

    const itemName = getValue('itemName')
    if (!itemName) {
      warnings.push({ row: rowNumber, column: 'itemName', message: 'Empty item name, skipping row' })
      continue
    }

    const priceStr = getValue('price')
    const price = parsePrice(priceStr)
    if (price === null) {
      errors.push({ row: rowNumber, column: 'price', message: `Invalid price: "${priceStr}"` })
      continue
    }

    const quantityResult = parseQuantity(getValue('quantity'))
    const combineResult = parseCombineShipping(getValue('combine'))

    const tagsStr = getValue('tags')
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : []

    const imageUrls: string[] = []
    for (const key of ['image1', 'image2', 'image3', 'image4'] as const) {
      const url = getValue(key)
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        imageUrls.push(url)
      }
    }

    const weightStr = getValue('weight')
    const weight = weightStr ? parseFloat(weightStr.replace(/[^\d.]/g, '')) : undefined

    const shippingCostStr = getValue('shippingCost')
    const shippingCost = shippingCostStr ? parsePrice(shippingCostStr) : undefined

    parsedRows.push({
      group: getValue('group') || undefined,
      section: getValue('section') || undefined,
      category: getValue('category') || undefined,
      subcategory: getValue('subcategory') || undefined,
      itemName,
      description: getValue('description') || undefined,
      sku: getValue('sku') || undefined,
      tags,
      variant: getValue('variant') || undefined,
      subVariant: getValue('subVariant') || undefined,
      price,
      quantity: quantityResult.value ?? quantityResult.formula ?? undefined,
      quantityFormula: quantityResult.formula ?? undefined,
      shippingCost: shippingCost ?? undefined,
      combineShipping: combineResult.type,
      combineShippingExtra: combineResult.extra,
      weight: weight && !isNaN(weight) ? weight : undefined,
      imageUrls,
      rowNumber
    })
  }

  // Group rows and build items
  const items = groupRows(parsedRows)

  // Set currency on all items
  for (const item of items) {
    item.currency = currency
  }

  // Evaluate quantity formulas
  evaluateQuantityFormulas(items)

  return { items, errors, warnings }
}

/**
 * Convert a grouped inventory item to a StoreItem creation payload
 */
export function toStoreItemData(item: GroupedInventoryItem): {
  title: string
  description?: string
  section?: string
  category?: string
  subcategory?: string
  tags?: string[]
  imageUrls?: string[]
  basePrice?: number
  currency?: string
  status: 'active'
  weight?: number
  stockQuantity?: number
  sku?: string
  variants?: ItemVariants
} {
  return {
    title: item.title,
    description: item.description,
    section: item.section,
    category: item.category,
    subcategory: item.subcategory,
    tags: item.tags.length > 0 ? item.tags : undefined,
    imageUrls: item.imageUrls.length > 0 ? item.imageUrls : undefined,
    basePrice: item.basePrice,
    currency: item.currency,
    status: 'active',
    weight: item.weight,
    stockQuantity: item.stockQuantity,
    sku: item.sku,
    variants: item.variants
  }
}

/**
 * Generate a sample CSV template
 */
export function generateCSVTemplate(): string {
  const headers = [
    'Group',
    'Section',
    'Category',
    'Subcategory',
    'Item Name',
    'Description',
    'SKU',
    'Tags',
    'Variant',
    'Sub Variant',
    'Price',
    'Quantity',
    'Weight',
    'Image1',
    'Image2',
    'Image3',
    'Image4'
  ]

  const sampleRows = [
    ['CATAN-ROADS', 'Games', 'Board Games', 'Catan', 'Catan Roads', 'Replacement roads for Catan', 'C-ROAD-BLUE-1', 'catan,roads,blue', 'Blue', 'Single', '0.69', '100', '5', 'https://example.com/road-blue.jpg', '', '', ''],
    ['CATAN-ROADS', 'Games', 'Board Games', 'Catan', 'Catan Roads', 'Replacement roads for Catan', 'C-ROAD-BLUE-10', 'catan,roads,blue', 'Blue', '10-Pack', '5.99', '50', '50', 'https://example.com/road-blue-10.jpg', '', '', ''],
    ['CATAN-ROADS', 'Games', 'Board Games', 'Catan', 'Catan Roads', 'Replacement roads for Catan', 'C-ROAD-GREEN-1', 'catan,roads,green', 'Green', 'Single', '0.69', '100', '5', 'https://example.com/road-green.jpg', '', '', ''],
    ['CATAN-ROADS', 'Games', 'Board Games', 'Catan', 'Catan Roads', 'Replacement roads for Catan', 'C-ROAD-GREEN-10', 'catan,roads,green', 'Green', '10-Pack', '5.99', '50', '50', 'https://example.com/road-green-10.jpg', '', '', ''],
    ['CATAN-ROADS', 'Games', 'Board Games', 'Catan', 'Catan Roads', 'Replacement roads for Catan', 'C-ROAD-GREEN-50', 'catan,roads,green', 'Green', '50-Pack', '24.99', '(C-ROAD-GREEN-10)*5', '250', 'https://example.com/road-green-50.jpg', '', '', ''],
    ['', 'Games', 'Board Games', 'Catan', 'Catan Base Set - Red', 'Complete red player set', 'C-BASE-RED', 'catan,set,red', '', '', '6.50', '25', '100', 'https://example.com/base-red.jpg', '', '', ''],
  ]

  return [headers.join(','), ...sampleRows.map(row => row.map(cell =>
    cell.includes(',') || cell.includes('"') || cell.includes('\n')
      ? `"${cell.replace(/"/g, '""')}"`
      : cell
  ).join(','))].join('\n')
}
