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

// Profile payload (shared between profile forms/services)
export interface Profile {
  displayName: string
  bio?: string
  location?: string
  website?: string
  avatar?: string
  bannerUri?: string
  paymentUris?: ParsedPaymentUri[]
  pronouns?: string
  nsfw?: boolean
  socialLinks?: SocialLink[]
}

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
  hasDpns?: boolean  // DPNS resolution state: undefined = loading, true = has DPNS, false = no DPNS
}
