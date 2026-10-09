/**
 * Pure logic for digital product delivery: which order lines are digital, how
 * a seller's kits turn into one delivery, when an order may be delivered in
 * bulk, and the (validated) wire format of both encrypted payloads.
 * docs/DIGITAL_PRODUCTS.md describes the flow end to end.
 */

import bs58 from 'bs58'
import { bytesEqual } from '../bytes'
import { DELIVERY_CIPHERTEXT_OVERHEAD, KIT_CIPHERTEXT_OVERHEAD } from '../crypto/digital-delivery'
import { storefrontVariantsAreTyped } from '../constants'
import { DIGITAL_PAYLOAD_MAX_BYTES, VARIANT_LIMITS } from '../storefront/storefront-contract'
import { findCombination, findOption, variantLabel } from '../storefront/variant-codec'
import type {
  DeliverWhen,
  OrderDelivery,
  DeliveredItem,
  DigitalAsset,
  ItemDeliverablePayload,
  ItemVariants,
  OrderDeliveryPayload,
  OrderItem,
  OrderPayload,
  OrderStatus,
  StoreItem,
  StoreOrder,
} from '../../types'

/** Both encrypted payload properties share one cap in the contract (v6: 5,120 bytes). */
export const MAX_KIT_PLAINTEXT_BYTES = DIGITAL_PAYLOAD_MAX_BYTES - KIT_CIPHERTEXT_OVERHEAD
export const MAX_DELIVERY_PLAINTEXT_BYTES = DIGITAL_PAYLOAD_MAX_BYTES - DELIVERY_CIPHERTEXT_OVERHEAD
/** Largest file a seller may attach: the whole file is encrypted in memory. */
export const MAX_DIGITAL_FILE_BYTES = 100 * 1024 * 1024
export const MAX_INSTRUCTIONS_LENGTH = 2000
/** Longest access code, voucher or other copyable text in one asset. */
export const MAX_CODE_LENGTH = 500
/**
 * Quantities come from the order payload, which the BUYER writes. A line must
 * be a whole number of units, and "Deliver all" leaves any order drawing more
 * license keys than this from one product's pool (over all its lines) for the
 * seller to review by hand.
 */
export const MAX_LINE_QUANTITY = 1000
export const MAX_BULK_KEYS_PER_ITEM = 10
export const MAX_DELIVERY_MESSAGE_LENGTH = 1000
/** Longest variant name a receipt carries for display. */
export const MAX_VARIANT_LABEL_LENGTH = 60

/**
 * Longest canonical variant id: at most five option ids (one per axis) of up
 * to three digits each, dot-joined ("254.254.254.254.254"). Receipts carry the
 * id, never the listing's variant names, so a receipt's size stays bounded
 * however the listing is edited later.
 */
const WORST_VARIANT_ID = '254.254.254.254.254'
export const MAX_VARIANT_ID_LENGTH = WORST_VARIANT_ID.length
const VARIANT_ID = /^\d+(\.\d+)*$/
/** A canonical variant id ("3.9") of bounded length. */
export const isVariantId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_VARIANT_ID_LENGTH && VARIANT_ID.test(value)

/** A receipt item is for this line: same item, same variant. */
export const deliveredFor = (item: Pick<DeliveredItem, 'itemId' | 'variantId'>, line: Pick<OrderItem, 'itemId' | 'variantId'>) =>
  item.itemId === line.itemId && (item.variantId ?? '') === (line.variantId ?? '')

/** Statuses after which an order is never delivered in bulk. */
const CLOSED_STATUSES: ReadonlySet<OrderStatus> = new Set(['delivered', 'cancelled', 'refunded', 'disputed'])
/** Statuses that mean the seller has confirmed payment. */
const PAID_STATUSES: ReadonlySet<OrderStatus> = new Set(['payment_received', 'processing', 'shipped'])

// Order payloads are decrypted buyer-written JSON, cast rather than validated:
// these helpers run over every order on a page, so they tolerate any shape
// (a malformed order counts as having no digital lines) instead of throwing
// and taking the whole page down with it.
const linesOf = <T>(payload: { items: readonly T[] } | undefined): readonly T[] =>
  Array.isArray(payload?.items) ? payload.items : []

/** A line the buyer marked digital, whatever else it holds. */
export const isDigitalLine = (line: Pick<OrderItem, 'fulfillment'> | null | undefined) =>
  typeof line === 'object' && line !== null && line.fulfillment === 'digital'
/** A base58 document id: 32 bytes. Buyer-written ids are queried in batches, where one bad operand fails them all. */
export function isDocumentId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}
/**
 * A digital line whose fields the delivery code reads have the types it reads
 * them as. The payload is buyer-written JSON: a numeric `variantLabel` or an
 * object `itemTitle` would otherwise throw (or fail to render) in a scan that
 * runs over every order on the seller's page, and a variant id that is not a
 * short canonical one would make a receipt larger than its kit was checked for.
 */
