import type { ParsedPaymentUri, SocialLink } from './user'

// Store policy for arbitrary seller-defined policies
export interface StorePolicy {
  name: string     // Policy title, e.g., "Return Policy"
  content: string  // Policy text
}

// Store status values
export type StoreStatus = 'active' | 'paused' | 'closed'

// Item status values
export type StoreItemStatus = 'active' | 'paused' | 'sold_out' | 'deleted'

// Order status values
export type OrderStatus = 'pending' | 'payment_received' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded' | 'disputed'

// Shipping rate type values
export type ShippingRateType = 'flat' | 'weight_tiered' | 'price_tiered'

// Contact methods for a store - uses same SocialLink format as profiles
// Legacy StoreContactMethods type kept for backward compatibility parsing
export interface LegacyStoreContactMethods {
  email?: string
  signal?: string
  twitter?: string
  telegram?: string
}

// Store document (from platform)
export interface StoreDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt?: number
  $revision?: number
  name: string
  description?: string
  logoUrl?: string
  bannerUrl?: string
  status: StoreStatus
  paymentUris?: string // JSON string of ParsedPaymentUri[]
  defaultCurrency?: string
  policies?: string
  location?: string
  contactMethods?: string // JSON string of SocialLink[] (or legacy StoreContactMethods object)
}

// Parsed store for UI display
export interface Store {
  id: string
  ownerId: string
  createdAt: Date
  $revision?: number
  name: string
  description?: string
  logoUrl?: string
  bannerUrl?: string
  status: StoreStatus
  paymentUris?: ParsedPaymentUri[]
  defaultCurrency?: string
  policies?: string
  location?: string
  contactMethods?: SocialLink[]
  // Enriched fields
  ownerUsername?: string
  ownerDisplayName?: string
  averageRating?: number
  reviewCount?: number
}

// Variant axis definition (e.g., Color, Size)
export interface VariantAxis {
  name: string
  options: string[]
}

// Individual variant combination
export interface VariantCombination {
  key: string // e.g., "Blue|Large"
  price: number // Price in smallest currency unit
  stock?: number // Optional - if undefined, inventory is not tracked (unlimited)
  sku?: string
  imageUrl?: string
}

// Full variants structure stored in item
export interface ItemVariants {
  axes: VariantAxis[]
  combinations: VariantCombination[]
}

// Store item document (from platform)
export interface StoreItemDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt?: number
  $revision?: number
  storeId: Uint8Array | string // byte array from platform
  title: string
  description?: string
  section?: string
  category?: string
  subcategory?: string
  tags?: string // JSON string of string[]
  imageUrls?: string // JSON string of string[]
  basePrice?: number
  currency?: string
  status: StoreItemStatus
  weight?: number
  stockQuantity?: number
  sku?: string
  variants?: string // JSON string of ItemVariants
}

// Parsed store item for UI display
export interface StoreItem {
  id: string
  ownerId: string
  storeId: string
  createdAt: Date
  $revision?: number
  title: string
  description?: string
  section?: string
  category?: string
  subcategory?: string
  tags?: string[]
  imageUrls?: string[]
  basePrice?: number
  currency?: string
  status: StoreItemStatus
  weight?: number
  stockQuantity?: number
  sku?: string
  variants?: ItemVariants
  // Enriched fields
  storeName?: string
  storeLogoUrl?: string
}

// Shipping tier definition (legacy format)
export interface ShippingTier {
  min: number
  max: number
  rate: number
}

// Combined shipping pricing config (new format stored in tiers field as JSON object)
export interface ShippingPricingConfig {
  weightRate?: number              // cents per weight unit
  weightUnit?: string              // seller-defined: "lb", "kg", "oz", "g", "item", etc.
  subtotalMultipliers?: SubtotalMultiplier[]
}

// Subtotal multiplier tier
export interface SubtotalMultiplier {
  upTo: number | null              // subtotal threshold in cents, null = infinity
  percent: number                  // 100 = 100%, 0 = free shipping
}

// Common weight units for conversion (item weights stored in grams in contract)
export const WEIGHT_UNITS: Record<string, number> = {
  'g': 1,
  'oz': 28.3495,
  'lb': 453.592,
  'kg': 1000,
}

