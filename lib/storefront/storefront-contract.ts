/**
 * What the storefront v6/v7 cuts declare that the client has to mirror
 * exactly: the action fee each create agrees to, the store category slug, the
 * variants table's limits and the size caps on items and encrypted payloads.
 * All are read off the committed contract JSON
 * (contracts/yappr-storefront-contract.json, which IS storefront v7), so the
 * app cannot drift from what is registered: an agreement naming a different
 * amount is refused (40133), and a value past a cap is refused after signing.
 *
 * Older cuts (v1–v5) price reviews in YAPP and have none of these rules;
 * every check here is a no-op on them.
 */
import storefrontContract from '@/contracts/yappr-storefront-contract.json'
import { STOREFRONT_TOPOLOGY, storefrontIsV6, storefrontVariantsAreTyped } from '@/lib/constants'
import { actionFeeOf, type ActionFeeDeclaration, type DocumentAction } from '@/lib/contract-topology'
import type { OrderPayload } from '@/lib/types'

interface PropertySchema {
  maxLength?: number
  maxBytes?: number
  maxItems?: number
  maximum?: number
  pattern?: string
  items?: PropertySchema
  properties?: Record<string, PropertySchema>
}
type StorefrontSchemas = Record<string, {
  actionFees?: Parameters<typeof actionFeeOf>[0]
  properties: Record<string, PropertySchema>
}>
const schemas = storefrontContract.documentSchemas as unknown as StorefrontSchemas
const property = (docType: string, name: string) => schemas[docType].properties[name]
const variantList = (name: string): PropertySchema => property('storeItem', 'variants').properties?.[name] ?? {}
const variantItem = (name: string): PropertySchema => variantList(name).items ?? {}

/**
 * The v7 variants table's limits, as the contract declares them. A table past
 * any of them is refused after signing (10101), so the editor, the CSV import
 * and `variantProblems` check them first.
 */
export const VARIANT_LIMITS = {
  axes: variantList('axes').maxItems ?? 5,
  axisNameLength: variantItem('axes').maxLength ?? 32,
  axisNameBytes: variantItem('axes').maxBytes ?? 64,
  options: variantList('options').maxItems ?? 64,
  optionNameLength: variantItem('options').maxLength ?? 40,
  optionNameBytes: variantItem('options').maxBytes ?? 80,
  /** Option ids run 1 to this; the next id to hand out may be one more. */
  maxOptionId: variantItem('optionIds').maximum ?? 254,
  combinations: variantList('prices').maxItems ?? 256,
  skuLength: variantItem('skus').maxLength ?? 32,
  skuBytes: variantItem('skus').maxBytes ?? 64,
  maxPrice: variantItem('prices').maximum ?? Number.MAX_SAFE_INTEGER,
  maxStock: variantItem('stocks').maximum ?? 4294967295,
  maxWeight: variantItem('weights').maximum ?? 4294967295,
  /** Highest image index a combination may name (1-based into imageUrls; 0 = none). */
  maxImageIndex: variantItem('images').maximum ?? 12,
} as const

/**
 * The most stock one combination can hold: v7's typed `stocks` are capped at
 * 4,294,967,295, while the v1–v6 JSON holds any whole number (safe integer).
 * Every check and input on a combination's stock goes through this, so a
 * v1–v6 table past the v7 cap stays editable.
 */
export const combinationStockCap = (legacy: boolean): number => (legacy ? Number.MAX_SAFE_INTEGER : VARIANT_LIMITS.maxStock)

/**
 * Most product images the editor lets a listing carry: the contract's 12 on
 * v7 (a variant names one by index), and 4 before it, as the editor always
 * allowed (v1–v3 store the list as one capped JSON string).
 */
export function itemImageLimit(): number {
  return storefrontVariantsAreTyped() ? property('storeItem', 'imageUrls').maxItems ?? 12 : 4
}

/**
 * The action fee a v6 transition on `docType`/`action` must agree to, or null
 * when it charges nothing (every storefront action before v6; on v6 every
 * action but a `store`, `storeItem`, `storeReview` or `itemReview` create).
 */
export function storefrontActionFee(docType: string, action: DocumentAction): ActionFeeDeclaration | null {
  return storefrontIsV6() ? actionFeeOf(schemas[docType]?.actionFees, action) : null
}

/** The credits a v6 create of `docType` pays into the fee pots at a 1.0x multiplier, or null when it is free. */
export function storefrontCreateFeeCredits(docType: string): bigint | null {
  const fee = storefrontActionFee(docType, 'create')
  return fee ? fee.owner + fee.moderators : null
}

