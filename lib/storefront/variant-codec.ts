/**
 * The storefront v7 variants table (docs/STOREFRONT_V7.md): the editor model
 * the app works with, its encoding as the typed lists `storeItem.variants`
 * stores, and the pure operations every surface shares (lookups, the buyer's
 * picker, price ranges, validation, editing). No SDK, no topology.
 *
 * Identity: every option has a small id (1–254) handed out from the item's
 * `nextOptionId` and never reused, and a combination is identified by the SET
 * of its option ids, written sorted and dot-joined ("3.9"). Renaming or
 * reordering options or axes keeps every id; adding or removing an axis makes
 * a different product grid, so its combinations get new ids, which is right.
 */
import { normalizeBytes } from '@/lib/bytes'
import type { ItemVariants, VariantAxis, VariantCombination, VariantOption } from '@/lib/types'
import { VARIANT_LIMITS } from './storefront-contract'

/** The table as storefront v7 stores it: parallel typed lists, aligned by consensus. */
export interface StoredVariants {
  axes: string[]
  options: string[]
  optionIds: number[]
  optionAxes: number[]
  nextOptionId: number
  /** One byte per axis, in axis order: the option id chosen on that axis. */
  selectors: Uint8Array[]
  prices: number[]
  stocks?: number[]
  /** '' for a combination without a SKU. */
  skus?: string[]
  /** 0 for a combination that weighs what the item does. */
  weights?: number[]
  /** 1-based index into imageUrls; 0 for none. */
  images?: number[]
}

/** What a combination added by an edit starts with. `stock` is set when the item tracks stock. */
export interface CombinationDefaults {
  price: number
  stock?: number
}

/** Longest variant name an order or cart line keeps as its snapshot. */
export const VARIANT_LABEL_MAX_LENGTH = 120

// ---- identity and lookups ---------------------------------------------------

/** The canonical variant id of a combination: its option ids, ascending, dot-joined. */
export function variantIdOf(optionIds: readonly number[]): string {
  return [...optionIds].sort((a, b) => a - b).join('.')
}

/** The combination `variantId` names, if the table still offers it. */
export function findCombination(variants: ItemVariants | undefined, variantId: string | undefined): VariantCombination | undefined {
  if (!variants || !variantId) return undefined
  return variants.combinations.find((combination) => combination.id === variantId)
}

/** The option with id `optionId` and the index of its axis. */
export function findOption(variants: ItemVariants, optionId: number): { axisIndex: number; option: VariantOption } | undefined {
  for (const [axisIndex, axis] of variants.axes.entries()) {
    const option = axis.options.find((candidate) => candidate.id === optionId)
    if (option) return { axisIndex, option }
  }
  return undefined
}

/** A variant spelled out as [option type, option] name pairs, in axis order. */
export type VariantOptionPairs = [string, string][]

/**
 * A combination spelled out by name: [option type, option] for each axis, in
 * axis order. With the option type named, two option types that share option
 * names (Front and Back, both Red and Blue) cannot be confused, whatever their
 * order.
 */
export function variantOptionPairs(variants: ItemVariants, combination: Pick<VariantCombination, 'optionIds'>): VariantOptionPairs {
  return combination.optionIds.map((optionId) => {
    const found = findOption(variants, optionId)
    return [found ? variants.axes[found.axisIndex].name : '', found?.option.name ?? '']
  })
}

/** A combination's name: its option names in axis order ("Red / Single Piece"). */
export function variantLabel(variants: ItemVariants, combination: Pick<VariantCombination, 'optionIds'>): string {
  return combination.optionIds
    .map((optionId) => findOption(variants, optionId)?.option.name ?? '?')
    .join(' / ')
}

/** {@link variantLabel} cut to what a cart line or order keeps. */
export function variantLabelSnapshot(variants: ItemVariants, combination: Pick<VariantCombination, 'optionIds'>): string {
  return variantLabel(variants, combination).slice(0, VARIANT_LABEL_MAX_LENGTH)
}

/**
 * The variant name an order line shows, read defensively: an order payload is
 * buyer-written JSON, so anything but a string shows nothing. Orders placed
 * before variants had ids (testnet production's) name theirs by its key,
 * "Blue|Large".
 */
