/**
 * Inventory CSV Parser
 *
 * Turns an inventory CSV into listings:
 * - Rows sharing a group ID (or Shopify handle) become one listing, each row
 *   one combination of its variants table (docs/STOREFRONT_V7.md). The option
 *   types come from Shopify-style `Option1 Name`/`Option1 Value` columns, else
 *   the `variant`/`subVariant` columns, whose values may carry compound labels
 *   ("Primary color: Red · Pack Size: Single Piece").
 * - Quantities may be formulas that reference another SKU's quantity, e.g. "(green-10)*5".
 * - Standard CSV quoting.
 */

import type { ItemVariants } from '../types'
import { storefrontVariantsAreTyped } from '../constants'
import { toSmallestUnit } from '../utils/format'
import { LIST_LIMITS } from '../typed-array-codecs'
import { VARIANT_LIMITS, itemImageLimit } from '../storefront/storefront-contract'
import { variantProblems, variantsFromRows, type VariantRow } from '../storefront/variant-codec'

/** The single-valued columns the parser reads, by internal name. */
type Column =
  | 'group' | 'section' | 'category' | 'subcategory' | 'itemName' | 'description' | 'sku' | 'tags'
  | 'variant' | 'subVariant' | 'price' | 'quantity' | 'shippingCost' | 'combine' | 'weight' | 'image'

// Parsed inventory row before grouping
interface ParsedInventoryRow {
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
  /** Shopify-style `OptionN Name`/`OptionN Value`, index N-1, as given on this row. */
  options: { name?: string; value?: string }[]
  price: number           // Price in the currency's smallest unit (cents, duffs, or satoshis)
  quantity?: number       // Stock; set from the formula once it is worked out
  quantityFormula?: string
  shippingCost?: number
  combineShipping?: 'free' | 'extra' | 'no'
  combineShippingExtra?: number
  weight?: number
  /** The listing's images named on this row (`Image1`, `Image2`, …). */
  imageUrls: string[]
  /** This row's own image (`Image URL`), shown when its combination is picked. */
  image?: string
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
  basePrice: number       // Lowest combination price, or the single price
  currency: string
  sku?: string            // SKU of an item without variants
  stockQuantity?: number  // Stock for an item without variants
  weight?: number
  variants?: ItemVariants // Populated if the item has variants
  /** Why this product cannot be uploaded; the others still can. */
  errors: string[]
  /** What the import changed or guessed for this product. */
  warnings: string[]
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
  /** Problems with the file or a row, which hold the whole upload. Product problems are on each item. */
  errors: InventoryParseError[]
  warnings: InventoryParseError[]
}

// Column headers, matched case-insensitively
const COLUMN_ALIASES: Record<Column, string[]> = {
  group: ['group', 'group_id', 'groupid', 'listing_id', 'listingid', 'handle'],
  section: ['section'],
  category: ['category', 'cat'],
  subcategory: ['subcategory', 'subcat', 'sub_category'],
  itemName: ['item name', 'item_name', 'itemname', 'name', 'title', 'product', 'product name'],
  description: ['description', 'desc', 'details'],
  sku: ['sku', 'item_sku', 'product_sku', 'variant sku'],
  tags: ['tags', 'keywords'],
  variant: ['variant', 'option', 'option1', 'color', 'colour', 'type'],
  subVariant: ['sub variant', 'sub_variant', 'subvariant', 'option2', 'size'],
  price: ['price', 'cost', 'amount', 'variant price'],
  quantity: ['quantity', 'qty', 'stock', 'inventory', 'variant inventory qty'],
  shippingCost: ['shipping cost', 'shipping_cost', 'shippingcost', 'shipping'],
  combine: ['combine', 'combine_shipping', 'combineshipping'],
  weight: ['weight', 'wt'],
  image: ['image url', 'image_url', 'imageurl', 'variant image', 'variant image url'],
}

