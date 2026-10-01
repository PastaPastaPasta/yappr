/**
 * Network wiring for the live responder, read from ONE variant env file: the
 * repo's `.env.devnet` by default, or `--env-file` / `YAPPR_ENV_FILE`. Values
 * missing from that file are errors, never a fallback to another file, so a
 * stale `.env.devnet` cannot silently point the responder at a dead devnet.
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { decodeYapprContractId } from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import type { Pool } from './pool'

export const ENV_FILE_VAR = 'YAPPR_ENV_FILE'
const KEY_EXCHANGE_CONTRACT_VAR = 'NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID'

export interface DevnetConfig {
  devnetName: string
  addresses: string[]
  quorumUrl: string | null
}

export interface ResponderConfig {
  envFile: string
  devnet: DevnetConfig
  /** Unset until the sakura Yappr contracts are published (W-SAKURA). */
  keyExchangeContractId: string | undefined
}

export function loadConfig(envFile: string): ResponderConfig {
  if (!existsSync(envFile)) throw new Error(`Env file not found: ${envFile}`)
  const env = parseEnv(readFileSync(envFile, 'utf8')) as Record<string, string | undefined>
  const value = (name: string) => env[name]?.trim() || undefined

  const network = value('NEXT_PUBLIC_NETWORK')
  if (network !== 'devnet') {
    throw new Error(`${envFile} sets NEXT_PUBLIC_NETWORK=${network ?? '(unset)'}; the responder only serves devnet (sakura)`)
  }
  const devnetName = value('NEXT_PUBLIC_DEVNET_NAME')
  if (!devnetName) throw new Error(`${envFile} has no NEXT_PUBLIC_DEVNET_NAME`)
  const addresses = (value('NEXT_PUBLIC_DAPI_ADDRESSES') ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => (address.includes('://') ? address : `https://${address}`))
  if (addresses.length === 0) throw new Error(`${envFile} has no NEXT_PUBLIC_DAPI_ADDRESSES`)

  const keyExchangeContractId = value(KEY_EXCHANGE_CONTRACT_VAR)
  if (keyExchangeContractId !== undefined && !isIdentifier(keyExchangeContractId)) {
    throw new Error(`${envFile}: ${KEY_EXCHANGE_CONTRACT_VAR} is not a base58 identifier`)
  }

  return {
    envFile,
    devnet: { devnetName, addresses, quorumUrl: value('NEXT_PUBLIC_QUORUM_URL') ?? null },
    keyExchangeContractId,
  }
}

/** The pool is tagged with its devnet (`devnet-sakura`); the env file must target the same one. */
export function requirePoolMatchesNetwork(pool: Pool, config: ResponderConfig): void {
  const expected = `devnet-${config.devnet.devnetName}`
  if (pool.network !== expected) {
    throw new Error(
      `The pool is for ${pool.network || '(untagged)'} but ${config.envFile} targets ${expected}. ` +
        `Pass --env-file (or ${ENV_FILE_VAR}) for the pool's devnet.`,
    )
  }
}

export function requireKeyExchangeContract(config: ResponderConfig): string {
  if (!config.keyExchangeContractId) {
    throw new Error(
      `${KEY_EXCHANGE_CONTRACT_VAR} is unset in ${config.envFile}: the key-exchange contract is not published on ` +
        `devnet ${config.devnet.devnetName} yet (W-SAKURA), so dash-key: requests cannot be answered. dash-st: still works.`,
    )
  }
  return config.keyExchangeContractId
}

function isIdentifier(value: string): boolean {
  try {
    decodeYapprContractId(value)
    return true
  } catch {
    return false
  }
}