/** Longest `store.category` slug (v6). */
export const STORE_CATEGORY_MAX_LENGTH = property('store', 'category').maxLength ?? 20
const STORE_CATEGORY_PATTERN = new RegExp(property('store', 'category').pattern ?? '^[a-z0-9]+(-[a-z0-9]+)*$')

/**
 * `input` as a `store.category` slug: lowercase ASCII letters and digits in
 * dash-separated words ("Vintage Clothing!" → "vintage-clothing"), accents
 * folded, at most {@link STORE_CATEGORY_MAX_LENGTH} characters. Empty when
 * nothing usable is left. Stores that type the same words share one key, so
 * they group under one category.
 */
export function normalizeStoreCategory(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STORE_CATEGORY_MAX_LENGTH)
    .replace(/-+$/, '')
}

/** Whether `value` is a category v6 stores as is. */
export function isStoreCategory(value: string): boolean {
  return value.length <= STORE_CATEGORY_MAX_LENGTH && STORE_CATEGORY_PATTERN.test(value)
}

/** A category slug for display: "vintage-clothing" → "Vintage clothing". */
export function storeCategoryLabel(slug: string): string {
  const words = slug.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const STORE_IMAGE_URL_PATTERN = new RegExp(property('store', 'logoUrl').pattern ?? '^(https|ipfs)://.+$')

/** Whether `url` is a store logo or banner URL the configured cut accepts (v6: https:// or ipfs:// only). */
export function isStoreImageUrl(url: string): boolean {
  return !storefrontIsV6() || STORE_IMAGE_URL_PATTERN.test(url)
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length

/** Platform's cap on one signed state transition, in bytes. */
export const STATE_TRANSITION_CAP = 20_480
/**
 * The most a listing's create or replace may take, signed, before the client
 * refuses to send it: the cap less a margin for what the estimate cannot see.
 */
export const ITEM_TRANSITION_BUDGET = 19_900
/**
 * What a storeItem create adds around its fields: the ids, type name, nonce,
 * entropy, action fee agreement and the signature. Measured at 154–159 bytes
 * unsigned on 5.0.0-beta.3 (a replace carries less), plus ~66 for the
 * signature, rounded up.
 */
export const ITEM_TRANSITION_OVERHEAD = 260

const varintBytes = (n: number) => (n < 251 ? 1 : n < 65_536 ? 3 : n < 4_294_967_296 ? 5 : 9)

/**
 * The bytes `value` takes inside a state transition, where a document's
 * fields travel as a platform Value map: a one-byte tag per value, then a
 * varint length (strings, bytes, lists, maps, keys included) or a varint
 * integer. Matches the SDK's serialization of storeItem documents exactly
 * (the envelope aside), so the budget below is neither loose nor timid.
 */
export function platformValueBytes(value: unknown): number {
  if (value === undefined || value === null) return 1
  if (typeof value === 'string') {
    const bytes = utf8Length(value)
    return 1 + varintBytes(bytes) + bytes
  }
  if (typeof value === 'number' || typeof value === 'bigint') return 1 + varintBytes(Math.abs(Number(value)))
  if (typeof value === 'boolean') return 2
  if (value instanceof Uint8Array) return 1 + varintBytes(value.length) + value.length
  if (Array.isArray(value)) return value.reduce<number>((total, element) => total + platformValueBytes(element), 1 + varintBytes(value.length))
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, element]) => element !== undefined)
    return entries.reduce<number>((total, [key, element]) => total + platformValueBytes(key) + platformValueBytes(element), 1 + varintBytes(entries.length))
  }
  return 9
}

/** The estimated signed size of a storeItem create or replace carrying `fields` (the document as written). */
export function itemTransitionBytes(fields: Record<string, unknown>): number {
  return ITEM_TRANSITION_OVERHEAD + platformValueBytes(fields)
}

/** The longest stored variants JSON on v1–v5, in characters. */
const LEGACY_VARIANTS_MAX_CHARS = 10_000
/** The longest stored variants JSON on v6, in UTF-8 bytes. */
const V6_VARIANTS_MAX_BYTES = 5120

/**
 * Why a listing whose stored fields are `fields` cannot be sent, or null when
 * it fits. Every cut caps a whole transition; v7 has no other cap on the
 * variants table, so this is its practical size limit. v1–v5 also cap the
 * variants JSON at 10,000 characters, and v6 at 5,120 bytes.
 */
