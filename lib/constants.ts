/**
 * Application constants
 */

// Contract IDs
export const YAPPR_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID || '9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9' // Testnet - v2 (protocol v12: count trees + YAPP token + tokenCost; documentsCountable + countable byOwner on post)

// YAPP token (defined at position 0 of the v2 social contract)
export const YAPP_TOKEN_POSITION = 0
// Contract-owner / token authority identity (signs freeze/unfreeze/slash).
// Per-deployment: the devnet contract is owned by a different maker identity,
// so the settings moderation gate must compare against that owner there.
// Mainnet TODO: move moderation to a Group and drop this single-identity gate.
export const YAPP_TOKEN_AUTHORITY_ID = process.env.NEXT_PUBLIC_YAPP_TOKEN_AUTHORITY_ID || 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A'
// Per-action token cost baked into the contract's tokenCost.create (immutable ratio).
// Used as the `maximumTokenCost` guard when creating token-paid documents.
//
// A doctype MISSING from this table gets no token-payment agreement attached, and
// consensus then rejects its create outright — so every doctype that declares a
// tokenCost on any deployed contract must appear here, keyed by document type
// name. `likeReply` only exists on the v3 topology; on v2 nothing looks it up.
export const YAPP_TOKEN_COSTS = {
  post: 10,
  reply: 3,
  like: 1,
  likeReply: 1,
  repost: 1,
} as const
// Storefront v2 reviews are priced in YAPP too, charged from the social
// contract's token through `tokenCost.create.contractId` (a cross-contract
// token cost), so their payment agreement must name the social contract.
export const STOREFRONT_YAPP_TOKEN_COSTS = {
  storeReview: 3,
  itemReview: 1,
} as const
// ---- tips (YAPP token transfers) — owned by the tips work, edit here only ----
// The SYSTEM token-history contract. Platform writes one `transfer` document
// into it for every transfer of a token whose config sets
// `keepsTransferHistory` (YAPP does), owned by the sender and carrying the
// exact amount, the recipient and the sender's `publicNote`. That document IS
// the tip proof — see docs/TIPS_YAPP.md.
//
// System contracts share an id across chains, so this is hardcoded; overridable
// all the same for a devnet genesised with a different registration.
export const TOKEN_HISTORY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TOKEN_HISTORY_CONTRACT_ID ?? '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF'
/** Minimum YAPP per tip. Whole tokens (YAPP has decimals=0). */
export const MIN_YAPP_TIP = BigInt(1)
// ---- end tips block ----

export const YAPPR_PROFILE_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID || 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe' // Unified profile contract
// Optional contracts use ?? (not ||) so a deployment can EXPLICITLY BLANK one
// (e.g. .env.devnet sets them empty until devnet copies are provisioned): the
// preload and every isConfigured() gate treat an empty id as "not available",
// which fails closed instead of querying an id that does not exist on-chain.
export const YAPPR_DM_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID ?? 'J7MP9YU1aEGNAe7bjB45XdrjDLBsevFLPK1t1YwFS4ck' // Testnet - DM contract v3 (simplified readReceipt)
// ---- DM topology — owned by the DM v4 work, edit here only ----
// `v3` is the testnet contract: no count flags, so the conversation list has to
// download a 100-message page per conversation and count unread in JS. `v4`
// (contracts/yappr-dm-contract-v4.json, docs/DM_V4.md) adds countable +
// rangeCountable to directMessage's conversation index, so unread is a count
// query and the list fetches only each conversation's newest message.
//
// Unlike the storefront switch, this one changes READS ONLY — v4 writes are
// byte-identical to v3 writes, so a mismatch is never rejected by consensus.
// It is not harmless, though: point `v4` at a contract WITHOUT the count flags
// (the id and this switch are separate env vars) and every count query fails,
// so unread reads as 0 everywhere and the badge silently never appears. The
// service logs a warning naming this cause on each failed count.
export const DM_TOPOLOGY: 'v3' | 'v4' =
  process.env.NEXT_PUBLIC_DM_TOPOLOGY === 'v4' ? 'v4' : 'v3'