export function orderLineVariantLabel(line: { variantLabel?: unknown; variantKey?: unknown }): string | undefined {
  let label: string | undefined
  if (typeof line.variantLabel === 'string') label = line.variantLabel
  else if (typeof line.variantKey === 'string') label = line.variantKey.split('|').join(' / ')
  return label ? label.slice(0, VARIANT_LABEL_MAX_LENGTH) : undefined
}

/** An order line's complete SKU snapshot for the seller, when it is a nonempty string. */
export function orderLineSku(line: { sku?: unknown }): string | undefined {
  return typeof line.sku === 'string' && line.sku ? line.sku : undefined
}

/** The combination made of `selection` (one option id per axis, in axis order), if offered. */
export function combinationForSelection(variants: ItemVariants, selection: ReadonlyArray<number | undefined>): VariantCombination | undefined {
  if (selection.length !== variants.axes.length || selection.some((optionId) => optionId === undefined)) return undefined
  return findCombination(variants, variantIdOf(selection as number[]))
}

// ---- the buyer's side -------------------------------------------------------

/** Whether a combination can be bought now: stock is untracked or above zero. */
export const isInStock = (combination: Pick<VariantCombination, 'stock'>) => combination.stock === undefined || combination.stock > 0

/** Whether the item tracks stock (v7 tracks every combination or none). */
export function tracksStock(variants: ItemVariants): boolean {
  return variants.combinations.some((combination) => combination.stock !== undefined)
}

/**
 * The options of axis `axisIndex` a buyer can pick given the options already
 * chosen on the OTHER axes (`selection`, one entry per axis; undefined where
 * nothing is chosen yet): those that complete to an offered combination in
 * stock. Missing combinations are never invented.
 */
export function selectableOptionIds(variants: ItemVariants, axisIndex: number, selection: ReadonlyArray<number | undefined>): Set<number> {
  const selectable = new Set<number>()
  for (const combination of variants.combinations) {
    if (!isInStock(combination)) continue
    const matches = combination.optionIds.every((optionId, axis) => axis === axisIndex || selection[axis] === undefined || selection[axis] === optionId)
    if (matches) selectable.add(combination.optionIds[axisIndex])
  }
  return selectable
}

/** The lowest and highest combination prices (0/0 for an empty table). */
export function priceRange(variants: ItemVariants): { min: number; max: number } {
  if (variants.combinations.length === 0) return { min: 0, max: 0 }
  const prices = variants.combinations.map((combination) => combination.price)
  return { min: Math.min(...prices), max: Math.max(...prices) }
}

/**
 * The image a combination shows: its own (1-based index into `imageUrls`, or
 * on v1–v6 a URL of its own), else the item's first.
 */
export function combinationImageUrl(imageUrls: readonly string[] | undefined, combination: Pick<VariantCombination, 'image' | 'imageUrl'> | undefined): string | undefined {
  const own = combination?.image ? imageUrls?.[combination.image - 1] : combination?.imageUrl
  return own ?? imageUrls?.[0]
}

// ---- encoding ----------------------------------------------------------------

/**
 * The table as v7 stores it. Options are written axis by axis in display
 * order. An optional list is written only when some combination uses it:
 * `stocks` when the item tracks stock (a missing count is 0), `skus` when one
 * has a SKU ('' for the rest), `weights` and `images` when one has a weight or
 * an image (0 for the rest). Call {@link variantProblems} first: this encodes
 * whatever it is given.
 */
export function encodeVariants(variants: ItemVariants): StoredVariants {
  const options: string[] = []
  const optionIds: number[] = []
  const optionAxes: number[] = []
  for (const [axisIndex, axis] of variants.axes.entries()) {
    for (const option of axis.options) {
      options.push(option.name)
      optionIds.push(option.id)
      optionAxes.push(axisIndex)
    }
  }
  const combinations = variants.combinations
  const stored: StoredVariants = {
    axes: variants.axes.map((axis) => axis.name),
    options,
    optionIds,
    optionAxes,
    nextOptionId: variants.nextOptionId,
    selectors: combinations.map((combination) => Uint8Array.from(combination.optionIds)),
    prices: combinations.map((combination) => combination.price),
  }
  if (combinations.some((combination) => combination.stock !== undefined)) stored.stocks = combinations.map((combination) => combination.stock ?? 0)
  if (combinations.some((combination) => combination.sku)) stored.skus = combinations.map((combination) => combination.sku ?? '')
  if (combinations.some((combination) => combination.weight)) stored.weights = combinations.map((combination) => combination.weight ?? 0)
  if (combinations.some((combination) => combination.image)) stored.images = combinations.map((combination) => combination.image ?? 0)
  return stored
}