const isWellFormedLine = (line: Partial<OrderItem>) =>
  isDocumentId(line.itemId) && typeof line.itemTitle === 'string' &&
  typeof line.quantity === 'number' && typeof line.unitPrice === 'number' &&
  (line.variantId === undefined || isVariantId(line.variantId)) &&
  (line.variantLabel === undefined || typeof line.variantLabel === 'string')
/** The order's digital lines that are well formed; a malformed one is never planned or delivered (see {@link lineProblems}). */
export const digitalLines = <T extends Pick<OrderItem, 'fulfillment'>>(payload: { items: readonly T[] }) =>
  linesOf(payload).filter((line) => isDigitalLine(line) && isWellFormedLine(line as Partial<OrderItem>))
/** Whether a (possibly not yet decrypted) order has anything to deliver online. */
export const hasDigitalLines = (payload: { items: ReadonlyArray<Pick<OrderItem, 'fulfillment'>> } | undefined) =>
  linesOf(payload).some(isDigitalLine)
/** The orders whose decrypted payload has digital lines. */
export const digitalOrders = <T extends Pick<StoreOrder, 'id'>>(orders: readonly T[], payloads: ReadonlyMap<string, Pick<OrderPayload, 'items'>>) =>
  orders.filter((order) => hasDigitalLines(payloads.get(order.id)))
export const isDigitalOnly = (items: ReadonlyArray<Pick<OrderItem, 'fulfillment'>>) =>
  Array.isArray(items) && items.length > 0 && items.every(isDigitalLine)

/**
 * Assets that apply to one variant, given its combination's option ids: those
 * for every variant, plus those whose options it ALL has (one option: every
 * variant with it; one per axis: exactly this one). A line whose variant
 * cannot be resolved (`optionIds` undefined) gets only the untargeted ones.
 */
export function assetsForVariant(assets: readonly DigitalAsset[], optionIds: readonly number[] | undefined): DigitalAsset[] {
  return assets.filter((asset) => !asset.optionIds?.length || (optionIds !== undefined && asset.optionIds.every((id) => optionIds.includes(id))))
}

const withoutTarget = (asset: DigitalAsset): DigitalAsset => {
  const copy = { ...asset }
  delete copy.optionIds
  return copy
}

/** The asset limited to `optionIds` (to every variant when empty). */
export function withAssetTarget(asset: DigitalAsset, optionIds: readonly number[]): DigitalAsset {
  const copy = withoutTarget(asset)
  return optionIds.length > 0 ? { ...copy, optionIds: [...optionIds] } : copy
}

/**
 * An asset's target with axis `axisIndex` set to `optionId` (undefined: any
 * option of that axis). Ids the listing no longer has are dropped, so editing
 * the target also clears a removed option.
 */
export function retargetAxis(variants: ItemVariants, optionIds: readonly number[] | undefined, axisIndex: number, optionId: number | undefined): number[] {
  const kept = (optionIds ?? []).filter((id) => {
    const found = findOption(variants, id)
    return found !== undefined && found.axisIndex !== axisIndex
  })
  return optionId === undefined ? kept : [...kept, optionId]
}

/**
 * How an asset's target reads for the seller ("All variants", "Red / XL";
 * an option since removed from the listing reads "Removed option"), and
 * whether no variant the listing offers has all of its options.
 */
export function describeAssetTarget(variants: ItemVariants | undefined, optionIds: readonly number[] | undefined): { label: string; matchesNone: boolean } {
  if (!optionIds?.length) return { label: 'All variants', matchesNone: false }
  const found = optionIds.map((id) => (variants ? findOption(variants, id) : undefined))
  const known = found
    .flatMap((entry) => (entry ? [entry] : []))
    .sort((a, b) => a.axisIndex - b.axisIndex)
    .map((entry) => entry.option.name)
  const removed = found.filter((entry) => entry === undefined).map(() => 'Removed option')
  const matchesNone = !(variants?.combinations ?? []).some((combination) => optionIds.every((id) => combination.optionIds.includes(id)))
  return { label: [...known, ...removed].join(' / '), matchesNone }
}

export interface DeliveryPlan {
  delivery: OrderDeliveryPayload
  /** License keys this delivery takes from each item's pool. */
  consumedKeys: Map<string, number>
  /** Titles of digital lines with no kit to deliver from. */
  missingKits: string[]
  /** Titles of digital lines whose license-key pool cannot cover the quantity. */
  shortOnKeys: string[]
  /** Titles of digital lines whose quantity is not a whole number from 1 to MAX_LINE_QUANTITY. */
  invalidQuantities: string[]
  /** Titles of planned lines with nothing in them (no assets for their variant, keys or instructions). */
  emptyLines: string[]
}