// Shipping zone document (from platform)
export interface ShippingZoneDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt?: number
  $revision?: number
  storeId: Uint8Array | string
  name: string
  postalPatterns?: string // JSON string of string[]
  countryPattern?: string
  rateType: ShippingRateType
  flatRate?: number
  tiers?: string // JSON string of ShippingTier[]
  currency?: string
  priority?: number
}

// Parsed shipping zone for UI
export interface ShippingZone {
  id: string
  ownerId: string
  storeId: string
  createdAt: Date
  $revision?: number
  name: string
  postalPatterns?: string[]
  countryPattern?: string
  rateType: ShippingRateType
  flatRate?: number
  tiers?: ShippingTier[] | ShippingPricingConfig  // Legacy array or new combined config
  currency?: string
  priority: number
}

// Cart item (stored in localStorage)
export interface CartItem {
  itemId: string
  storeId: string
  title: string
  variantKey?: string // e.g., "Blue|Large"
  quantity: number
  unitPrice: number
  imageUrl?: string
  currency: string
}

// Cart (localStorage)
export interface Cart {
  items: CartItem[]
  updatedAt: Date
}

// Shipping address for orders
export interface ShippingAddress {
  name: string
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

// Buyer contact info for orders
export interface BuyerContact {
  email?: string
  phone?: string
}

// Order item in encrypted payload
export interface OrderItem {
  itemId: string
  itemTitle: string
  variantKey?: string
  quantity: number
  unitPrice: number
  imageUrl?: string
}

// Encrypted order payload structure
export interface OrderPayload {
  items: OrderItem[]
  shippingAddress: ShippingAddress
  buyerContact: BuyerContact
  subtotal: number
  shippingCost: number
  total: number
  currency: string
  paymentUri: string
  txid?: string
  notes?: string
  refundAddress?: string
}

// Store order document (from platform)
export interface StoreOrderDocument {
  $id: string
  $ownerId: string // buyer
  $createdAt: number
  storeId: Uint8Array | string
  sellerId: Uint8Array | string
  encryptedPayload: Uint8Array
  nonce: Uint8Array
}

// Parsed store order for UI (after decryption)
export interface StoreOrder {
  id: string
  buyerId: string
  storeId: string
  sellerId: string
  createdAt: Date
  encryptedPayload: Uint8Array
  nonce: Uint8Array
  // Decrypted payload (only available to buyer/seller)
  payload?: OrderPayload
  // Enriched fields
  storeName?: string
  buyerUsername?: string
  latestStatus?: OrderStatus
  trackingNumber?: string
  trackingCarrier?: string
}

export type Order = StoreOrder

// Order status update document (from platform)
export interface OrderStatusUpdateDocument {
  $id: string
  $ownerId: string // seller
  $createdAt: number
  orderId: Uint8Array | string
  status: OrderStatus
  trackingNumber?: string
  trackingCarrier?: string
  message?: string
}

// Parsed order status update for UI
export interface OrderStatusUpdate {
  id: string
  ownerId: string
  orderId: string
  createdAt: Date
  status: OrderStatus
  trackingNumber?: string
  trackingCarrier?: string
  message?: string
}

// Store review document (from platform)
export interface StoreReviewDocument {
  $id: string
  $ownerId: string // reviewer (buyer)
  $createdAt: number
  storeId: Uint8Array | string
  orderId: Uint8Array | string
  sellerId: Uint8Array | string
  rating: number
  title?: string
  content?: string
}

// Parsed store review for UI
export interface StoreReview {
  id: string
  reviewerId: string
  storeId: string
  orderId: string
  sellerId: string
  createdAt: Date
  rating: number
  title?: string
  content?: string
  // Enriched fields
  reviewerUsername?: string
  reviewerDisplayName?: string
  reviewerAvatar?: string
}

// Store rating summary
export interface StoreRatingSummary {
  averageRating: number
  reviewCount: number
  ratingDistribution: {
    1: number
    2: number
    3: number
    4: number
    5: number
  }
}

// Saved address for encrypted storage
export interface SavedAddress {
  id: string               // UUID
  label: string            // "Home", "Work", etc.
  address: ShippingAddress
  contact: BuyerContact
  isDefault?: boolean
  createdAt: number
}

// Payload structure stored encrypted on-chain
export interface SavedAddressPayload {
  version: number          // Schema version
  addresses: SavedAddress[]
}

// Document from platform
export interface SavedAddressDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt?: number
  $revision?: number
  encryptedPayload: Uint8Array
}