/** A non-negative safe integer however a read hands it back (number, bigint or decimal string), else undefined. */
function toCount(value: unknown): number | undefined {
  let number = value
  if (typeof value === 'bigint') number = Number(value)
  else if (typeof value === 'string' && /^\d+$/.test(value)) number = Number(value)
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

const asList = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined)
/** An optional column, used only when it has one entry per combination. */
const column = (value: unknown, length: number): unknown[] | undefined => {
  const list = asList(value)
  return list && list.length === length ? list : undefined
}

/**
 * The table a v7 item stores, read defensively: undefined when there is no
 * usable table (absent, malformed axes or options), and any combination that
 * does not name exactly one known option per axis, has no valid price, or
 * repeats another is dropped rather than shown wrongly.
 */
export function decodeVariants(raw: unknown): ItemVariants | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const stored = raw as Record<string, unknown>
  const axisNames = asList(stored.axes)
  const optionNames = asList(stored.options)
  const optionIds = asList(stored.optionIds)
  const optionAxes = asList(stored.optionAxes)
  const selectors = asList(stored.selectors)
  const prices = asList(stored.prices)
  if (!axisNames || !optionNames || !optionIds || !optionAxes || !selectors || !prices) return undefined
  if (axisNames.length === 0 || axisNames.some((name) => typeof name !== 'string')) return undefined
  if (optionIds.length !== optionNames.length || optionAxes.length !== optionNames.length) return undefined

  const axes: VariantAxis[] = (axisNames as string[]).map((name) => ({ name, options: [] }))
  const axisOfOption = new Map<number, number>()
  for (const [index, rawName] of optionNames.entries()) {
    const id = toCount(optionIds[index])
    const axisIndex = toCount(optionAxes[index])
    if (typeof rawName !== 'string' || id === undefined || id === 0 || axisIndex === undefined || axisIndex >= axes.length || axisOfOption.has(id)) continue
    axisOfOption.set(id, axisIndex)
    axes[axisIndex].options.push({ id, name: rawName })
  }
  if (axes.some((axis) => axis.options.length === 0)) return undefined

  const count = selectors.length
  const stocks = column(stored.stocks, count)
  const skus = column(stored.skus, count)
  const weights = column(stored.weights, count)
  const images = column(stored.images, count)
  const combinations: VariantCombination[] = []
  const seen = new Set<string>()
  for (const [index, rawSelector] of selectors.entries()) {
    const selector = normalizeBytes(rawSelector)
    const price = toCount(prices[index])
    if (!selector || selector.length !== axes.length || price === undefined) continue
    const ids = Array.from(selector)
    if (ids.some((optionId, axisIndex) => axisOfOption.get(optionId) !== axisIndex)) continue
    const id = variantIdOf(ids)
    if (seen.has(id)) continue
    seen.add(id)
    const combination: VariantCombination = { id, optionIds: ids, price }
    const stock = stocks ? toCount(stocks[index]) : undefined
    if (stocks) combination.stock = stock ?? 0
    const sku = skus?.[index]
    if (typeof sku === 'string' && sku) combination.sku = sku
    const weight = weights ? toCount(weights[index]) : undefined
    if (weight) combination.weight = weight
    const image = images ? toCount(images[index]) : undefined
    if (image) combination.image = image
    combinations.push(combination)
  }
  if (combinations.length === 0) return undefined

  const highestId = Math.max(...axisOfOption.keys())
  return { axes, combinations, nextOptionId: Math.max(toCount(stored.nextOptionId) ?? 0, highestId + 1) }
}

// ---- validation --------------------------------------------------------------

const utf8Length = (text: string) => new TextEncoder().encode(text).length
/** Whether two option type or option names are the same to a shopper (spaces and case aside). */
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export interface VariantCheckOptions {
  /** How many images the listing has (a combination names one by 1-based index). */
  imageCount: number
  /**
   * The table is stored as the v1–v6 JSON string, which has none of v7's caps
   * (only its 10,000-character or 5,120-byte length, checked on the whole
   * string): option names cannot hold "|" (its key separator), there are no
   * weights, and stock may be tracked for some combinations only. Listings
   * already stored there must stay editable, so only the structure is judged.
   */
  legacy?: boolean
}

