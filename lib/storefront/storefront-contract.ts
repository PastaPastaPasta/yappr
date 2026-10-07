/**
 * What the storefront v6 cut declares that the client has to mirror exactly:
 * the action fee each create agrees to, the store category slug, and the
 * size caps on variants and encrypted payloads. All are read off the
 * committed contract JSON (contracts/yappr-storefront-contract.json, which IS
 * storefront v6), so the app cannot drift from what is registered: an
 * agreement naming a different amount is refused (40133), and a value past a
 * cap is refused after signing.
 *
 * Older cuts (v1–v5) price reviews in YAPP and have none of these rules;
 * every check here is a no-op on them.
 */
import storefrontContract from '@/contracts/yappr-storefront-contract.json'
import { storefrontIsV6 } from '@/lib/constants'
import { actionFeeOf, type ActionFeeDeclaration, type DocumentAction } from '@/lib/contract-topology'
import type { ItemVariants } from '@/lib/types'

type StorefrontSchemas = Record<string, {
  actionFees?: Parameters<typeof actionFeeOf>[0]
  properties: Record<string, { maxLength?: number; maxBytes?: number; maxItems?: number; pattern?: string }>
}>
const schemas = storefrontContract.documentSchemas as unknown as StorefrontSchemas
const property = (docType: string, name: string) => schemas[docType].properties[name]

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

/** Largest stored `storeItem.variants` JSON, in UTF-8 bytes (v6). */
export const ITEM_VARIANTS_MAX_BYTES = property('storeItem', 'variants').maxBytes ?? 5120

/**
 * Why `variants` cannot be stored on this cut, or null when they fit (always
 * null before v6). The item stores them as JSON, capped in bytes, and a
 * listing past the cap is refused after signing.
 */
export function variantsSizeError(variants: ItemVariants | undefined): string | null {
  if (!variants || !storefrontIsV6()) return null
  const bytes = utf8Length(JSON.stringify(variants))
  return bytes > ITEM_VARIANTS_MAX_BYTES
    ? `The variants take ${bytes.toLocaleString()} bytes, more than the ${ITEM_VARIANTS_MAX_BYTES.toLocaleString()} a listing can store. Remove some options, or split the product into several listings.`
    : null
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

/** The cap both digital payloads share (`itemDeliverable` and `orderDelivery`), in bytes. */
export const DIGITAL_PAYLOAD_MAX_BYTES = Math.min(
  property('itemDeliverable', 'encryptedPayload').maxItems ?? 5120,
  property('orderDelivery', 'encryptedPayload').maxItems ?? 5120,
)