export const dmIsV4 = () => DM_TOPOLOGY === 'v4'
// ---- end DM topology block ----
// DPNS is a system contract, so its id is normally identical on every chain.
// Overridable all the same: a freshly genesised devnet can be brought up with a
// different DPNS registration, and `/devnet` must not preload a missing id.
export const DPNS_CONTRACT_ID = process.env.NEXT_PUBLIC_DPNS_CONTRACT_ID || 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec'
export const YAPPR_STOREFRONT_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID ?? '2AUBj86MGTsXP7A3ekD62YoTeDwtJe5b9MxwkWwdg6Ba' // Testnet - legacy storefront (v1 topology, with savedAddress)
// Storefront contract topology. `v1` is the testnet contract: plain indexes,
// no buyerId/sellerId attestation, no itemReview, no token cost — aggregates
// are client-side scans. `v2` (contracts/yappr-storefront-contract-v2.json,
// docs/STOREFRONT_V2.md) adds the proved rating trees, the refersTo chain
// and YAPP-priced reviews; writes carry the v2 fields and consensus rejects
// them on a v1 contract, so the switch must match the deployed contract.
export const STOREFRONT_TOPOLOGY: 'v1' | 'v2' =
  process.env.NEXT_PUBLIC_STOREFRONT_TOPOLOGY === 'v2' ? 'v2' : 'v1'
export const storefrontIsV2 = () => STOREFRONT_TOPOLOGY === 'v2'
export const ENCRYPTED_KEY_BACKUP_CONTRACT_ID = process.env.NEXT_PUBLIC_ENCRYPTED_KEY_BACKUP_CONTRACT_ID ?? '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts' // Testnet - Encrypted key backup contract (1B max iterations)
export const DASHPAY_CONTRACT_ID = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7' // Dash Pay contacts contract
export const KEY_EXCHANGE_CONTRACT_ID = process.env.NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID ?? '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P' // Key exchange protocol contract
export const YAPPR_VAULT_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_VAULT_CONTRACT_ID ?? '7RQoHtVZaRZDSrR22s8KcbCJmwSwetJHBcFjx6FJdkJD' // Testnet - Vault contract (contract-bound encryption keys + encrypted storage)
export const YAPPR_AUTH_VAULT_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_AUTH_VAULT_CONTRACT_ID ?? '64RTgHjGXhtiN9t5S4u6hVDps7oHuTBaaHrQEFYcxt9M'
export const YAPPR_BLOG_CONTRACT_ID = process.env.NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID ?? '9jfarXPwRoKXK4v2JBDaiFg3j78diQuLnHMyVqBZfZNc' // Testnet - Blog contract v4 (BlockNote 0.47 upgrade)
// ---- blog v2 topology — owned by the blog work, edit here only ----
// `v1` is the testnet contract: plain indexes, no attested `author`, no token
// cost — comment counts and follower counts are client-side page scans. `v2`
// (contracts/yappr-blog-contract-v2.json, docs/BLOG_V2.md) adds the refersTo
// chain, the countable/ranked comment and follower trees, and YAPP-priced
// comments; writes carry the v2 fields and consensus rejects them on a v1
// contract, so the switch must match the deployed contract.
//
// Read at CALL time (like `getContractTopology`, unlike `STOREFRONT_TOPOLOGY`):
// `NEXT_PUBLIC_*` is inlined at build time either way, and a function keeps the
// gate stubbable from unit tests.
export const blogTopology = (): 'v1' | 'v2' =>
  process.env.NEXT_PUBLIC_BLOG_TOPOLOGY === 'v2' ? 'v2' : 'v1'
export const blogIsV2 = () => blogTopology() === 'v2'
// Blog comments are priced in YAPP, charged from the SOCIAL contract's token
// through `tokenCost.create.contractId` (a cross-contract token cost), so their
// payment agreement must name that contract — see resolveTokenPayment.
export const BLOG_YAPP_TOKEN_COSTS = {
  blogComment: 1,
} as const
// ---- end blog v2 block ----
export const BLOG_CHUNK_SIZE = 5120         // 5 KiB — platform max_field_value_size
export const BLOG_MAX_CHUNKS = 4            // Number of data fields in contract (data0–data3)
export const BLOG_POST_SIZE_LIMIT = 16384   // Max total compressed content (leaves headroom within 4 × 5120 = 20KB)