/** A buyer-written quantity delivery accepts: a whole number from 1 to MAX_LINE_QUANTITY. */
export const validQuantity = (quantity: unknown): quantity is number =>
  Number.isInteger(quantity) && (quantity as number) >= 1 && (quantity as number) <= MAX_LINE_QUANTITY

/**
 * Build the delivery for an order's digital lines from the seller's kits.
 * License keys are taken from the front of each item's pool, `quantity` per
 * line; lines of the same item (different variants) share its pool.
 */
export function planDelivery(
  payload: Pick<OrderPayload, 'items'>,
  kits: ReadonlyMap<string, ItemDeliverablePayload>,
  /** The seller's listings, by item id: they say which options each line's variant has. */
  listings: ReadonlyMap<string, Pick<ItemListing, 'variants'>>,
  message?: string,
  /** Lines that take no unique codes this time (re-sent lines the seller did not ask new codes for). */
  withoutNewKeys?: (line: OrderItem) => boolean
): DeliveryPlan {
  const consumedKeys = new Map<string, number>()
  const missingKits: string[] = []
  const shortOnKeys: string[] = []
  const invalidQuantities: string[] = []
  const items: DeliveredItem[] = []

  for (const line of digitalLines(payload)) {
    if (!validQuantity(line.quantity)) {
      invalidQuantities.push(line.itemTitle)
      continue
    }
    const kit = kits.get(line.itemId)
    if (!kit) {
      missingKits.push(line.itemTitle)
      continue
    }
    const variants = listings.get(line.itemId)?.variants
    const combination = findCombination(variants, line.variantId)
    const label = line.variantLabel || (variants && combination ? variantLabel(variants, combination) : undefined)
    const item: DeliveredItem = {
      itemId: line.itemId,
      itemTitle: line.itemTitle,
      ...(line.variantId ? { variantId: line.variantId } : {}),
      ...(line.variantId && label ? { variantLabel: label.slice(0, MAX_VARIANT_LABEL_LENGTH) } : {}),
      // Before v7 option ids are numbered by position on every read, so a kit's
      // targets cannot be trusted there: only its untargeted assets go out.
      assets: assetsForVariant(kit.assets, storefrontVariantsAreTyped() ? combination?.optionIds : undefined).map(withoutTarget),
      ...(kit.instructions ? { instructions: kit.instructions } : {}),
    }
    if (kit.licenseKeys && !withoutNewKeys?.(line)) {
      const taken = consumedKeys.get(line.itemId) ?? 0
      const keys = kit.licenseKeys.slice(taken, taken + line.quantity)
      if (keys.length < line.quantity) shortOnKeys.push(line.itemTitle)
      consumedKeys.set(line.itemId, taken + keys.length)
      item.licenseKeys = keys
    }
    items.push(item)
  }

  const trimmed = message?.trim()
  return {
    delivery: { v: 1, items, ...(trimmed ? { message: trimmed } : {}) },
    consumedKeys,
    missingKits,
    shortOnKeys,
    invalidQuantities,
    emptyLines: items
      .filter((item) => item.assets.length === 0 && !item.licenseKeys?.length && !item.instructions)
      .map((item) => item.itemTitle),
  }
}

/** Why a delivery cannot be encrypted within the contract's cap, or null when it can. */
function deliverySizeError(delivery: OrderDeliveryPayload): string | null {
  try {
    encodeDelivery(delivery)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'This delivery is too large.'
  }
}

/** What an order line's earlier deliveries hold, for delivering an order in parts. */
export interface LineCoverage {
  /** Some receipt may hold this line: a confirmed one, a pending one, or one this device cannot read. */
  possibly: boolean
  /** A confirmed receipt this device read holds this line. */
  confirmed: boolean
  /** Unique codes for this line that may have gone out (a receipt that cannot be read counts as all of them). */
  possiblyCodes: number
  /** Unique codes for this line in confirmed receipts this device read. */
  confirmedCodes: number
}

type DeliveryRecord = Pick<OrderDelivery, 'unconfirmed' | 'payload'>