export function itemSizeError(fields: Record<string, unknown>): string | null {
  const advice = 'Remove some options or images, shorten the description, or split the product into several listings.'
  if (typeof fields.variants === 'string') {
    const tooLarge = STOREFRONT_TOPOLOGY === 'v6'
      ? utf8Length(fields.variants) > V6_VARIANTS_MAX_BYTES
      : fields.variants.length > LEGACY_VARIANTS_MAX_CHARS
    if (tooLarge) return `The variants are too large for one listing. ${advice}`
  }
  return itemTransitionBytes(fields) > ITEM_TRANSITION_BUDGET ? `This product is too large to save as one listing. ${advice}` : null
}

/**
 * Why a seller cannot check out from their own store. v6 refuses it on chain
 * (`storeOrder.sellerId` distinctFrom `$ownerId`); the client refuses it on every cut.
 */
export const OWN_STORE_ORDER_MESSAGE = 'This is your own store. You cannot place an order with yourself.'

/** Whether `viewerId` owns `store` (false while either is unknown, so a missing store never reads as "yours"). */
export function isOwnStore(store: { ownerId: string } | null | undefined, viewerId: string | undefined): boolean {
  return Boolean(store && viewerId && store.ownerId === viewerId)
}

/** Largest encrypted order payload, in bytes (v6). */
export const ORDER_PAYLOAD_MAX_BYTES = property('storeOrder', 'encryptedPayload').maxItems ?? 5120

/**
 * Why an encrypted order payload of `bytes` cannot be placed on this cut, or
 * null when it fits (always null before v6).
 */
export function orderPayloadSizeError(bytes: number): string | null {
  return storefrontIsV6() && bytes > ORDER_PAYLOAD_MAX_BYTES
    ? `This order is too large to send (${bytes.toLocaleString()} of ${ORDER_PAYLOAD_MAX_BYTES.toLocaleString()} bytes). Shorten the notes, or split it into smaller orders.`
    : null
}

/**
 * What ECIES adds to the order JSON: the 33-byte ephemeral public key and the
 * 16-byte Poly1305 tag (`privateFeedCryptoService.eciesEncryptWithEphemeralKey`).
 */
export const ORDER_CIPHERTEXT_OVERHEAD = 33 + 16

/**
 * The longest values v6 lets a buyer type into the order fields that are
 * filled in on the payment step, after payment has been offered. Checkout caps
 * those inputs at these lengths, and {@link orderPaymentBudgetError} reserves
 * room for them up front.
 */
export const ORDER_PAYMENT_FIELD_LIMITS = { txid: 100, refundAddress: 120, notes: 280 } as const

/** UTF-8 bytes per UTF-16 unit at worst (3), which also covers JSON's two-byte escapes of quotes and newlines. */
const WORST_BYTES_PER_CHAR = 3

/**
 * Why an order built from `draft` could outgrow v6's payload cap, or null when
 * it always fits (always null before v6). Run BEFORE payment is offered, since
 * a payment sent for an order that is then refused leaves the seller with no
 * record of it: the payment URI is taken at the store's longest, and the
 * transaction id, refund address and notes (typed afterwards) at their caps,
 * worst-case encoded.
 */
export function orderPaymentBudgetError(draft: OrderPayload, paymentUris: readonly string[]): string | null {
  if (!storefrontIsV6()) return null
  const reserve = (chars: number) => 'x'.repeat(chars * WORST_BYTES_PER_CHAR)
  const worst: OrderPayload = {
    ...draft,
    paymentUri: [draft.paymentUri, ...paymentUris].reduce((longest, uri) => (utf8Length(uri) > utf8Length(longest) ? uri : longest)),
    txid: reserve(ORDER_PAYMENT_FIELD_LIMITS.txid),
    refundAddress: reserve(ORDER_PAYMENT_FIELD_LIMITS.refundAddress),
    notes: reserve(ORDER_PAYMENT_FIELD_LIMITS.notes),
  }
  const bytes = utf8Length(JSON.stringify(worst)) + ORDER_CIPHERTEXT_OVERHEAD
  return bytes > ORDER_PAYLOAD_MAX_BYTES
    ? `This order is too large to place (${bytes.toLocaleString()} of ${ORDER_PAYLOAD_MAX_BYTES.toLocaleString()} bytes, counting room for payment details and notes). Remove some items, or split it into smaller orders.`
    : null
}

/** The cap both digital payloads share (`itemDeliverable` and `orderDelivery`), in bytes. */
export const DIGITAL_PAYLOAD_MAX_BYTES = Math.min(
  property('itemDeliverable', 'encryptedPayload').maxItems ?? 5120,
  property('orderDelivery', 'encryptedPayload').maxItems ?? 5120,
)
