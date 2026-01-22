/**
 * Application constants
 */

// Contract IDs
export const YAPPR_CONTRACT_ID = '7dYxnA4V3e5BwV7pGJmQAFjUKbnty6ZvqwbPVBXBUe29' // Testnet - v6 with privateFeedRekey canBeDeleted fix
export const YAPPR_PROFILE_CONTRACT_ID = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe' // Unified profile contract
export const YAPPR_DM_CONTRACT_ID = 'J7MP9YU1aEGNAe7bjB45XdrjDLBsevFLPK1t1YwFS4ck' // Testnet - DM contract v3 (simplified readReceipt)
// YAPPR_BLOCK_CONTRACT_ID removed - block, blockFilter, blockFollow document types now in YAPPR_CONTRACT_ID
export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec' // Testnet
export const ENCRYPTED_KEY_BACKUP_CONTRACT_ID = '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts' // Testnet - Encrypted key backup contract (1B max iterations)
// HASHTAG_CONTRACT_ID and MENTION_CONTRACT_ID removed - these document types are now in YAPPR_CONTRACT_ID
export const DASHPAY_CONTRACT_ID = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7' // Dash Pay contacts contract

// Network configuration
export const DEFAULT_NETWORK = 'testnet'

// Document types
export const DOCUMENT_TYPES = {
  PROFILE: 'profile',
  AVATAR: 'avatar',
  POST: 'post',
  LIKE: 'like',
  REPOST: 'repost',
  FOLLOW: 'follow',
  BOOKMARK: 'bookmark',
  LIST: 'list',
  LIST_MEMBER: 'listMember',
  BLOCK: 'block',
  BLOCK_FILTER: 'blockFilter',
  BLOCK_FOLLOW: 'blockFollow',
  MUTE: 'mute',
  DIRECT_MESSAGE: 'directMessage',
  NOTIFICATION: 'notification',
  ENCRYPTED_KEY_BACKUP: 'encryptedKeyBackup',
  POST_HASHTAG: 'postHashtag',
  POST_MENTION: 'postMention',
  // Private feed document types
  FOLLOW_REQUEST: 'followRequest',
  PRIVATE_FEED_GRANT: 'privateFeedGrant',
  PRIVATE_FEED_REKEY: 'privateFeedRekey',
  PRIVATE_FEED_STATE: 'privateFeedState'
} as const

// DPNS
export const DPNS_DOCUMENT_TYPE = 'domain'