/** Whether `text` is past a contract string cap (characters or UTF-8 bytes). */
const tooLong = (text: string, length: number, bytes: number) => [...text].length > length || utf8Length(text) > bytes

/**
 * What stops `variants` from being stored, as sentences for the seller (empty
 * when it can be saved). Covers what the contract refuses (caps, ranges,
 * aligned lists) and what only the client can check (each combination names
 * one option of every axis, no combination twice, names unique per axis).
 */
export function variantProblems(variants: ItemVariants, { imageCount, legacy = false }: VariantCheckOptions): string[] {
  const problems: string[] = []
  const add = (problem: string) => { if (!problems.includes(problem)) problems.push(problem) }
  const limits = VARIANT_LIMITS
  /** v7's caps: the typed table's lists, lengths and id range. */
  const capped = !legacy
  const { axes, combinations } = variants

  if (axes.length === 0) add('Add at least one option type, such as Size or Color.')
  if (capped && axes.length > limits.axes) add(`A product can have at most ${limits.axes} option types.`)
  const optionCount = axes.reduce((total, axis) => total + axis.options.length, 0)
  if (capped && optionCount > limits.options) add(`A product can have at most ${limits.options} options in all (this one has ${optionCount}).`)
  const ids = new Set<number>()
  for (const [axisIndex, axis] of axes.entries()) {
    const axisName = axis.name.trim()
    if (!axisName) add('Give every option type a name.')
    else if (capped && tooLong(axisName, limits.axisNameLength, limits.axisNameBytes)) add(`Option type names can be at most ${limits.axisNameLength} characters ("${axisName.slice(0, 20)}…" is longer).`)
    if (axes.some((other, otherIndex) => otherIndex < axisIndex && sameName(other.name, axis.name))) add(`Two option types are both called "${axisName}". Give each a different name.`)
    if (axis.options.length === 0) add(`Add at least one option to "${axisName || 'each option type'}".`)
    for (const [optionIndex, option] of axis.options.entries()) {
      const name = option.name.trim()
      if (!name) add(`Every option in "${axisName}" needs a name.`)
      else if (capped && tooLong(name, limits.optionNameLength, limits.optionNameBytes)) add(`Option names can be at most ${limits.optionNameLength} characters ("${name.slice(0, 20)}…" is longer).`)
      if (legacy && name.includes('|')) add(`Option names cannot contain "|" ("${name.slice(0, 20)}").`)
      if (axis.options.some((other, otherIndex) => otherIndex < optionIndex && sameName(other.name, option.name))) add(`"${axisName}" lists "${name}" twice.`)
      const badId = !Number.isInteger(option.id) || option.id < 1 || ids.has(option.id) || option.id >= variants.nextOptionId || (capped && option.id > limits.maxOptionId)
      if (badId) add('Some options are numbered incorrectly. Remove the variants and add them again.')
      ids.add(option.id)
    }
  }
  if (capped && variants.nextOptionId > limits.maxOptionId + 1) add('This product has used all its option numbers. To offer more options, list it again as a new product.')

  if (combinations.length === 0 && axes.length > 0) add('Offer at least one combination of options.')
  if (capped && combinations.length > limits.combinations) add(`A product can offer at most ${limits.combinations} combinations (this one has ${combinations.length}). Remove some options, or split it into several listings.`)
  const seen = new Set<string>()
  const tracked = combinations.filter((combination) => combination.stock !== undefined).length
  if (capped && tracked > 0 && tracked < combinations.length) add('Track stock for every combination or for none.')
  for (const combination of combinations) {
    const wellFormed = combination.optionIds.length === axes.length
      && combination.optionIds.every((optionId, axisIndex) => axes[axisIndex].options.some((option) => option.id === optionId))
      && combination.id === variantIdOf(combination.optionIds)
    if (!wellFormed) add('A combination no longer matches the options. Review the combinations table.')
    if (seen.has(combination.id)) add('A combination is listed twice.')
    seen.add(combination.id)
    if (!Number.isSafeInteger(combination.price) || combination.price < 0 || combination.price > limits.maxPrice) add('Every combination needs a valid price.')
    if (combination.stock !== undefined && (!Number.isSafeInteger(combination.stock) || combination.stock < 0 || combination.stock > limits.maxStock)) add('Stock must be a whole number of 0 or more.')
    if (capped && combination.sku !== undefined && tooLong(combination.sku, limits.skuLength, limits.skuBytes)) add(`SKUs can be at most ${limits.skuLength} characters.`)
    if (combination.weight !== undefined) {
      if (legacy) add('Per-combination weights are not available for this store.')
      else if (!Number.isSafeInteger(combination.weight) || combination.weight < 0 || combination.weight > limits.maxWeight) add('Weights must be a whole number of grams.')
    }
    const imageLimit = capped ? Math.min(imageCount, limits.maxImageIndex) : imageCount
    if (combination.image !== undefined && (!Number.isInteger(combination.image) || combination.image < 1 || combination.image > imageLimit)) {
      add('A combination shows an image the listing no longer has. Pick its image again.')
    }
  }
  return problems
}