/** Headers that say nothing about the option type, so its axis is just "Option". */
const GENERIC_VARIANT_HEADERS = new Set(['variant', 'option', 'option1', 'sub variant', 'sub_variant', 'subvariant', 'option2'])
/** Specific headers whose axis name is spelled differently from the header. */
const AXIS_NAME_OF_HEADER: Record<string, string> = { color: 'Color', colour: 'Color' }

const SHOPIFY_OPTION_HEADER = /^option[\s_]*([1-5])[\s_]*(name|value)$/
const IMAGE_HEADER = /^(?:image|img|picture|photo)[\s_]*(\d{1,2})$/
const MAX_OPTION_COLUMNS = 5

interface ColumnMap {
  fields: Partial<Record<Column, number>>
  /** Header text of the variant / subVariant columns, for naming their axes. */
  headers: Partial<Record<Column, string>>
  optionNames: (number | undefined)[]
  optionValues: (number | undefined)[]
  /** Item image columns, in their number order. */
  images: number[]
}

const normalizeHeader = (header: string) => header.toLowerCase().trim().replace(/\s+/g, ' ')

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
function mapHeaders(headers: string[]): ColumnMap {
  const map: ColumnMap = { fields: {}, headers: {}, optionNames: [], optionValues: [], images: [] }
  const imageColumns: { number: number; index: number }[] = []

  for (let i = 0; i < headers.length; i++) {
    const header = normalizeHeader(headers[i])

    const option = SHOPIFY_OPTION_HEADER.exec(header)
    if (option) {
      const list = option[2] === 'name' ? map.optionNames : map.optionValues
      const slot = Number(option[1]) - 1
      if (list[slot] === undefined) list[slot] = i
      continue
    }
    const image = IMAGE_HEADER.exec(header)
    if (image) {
      imageColumns.push({ number: Number(image[1]), index: i })
      continue
    }
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [Column, string[]][]) {
      if (aliases.includes(header) && map.fields[field] === undefined) {
        map.fields[field] = i
        map.headers[field] = header
        break
      }
    }
  }

  map.images = imageColumns.sort((a, b) => a.number - b.number).map((column) => column.index)
  return map
}

/**
 * Parse a display price into the currency's smallest unit.
 */
function parsePrice(value: string, currency: string): number | null {
  if (!value) return null

  // Remove currency symbols and whitespace
  const cleaned = value.replace(/[$€£¥,\s]/g, '').trim()

  const num = parseFloat(cleaned)
  if (isNaN(num)) return null

  const amount = toSmallestUnit(num, currency)
  return Number.isSafeInteger(amount) ? amount : null
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
function parseCombineShipping(value: string, currency: string): { type: 'free' | 'extra' | 'no'; extra?: number } {
  if (!value) return { type: 'no' }

  const lower = value.toLowerCase().trim()

  if (lower === 'free' || lower === 'yes' || lower === 'true') {
    return { type: 'free' }
  }

  if (lower === 'no' || lower === 'false') {
    return { type: 'no' }
  }

  // Check for extra cost like "$0.05" or "0.05"
  const extraCost = parsePrice(value, currency)
  if (extraCost !== null && extraCost > 0) {
    return { type: 'extra', extra: extraCost }
  }

  return { type: 'no' }
}

const IMAGE_URL_PATTERN = LIST_LIMITS.storeImageUrls.pattern
/** An image URL a listing can store (http(s) or ipfs, not too long), else undefined. */
const imageUrlOf = (value: string): string | undefined =>
  value && value.length <= LIST_LIMITS.storeImageUrls.maxLength && IMAGE_URL_PATTERN.test(value) ? value : undefined

/**
 * Work out formula quantities. A formula references another row's quantity
 * by its SKU in parentheses: "(SKU-NAME)*5". A formula may reference a SKU
 * whose quantity is itself a formula; one that cannot be worked out keeps no
 * quantity.
 */
function evaluateQuantityFormulas(rows: ParsedInventoryRow[]): void {
  const known = new Map<string, number>()
  for (const row of rows) {
    if (row.sku && row.quantity !== undefined) known.set(row.sku.toLowerCase(), row.quantity)
  }

  let pending = rows.filter((row) => row.quantityFormula !== undefined)
  let progress = true
  while (pending.length > 0 && progress) {
    progress = false
    pending = pending.filter((row) => {
      const value = evaluateSingleFormula(row.quantityFormula ?? '', known)
      if (value === null) return true
      row.quantity = Math.max(0, value)
      if (row.sku) known.set(row.sku.toLowerCase(), row.quantity)
      progress = true
      return false
    })
  }
}

/**
 * Evaluate a single formula string
 */
function evaluateSingleFormula(formula: string, skuQuantities: ReadonlyMap<string, number>): number | null {
  // Replace SKU references with their quantities
  // Format: (SKU-NAME) only
  let expression = formula

  // Find SKU references in parentheses first: (sku-name)
  const parenMatches = formula.match(/\(([^)]+)\)/g)
  if (parenMatches) {
    for (const match of parenMatches) {
      const sku = match.slice(1, -1).toLowerCase().trim()
      const qty = skuQuantities.get(sku)
      if (qty !== undefined) {
        expression = expression.replace(match, String(qty))
      }
    }
  }

  // Simple case: just multiply/divide operations
  // e.g., "(C-road-green-10)*5" -> "10*5" (if C-road-green-10 has qty 10)
  // Use safe recursive descent parser instead of Function()
  const result = safeEvaluateMath(expression)
  if (result !== null && isFinite(result)) {
    return Math.floor(result)
  }

  return null
}

