/**
 * Pure logic for digital product delivery: which order lines are digital, how
 * a seller's kits turn into one delivery, when an order may be delivered in
 * bulk, and the (validated) wire format of both encrypted payloads.
 * docs/DIGITAL_PRODUCTS.md describes the flow end to end.
 */

import bs58 from 'bs58'
import { DELIVERY_CIPHERTEXT_OVERHEAD, KIT_CIPHERTEXT_OVERHEAD } from '../crypto/digital-delivery'
import type {
  DeliverWhen,
  OrderDelivery,
  DeliveredItem,
  DigitalAsset,
  ItemDeliverablePayload,
  OrderDeliveryPayload,
  OrderItem,
  OrderPayload,
  OrderStatus,
  StoreItem,
  StoreOrder,
} from '../../types'

/** Both encrypted payload properties are capped at 16000 bytes by the contract. */
export const MAX_ENCRYPTED_PAYLOAD_BYTES = 16000
export const MAX_KIT_PLAINTEXT_BYTES = MAX_ENCRYPTED_PAYLOAD_BYTES - KIT_CIPHERTEXT_OVERHEAD
export const MAX_DELIVERY_PLAINTEXT_BYTES = MAX_ENCRYPTED_PAYLOAD_BYTES - DELIVERY_CIPHERTEXT_OVERHEAD
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
/**
 * A digital line whose fields the delivery code reads have the types it reads
 * them as. The payload is buyer-written JSON: a numeric `variantKey` or an
 * object `itemTitle` would otherwise throw (or fail to render) in a scan that
 * runs over every order on the seller's page.
 */
/** A base58 document id: 32 bytes. Buyer-written ids are queried in batches, where one bad operand fails them all. */
export function isDocumentId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}
const isWellFormedLine = (line: Partial<OrderItem>) =>
  isDocumentId(line.itemId) && typeof line.itemTitle === 'string' &&
  typeof line.quantity === 'number' && typeof line.unitPrice === 'number' &&
  (line.variantKey === undefined || typeof line.variantKey === 'string')
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

/** Assets that apply to one variant: those for every variant, plus those for this one. */
export function assetsForVariant(assets: readonly DigitalAsset[], variantKey?: string): DigitalAsset[] {
  return assets.filter((asset) => !asset.variantKey || asset.variantKey === variantKey)
}