/** What the order's earlier deliveries hold for this line (same item and variant). */
export function lineCoverage(line: Pick<OrderItem, 'itemId' | 'variantId' | 'quantity'>, deliveries: readonly DeliveryRecord[]): LineCoverage {
  const coverage: LineCoverage = { possibly: false, confirmed: false, possiblyCodes: 0, confirmedCodes: 0 }
  for (const delivery of deliveries) {
    if (!delivery.payload) {
      coverage.possibly = true
      coverage.possiblyCodes = Math.max(coverage.possiblyCodes, line.quantity)
      continue
    }
    for (const item of delivery.payload.items) {
      if (!deliveredFor(item, line)) continue
      const codes = item.licenseKeys?.length ?? 0
      coverage.possibly = true
      coverage.possiblyCodes += codes
      if (!delivery.unconfirmed) {
        coverage.confirmed = true
        coverage.confirmedCodes += codes
      }
    }
  }
  return coverage
}

/**
 * An order's receipts as just read from the chain, plus every receipt already
 * held that the read does not show (matched by nonce): one this session sent
 * that is still pending, or one a lagging node has not caught up with.
 * Receipts are append-only, so a read can only add to what is held; it never
 * makes codes that went out look unsent.
 */
export function withHeldDeliveries<T extends Pick<OrderDelivery, 'nonce'>>(fresh: readonly T[], held: readonly T[]): T[] {
  const read = (delivery: T) => fresh.some((candidate) => bytesEqual(candidate.nonce, delivery.nonce))
  return [...fresh, ...held.filter((delivery) => !read(delivery))]
}

/**
 * Whether two readings of the order's receipts differ in what a delivery is
 * worked out from: which lines may have gone out, and how many of their
 * unique codes. (A pending receipt that has since confirmed changes neither.)
 */
export function coverageChanged(
  lines: ReadonlyArray<Pick<OrderItem, 'itemId' | 'variantId' | 'quantity'>>,
  before: readonly DeliveryRecord[],
  after: readonly DeliveryRecord[]
): boolean {
  return lines.some((line) => {
    const a = lineCoverage(line, before)
    const b = lineCoverage(line, after)
    return a.possibly !== b.possibly || a.possiblyCodes !== b.possiblyCodes
  })
}

/** What one order line takes in the delivery being sent. */
export interface LineSending {
  /** The line is in this delivery. */
  selected: boolean
  /** The line's product sells unique codes. */
  sellsCodes: boolean
  /** Unique codes this delivery takes for it. */
  codes: number
}

/**
 * Whether this delivery, with the confirmed receipts before it, holds every
 * line's goods: a code line needs all its codes, any other line just one
 * receipt. Only confirmed receipts count (a pending one may never land), and
 * an invalid quantity never counts as covered. `deliveries` should be the
 * receipts as just read: one that confirmed since the form opened counts.
 */
export function deliveryCompletesOrder(
  lines: ReadonlyArray<Pick<OrderItem, 'itemId' | 'variantId' | 'quantity'>>,
  deliveries: readonly DeliveryRecord[],
  sending: readonly LineSending[]
): boolean {
  return lines.every((line, index) => {
    if (!validQuantity(line.quantity)) return false
    const coverage = lineCoverage(line, deliveries)
    const { selected, sellsCodes, codes } = sending[index]
    return sellsCodes
      ? coverage.confirmedCodes + (selected ? codes : 0) >= line.quantity
      : selected || coverage.confirmed
  })
}

/** Longest title a product can have (the product editor's limit). */
const MAX_ITEM_TITLE_LENGTH = 200
/** Longest base58 encoding of a 32-byte id. */
const MAX_ID_LENGTH = 44

/**
 * Why this kit could not go out for one unit in one delivery, or null when it
 * can. A receipt's size depends only on the kit and on fixed limits: a
 * full-length title at its largest once serialized, the longest variant
 * id and a cut variant label (never the listing's variant names), every
 * asset and the largest unique code. So a kit that passes stays deliverable
 * whatever happens to the listing (a long message aside, which the seller can
 * shorten): an order too big for one receipt can be split line by line, and a
 * line's codes unit by unit.
 */
export function kitDeliveryFitError(kit: ItemDeliverablePayload): string | null {
  // Largest by what it adds to the receipt: UTF-8 bytes after JSON escaping, not string length.
  const size = (value: string) => new TextEncoder().encode(JSON.stringify(value)).length
  const licenseKey = (kit.licenseKeys ?? []).reduce((a, b) => (size(b) > size(a) ? b : a), '')
  // The most a string can take once serialized: a control character is
  // escaped as \uXXXX, 6 bytes per UTF-16 code unit.
  const worst = (length: number) => '\u0001'.repeat(length)
  const delivery: OrderDeliveryPayload = {
    v: 1,
    items: [{
      itemId: 'x'.repeat(MAX_ID_LENGTH),
      itemTitle: worst(MAX_ITEM_TITLE_LENGTH),
      variantId: WORST_VARIANT_ID,
      variantLabel: worst(MAX_VARIANT_LABEL_LENGTH),
      assets: kit.assets.map(withoutTarget),
      ...(kit.instructions ? { instructions: kit.instructions } : {}),
      ...(licenseKey ? { licenseKeys: [licenseKey] } : {}),
    }],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(delivery)).length
  return bytes > MAX_DELIVERY_PLAINTEXT_BYTES
    ? `Delivery content is too large to send in one delivery (${bytes} of ${MAX_DELIVERY_PLAINTEXT_BYTES} bytes). Remove some links, codes or instructions.`
    : null
}