/**
 * Safe math expression evaluator using recursive descent parsing.
 * Only supports: numbers, +, -, *, /, and parentheses.
 * Returns null if the expression is invalid.
 */
function safeEvaluateMath(expr: string): number | null {
  // Remove whitespace
  const tokens = tokenize(expr.replace(/\s/g, ''))
  if (tokens === null) return null

  // Assign to non-null local for TypeScript narrowing in nested functions
  const tokenList = tokens
  let pos = 0

  function peek(): string | null {
    return pos < tokenList.length ? tokenList[pos] : null
  }

  function consume(): string | null {
    return pos < tokenList.length ? tokenList[pos++] : null
  }

  // Grammar: expr -> term (('+' | '-') term)*
  function parseExpr(): number | null {
    let left = parseTerm()
    if (left === null) return null

    while (peek() === '+' || peek() === '-') {
      const op = consume()
      const right = parseTerm()
      if (right === null) return null
      left = op === '+' ? left + right : left - right
    }
    return left
  }

  // Grammar: term -> factor (('*' | '/') factor)*
  function parseTerm(): number | null {
    let left = parseFactor()
    if (left === null) return null

    while (peek() === '*' || peek() === '/') {
      const op = consume()
      const right = parseFactor()
      if (right === null) return null
      if (op === '/' && right === 0) return null // Division by zero
      left = op === '*' ? left * right : left / right
    }
    return left
  }

  // Grammar: factor -> number | '(' expr ')'
  function parseFactor(): number | null {
    const token = peek()
    if (token === null) return null

    if (token === '(') {
      consume() // consume '('
      const result = parseExpr()
      if (result === null || peek() !== ')') return null
      consume() // consume ')'
      return result
    }

    // Must be a number
    const numToken = consume()
    if (numToken === null) return null
    const num = parseFloat(numToken)
    if (isNaN(num)) return null
    return num
  }

  const result = parseExpr()
  // Ensure we consumed all tokens
  if (pos !== tokenList.length) return null
  return result
}

/**
 * Tokenize a math expression into numbers and operators.
 * Returns null if invalid characters are found.
 */
function tokenize(expr: string): string[] | null {
  const tokens: string[] = []
  let i = 0

  while (i < expr.length) {
    const char = expr[i]

    // Operators and parentheses
    if ('+-*/()'.includes(char)) {
      tokens.push(char)
      i++
      continue
    }

    // Numbers (including decimals)
    if (/[0-9.]/.test(char)) {
      let num = ''
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        num += expr[i]
        i++
      }
      // Validate it's a proper number
      if (isNaN(parseFloat(num))) return null
      tokens.push(num)
      continue
    }

    // Invalid character
    return null
  }

  return tokens
}