// ---- editing -----------------------------------------------------------------

/** A table with no options yet. */
export function emptyVariants(): ItemVariants {
  return { axes: [], combinations: [], nextOptionId: 1 }
}

/** A combination's own data (price, stock, SKU, weight, image), without its identity. */
export type CombinationData = Omit<VariantCombination, 'id' | 'optionIds'>
const combinationOf = (optionIds: number[], data: CombinationData): VariantCombination =>
  ({ ...data, id: variantIdOf(optionIds), optionIds })
/** `combination` without its identity. */
function dataOf(combination: VariantCombination): CombinationData {
  const data: Partial<VariantCombination> = { ...combination }
  delete data.id
  delete data.optionIds
  return data as CombinationData
}
const defaultData = (defaults: CombinationDefaults): CombinationData =>
  (defaults.stock === undefined ? { price: defaults.price } : { price: defaults.price, stock: defaults.stock })

/** Every way to pick one of each list (the cartesian product). */
function product(lists: number[][]): number[][] {
  return lists.reduce<number[][]>((rows, list) => rows.flatMap((row) => list.map((value) => [...row, value])), [[]])
}

/** How many more options the table can take before its ids run out (they are never reused). */
export function optionIdsLeft(variants: ItemVariants): number {
  return Math.max(0, VARIANT_LIMITS.maxOptionId + 1 - variants.nextOptionId)
}

/**
 * Options with fresh ids from `nextOptionId`. Ids are never reused, so this
 * refuses (throws) when they run out: renumbering would give an old cart line
 * or kit target a different combination's id. Callers check
 * {@link optionIdsLeft} first; a listing past 254 options is listed again.
 */
function allocate(variants: ItemVariants, names: readonly string[]): { variants: ItemVariants; options: VariantOption[] } {
  if (names.length > optionIdsLeft(variants)) throw new Error('option ids exhausted: list the product again')
  const options = names.map((name, index) => ({ id: variants.nextOptionId + index, name }))
  return { variants: { ...variants, nextOptionId: variants.nextOptionId + names.length }, options }
}

/**
 * Add an option type with `optionNames`. Each existing combination becomes one
 * per new option. With a single new option a combination keeps everything
 * (stock and SKU included); with several, each copy keeps the price, image
 * and weight, starting stock at the default and with no SKU, since one
 * product's stock and SKU cannot belong to several.
 */
export function addAxis(variants: ItemVariants, name: string, optionNames: readonly string[], defaults: CombinationDefaults): ItemVariants {
  const { variants: allocated, options } = allocate(variants, optionNames)
  const axes = [...allocated.axes, { name, options }]
  if (allocated.axes.length === 0) {
    return { ...allocated, axes, combinations: options.map((option) => combinationOf([option.id], defaultData(defaults))) }
  }
  const combinations = allocated.combinations.flatMap((combination) => options.map((option) => {
    const data = dataOf(combination)
    if (options.length > 1) {
      delete data.sku
      if (data.stock !== undefined) data.stock = defaults.stock ?? 0
    }
    return combinationOf([...combination.optionIds, option.id], data)
  }))
  return { ...allocated, axes, combinations }
}

/**
 * Remove option type `axisIndex`. Combinations that differed only on it
 * merge into one, which keeps the first one's price, stock and SKU. Removing
 * the last type empties the table.
 */
