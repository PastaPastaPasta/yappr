// Build-only validation. Importing application constants must remain safe in
// Vitest, next dev and the mobile engine; next.config.js calls this at build time.
const bs58 = require('bs58').default
const { readFileSync } = require('node:fs')
const { parseEnv } = require('node:util')

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
// The archival ("uncensored") frontend flags (docs/ARCHIVE_FRONTEND.md). yap.pr
// and the official apps never enable them: a release build refuses any value
// that is not "off". The view flag has no off value but unset or empty; the log
// flag also accepts an explicit 0, the only other value lib/moderation-view.ts
// reads as off.
const ARCHIVE_FLAGS = {
  NEXT_PUBLIC_MODERATION_VIEW: [undefined, ''],
  NEXT_PUBLIC_MODERATION_LOG: [undefined, '', '0'],
}

/** The archival flags in `env` that are on (or set to anything but an off value), as error lines. */
function archiveFlagErrors(env, where) {
  return Object.entries(ARCHIVE_FLAGS)
    .filter(([key, off]) => !off.includes(env[key]))
    .map(([key]) => `${key} must be unset or empty in a release build (${where}); it turns the build into an archival frontend, see docs/ARCHIVE_FRONTEND.md`)
}

/** The D36 rehearsal's App Connect group and its owner (TESTNET_REHEARSAL_SET in app-connect-set.mjs). */
const REHEARSAL_GROUP = { id: 'ePtSmVdSqxJESyegxxRGcS7CwznyWSAn2FULYow8Dks', owner: 'At8Xd9BpbVbzxvrna2smE3GbACeTaxf7YGUEwn7FHUZF' }

/**
 * The subpath QA builds served from the staging branch on the D36 testnet
 * rehearsal set (maker At8Xd9…, group ePtSmVdS…) instead of .env.testnet's.
 * Each builds only from its own env file (build-release.mjs sets
 * YAPPR_QA_BUILD to its name), only at its own base path, only on testnet,
 * only for the rehearsal maker's group, with its own contract snapshot in
 * place of bundled/testnet.json (next.config.js). It differs from a release
 * build only as listed here:
 *   - `values`: the topologies it serves instead of RELEASE_VALUES';
 *   - `unusedMembers`: group members it must pin, since App Connect checks the
 *     group's members exactly, but never reads, so its snapshot leaves them out.
 * The group holds social v17, blog v9 and storefront v10 (2026-10-18) and the
 * "hide, don't delete" social v18, blog v10 and storefront v11 appended after
 * them (docs/SOCIAL_V18.md): /staging-old serves the first, /beta the second.
 */
const REHEARSAL_V17 = ['AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9', 'HAEBfyZP9ECiX8crakwRSdjvVDkeJKPbG8Zs4YaRQrRa', '9Z5W23rzbMdwPBEn9e5pKKz6rmRVAkoCYDTWaqzLpWqS']
const REHEARSAL_V18 = ['5Kucw9g9TsiSRXbns2mPumXKVkYW7jwVrTdjFuFhMEwU', '9mMb6qGmPA8mjxkk7wdUE5aotEVpY1hJwPJZqPPdUdPc', 'THxfq5ZinV2U5gmPZ8dTwqh11sCtGF53a2a87qHErNR']
const QA_BUILDS = {
  'staging-old': {
    envFile: '.env.staging-old', basePath: '/staging-old', snapshot: 'lib/contracts/snapshots/testnet-staging-old.json',
    values: {}, unusedMembers: REHEARSAL_V18,
  },
  'beta': {
    envFile: '.env.beta', basePath: '/beta', snapshot: 'lib/contracts/snapshots/testnet-beta.json',
    values: { NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v18', NEXT_PUBLIC_BLOG_TOPOLOGY: 'v10', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v11' },
    unusedMembers: REHEARSAL_V17,
  },
}

