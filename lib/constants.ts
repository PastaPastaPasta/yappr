/**
 * Application constants
 */

// Contract IDs
export const YAPPR_CONTRACT_ID = 'AyWK6nDVfb8d1ZmkM5MmZZrThbUyWyso1aMeGuuVSfxf' // Testnet
export const YAPPR_DM_CONTRACT_ID = '3PWMM9NbSf84QcPy1N69Jyz7xtBFUEHNNTLcGrf6sq7M' // Testnet - DM contract v2.1 (10-byte conversationId)
export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec' // Testnet
export const ENCRYPTED_KEY_BACKUP_CONTRACT_ID = '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts' // Testnet - Encrypted key backup contract (1B max iterations)
export const HASHTAG_CONTRACT_ID = '82kvJWPsaMouoQjKYeqmkm6eYu5UEJquWrGzJFuiSErs' // Testnet - Hashtag tracking contract (v2 with byTime index)

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
  MUTE: 'mute',
  DIRECT_MESSAGE: 'directMessage',
  NOTIFICATION: 'notification',
  ENCRYPTED_KEY_BACKUP: 'encryptedKeyBackup',
  POST_HASHTAG: 'postHashtag'
} as const

// DPNS
export const DPNS_DOCUMENT_TYPE = 'domain'