// Pollr — native polls shared with the standalone Pollr app.
// Testnet pollr v3: count trees plus a per-mode ballot doctype, maker-owned
// (Yappr only reads/writes documents).
export const POLLR_CONTRACT_ID = process.env.NEXT_PUBLIC_POLLR_CONTRACT_ID ?? 'GBCR8JqtXNMZa4B16ZAYm3RkNHrPcU3D36jcAoYWvr8E'
// Two superseded pollr contracts were abandoned in place (v1 stored options as
// JSON in byte arrays; v2 had a single `vote` doctype whose uniqueness rule could
// not enforce single-choice ballots). Their ids are recorded in git history and
// must never be reused; their documents are not readable by the v3 services.
export const POLLR_APP_URL = 'https://pastapastapasta.github.io/pollr'
// The contract the standalone app at POLLR_APP_URL reads (the testnet v3
// deployment above). External poll permalinks only resolve when our polls live
// in that same contract — a devnet clone's polls do not exist there.
export const POLLR_APP_CONTRACT_ID = 'GBCR8JqtXNMZa4B16ZAYm3RkNHrPcU3D36jcAoYWvr8E'

/**
 * `VOTE` and `MULTI_VOTE` are the two ballot doctypes. A poll's immutable
 * `multiChoice` flag picks which one holds its ballots, and each carries the
 * uniqueness rule that mode needs: `vote` is unique per (poll, voter), so
 * Platform rejects a second single-choice selection; `multiVote` is unique per
 * (poll, voter, choice). Documents written to the doctype a poll doesn't use
 * are never read, so they can't reach a tally.
 */
export const POLLR_DOCUMENT_TYPES = {
  POLL: 'poll',
  VOTE: 'vote',
  MULTI_VOTE: 'multiVote',
} as const

/** The doctype holding a poll's ballots, chosen by its `multiChoice` flag. */
export function pollrVoteDocType(multiChoice: boolean): string {
  return multiChoice ? POLLR_DOCUMENT_TYPES.MULTI_VOTE : POLLR_DOCUMENT_TYPES.VOTE
}

// Poll limits — mirror the pollr v3 contract schema (option0..option9, 1-100 chars each).
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
//
// `AppNetwork` is what the SDK connects to; `KeyNetwork` is what address and WIF
// encoding follow. They differ on devnet: Dash devnets reuse the testnet address
// and WIF version bytes (moutai's Insight even reports `"network":"testnet"`), so
// every key-derivation and secure-storage call site must stay on 'testnet' there.
// Use `getConfiguredNetwork()` for connections and `keyNetwork()` for key material.
export type AppNetwork = 'testnet' | 'mainnet' | 'devnet'
export type KeyNetwork = 'testnet' | 'mainnet'

export const DEFAULT_NETWORK: AppNetwork = 'testnet'

/** The network the SDK talks to, from `NEXT_PUBLIC_NETWORK`. */
export function getConfiguredNetwork(): AppNetwork {
  const configured = process.env.NEXT_PUBLIC_NETWORK
  if (configured === 'mainnet' || configured === 'devnet' || configured === 'testnet') {
    return configured
  }
  return DEFAULT_NETWORK
}

/** The network whose address/WIF prefixes apply. Devnets use testnet's. */
export function keyNetwork(): KeyNetwork {
  return getConfiguredNetwork() === 'mainnet' ? 'mainnet' : 'testnet'
}