export function removeAxis(variants: ItemVariants, axisIndex: number): ItemVariants {
  const axes = variants.axes.filter((_, index) => index !== axisIndex)
  if (axes.length === 0) return { ...emptyVariants(), nextOptionId: variants.nextOptionId }
  const merged = new Map<string, VariantCombination>()
  for (const combination of variants.combinations) {
    const optionIds = combination.optionIds.filter((_, index) => index !== axisIndex)
    const id = variantIdOf(optionIds)
    if (!merged.has(id)) merged.set(id, combinationOf(optionIds, dataOf(combination)))
  }
  return { ...variants, axes, combinations: [...merged.values()] }
}

export function renameAxis(variants: ItemVariants, axisIndex: number, name: string): ItemVariants {
  return { ...variants, axes: variants.axes.map((axis, index) => (index === axisIndex ? { ...axis, name } : axis)) }
}

/** Move option type `from` to position `to`; every id is kept (the selectors are reordered with it). */
export function moveAxis(variants: ItemVariants, from: number, to: number): ItemVariants {
  if (from === to || to < 0 || to >= variants.axes.length) return variants
  const order = variants.axes.map((_, index) => index)
  order.splice(to, 0, ...order.splice(from, 1))
  return {
    ...variants,
    axes: order.map((index) => variants.axes[index]),
    combinations: variants.combinations.map((combination) => ({ ...combination, optionIds: order.map((index) => combination.optionIds[index]) })),
  }
}

/**
 * Add an option named `name` to axis `axisIndex`. It is offered with every
 * pattern of the other axes the table already offers (so combinations the
 * seller removed stay removed), each at the defaults.
 */
export function addOption(variants: ItemVariants, axisIndex: number, name: string, defaults: CombinationDefaults): ItemVariants {
  const { variants: allocated, options: [option] } = allocate(variants, [name])
  const axes = allocated.axes.map((axis, index) => (index === axisIndex ? { ...axis, options: [...axis.options, option] } : axis))
  const patterns = new Map<string, number[]>()
  for (const combination of allocated.combinations) {
    const optionIds = combination.optionIds.map((optionId, index) => (index === axisIndex ? option.id : optionId))
    patterns.set(variantIdOf(optionIds), optionIds)
  }
  if (patterns.size === 0) {
    for (const optionIds of product(axes.map((axis, index) => (index === axisIndex ? [option.id] : axis.options.map((o) => o.id))))) {
      patterns.set(variantIdOf(optionIds), optionIds)
    }
  }
  const added = [...patterns.values()].map((optionIds) => combinationOf(optionIds, defaultData(defaults)))
  return { ...allocated, axes, combinations: [...allocated.combinations, ...added] }
}

/** Remove option `optionId` and every combination with it; an option type left empty goes too. */
export function removeOption(variants: ItemVariants, optionId: number): ItemVariants {
  const found = findOption(variants, optionId)
  if (!found) return variants
  if (variants.axes[found.axisIndex].options.length === 1) return removeAxis(variants, found.axisIndex)
  return {
    ...variants,
    axes: variants.axes.map((axis) => ({ ...axis, options: axis.options.filter((option) => option.id !== optionId) })),
    combinations: variants.combinations.filter((combination) => !combination.optionIds.includes(optionId)),
  }
}

export function renameOption(variants: ItemVariants, optionId: number, name: string): ItemVariants {
  return { ...variants, axes: variants.axes.map((axis) => ({ ...axis, options: axis.options.map((option) => (option.id === optionId ? { ...option, name } : option)) })) }
}

/** Move option `optionId` one place earlier (-1) or later (+1) on its axis. */
export function moveOption(variants: ItemVariants, optionId: number, offset: -1 | 1): ItemVariants {
  return {
    ...variants,
    axes: variants.axes.map((axis) => {
      const from = axis.options.findIndex((option) => option.id === optionId)
      const to = from + offset
      if (from < 0 || to < 0 || to >= axis.options.length) return axis
      const options = [...axis.options]
      options.splice(to, 0, ...options.splice(from, 1))
      return { ...axis, options }
    }),
  }
}

/** Change one combination's data. A key given as undefined clears it. */
export function updateCombination(variants: ItemVariants, variantId: string, patch: Partial<CombinationData>): ItemVariants {
  return { ...variants, combinations: variants.combinations.map((combination) => (combination.id === variantId ? withPatch(combination, patch) : combination)) }
}

