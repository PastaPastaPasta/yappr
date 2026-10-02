/**
 * Pure logic for digital product delivery: which order lines are digital, how
 * a seller's kits turn into one delivery, when an order may be delivered in
 * bulk, and the (validated) wire format of both encrypted payloads.
 * docs/DIGITAL_PRODUCTS.md describes the flow end to end.
 */

import { DELIVERY_CIPHERTEXT_OVERHEAD, KIT_CIPHERTEXT_OVERHEAD } from '../crypto/digital-delivery'
import type {
  DeliverWhen,
  DeliveredItem,
  DigitalAsset,
  ItemDeliverablePayload,
  OrderDeliveryPayload,
  OrderItem,
  OrderPayload,
  OrderStatus,
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
 * be a whole number of units, and "Deliver all" leaves any line drawing more
 * license keys than this for the seller to review by hand.
 */
export const MAX_LINE_QUANTITY = 1000
export const MAX_BULK_KEYS_PER_LINE = 10
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

export const isDigitalLine = (line: Pick<OrderItem, 'fulfillment'> | null | undefined) =>
  typeof line === 'object' && line !== null && line.fulfillment === 'digital'
export const digitalLines = <T extends Pick<OrderItem, 'fulfillment'>>(payload: { items: readonly T[] }) =>
  linesOf(payload).filter(isDigitalLine)
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
  message?: string
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
    if (kit.licenseKeys) {
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

/** Every reason a plan cannot be delivered as it stands, for the seller. */
export function planBlockers(plan: DeliveryPlan): string[] {
  return [
    ...plan.invalidQuantities.map((title) => `"${title}" has an invalid quantity in the order. Check it with the buyer before delivering.`),
    ...plan.missingKits.map((title) => `"${title}" has no delivery content. Add a link, code or file for it below, or add them to the product.`),
    ...plan.shortOnKeys.map((title) => `"${title}" does not have enough unique codes left. Add more in the product's delivery settings.`),
    ...plan.emptyLines.map((title) => `"${title}" would be delivered empty (nothing in its kit applies to this variant). Add a link, code or file for it below.`),
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

/**
 * Whether "Deliver ready orders" may fulfil this order without the seller
 * opening it: it has digital lines, nothing was delivered yet, it is not
 * closed, every digital line has a kit with keys enough, and every kit's
 * timing rule is met (`on_order` always; `payment_confirmed` once the seller
 * has marked payment received).
 */
export function isReadyForBulkDelivery(
  payload: Pick<OrderPayload, 'items'>,
  latestStatus: OrderStatus | undefined,
  alreadyDelivered: boolean,
  kits: ReadonlyMap<string, ItemDeliverablePayload>
): boolean {
  if (alreadyDelivered || !hasDigitalLines(payload)) return false
  if (latestStatus && CLOSED_STATUSES.has(latestStatus)) return false
  const plan = planDelivery(payload, kits)
  if (planBlockers(plan).length > 0) return false
  // A large key order is the seller's call, not the bulk button's.
  if (plan.delivery.items.some((item) => (item.licenseKeys?.length ?? 0) > MAX_BULK_KEYS_PER_LINE)) return false
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

/**
 * A URL the buyer's browser may safely open: http(s), ipfs (a CID) or magnet.
 * Anything else (`javascript:`, `data:`) is refused; a seller with another
 * kind of address can send it as a code instead.
 */
export const isSafeDeliveryUrl = (url: string) =>
  SAFE_HTTP_URL.test(url) || SAFE_IPFS_URL.test(url) || SAFE_MAGNET_URL.test(url)

const safeUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && isSafeDeliveryUrl(value) ? value : undefined

function parseAsset(value: unknown): DigitalAsset | null {
  if (!isRecord(value)) return null
  const variantKey = optionalString(value.variantKey)
  const variant = variantKey ? { variantKey } : {}
  const code = optionalString(value.code)
  if (value.kind === 'file') {
    const url = safeUrl(value.url)
    // A file is fetched and decrypted here, which a magnet link cannot be.
    if (!url || SAFE_MAGNET_URL.test(url)) return null
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

const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decodeJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))

export function encodeKit(kit: ItemDeliverablePayload): Uint8Array {
  const bytes = encodeJson(kit)
  if (bytes.length > MAX_KIT_PLAINTEXT_BYTES) {
    throw new Error(`Delivery content is too large to store (${bytes.length} of ${MAX_KIT_PLAINTEXT_BYTES} bytes). Remove some license keys or links.`)
  }
  return bytes
}

export function decodeKit(bytes: Uint8Array): ItemDeliverablePayload {
  const value = decodeJson(bytes)
  if (!isRecord(value) || value.v !== 1) throw new Error('Unsupported delivery kit version')
  const deliverWhen: DeliverWhen = value.deliverWhen === 'on_order' ? 'on_order' : 'payment_confirmed'
  const instructions = optionalString(value.instructions)
  const licenseKeys = parseKeys(value.licenseKeys)
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
    throw new Error(`This delivery is too large (${bytes.length} of ${MAX_DELIVERY_PLAINTEXT_BYTES} bytes). Shorten the message or deliver the items separately.`)
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