// Contract interaction topology.
//
// `v2` is the shape every deployed contract has today: replies chain through a
// single polymorphic `parentId`, and like/repost/bookmark/quote all address
// posts and replies through the same `postId`/`quotedPostId` keyspace.
//
// `v3` is the topology from PLAN_CONTRACT_V3_TOPOLOGY.md: flat threads
// (`rootPostId` + `replyToReplyId`), a separate `likeReply` doctype, posts-only
// repost/bookmark, and dual quote fields — each reference `refersTo`-checked by
// consensus, which is only possible once every field points at exactly one
// document type.
//
// `v4` is the like-overhaul topology (PLAN_LIKE_OVERHAUL.md,
// contracts/yappr-social-contract-v4.json): same document graph as v3 plus
// indexOnly `like`/`likeReply` doctypes (no stored body, delete-by-values,
// ranked/count axes), a single inline `post.hashtag` property replacing the
// `postHashtag` doctype, and required poster-attested `author` fields on
// post/reply serving the likes' propertyAgreement.
//
// `v5` is the dev.6 re-cut (PLAN_DEV6_V5.md,
// contracts/yappr-social-contract-v5.json): same graph as v4, but `hashtag` is
// OPTIONAL (an untagged post/like omits the property instead of writing the
// `''` sentinel; `like.byHashtagPost` is `skipIfAbsent`, so untagged likes
// write no per-tag index entries at all), hashtag maxLength shrinks to 61 (the
// ranked key-size ceiling), and the at-form `rankedCountable` chains unlock
// proved prefix rankings: trending hashtags, the creator leaderboard, and
// most-followed.
//
// The topologies are wired into the app through `lib/contract-topology.ts`. A
// deployment must set this to match the contract in
// `NEXT_PUBLIC_YAPPR_CONTRACT_ID`; the default keeps testnet/staging/prod on v2.
export type ContractTopology = 'v2' | 'v3' | 'v4' | 'v5' | 'v6'

export const DEFAULT_CONTRACT_TOPOLOGY: ContractTopology = 'v2'

/** The interaction topology of the configured contract, from `NEXT_PUBLIC_CONTRACT_TOPOLOGY`. */
export function getContractTopology(): ContractTopology {
  const configured = process.env.NEXT_PUBLIC_CONTRACT_TOPOLOGY
  if (configured === 'v2' || configured === 'v3' || configured === 'v4' || configured === 'v5' || configured === 'v6') {
    return configured
  }
  return DEFAULT_CONTRACT_TOPOLOGY
}

// Devnet wiring. A devnet has no public masternode discovery, so the DAPI
// addresses are supplied explicitly and the trusted context (quorum public keys)
// is prefetched from a quorum service. `EvoSDK.devnetTrusted` defaults that to
// `https://quorums.<devnetName>.networks.dash.org`, which does not exist for
// moutai — point NEXT_PUBLIC_QUORUM_URL at a service exposing /quorums,
// /previous and /masternodes instead.
export const DEVNET_NAME = process.env.NEXT_PUBLIC_DEVNET_NAME || 'moutai'
export const DEVNET_QUORUM_URL = process.env.NEXT_PUBLIC_QUORUM_URL || ''
export const DAPI_ADDRESSES: readonly string[] = (process.env.NEXT_PUBLIC_DAPI_ADDRESSES || '')
  .split(',')
  .map((address) => address.trim())
  .filter(Boolean)

// Insight API configuration for transaction detection
export const INSIGHT_API_URLS = {
  testnet: 'https://insight.testnet.networks.dash.org/insight-api',
  mainnet: 'https://insight.dash.org/insight-api',
  devnet: process.env.NEXT_PUBLIC_INSIGHT_API_URL || 'https://insight.moutai.networks.dash.org/insight-api',
} as const

export const INSIGHT_API_CONFIG = {
  pollIntervalMs: 3000,
  timeoutMs: 120000
} as const

// Document types of the social contract. Avatars live on the profile document,
// direct messages on the DM contract, and notifications are derived client-side.
export const DOCUMENT_TYPES = {
  PROFILE: 'profile',
  POST: 'post',
  REPLY: 'reply',
  LIKE: 'like',
  FOLLOW: 'follow',
  BOOKMARK: 'bookmark',
  BLOCK: 'block',
  BLOCK_FILTER: 'blockFilter',
  BLOCK_FOLLOW: 'blockFollow',
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
  ITEM_REVIEW: 'itemReview',
  SAVED_ADDRESS: 'savedAddress'
} as const

// DPNS
export const DPNS_DOCUMENT_TYPE = 'domain'