const withoutVariant = (asset: DigitalAsset): DigitalAsset => {
  const copy = { ...asset }
  delete copy.variantKey
  return copy
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

const validQuantity = (quantity: unknown): quantity is number =>
  Number.isInteger(quantity) && (quantity as number) >= 1 && (quantity as number) <= MAX_LINE_QUANTITY

/**
 * Build the delivery for an order's digital lines from the seller's kits.
 * License keys are taken from the front of each item's pool, `quantity` per
 * line; lines of the same item (different variants) share its pool.
 */
export function planDelivery(
  payload: Pick<OrderPayload, 'items'>,
  kits: ReadonlyMap<string, ItemDeliverablePayload>,
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
    const item: DeliveredItem = {
      itemId: line.itemId,
      itemTitle: line.itemTitle,
      ...(line.variantKey ? { variantKey: line.variantKey } : {}),
      assets: assetsForVariant(kit.assets, line.variantKey).map(withoutVariant),
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
export function lineCoverage(line: Pick<OrderItem, 'itemId' | 'variantKey' | 'quantity'>, deliveries: readonly DeliveryRecord[]): LineCoverage {
  const coverage: LineCoverage = { possibly: false, confirmed: false, possiblyCodes: 0, confirmedCodes: 0 }
  for (const delivery of deliveries) {
    if (!delivery.payload) {
      coverage.possibly = true
      coverage.possiblyCodes = Math.max(coverage.possiblyCodes, line.quantity)
      continue
    }
    for (const item of delivery.payload.items) {
      if (item.itemId !== line.itemId || (item.variantKey ?? '') !== (line.variantKey ?? '')) continue
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

/** Longest title a product can have (the product editor's limit). */
const MAX_ITEM_TITLE_LENGTH = 200
/** Longest base58 encoding of a 32-byte id. */
const MAX_ID_LENGTH = 44

/**
 * Why this kit could not go out for one unit in one delivery, or null when it
 * can. Worst case: a full-length title (in 3-byte characters), the longest
 * variant key, every asset and the longest unique code. A kit that passes is
 * never undeliverable for size alone (a long message aside, which the seller
 * can shorten): an order too big for one receipt can be split line by line,
 * and a line's codes unit by unit.
 */
export function kitDeliveryFitError(kit: ItemDeliverablePayload, variantKeys: readonly string[] = []): string | null {
  const longest = (values: readonly string[]) => values.reduce((a, b) => (b.length > a.length ? b : a), '')
  const variantKey = longest(variantKeys)
  const licenseKey = longest(kit.licenseKeys ?? [])
  const delivery: OrderDeliveryPayload = {
    v: 1,
    items: [{
      itemId: 'x'.repeat(MAX_ID_LENGTH),
      // The most bytes a title can take: 3 UTF-8 bytes per UTF-16 code unit.
      itemTitle: '\u3042'.repeat(MAX_ITEM_TITLE_LENGTH),
      ...(variantKey ? { variantKey } : {}),
      assets: kit.assets.map(withoutVariant),
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
export type ItemListing = Pick<StoreItem, 'storeId' | 'fulfillment' | 'title' | 'basePrice' | 'currency' | 'variants'>

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
  for (const line of digitalLines(payload)) {
    const listing = listings.get(line.itemId)
    const problem = (text: string, blocking = false) => problems.push({ itemTitle: line.itemTitle, text, blocking })
    if (!listing) { problem(`"${line.itemTitle}" could not be checked against your listings. Reload and try again.`, true); continue }
    if (listing.storeId !== storeId) { problem(`"${line.itemTitle}" is not a product of this order's store.`, true); continue }
    if (listing.fulfillment !== 'digital') { problem(`"${line.itemTitle}" is not listed as a digital product.`, true); continue }
    if (listing.title !== line.itemTitle) problem(`The order calls "${listing.title}" "${line.itemTitle}".`)
    const combinations = listing.variants?.combinations ?? []
    const combination = line.variantKey ? combinations.find((c) => c.key === line.variantKey) : undefined
    if (line.variantKey && !combination) problem(`"${listing.title}" has no variant "${line.variantKey.replace(/\|/g, ' / ')}".`)
    else if (!line.variantKey && combinations.length > 0) problem(`The order names no variant of "${listing.title}".`)
    // What checkout charges (storeItemService.getPrice): the variant's price, else the base price, else 0.
    const listedPrice = combination ? combination.price : (listing.basePrice ?? 0)
    if (line.unitPrice !== listedPrice) problem(`The order's price for "${listing.title}" differs from your listing.`)
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
 * product of this store, with the listed title, variant and price), every one
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
  const plan = planDelivery(payload, kits)
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

function parseAsset(value: unknown): DigitalAsset | null {
  if (!isRecord(value)) return null
  const variantKey = optionalString(value.variantKey)
  const variant = variantKey ? { variantKey } : {}
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
    const variantKey = optionalString(raw.variantKey)
    const instructions = optionalString(raw.instructions)
    const licenseKeys = parseKeys(raw.licenseKeys)
    items.push({
      itemId: raw.itemId,
      itemTitle: raw.itemTitle,
      assets: parseAssets(raw.assets),
      ...(variantKey ? { variantKey } : {}),
      ...(instructions ? { instructions } : {}),
      ...(licenseKeys ? { licenseKeys } : {}),
    })
  }
  const message = optionalString(value.message)
  return { v: 1, items, ...(message ? { message } : {}) }
}