/** The QA build `env` names (YAPPR_QA_BUILD), null for a release build; throws on an unknown name. */
function qaBuildOf(env) {
  const name = env.YAPPR_QA_BUILD
  if (name === undefined || name === '') return null
  if (!Object.hasOwn(QA_BUILDS, name)) throw new Error(`YAPPR_QA_BUILD must be one of ${Object.keys(QA_BUILDS).join(', ')} (got "${name}")`)
  return { name, ...QA_BUILDS[name] }
}

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
  const qa = qaBuildOf(env)
  if (env.NEXT_PUBLIC_RELEASE !== '1') errors.push('NEXT_PUBLIC_RELEASE must be 0 or 1')
  const qaPath = Object.entries(QA_BUILDS).find(([, build]) => build.basePath === env.BASE_PATH)
  if (!qa && qaPath) errors.push(`BASE_PATH=${env.BASE_PATH} serves only the ${qaPath[0]} QA build (npm run build:${qaPath[0]})`)
  if (qa) {
    if (env.BASE_PATH !== qa.basePath) errors.push(`the ${qa.name} build is served only at BASE_PATH=${qa.basePath}`)
    if (env.NEXT_PUBLIC_NETWORK !== 'testnet') errors.push(`the ${qa.name} build is testnet only`)
    if (env.NEXT_PUBLIC_APP_CONNECT_GROUP_ID !== REHEARSAL_GROUP.id || env.NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER !== REHEARSAL_GROUP.owner) {
      errors.push(`the ${qa.name} build serves only the rehearsal group ${REHEARSAL_GROUP.id} (owner ${REHEARSAL_GROUP.owner})`)
    }
  }
  if (!['testnet', 'mainnet'].includes(env.NEXT_PUBLIC_NETWORK)) {
    errors.push('NEXT_PUBLIC_NETWORK must be testnet or mainnet')
  }
  for (const key of IDENTIFIER_KEYS) {
    if (!isIdentifier(env[key])) errors.push(`${key} must be a base58 identifier encoding 32 bytes`)
  }
  for (const [key, value] of Object.entries({ ...RELEASE_VALUES, ...qa?.values })) {
    if (env[key] !== value) errors.push(`${key} must be ${value}`)
  }
  for (const key of EMPTY_KEYS) {
    if (env[key] !== '') errors.push(`${key} must be explicitly empty (retired or devnet-only)`)
  }
  errors.push(...archiveFlagErrors(env, 'the effective environment'))
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
  for (const id of qa?.unusedMembers ?? []) {
    if (expectedIds.has(id)) errors.push(`NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: ${id} is unused by the ${qa.name} build, so no contract variable may name it`)
    else if (!members.has(id)) errors.push(`NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS must pin ${id}, a member of the group the ${qa.name} build does not read`)
    expectedIds.add(id)
  }
  for (const id of members) {
    if (!expectedIds.has(id)) errors.push(`NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS has unexpected member ${id}`)
  }
  const contractIds = [...CONTRACT_KEYS, 'NEXT_PUBLIC_APP_CONNECT_APP_ID'].map(key => env[key]).filter(isIdentifier)
  if (new Set(contractIds).size !== contractIds.length) errors.push('Release contract ids must be distinct')
  if (errors.length) {
    throw new Error(`Release configuration is incomplete or malformed:\n - ${errors.join('\n - ')}\nSee docs/TESTNET_DEPLOY.md; defaults are forbidden in release mode.`)
  }
}

// Builds without an epoch (/testing, /devnet) keep their unprefixed subpath scope.
function storageScope(basePath, epoch = '') {
  if (epoch && !STORAGE_EPOCH_PATTERN.test(epoch)) throw new Error('STORAGE_EPOCH must contain only letters, digits, _ or -')
  return [epoch, basePath.replace(/^\//, '')].filter(Boolean).join(':')
}

/** A QA build's snapshot must contain exactly the pinned contracts it reads, plus the profile and system contracts. */
function assertSnapshotPins(snapshot, env) {
  const unused = new Set(qaBuildOf(env)?.unusedMembers ?? [])
  const pins = env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS.split(',').map(pin => pin.split(':')).filter(([id]) => !unused.has(id))
  const expectedIds = new Set([...pins.map(([id]) => id), env.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID,
    env.NEXT_PUBLIC_DPNS_CONTRACT_ID, env.NEXT_PUBLIC_TOKEN_HISTORY_CONTRACT_ID])
  if (snapshot.network !== 'testnet' || Object.keys(snapshot.contracts).length !== expectedIds.size ||
      Object.keys(snapshot.contracts).some(id => !expectedIds.has(id)) ||
      pins.some(([id, version]) => snapshot.contracts[id]?.version !== Number(version))) {
    throw new Error(`The ${env.BASE_PATH} snapshot must match the exact contract pins of its env file`)
  }
}

/**
 * Authoritative public release pins, shared by web and native builders. A QA
 * build names itself (`qaBuild`, a QA_BUILDS key) and must load its own file;
 * neither the file nor the ambient environment can name one.
 */
function loadReleaseEnv(file, ambient = process.env, qaBuild = null) {
  let configured
  try {
    configured = parseEnv(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot load ${file}: ${error.message}\nComplete the public release configuration before building; see docs/TESTNET_DEPLOY.md.`)
  }
  // Ambient NEXT_PUBLIC_* values are dropped below, which would also hide an
  // archival flag set in the shell. Refuse it out loud instead, so nobody ships
  // a build they believe is archival (or, worse, expects the flag to apply).
  const ambientFlags = archiveFlagErrors(ambient, 'the ambient environment')
  if (ambientFlags.length) throw new Error(`Release configuration is incomplete or malformed:\n - ${ambientFlags.join('\n - ')}`)
  const env = Object.fromEntries(Object.entries(ambient).filter(([key]) =>
    !key.startsWith('NEXT_PUBLIC_') && key !== 'STORAGE_EPOCH' && key !== 'YAPPR_QA_BUILD'))
  if (Object.hasOwn(configured, 'YAPPR_QA_BUILD')) throw new Error(`${file} may not set YAPPR_QA_BUILD; the build entry point names its QA build`)
  Object.assign(env, configured, { NEXT_PUBLIC_RELEASE: '1' })
  if (qaBuild !== null) {
    if (!Object.hasOwn(QA_BUILDS, qaBuild) || !file.endsWith(`/${QA_BUILDS[qaBuild].envFile}`)) throw new Error(`the ${qaBuild} build loads only ${QA_BUILDS[qaBuild]?.envFile ?? 'its own env file'}`)
    env.YAPPR_QA_BUILD = qaBuild
  }
  assertReleaseConfig(env)
  // Pin the flags to an explicit "off" in the environment `next build` inherits.
  // Next loads .env.local, .env.production and .env for any variable that is
  // UNSET (and never overrides one that is set), so an unset flag could still be
  // supplied by a stray file; next.config.js re-checks after those files load.
  for (const key of Object.keys(ARCHIVE_FLAGS)) env[key] ??= ''
  return env
}

module.exports = { assertReleaseConfig, storageScope, loadReleaseEnv, assertSnapshotPins, qaBuildOf, QA_BUILDS, REHEARSAL_GROUP }
