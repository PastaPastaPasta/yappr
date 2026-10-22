// Build-time only. Release pins and validation are identical to the web loader.
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { parseEnv } = require('node:util')
const { loadReleaseEnv } = require('../../scripts/release-config.cjs')

const VARIANTS = {
  testnet: { envFile: '.env.testnet', basePath: '' },
  // D20: /staging serves the same release set; only the web handoff prefix differs.
  'staging-testnet': { envFile: '.env.testnet', basePath: '/staging' },
  devnet: { envFile: '.env.devnet', basePath: '/devnet' },
}

/**
 * The archival and moderation-log flags (docs/ARCHIVE_FRONTEND.md). Only a
 * non-release variant (devnet) may carry them, and they reach its bundle like
 * any other NEXT_PUBLIC key. The official apps (testnet, staging-testnet) must
 * have both off. This check is the engine's own and does not rely on the web
 * loader's, so it still holds if that one changes.
 */
const MODERATION_FLAGS = ['NEXT_PUBLIC_MODERATION_VIEW', 'NEXT_PUBLIC_MODERATION_LOG']

/** As the web check (scripts/release-config.cjs): the view flag must be unset or empty, the log flag unset, empty or `0`. */
const OFF_VALUES = {
  NEXT_PUBLIC_MODERATION_VIEW: [undefined, ''],
  NEXT_PUBLIC_MODERATION_LOG: [undefined, '', '0'],
}

function assertModerationFlagsOff(variant, env) {
  const set = MODERATION_FLAGS.filter(key => !OFF_VALUES[key].includes(env[key]))
  if (set.length) {
    throw new Error(`The ${variant} engine is an official release build and must not enable ${set.join(', ')} (archival and moderation-log builds are not shipped by the official apps).`)
  }
}

/** @returns {{env: Record<string, string>, storageEpoch: string, webBasePath: string, networkKey: string}} */
function variantConfig(root, variant) {
  const selected = VARIANTS[variant]
  if (!selected) throw new Error(`Unknown engine variant ${variant}; expected ${Object.keys(VARIANTS).join(', ')}`)
  const file = path.join(root, selected.envFile)
  const configured = variant === 'devnet'
    ? parseEnv(readFileSync(file, 'utf8'))
    : loadReleaseEnv(file, {})
  if (variant !== 'devnet') assertModerationFlagsOff(variant, configured)
  const network = variant === 'devnet' ? 'devnet' : 'testnet'
  if (configured.NEXT_PUBLIC_NETWORK !== network) throw new Error(`${selected.envFile} must select ${network}`)
  if (configured.BASE_PATH !== undefined && configured.BASE_PATH !== selected.basePath) {
    throw new Error(`${selected.envFile} BASE_PATH must match ${selected.basePath || 'the root deployment'}`)
  }
  const env = Object.fromEntries(Object.entries(configured).filter(([key]) => key.startsWith('NEXT_PUBLIC_')))
  const storageEpoch = configured.STORAGE_EPOCH ?? ''
  const networkKey = network === 'devnet'
    ? `devnet-${env.NEXT_PUBLIC_DEVNET_NAME ?? 'unnamed'}`
    : [network, storageEpoch, selected.basePath].filter(Boolean).join('-').replace(/[^\w.-]/g, '.')
  return {
    storageEpoch,
    webBasePath: selected.basePath,
    networkKey,
    // The native host namespaces storage and recognises unscoped session/secret keys.
    env: { ...env, NODE_ENV: 'production', NEXT_PUBLIC_BASE_PATH: '', NEXT_PUBLIC_STORAGE_SCOPE: '' },
  }
}

module.exports = { VARIANTS, MODERATION_FLAGS, assertModerationFlagsOff, variantConfig }