// ---- option types ------------------------------------------------------------

/** Separators between the parts of a compound label: a middle dot, "|" or ";". */
const COMPOUND_SEPARATOR = /\s*[·|;]\s*/
/** One part of a compound label: "Pack Size: Single Piece". */
const COMPOUND_PART = /^(.{1,32}?):\s*(.+)$/

/** A compound label's option types and values, or null when it is not one. */
function splitCompound(value: string): { names: string[]; values: string[] } | null {
  const names: string[] = []
  const values: string[] = []
  for (const part of value.split(COMPOUND_SEPARATOR).map((piece) => piece.trim())) {
    const match = part ? COMPOUND_PART.exec(part) : null
    const name = match?.[1].trim()
    const option = match?.[2].trim()
    if (!name || !option) return null
    names.push(name)
    values.push(option)
  }
  return names.length > 0 ? { names, values } : null
}

const looksCompound = (value: string) => COMPOUND_SEPARATOR.test(value) || COMPOUND_PART.test(value)
const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, index) => name.toLowerCase() === b[index].toLowerCase())
const hasDuplicateName = (names: readonly string[]) => new Set(names.map((name) => name.toLowerCase())).size !== names.length

/** An option type taken from a column: its name, or null for a generic header that names nothing. */
function axisNameOfHeader(header: string | undefined): string | null {
  if (!header || GENERIC_VARIANT_HEADERS.has(header)) return null
  return AXIS_NAME_OF_HEADER[header] ?? header.charAt(0).toUpperCase() + header.slice(1)
}

/** "Option", "Option 2", … for option types the file does not name. */
const genericAxisName = (index: number) => (index === 0 ? 'Option' : `Option ${index + 1}`)

/** A group's option types and, per row, its option on each (in axis order). */
interface AxisPlan {
  names: string[]
  rowOptions: string[][]
  warning?: string
}

/**
 * The option types of one product group, in priority order: Shopify-style
 * `OptionN` columns, then the variant / subVariant columns (a variant value
 * may be a compound label naming several option types). Null when the group
 * is a single product without options.
 */
function planAxes(rows: ParsedInventoryRow[], columns: ColumnMap, title: string): AxisPlan | null {
  const shopifySlots = Array.from({ length: MAX_OPTION_COLUMNS }, (_, slot) => slot)
    .filter((slot) => rows.some((row) => row.options[slot]?.value))
  if (shopifySlots.length > 0) {
    // Shopify writes a product without options as Title: "Default Title".
    const onlyDefault = rows.length === 1 && shopifySlots.length === 1 && rows[0].options[shopifySlots[0]]?.value?.toLowerCase() === 'default title'
    if (onlyDefault) return null
    // Shopify names an option type on the group's first row only: carry it down.
    const names = shopifySlots.map((slot, index) => rows.map((row) => row.options[slot]?.name).find(Boolean) ?? genericAxisName(index))
    return { names, rowOptions: rows.map((row) => shopifySlots.map((slot) => row.options[slot]?.value ?? '')) }
  }

  const hasVariant = rows.some((row) => row.variant)
  const hasSubVariant = rows.some((row) => row.subVariant)
  if (!hasVariant && !hasSubVariant) return null

  // Each column is one option type, named after its header; a variant value
  // that is a compound label names several.
  type ColumnAxes = { names: (string | null)[]; values: (row: ParsedInventoryRow, index: number) => string[] }
  const parts: ColumnAxes[] = []
  let warning: string | undefined
  if (hasVariant) {
    const plain: ColumnAxes = { names: [axisNameOfHeader(columns.headers.variant)], values: (row) => [row.variant ?? ''] }
    if (rows.some((row) => row.variant && looksCompound(row.variant))) {
      const splits = rows.map((row) => splitCompound(row.variant ?? ''))
      const first = splits[0]
      const consistent = first !== null && first.names.length <= VARIANT_LIMITS.axes && !hasDuplicateName(first.names)
        && splits.every((split) => split !== null && sameNames(split.names, first.names))
      if (consistent) {
        parts.push({ names: first.names, values: (_, index) => splits[index]?.values ?? [] })
      } else {
        parts.push(plain)
        warning = `"${title}": the variant names could not be split into option types, so they were kept whole.`
      }
    } else {
      parts.push(plain)
    }
  }
  if (hasSubVariant) parts.push({ names: [axisNameOfHeader(columns.headers.subVariant)], values: (row) => [row.subVariant ?? ''] })

  let generic = 0
  const names = parts.flatMap((part) => part.names).map((name) => name ?? genericAxisName(generic++))
  return { names, rowOptions: rows.map((row, index) => parts.flatMap((part) => part.values(row, index))), warning }
}