/** Every reason a plan cannot be delivered as it stands, for the seller. */
export function planBlockers(plan: DeliveryPlan): string[] {
  const sizeError = deliverySizeError(plan.delivery)
  return [
    ...plan.invalidQuantities.map((title) => `"${title}" has an invalid quantity in the order. Check it with the buyer before delivering.`),
    ...plan.missingKits.map((title) => `"${title}" has no delivery content. Add a link, code or file for it below, or add them to the product.`),
    ...plan.shortOnKeys.map((title) => `"${title}" does not have enough unique codes left. Add more in the product's delivery settings.`),
    ...plan.emptyLines.map((title) => `"${title}" would be delivered empty (nothing in its kit applies to this variant). Add a link, code or file for it below.`),
    ...(sizeError ? [sizeError] : []),
  ]
}

/** Each kit's pool after a delivery took `consumed` keys from the front. */
export function kitsAfterDelivery(
  kits: ReadonlyMap<string, ItemDeliverablePayload>,
  consumed: ReadonlyMap<string, number>
): Map<string, ItemDeliverablePayload> {
  const next = new Map<string, ItemDeliverablePayload>()
  for (const [itemId, count] of consumed) {
    const kit = kits.get(itemId)
    if (kit?.licenseKeys && count > 0) next.set(itemId, { ...kit, licenseKeys: kit.licenseKeys.slice(count) })
  }
  return next
}

/** The seller's own listing of an item, read from the chain. */
export type ItemListing = Pick<StoreItem, 'storeId' | 'fulfillment' | 'title' | 'basePrice' | 'currency' | 'variants' | 'unreadableVariants'> & Partial<Pick<StoreItem, 'status'>> & {
  /** Required (undefined when untracked), so no listing passes the stock check by leaving it out. */
  stockQuantity: number | undefined
}

const lineKey = (line: Pick<OrderItem, 'itemId' | 'variantId'>) => `${line.itemId}|${line.variantId ?? ''}`
const repeatedLineText = (line: Pick<OrderItem, 'itemTitle'>) => `"${line.itemTitle}" appears more than once in this order. Check it with the buyer.`

/**
 * Problems of the WHOLE order that no part of it may be delivered past: a
 * line that repeats an earlier line's item and variant (the cart keeps one
 * line per item and variant, so a repeat can only be hand-written, and it
 * would let one receipt count for two lines), or a digital line whose
 * quantity is not a whole number from 1 to MAX_LINE_QUANTITY. Checked over
 * every line: unticking one in a delivery in parts must not hide it.
 */
export function wholeOrderProblems(payload: Pick<OrderPayload, 'items'>): string[] {
  const seen = new Set<string>()
  return digitalLines(payload).flatMap((line) => {
    const key = lineKey(line)
    const problems: string[] = []
    if (seen.has(key)) problems.push(repeatedLineText(line))
    seen.add(key)
    if (!validQuantity(line.quantity)) problems.push(`"${line.itemTitle}" has an invalid quantity in the order. Check it with the buyer.`)
    return problems
  })
}

/** A way an order line disagrees with the seller's listing of the item it names. */
export interface LineProblem {
  itemTitle: string
  text: string
  /**
   * The line names no digital product of this order's store (or its listing
   * could not be read): its kit is not one this order may draw from. A
   * non-blocking problem (title, variant, price) needs the seller's review.
   */
  blocking: boolean
}

/**
 * Every way the order's digital lines disagree with the seller's listings.
 *
 * The order payload is BUYER-written: a line's `itemId` decides which kit is
 * sent, while its title, variant and price are only what the buyer claims. A
 * buyer could name an expensive product's id with a cheap one's title and
 * price, so the seller's page would show the cheap one while the expensive
 * content went out. Deliveries are therefore checked against the listing.
 * A listing edited since the order (a new price or title) also shows up here,
 * which is the safe direction: the seller reviews it.
 */
