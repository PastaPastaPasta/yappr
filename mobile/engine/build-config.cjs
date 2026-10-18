// Build-time only. Release pins and validation are identical to the web loader.
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { parseEnv } = require('node:util')
const { loadReleaseEnv } = require('../../scripts/release-config.cjs')

const VARIANTS = {
  testnet: { envFile: '.env.testnet', basePath: '' },
  'staging-testnet': { envFile: '.env.staging', basePath: '/staging' },
  devnet: { envFile: '.env.devnet', basePath: '/devnet' },
}

/** @returns {{env: Record<string, string>, storageEpoch: string, webBasePath: string, networkKey: string}} */
function variantConfig(root, variant) {
  const selected = VARIANTS[variant]
  if (!selected) throw new Error(`Unknown engine variant ${variant}; expected ${Object.keys(VARIANTS).join(', ')}`)
  const file = path.join(root, selected.envFile)
  const configured = variant === 'devnet'
    ? parseEnv(readFileSync(file, 'utf8'))
    : loadReleaseEnv(file, {})
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

module.exports = { VARIANTS, variantConfig }