// ---- grouping ----------------------------------------------------------------

/** Every image the group names, deduplicated in order (item images before a row's own). */
function collectImages(rows: ParsedInventoryRow[]): string[] {
  const images: string[] = []
  for (const row of rows) {
    for (const url of [...row.imageUrls, row.image]) {
      if (url && !images.includes(url)) images.push(url)
    }
  }
  return images
}

/** The quantity the import gives a variant row: tracked rows without one start at 0. */
function rowStock(row: ParsedInventoryRow, tracked: boolean): number | undefined {
  if (!tracked) return undefined
  return row.quantity ?? 0
}

/** A SKU cut to what a combination can store. */
function fitSku(sku: string): string {
  let fitted = [...sku].slice(0, VARIANT_LIMITS.skuLength).join('')
  while (new TextEncoder().encode(fitted).length > VARIANT_LIMITS.skuLength * 2) fitted = [...fitted].slice(0, -1).join('')
  return fitted
}

/** Build one product from its rows. */
function buildItem(groupId: string | undefined, rows: ParsedInventoryRow[], columns: ColumnMap, currency: string): GroupedInventoryItem {
  const firstRow = rows[0]
  const title = firstRow.itemName
  const errors: string[] = []
  const warnings: string[] = []

  const allImages = collectImages(rows)
  const imageLimit = itemImageLimit()
  if (allImages.length > imageLimit) warnings.push(`"${title}": kept the first ${imageLimit} of ${allImages.length} images.`)
  const imageUrls = allImages.slice(0, imageLimit)

  const tags: string[] = []
  for (const row of rows) {
    for (const tag of row.tags) {
      if (!tags.includes(tag)) tags.push(tag)
    }
  }

  const item: GroupedInventoryItem = {
    groupId,
    title,
    description: firstRow.description,
    section: firstRow.section,
    category: firstRow.category,
    subcategory: firstRow.subcategory,
    tags,
    imageUrls,
    basePrice: firstRow.price,
    currency,
    errors,
    warnings,
  }

  const plan = planAxes(rows, columns, title)
  if (!plan) {
    if (rows.length > 1) {
      errors.push(`"${title}" has ${rows.length} rows but no options to tell them apart. Give each row its own option, or its own group.`)
      return item
    }
    item.sku = firstRow.sku
    item.stockQuantity = firstRow.quantity
    item.weight = firstRow.weight
    if (firstRow.quantityFormula !== undefined && firstRow.quantity === undefined) {
      warnings.push(`"${title}": the quantity formula on row ${firstRow.rowNumber} could not be worked out, so stock is not tracked.`)
    }
    return item
  }
  if (plan.warning) warnings.push(plan.warning)

  for (const [index, options] of plan.rowOptions.entries()) {
    const missing = options.findIndex((option) => !option)
    if (missing >= 0) errors.push(`"${title}": row ${rows[index].rowNumber} is missing a value for "${plan.names[missing]}".`)
  }
  if (errors.length > 0) return item

  // v7 tracks stock for every combination or for none.
  const tracked = rows.some((row) => row.quantity !== undefined || row.quantityFormula !== undefined)
  if (tracked) {
    const unresolved = rows.filter((row) => row.quantityFormula !== undefined && row.quantity === undefined)
    for (const row of unresolved) warnings.push(`"${title}": the quantity formula on row ${row.rowNumber} could not be worked out, so it was set to 0.`)
    const blank = rows.filter((row) => row.quantity === undefined && row.quantityFormula === undefined).length
    if (blank > 0) warnings.push(`"${title}": ${blank} row${blank === 1 ? ' has' : 's have'} no quantity, so ${blank === 1 ? 'it was' : 'they were'} set to 0.`)
  }

  const longSkus = rows.filter((row) => row.sku && fitSku(row.sku) !== row.sku).length
  if (longSkus > 0) warnings.push(`"${title}": ${longSkus} SKU${longSkus === 1 ? ' is' : 's are'} longer than ${VARIANT_LIMITS.skuLength} characters, so ${longSkus === 1 ? 'it was' : 'they were'} shortened.`)

  // A weight per combination only when the rows differ (and the store keeps one per combination).
  const weights = rows.map((row) => row.weight)
  const weightsDiffer = weights.some((weight) => weight !== weights[0])
  const perCombinationWeight = weightsDiffer && storefrontVariantsAreTyped()
  if (!perCombinationWeight) item.weight = weights.find((weight) => weight !== undefined)
  if (weightsDiffer && !perCombinationWeight) warnings.push(`"${title}": the rows have different weights, but this store keeps one weight per product, so the first one was used.`)

  // A row's own image is its Image URL, else (older files) its first image.
  const ownImage = (row: ParsedInventoryRow) => (columns.fields.image !== undefined ? row.image : row.imageUrls[0])
  const variantRows: VariantRow[] = rows.map((row, index) => {
    const imageIndex = imageUrls.indexOf(ownImage(row) ?? '') + 1
    return {
      optionNames: plan.rowOptions[index],
      price: row.price,
      stock: rowStock(row, tracked),
      sku: row.sku ? fitSku(row.sku) : undefined,
      weight: perCombinationWeight && row.weight !== undefined ? Math.round(row.weight) : undefined,
      image: imageIndex > 0 ? imageIndex : undefined,
    }
  })

  const { variants, duplicate } = variantsFromRows(plan.names, variantRows)
  if (!variants) {
    errors.push(`"${title}" lists "${duplicate}" more than once. Keep one row for each combination.`)
    return item
  }
  item.variants = variants
  item.basePrice = Math.min(...variants.combinations.map((combination) => combination.price))
  for (const problem of variantProblems(variants, { imageCount: imageUrls.length, legacy: !storefrontVariantsAreTyped() })) {
    errors.push(`"${title}": ${problem}`)
  }
  return item
}