export function lineProblems(
  payload: Pick<OrderPayload, 'items'> & Partial<Pick<OrderPayload, 'currency'>>,
  storeId: string,
  listings: ReadonlyMap<string, ItemListing>
): LineProblem[] {
  const problems: LineProblem[] = []
  // The currency is buyer-written too, and interpolated below.
  if (payload.currency !== undefined && typeof payload.currency !== 'string') {
    return [{ itemTitle: '', text: 'This order\'s currency is malformed, so it cannot be delivered from here. Check it with the buyer.', blocking: true }]
  }
  const malformed = linesOf(payload).filter(isDigitalLine).length - digitalLines(payload).length
  if (malformed > 0) problems.push({ itemTitle: '', text: `${malformed} digital line${malformed === 1 ? ' of this order is' : 's of this order are'} malformed, so the order cannot be delivered from here. Check it with the buyer.`, blocking: true })
  const seen = new Set<string>()
  for (const line of digitalLines(payload)) {
    const listing = listings.get(line.itemId)
    const problem = (text: string, blocking = false) => problems.push({ itemTitle: line.itemTitle, text, blocking })
    const key = lineKey(line)
    if (seen.has(key)) { problem(repeatedLineText(line), true); continue }
    seen.add(key)
    // Checked here too: a delivery in parts plans with per-receipt counts, not the order's quantity.
    if (!validQuantity(line.quantity)) { problem(`"${line.itemTitle}" has an invalid quantity in the order. Check it with the buyer.`, true); continue }
    if (!listing) { problem(`"${line.itemTitle}" could not be checked against your listings. Reload and try again.`, true); continue }
    if (listing.storeId !== storeId) { problem(`"${line.itemTitle}" is not a product of this order's store.`, true); continue }
    if (listing.fulfillment !== 'digital') { problem(`"${line.itemTitle}" is not listed as a digital product.`, true); continue }
    // Its options could not be read, so nothing about the line can be checked.
    if (listing.unreadableVariants !== undefined) { problem(`The options of "${listing.title}" could not be read, so this order can't be checked against the listing. Review it with the buyer.`, true); continue }
    // Paused, sold out or deleted since: perhaps a legitimate earlier purchase,
    // but never released without the seller looking (bulk holds any problem).
    if (listing.status !== undefined && listing.status !== 'active') problem(`"${listing.title}" is not on sale right now (${listing.status}).`)
    if (listing.title !== line.itemTitle) problem(`The order calls "${listing.title}" "${line.itemTitle}".`)
    // Before v7 option ids follow the options' order on every read, so an id
    // alone can name another combination after the seller reorders: the name
    // the order carries must match too.
    const found = findCombination(listing.variants, line.variantId)
    const combination = found && listing.variants && !storefrontVariantsAreTyped() && line.variantLabel && variantLabel(listing.variants, found) !== line.variantLabel
      ? undefined
      : found
    if (line.variantId && !combination) {
      // Stock and price are only judged for an option the listing still offers.
      problem(line.variantLabel
        ? `"${listing.title}" has no option "${line.variantLabel}" any more.`
        : `"${listing.title}" no longer has the option this order names.`)
    } else if (!line.variantId && listing.variants) {
      problem(`The order does not say which option of "${listing.title}" was bought.`)
    } else {
      // Tracked stock as checkout reads it (storeItemService.getStock): the
      // variant's, else the base item's; untracked is unlimited. An active
      // listing can still be out of stock, which checkout refuses to sell.
      const stock = combination ? combination.stock : listing.stockQuantity
      if (typeof stock === 'number' && line.quantity > stock) {
        problem(stock <= 0
          ? `"${listing.title}" is out of stock.`
          : `The order is for ${line.quantity} of "${listing.title}", but only ${stock} ${stock === 1 ? 'is' : 'are'} in stock.`)
      }
      // What checkout charges (storeItemService.getPrice): the variant's price, else the base price, else 0.
      const listedPrice = combination?.price ?? listing.basePrice ?? 0
      if (line.unitPrice !== listedPrice) problem(`The order's price for "${listing.title}" differs from your listing.`)
    }
    if (listing.currency && payload.currency && payload.currency !== listing.currency) problem(`The order is in ${payload.currency}, but "${listing.title}" is priced in ${listing.currency}.`)
  }
  return problems
}

export interface BulkReadinessInput {
  payload: Pick<OrderPayload, 'items'> & Partial<Pick<OrderPayload, 'currency'>>
  /** The store the order was placed with. */
  storeId: string
  latestStatus: OrderStatus | undefined
  alreadyDelivered: boolean
  kits: ReadonlyMap<string, ItemDeliverablePayload>
  /** The seller's current listing of each item the order names, by item id. */
  listings: ReadonlyMap<string, ItemListing>
}