function withPatch(combination: VariantCombination, patch: Partial<CombinationData>): VariantCombination {
  const next = { ...combination, ...patch }
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete next[key]
  return next
}

/**
 * Bulk edit: apply `patch` to every combination, or only to those carrying
 * option `optionId` ("price by option": every Large costs more).
 */
export function updateCombinations(variants: ItemVariants, patch: Partial<CombinationData>, optionId?: number): ItemVariants {
  return {
    ...variants,
    combinations: variants.combinations.map((combination) =>
      (optionId === undefined || combination.optionIds.includes(optionId) ? withPatch(combination, patch) : combination)),
  }
}

/** Stop offering one combination (its options stay, for the others). */
export function removeCombination(variants: ItemVariants, variantId: string): ItemVariants {
  return { ...variants, combinations: variants.combinations.filter((combination) => combination.id !== variantId) }
}

/** The combinations of the current options the table does not offer, as option ids in axis order. */
export function missingCombinations(variants: ItemVariants): number[][] {
  if (variants.axes.length === 0) return []
  const offered = new Set(variants.combinations.map((combination) => combination.id))
  return product(variants.axes.map((axis) => axis.options.map((option) => option.id))).filter((optionIds) => !offered.has(variantIdOf(optionIds)))
}

/** Offer every missing combination again, at the defaults. */
export function restoreCombinations(variants: ItemVariants, defaults: CombinationDefaults): ItemVariants {
  const added = missingCombinations(variants).map((optionIds) => combinationOf(optionIds, defaultData(defaults)))
  return { ...variants, combinations: [...variants.combinations, ...added] }
}

/** Track stock for every combination (untracked ones start at 0) or for none. */
export function setStockTracking(variants: ItemVariants, tracked: boolean): ItemVariants {
  return {
    ...variants,
    combinations: variants.combinations.map((combination) => {
      if (tracked) return combination.stock === undefined ? { ...combination, stock: 0 } : combination
      return withPatch(combination, { stock: undefined })
    }),
  }
}

/** Drop image references past the listing's `imageCount` images (after an image is removed). */
export function clampImages(variants: ItemVariants, imageCount: number): ItemVariants {
  if (!variants.combinations.some((combination) => combination.image !== undefined && combination.image > imageCount)) return variants
  return { ...variants, combinations: variants.combinations.map((combination) => (combination.image !== undefined && combination.image > imageCount ? withPatch(combination, { image: undefined }) : combination)) }
}

// ---- building a table from rows (the CSV import) -----------------------------

/** One imported row: an option name per axis (in axis order) and that combination's data. */
export interface VariantRow {
  optionNames: string[]
  price: number
  stock?: number
  sku?: string
  weight?: number
  image?: number
  /** v1–v6 only: the row's own image URL when it is not in the listing's gallery. */
  imageUrl?: string
}

/**
 * The table holding exactly `rows` (never a combination the rows do not
 * name), with options on each axis in first-seen order and ids from 1. A
 * repeated combination is an error: undefined with `duplicate` set to its name.
 */
export function variantsFromRows(axisNames: readonly string[], rows: readonly VariantRow[]): { variants?: ItemVariants; duplicate?: string } {
  const axes: VariantAxis[] = axisNames.map((name) => ({ name, options: [] }))
  let nextOptionId = 1
  const idOf = (axisIndex: number, name: string): number => {
    const axis = axes[axisIndex]
    const existing = axis.options.find((option) => option.name === name)
    if (existing) return existing.id
    const option = { id: nextOptionId++, name }
    axis.options.push(option)
    return option.id
  }
  const combinations: VariantCombination[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const optionIds = row.optionNames.map((name, axisIndex) => idOf(axisIndex, name))
    const id = variantIdOf(optionIds)
    if (seen.has(id)) return { duplicate: row.optionNames.join(' / ') }
    seen.add(id)
    const combination: VariantCombination = { id, optionIds, price: row.price }
    if (row.stock !== undefined) combination.stock = row.stock
    if (row.sku) combination.sku = row.sku
    if (row.weight) combination.weight = row.weight
    if (row.image) combination.image = row.image
    else if (row.imageUrl) combination.imageUrl = row.imageUrl
    combinations.push(combination)
  }
  return { variants: { axes, combinations, nextOptionId } }
}