/**
 * Group parsed rows into inventory items based on group ID
 */
function groupRows(rows: ParsedInventoryRow[], columns: ColumnMap, currency: string): GroupedInventoryItem[] {
  const groups = new Map<string, ParsedInventoryRow[]>()
  let ungroupedIndex = 0

  for (const row of rows) {
    const groupId = row.group || `__ungrouped_${ungroupedIndex++}`
    const group = groups.get(groupId)
    if (group) group.push(row)
    else groups.set(groupId, [row])
  }

  return Array.from(groups, ([groupId, groupRowsArr]) =>
    buildItem(groupId.startsWith('__ungrouped_') ? undefined : groupId, groupRowsArr, columns, currency))
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

  const columns = mapHeaders(csvRows[0])

  // Check for required columns
  if (columns.fields.itemName === undefined) {
    errors.push({ row: 1, message: 'Missing required column: Item Name (or name, title, product)' })
  }
  if (columns.fields.price === undefined) {
    errors.push({ row: 1, message: 'Missing required column: Price' })
  }

  if (errors.length > 0) {
    return { items: [], errors, warnings }
  }

  const parsedRows: ParsedInventoryRow[] = []
  // A group's title, for its later rows (Shopify names a product on its first row only).
  const groupTitles = new Map<string, string>()

  for (let i = 1; i < csvRows.length; i++) {
    const row = csvRows[i]
    const rowNumber = i + 1 // 1-indexed for user display

    const cell = (index: number | undefined): string => (index !== undefined ? row[index] ?? '' : '')
    const getValue = (column: Column): string => cell(columns.fields[column])

    const group = getValue('group') || undefined
    const itemName = getValue('itemName') || (group ? groupTitles.get(group) ?? '' : '')
    if (!itemName) {
      warnings.push({ row: rowNumber, column: 'itemName', message: 'Empty item name, skipping row' })
      continue
    }
    if (group && !groupTitles.has(group)) groupTitles.set(group, itemName)

    const priceStr = getValue('price')
    const price = parsePrice(priceStr, currency)
    if (price === null) {
      errors.push({ row: rowNumber, column: 'price', message: `Invalid price: "${priceStr}"` })
      continue
    }

    const quantityResult = parseQuantity(getValue('quantity'))
    const combineResult = parseCombineShipping(getValue('combine'), currency)

    const tagsStr = getValue('tags')
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : []

    const imageUrls = columns.images.map((index) => imageUrlOf(cell(index))).filter((url): url is string => url !== undefined)

    const weightStr = getValue('weight')
    const weight = weightStr ? parseFloat(weightStr.replace(/[^\d.]/g, '')) : undefined

    const shippingCostStr = getValue('shippingCost')
    const shippingCost = shippingCostStr ? parsePrice(shippingCostStr, currency) : undefined

    const options = Array.from({ length: MAX_OPTION_COLUMNS }, (_, slot) => ({
      name: cell(columns.optionNames[slot]) || undefined,
      value: cell(columns.optionValues[slot]) || undefined,
    }))

    parsedRows.push({
      group,
      section: getValue('section') || undefined,
      category: getValue('category') || undefined,
      subcategory: getValue('subcategory') || undefined,
      itemName,
      description: getValue('description') || undefined,
      sku: getValue('sku') || undefined,
      tags,
      variant: getValue('variant') || undefined,
      subVariant: getValue('subVariant') || undefined,
      options,
      price,
      quantity: quantityResult.value ?? undefined,
      quantityFormula: quantityResult.formula ?? undefined,
      shippingCost: shippingCost ?? undefined,
      combineShipping: combineResult.type,
      combineShippingExtra: combineResult.extra,
      weight: weight !== undefined && !isNaN(weight) ? weight : undefined,
      imageUrls,
      image: imageUrlOf(getValue('image')),
      rowNumber
    })
  }

  // Formulas resolve across the whole file, before rows become combinations.
  evaluateQuantityFormulas(parsedRows)

  const items = groupRows(parsedRows, columns, currency)

  // The merged tag list must fit what storefront v4 stores (32 tags of at most
  // 64 characters). Trim to fit and say so, rather than build a save the
  // contract refuses.
  const tagLimits = LIST_LIMITS.storeTags
  for (const item of items) {
    const tooLong = item.tags.filter((tag) => [...tag].length > tagLimits.maxLength)
    if (tooLong.length > 0) {
      item.tags = item.tags.filter((tag) => [...tag].length <= tagLimits.maxLength)
      item.warnings.push(`"${item.title}": dropped ${tooLong.length} tag(s) longer than ${tagLimits.maxLength} characters`)
    }
    if (item.tags.length > tagLimits.maxItems) {
      item.warnings.push(`"${item.title}": kept the first ${tagLimits.maxItems} of ${item.tags.length} tags`)
      item.tags = item.tags.slice(0, tagLimits.maxItems)
    }
  }

  return { items, errors, warnings }
}

/**
 * Convert a grouped inventory item to a StoreItem creation payload. A product
 * with options is priced and stocked per combination, so it carries no single
 * price, stock or SKU.
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
  const single = !item.variants
  return {
    title: item.title,
    description: item.description,
    section: item.section,
    category: item.category,
    subcategory: item.subcategory,
    tags: item.tags.length > 0 ? item.tags : undefined,
    imageUrls: item.imageUrls.length > 0 ? item.imageUrls : undefined,
    basePrice: single ? item.basePrice : undefined,
    currency: item.currency,
    status: 'active',
    weight: item.weight,
    stockQuantity: single ? item.stockQuantity : undefined,
    sku: single ? item.sku : undefined,
    variants: item.variants
  }
}