/**
 * Whether "Deliver ready orders" may fulfil this order without the seller
 * opening it: it has digital lines, nothing was delivered yet, it is not
 * closed, every digital line agrees with the seller's listing (a digital
 * product of this store, with the listed title, variant and price, and in
 * stock for the quantity ordered), every one
 * has a kit with keys enough, and every kit's timing rule is met (`on_order`
 * always; `payment_confirmed` once the seller has marked payment received).
 *
 * The listing check matters because the order payload is buyer-written: a
 * line's `itemId`, `fulfillment`, title and price prove nothing (see
 * {@link lineProblems}). Without it a buyer could name another store's item,
 * one switched back to shipped whose old kit remains, or an expensive product
 * dressed as a cheap one, and have its content sent automatically.
 */
export function isReadyForBulkDelivery({ payload, storeId, latestStatus, alreadyDelivered, kits, listings }: BulkReadinessInput): boolean {
  if (alreadyDelivered || !hasDigitalLines(payload)) return false
  if (latestStatus && CLOSED_STATUSES.has(latestStatus)) return false
  if (lineProblems(payload, storeId, listings).length > 0) return false
  const plan = planDelivery(payload, kits, listings)
  if (planBlockers(plan).length > 0) return false
  // A large key order is the seller's call, not the bulk button's: counted per
  // product, so splitting it over several lines does not get round the cap.
  if ([...plan.consumedKeys.values()].some((taken) => taken > MAX_BULK_KEYS_PER_ITEM)) return false
  const paid = latestStatus !== undefined && PAID_STATUSES.has(latestStatus)
  return digitalLines(payload).every((line) => kits.get(line.itemId)?.deliverWhen === 'on_order' || paid)
}

// ---------------------------------------------------------------------------
// Wire format. Both payloads are JSON; decoding validates every field, since
// a kit is only as trustworthy as the device that wrote it and a delivery is
// written by the seller, not by this app.
// ---------------------------------------------------------------------------

const SAFE_HTTP_URL = /^https?:\/\/\S+$/i
// ipfs:// must name a bare CID (and optional path): a host-like value such as
// `ipfs://evil.example#` would become that host on a subdomain gateway.
const SAFE_IPFS_URL = /^ipfs:\/\/[a-z0-9]{46,100}(\/[^\s?#]*)?$/i
// Handed to the buyer's torrent client; it carries no script.
const SAFE_MAGNET_URL = /^magnet:\?\S+$/i
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** A URL this app can fetch a file from: http(s) or ipfs (a CID). */
const isFetchableUrl = (url: string) => SAFE_HTTP_URL.test(url) || SAFE_IPFS_URL.test(url)

/**
 * A URL the buyer's browser may safely open: http(s), ipfs (a CID) or magnet.
 * Anything else (`javascript:`, `data:`) is refused; a seller with another
 * kind of address can send it as a code instead.
 */
export const isSafeDeliveryUrl = (url: string) => isFetchableUrl(url) || SAFE_MAGNET_URL.test(url)

/**
 * A link as the seller typed it, made openable where that is unambiguous: a
 * bare host such as `drive.google.com/…` gets `https://`.
 */
export function normalizeLinkInput(input: string): string {
  const url = input.trim()
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url)
  const looksLikeHost = /^[^\s/]+\.[^\s/]+/.test(url)
  return !hasScheme && looksLikeHost ? `https://${url}` : url
}

/**
 * One entry of a unique-codes pool, as the buyer gets it. An entry that starts
 * with a URL is a link, and anything after the URL (separated by whitespace)
 * is that link's own access code: `https://example.com/invite/abc PASS-123`.
 * Anything else is a code.
 */
export function splitPoolEntry(entry: string): { url?: string; code?: string } {
  const [first, ...rest] = entry.trim().split(/\s+/)
  if (!isSafeDeliveryUrl(first)) return { code: entry }
  const code = rest.join(' ')
  return code ? { url: first, code } : { url: first }
}

const safeUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && isSafeDeliveryUrl(value) ? value : undefined

/**
 * An asset limited to variants this client cannot read (a target written by an
 * older client, or ids that are not option ids) matches NO variant rather than
 * every one: a file meant for one variant must never reach the buyers of the
 * others. Option id 0 never occurs, so the editor shows it as a removed option
 * the seller can clear.
 */
const UNREADABLE_TARGET = { optionIds: [0] }

/** An asset's target: whole option ids from 1 to 254, each once; absent when it has none. */
function parseOptionIds(asset: Record<string, unknown>): { optionIds?: number[] } {
  if (asset.optionIds === undefined) return asset.variantKey === undefined ? {} : UNREADABLE_TARGET
  if (!Array.isArray(asset.optionIds)) return UNREADABLE_TARGET
  const ids = asset.optionIds.filter((id): id is number => Number.isInteger(id) && id >= 1 && id <= VARIANT_LIMITS.maxOptionId)
  // Dropping one bad member would WIDEN the target, so any bad member voids it.
  if (ids.length !== asset.optionIds.length) return UNREADABLE_TARGET
  return ids.length === 0 ? {} : { optionIds: [...new Set(ids)] }
}

function parseAsset(value: unknown): DigitalAsset | null {
  if (!isRecord(value)) return null
  const variant = parseOptionIds(value)
  const code = optionalString(value.code)
  if (value.kind === 'file') {
    // A file is fetched and decrypted here, which a magnet link cannot be.
    const url = typeof value.url === 'string' && isFetchableUrl(value.url) ? value.url : undefined
    if (!url) return null
    if (typeof value.name !== 'string' || !value.name) return null
    if (typeof value.key !== 'string' || !BASE64_KEY.test(value.key)) return null
    if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) return null
    const mime = optionalString(value.mime)
    return { kind: 'file', name: value.name, size: value.size, url, key: value.key, ...(mime ? { mime } : {}), ...variant }
  }
  if (value.kind === 'link') {
    const url = safeUrl(value.url)
    if (!url) return null
    return { kind: 'link', label: optionalString(value.label) ?? url, url, ...(code ? { code } : {}), ...variant }
  }
  if (value.kind === 'code') {
    if (!code) return null
    return { kind: 'code', label: optionalString(value.label) ?? 'Code', code, ...variant }
  }
  return null
}

