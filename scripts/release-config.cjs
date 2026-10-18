// Build-only validation. Importing application constants must remain safe in
// Vitest, next dev and the mobile engine; next.config.js calls this at build time.
const bs58 = require('bs58').default

const CONTRACT_KEYS = [
  'NEXT_PUBLIC_YAPPR_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID',
  'NEXT_PUBLIC_POLLR_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_PASSKEY_VAULT_CONTRACT_ID',
]
const IDENTIFIER_KEYS = [
  ...CONTRACT_KEYS,
  'NEXT_PUBLIC_DPNS_CONTRACT_ID',
  'NEXT_PUBLIC_TOKEN_HISTORY_CONTRACT_ID',
  'NEXT_PUBLIC_YAPP_TOKEN_AUTHORITY_ID',
  'NEXT_PUBLIC_YAPP_TOKEN_ID',
  'NEXT_PUBLIC_APP_CONNECT_APP_ID',
  'NEXT_PUBLIC_APP_CONNECT_GROUP_ID',
  'NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER',
]
const RELEASE_VALUES = {
  NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v17',
  NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v10',
  NEXT_PUBLIC_BLOG_TOPOLOGY: 'v9',
  NEXT_PUBLIC_POLLR_TOPOLOGY: 'v8',
  NEXT_PUBLIC_DM_TOPOLOGY: 'v5',
  NEXT_PUBLIC_PROFILE_TOPOLOGY: 'v2',
  NEXT_PUBLIC_LOGIN_PROTOCOL: 'app-connect',
  NEXT_PUBLIC_FEATURE_STORE: 'beta',
  NEXT_PUBLIC_FEATURE_BLOG: 'beta',
  NEXT_PUBLIC_FEATURE_CREDIT_TIPS: 'off',
}
const EMPTY_KEYS = [
  'NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID',
  'NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_VAULT_CONTRACT_ID',
  'NEXT_PUBLIC_YAPPR_AUTH_VAULT_CONTRACT_ID',
  'NEXT_PUBLIC_ENCRYPTED_KEY_BACKUP_CONTRACT_ID',
  'NEXT_PUBLIC_DEVNET_NAME',
  'NEXT_PUBLIC_DAPI_ADDRESSES',
  'NEXT_PUBLIC_QUORUM_URL',
  'NEXT_PUBLIC_INSIGHT_API_URL',
]
const STORAGE_EPOCH_PATTERN = /^[a-zA-Z0-9_-]+$/

function isIdentifier(value) {
  if (typeof value !== 'string' || value !== value.trim()) return false
  try {
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}

function assertReleaseConfig(env) {
  if (env.NEXT_PUBLIC_RELEASE === undefined || env.NEXT_PUBLIC_RELEASE === '0') return
  const errors = []
  if (env.NEXT_PUBLIC_RELEASE !== '1') errors.push('NEXT_PUBLIC_RELEASE must be 0 or 1')
  if (!['testnet', 'mainnet'].includes(env.NEXT_PUBLIC_NETWORK)) {
    errors.push('NEXT_PUBLIC_NETWORK must be testnet or mainnet')
  }
  for (const key of IDENTIFIER_KEYS) {
    if (!isIdentifier(env[key])) errors.push(`${key} must be a base58 identifier encoding 32 bytes`)
  }
  for (const [key, value] of Object.entries(RELEASE_VALUES)) {
    if (env[key] !== value) errors.push(`${key} must be ${value}`)
  }
  for (const key of EMPTY_KEYS) {
    if (env[key] !== '') errors.push(`${key} must be explicitly empty (retired or devnet-only)`)
  }
  if (!STORAGE_EPOCH_PATTERN.test(env.STORAGE_EPOCH ?? '')) errors.push('STORAGE_EPOCH must be a non-empty scope containing only letters, digits, _ or -')

  const members = new Set()
  const entries = (env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS ?? '').split(',')
  for (const entry of entries) {
    const [id, version, extra] = entry.split(':')
    if (!isIdentifier(id) || !/^[1-9][0-9]*$/.test(version ?? '') ||
        !Number.isSafeInteger(Number(version)) || extra !== undefined) {
      errors.push('NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS must contain explicit id:version pins (positive safe integers)')
      break
    }
    if (members.has(id)) errors.push(`NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS has duplicate member ${id}`)
    members.add(id)
  }
  // Profile and system contracts are separately granted, not group members.
  const expected = ['NEXT_PUBLIC_APP_CONNECT_APP_ID', ...CONTRACT_KEYS.filter(key => key !== 'NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID')]
  for (const key of expected) {
    if (isIdentifier(env[key]) && !members.has(env[key])) errors.push(`NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS must pin ${key}`)
  }
  const expectedIds = new Set(expected.map(key => env[key]))
  for (const id of members) {
    if (!expectedIds.has(id)) errors.push(`NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS has unexpected member ${id}`)
  }
  const contractIds = [...CONTRACT_KEYS, 'NEXT_PUBLIC_APP_CONNECT_APP_ID'].map(key => env[key]).filter(isIdentifier)
  if (new Set(contractIds).size !== contractIds.length) errors.push('Release contract ids must be distinct')
  if (errors.length) {
    throw new Error(`Release configuration is incomplete or malformed:\n - ${errors.join('\n - ')}\nSee docs/TESTNET_DEPLOY.md; defaults are forbidden in release mode.`)
  }
}

// Empty until the cut-over env opts in. Preserve today's root and subpath keys.
function storageScope(basePath, epoch = '') {
  if (epoch && !STORAGE_EPOCH_PATTERN.test(epoch)) throw new Error('STORAGE_EPOCH must contain only letters, digits, _ or -')
  return [epoch, basePath.replace(/^\//, '')].filter(Boolean).join(':')
}

module.exports = { assertReleaseConfig, storageScope }
