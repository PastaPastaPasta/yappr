export interface User {
  id: string
  documentId?: string  // The profile document $id (for updates)
  $revision?: number   // Document revision (for updates)
  username: string  // From DPNS - not stored in profile document
  displayName: string
  avatar: string // URL for display (DiceBear generated from user ID or custom URI)
  bio?: string
  location?: string
  website?: string
  followers: number
  following: number
  verified?: boolean
  joinedAt: Date
  // New unified profile fields
  bannerUri?: string
  paymentUris?: ParsedPaymentUri[]
  pronouns?: string
  nsfw?: boolean
  socialLinks?: SocialLink[]
  hasUnifiedProfile?: boolean  // true if migrated to new contract
  hasDpns?: boolean  // DPNS resolution state: undefined = loading, true = has DPNS, false = no DPNS
}

// Payment URI parsed from profile
export interface ParsedPaymentUri {
  scheme: string  // e.g., 'dash:', 'bitcoin:'
  uri: string     // Full URI e.g., 'dash:XnNh3...'
  label?: string  // Optional display label
}

// Social link from profile
export interface SocialLink {
  platform: string  // e.g., 'twitter', 'github'
  handle: string    // e.g., '@username' or 'username'
}

export interface Post {
  id: string
  author: User
  content: string
  createdAt: Date
  likes: number
  reposts: number
  replies: number
  views: number
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
  media?: Media[]
  quotedPostId?: string // ID of quoted post (for fetching if quotedPost not populated)
  quotedPostOwnerId?: string // ID of quoted post owner (for notification queries)
  quotedPost?: Post
  tipInfo?: TipInfo     // Populated if this post is a tip (parsed from content)
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  repostedBy?: { id: string; username?: string; displayName?: string }  // If this is a repost, who reposted it
  repostTimestamp?: Date  // When the repost was created (for timeline sorting)
  // Reply fields (present when this Post object represents a Reply for display)
  parentId?: string        // ID of post or reply being replied to (only on replies)
  parentOwnerId?: string   // Owner of parent (only on replies)
  // Private feed fields (present when post is encrypted)
  encryptedContent?: Uint8Array  // XChaCha20-Poly1305 ciphertext
  epoch?: number                 // Revocation epoch at post creation
  nonce?: Uint8Array             // Random nonce for encryption
}

/** A reply to a post or another reply */
export interface Reply {
  id: string
  author: User
  content: string
  createdAt: Date
  likes: number
  reposts: number
  replies: number
  views: number
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
  media?: Media[]
  parentId: string        // ID of post or reply being replied to
  parentOwnerId: string   // Owner of parent (for notifications)
  parentContent?: Post | Reply  // Lazy-loaded parent
  _enrichment?: PostEnrichment  // Pre-fetched data to avoid N+1 queries
  // Private feed fields (present when reply is encrypted)
  encryptedContent?: Uint8Array
  epoch?: number
  nonce?: Uint8Array
}

/** Pre-fetched enrichment data to avoid N+1 queries in feed */
export interface PostEnrichment {
  authorIsBlocked: boolean
  authorIsFollowing: boolean
  authorAvatarUrl: string
}

/** Reply thread structure for threaded post display */
export interface ReplyThread {
  content: Reply                // The reply (could be nested)
  isAuthorThread: boolean       // true if same author as main post
  isThreadContinuation: boolean // true if continues previous author reply
  nestedReplies: ReplyThread[]  // 2nd level replies (depth limited)
}

// Tip metadata parsed from post content (format: tip:CREDITS\nmessage)
// NOTE: Amount is currently self-reported and unverified.
// TODO: Once SDK exposes transition IDs, format will become tip:CREDITS@TRANSITION_ID
// which will allow on-chain verification of tip amounts.
export interface TipInfo {
  amount: number        // Tip amount in credits (self-reported, unverified)
  message: string       // The tip message (content after the tip: line)
  transitionId?: string // Future: will be used for on-chain verification
}

export interface Media {
  id: string
  type: 'image' | 'video' | 'gif'
  url: string
  thumbnail?: string
  alt?: string
  width?: number
  height?: number
}

export interface Comment {
  id: string
  author: User
  content: string
  createdAt: Date
  likes: number
  liked?: boolean
  postId: string
}

export interface Notification {
  id: string
  type: 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked'
  from: User
  post?: Post
  createdAt: Date
  read: boolean
}

export interface Trend {
  topic: string
  posts: number
  category?: string
}

// V3 DM contract document types (raw from platform)
export interface ConversationInviteDocument {
  $id: string
  $ownerId: string  // sender
  $createdAt: number
  recipientId: Uint8Array  // 32 bytes
  conversationId: Uint8Array  // 10 bytes
  senderPubKey?: Uint8Array  // 33 bytes, optional (for hash160 identities)
}

export interface DirectMessageDocument {
  $id: string
  $ownerId: string  // sender
  $createdAt: number
  conversationId: Uint8Array  // 10 bytes
  encryptedContent: Uint8Array  // binary: [12 bytes IV | ciphertext], max 5KB
}

export interface ReadReceiptDocument {
  $id: string
  $ownerId: string  // reader (who owns this receipt)
  $createdAt: number
  $updatedAt: number  // v3: use this as "last read" timestamp
  $revision?: number
  conversationId: Uint8Array  // 10 bytes
}

// Decrypted message for UI display
export interface DirectMessage {
  id: string
  senderId: string
  recipientId: string
  conversationId: string  // base58 encoded
  content: string  // Decrypted content for display
  createdAt: Date
}

export interface Conversation {
  id: string  // conversationId (derived from participants)
  participantId: string  // The other participant (not current user)
  participantUsername?: string  // DPNS username if available
  participantDisplayName?: string  // Profile display name if available
  lastMessage?: DirectMessage | null
  unreadCount: number
  updatedAt: Date
}

// Query options for post service methods
export interface PostQueryOptions {
  /** Skip automatic enrichment - caller will handle enrichment manually */
  skipEnrichment?: boolean
}

// Block contract document types (enhanced blocking with bloom filters)
export interface BlockDocument {
  $id: string
  $ownerId: string // Who is doing the blocking
  $createdAt: number
  blockedId: string // Who is blocked (base58 format after transformation)
  message?: string // Optional public reason for blocking
}

export interface BlockFilterDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt: number
  $revision?: number
  filterData: Uint8Array // Serialized bloom filter (up to 5KB)
  itemCount: number // Number of items in the filter
  version: number // Bloom filter version for forward compatibility
}

export interface BlockFollowDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $updatedAt: number
  $revision?: number
  followedBlockers: Uint8Array // Encoded array of user IDs (max 100 * 32 bytes)
}

// Parsed block follow data (after decoding followedBlockers)
export interface BlockFollowData {
  $id: string
  $ownerId: string
  $revision?: number
  followedUserIds: string[] // Decoded list of user IDs being followed
}

// DPNS Multi-Username Registration Types
export type UsernameStatus = 'pending' | 'checking' | 'available' | 'contested' | 'taken' | 'invalid'
export type RegistrationStep = 'username-entry' | 'checking' | 'review' | 'registering' | 'complete'

export interface UsernameEntry {
  id: string
  label: string
  status: UsernameStatus
  isContested: boolean
  validationError?: string
  registrationError?: string
  registered?: boolean
}

export interface UsernameCheckResult {
  available: boolean
  contested: boolean
  error?: string
}

export interface UsernameRegistrationResult {
  label: string
  success: boolean
  isContested: boolean
  error?: string
}

// ============================================================================
// Storefront Types
// ============================================================================

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