const parseAssets = (value: unknown): DigitalAsset[] =>
  Array.isArray(value) ? value.map(parseAsset).filter((asset): asset is DigitalAsset => asset !== null) : []

const parseKeys = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string' && key.length > 0) : undefined
/** A kit's pool keeps each code once, so no code can go to two buyers. */
const parsePool = (value: unknown): string[] | undefined => {
  const keys = parseKeys(value)
  return keys && [...new Set(keys)]
}

const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
/**
 * Parse decrypted JSON. A parser error can quote its input, which here is
 * plaintext (codes, links), and callers log decode failures: so a failure
 * becomes a generic error that keeps neither the message nor the cause.
 */
const decodeJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('Malformed encrypted payload')
  }
}

export function encodeKit(kit: ItemDeliverablePayload): Uint8Array {
  const bytes = encodeJson(kit)
  if (bytes.length > MAX_KIT_PLAINTEXT_BYTES) {
    throw new Error(`Delivery content is too large to store (${bytes.length} of ${MAX_KIT_PLAINTEXT_BYTES} bytes). Remove some unique codes or links.`)
  }
  return bytes
}

export function decodeKit(bytes: Uint8Array): ItemDeliverablePayload {
  const value = decodeJson(bytes)
  if (!isRecord(value) || value.v !== 1) throw new Error('Unsupported delivery kit version')
  const deliverWhen: DeliverWhen = value.deliverWhen === 'on_order' ? 'on_order' : 'payment_confirmed'
  const instructions = optionalString(value.instructions)
  const licenseKeys = parsePool(value.licenseKeys)
  return {
    v: 1,
    assets: parseAssets(value.assets),
    deliverWhen,
    ...(instructions ? { instructions } : {}),
    ...(licenseKeys ? { licenseKeys } : {}),
  }
}

export function encodeDelivery(delivery: OrderDeliveryPayload): Uint8Array {
  const bytes = encodeJson(delivery)
  if (bytes.length > MAX_DELIVERY_PLAINTEXT_BYTES) {
    throw new Error(`This delivery is too large (${bytes.length} of ${MAX_DELIVERY_PLAINTEXT_BYTES} bytes). Shorten the message, or deliver the items in parts: untick some, deliver, then deliver the rest.`)
  }
  return bytes
}

export function decodeDelivery(bytes: Uint8Array): OrderDeliveryPayload {
  const value = decodeJson(bytes)
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.items)) throw new Error('Unsupported delivery version')
  const items: DeliveredItem[] = []
  for (const raw of value.items) {
    if (!isRecord(raw) || typeof raw.itemId !== 'string' || typeof raw.itemTitle !== 'string') continue
    const variantId = isVariantId(raw.variantId) ? raw.variantId : undefined
    const variantLabel = variantId ? optionalString(raw.variantLabel)?.slice(0, MAX_VARIANT_LABEL_LENGTH) : undefined
    const instructions = optionalString(raw.instructions)
    const licenseKeys = parseKeys(raw.licenseKeys)
    items.push({
      itemId: raw.itemId,
      itemTitle: raw.itemTitle,
      assets: parseAssets(raw.assets),
      ...(variantId ? { variantId } : {}),
      ...(variantLabel ? { variantLabel } : {}),
      ...(instructions ? { instructions } : {}),
      ...(licenseKeys ? { licenseKeys } : {}),
    })
  }
  const message = optionalString(value.message)
  return { v: 1, items, ...(message ? { message } : {}) }
}
