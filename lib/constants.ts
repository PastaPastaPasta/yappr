/**
 * Application constants
 */

// Contract IDs
export const YAPPR_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID || '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9' // Testnet - v2 (protocol v12: count trees + YAPP token + tokenCost; documentsCountable + countable byOwner on post)

// YAPP token (defined at position 0 of the v2 social contract)
export const YAPP_TOKEN_POSITION = 0
// Contract-owner / token authority identity (signs freeze/unfreeze/slash on testnet).
// Mainnet TODO: move moderation to a Group and drop this single-identity gate.
export const YAPP_TOKEN_AUTHORITY_ID = 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A'
// Per-action token cost baked into the v2 contract's tokenCost.create (immutable ratio).
// Used as the `maximumTokenCost` guard when creating token-paid documents.
export const YAPP_TOKEN_COSTS = {
  post: 10,
  reply: 3,
  like: 1,
  repost: 1,
} as const
export const YAPPR_PROFILE_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID || 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe' // Unified profile contract
export const YAPPR_DM_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID || 'J7MP9YU1aEGNAe7bjB45XdrjDLBsevFLPK1t1YwFS4ck' // Testnet - DM contract v3 (simplified readReceipt)
// YAPPR_BLOCK_CONTRACT_ID removed - block, blockFilter, blockFollow document types now in YAPPR_CONTRACT_ID
export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec' // Testnet
export const YAPPR_STOREFRONT_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID || '2AUBj86MGTsXP7A3ekD62YoTeDwtJe5b9MxwkWwdg6Ba' // Testnet - Storefront contract v2 (with savedAddress)
export const ENCRYPTED_KEY_BACKUP_CONTRACT_ID = process.env.NEXT_PUBLIC_ENCRYPTED_KEY_BACKUP_CONTRACT_ID || '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts' // Testnet - Encrypted key backup contract (1B max iterations)
// HASHTAG_CONTRACT_ID and MENTION_CONTRACT_ID removed - these document types are now in YAPPR_CONTRACT_ID
export const DASHPAY_CONTRACT_ID = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7' // Dash Pay contacts contract
export const KEY_EXCHANGE_CONTRACT_ID = process.env.NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID || '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P' // Key exchange protocol contract
export const YAPPR_VAULT_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_VAULT_CONTRACT_ID || '7RQoHtVZaRZDSrR22s8KcbCJmwSwetJHBcFjx6FJdkJD' // Testnet - Vault contract (contract-bound encryption keys + encrypted storage)
export const YAPPR_AUTH_VAULT_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_AUTH_VAULT_CONTRACT_ID || '64RTgHjGXhtiN9t5S4u6hVDps7oHuTBaaHrQEFYcxt9M'
export const YAPPR_BLOG_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID || '9jfarXPwRoKXK4v2JBDaiFg3j78diQuLnHMyVqBZfZNc' // Testnet - Blog contract v4 (BlockNote 0.47 upgrade)
export const BLOG_CHUNK_SIZE = 5120         // 5 KiB — platform max_field_value_size
export const BLOG_MAX_CHUNKS = 4            // Number of data fields in contract (data0–data3)
export const BLOG_POST_SIZE_LIMIT = 16384   // Max total compressed content (leaves headroom within 4 × 5120 = 20KB)

// Pollr — native polls shared with the standalone Pollr app.
// Testnet pollr v2: count trees on `vote`, maker-owned (Yappr only reads/writes documents).
export const POLLR_CONTRACT_ID = process.env.NEXT_PUBLIC_POLLR_CONTRACT_ID || '8R4SgHyxrEZCb5yBb6p4gtT3g1CSRv5GAM4Rehc1vQJq'
// Pollr v1 — abandoned in place. Recorded so the id stays documented and is never
// reused; its documents use the old schema and are NOT readable by the v2 services.
export const LEGACY_POLLR_CONTRACT_ID = '7Xye3k1MuVYTpLuTnein5GLwR1NUjmt5gtLLp4pGhhRf'
export const POLLR_APP_URL = 'https://pastapastapasta.github.io/pollr'

export const POLLR_DOCUMENT_TYPES = {
  POLL: 'poll',
  VOTE: 'vote',
} as const

// Poll limits — mirror the pollr v2 contract schema (option0..option9, 1-100 chars each).
export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 10
export const POLL_QUESTION_MAX_LENGTH = 512
export const POLL_OPTION_MAX_LENGTH = 100

// App URL (custom domain on GitHub Pages)
export const APP_URL = 'https://yap.pr'

// Previous ("v2") Yappr deployment — the old contract's content lives here.
// Linked from empty / end-of-feed states so users can still reach pre-cutover posts.
export const LEGACY_APP_URL = 'https://yappr-v2.thepasta.org'

// Network configuration
export const DEFAULT_NETWORK = 'testnet'

// Insight API configuration for transaction detection
export const INSIGHT_API_URLS = {
  testnet: 'https://insight.testnet.networks.dash.org/insight-api',
  mainnet: 'https://insight.dash.org/insight-api'
} as const

export const INSIGHT_API_CONFIG = {
  pollIntervalMs: 3000,
  timeoutMs: 120000
} as const

// Document types
// Note: AVATAR, REPOST, DIRECT_MESSAGE, NOTIFICATION were removed in contract migration
// - avatar: now in unified profile contract
// - repost: merged into post (post with quotedPostId + empty content = repost)
// - directMessage: uses separate DM contract v3
// - notification: derived from other document types
export const DOCUMENT_TYPES = {
  PROFILE: 'profile',
  POST: 'post',
  REPLY: 'reply',
  LIKE: 'like',
  FOLLOW: 'follow',
  BOOKMARK: 'bookmark',
  LIST: 'list',
  LIST_MEMBER: 'listMember',
  BLOCK: 'block',
  BLOCK_FILTER: 'blockFilter',
  BLOCK_FOLLOW: 'blockFollow',
  MUTE: 'mute',
  ENCRYPTED_KEY_BACKUP: 'encryptedKeyBackup',
  POST_HASHTAG: 'postHashtag',
  POST_MENTION: 'postMention',
  // Private feed document types
  FOLLOW_REQUEST: 'followRequest',
  PRIVATE_FEED_GRANT: 'privateFeedGrant',
  PRIVATE_FEED_REKEY: 'privateFeedRekey',
  PRIVATE_FEED_STATE: 'privateFeedState',
  // Key exchange protocol document types (separate contract)
  LOGIN_KEY_RESPONSE: 'loginKeyResponse',
  BLOG: 'blog',
  BLOG_POST: 'blogPost',
  BLOG_COMMENT: 'blogComment',
  BLOG_FOLLOW: 'blogFollow',
  VAULT: 'vault',
  AUTH_VAULT: 'authVault',
  AUTH_VAULT_ACCESS: 'authVaultAccess',
} as const

// Storefront document types (separate contract)
export const STOREFRONT_DOCUMENT_TYPES = {
  STORE: 'store',
  STORE_ITEM: 'storeItem',
  SHIPPING_ZONE: 'shippingZone',
  STORE_ORDER: 'storeOrder',
  ORDER_STATUS_UPDATE: 'orderStatusUpdate',
  STORE_REVIEW: 'storeReview',
  SAVED_ADDRESS: 'savedAddress'
} as const

// DPNS
export const DPNS_DOCUMENT_TYPE = 'domain'
