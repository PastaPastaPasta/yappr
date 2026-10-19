/**
 * The sakura identity pool (ENGINE.md §12.3): the ops `identities.json`, found
 * through `YAPPR_SAKURA_IDENTITIES`. It is never copied into the repo and its
 * key material is never printed: errors name key ids and field names only.
 *
 * A pool may name a recovery phrase (`mnemonicFile`, relative to the pool
 * file) and give personas their DIP-13 `identityIndex` under it: those
 * personas' App Connect keys are the ones a DashPay build restoring the phrase
 * derives (app-connect/derive.ts). The phrase is read, never printed.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { WasmSdk } from '@dashevo/evo-sdk'
import { decodeYapprIdentityId } from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'
import { dip13Wallet, identityAuthKeyPath, normalizeRecoveryPhrase, type Dip13Network, type Dip13Wallet } from '../../../lib/crypto/dip13'
import { dip13ConnectKeys, legacyConnectKeys, type ConnectKeys } from './app-connect/derive'

export const POOL_ENV_VAR = 'YAPPR_SAKURA_IDENTITIES'

/** The pool's fixed key layout: keyId → purpose and level. */
const POOL_KEYS = {
  master: { keyId: 0, purpose: 'authentication', securityLevel: 'master' },
  critical: { keyId: 1, purpose: 'authentication', securityLevel: 'critical' },
  high: { keyId: 2, purpose: 'authentication', securityLevel: 'high' },
} as const

type PoolKeyRole = keyof typeof POOL_KEYS

interface PoolKeyEntry {
  keyId: number
  purpose: string
  securityLevel: string
  privateKeyHex: string
  publicKeyHex: string
}

interface PoolIdentityEntry {
  personaIdx: number
  identityId: string
  identityKeys: PoolKeyEntry[]
  /** DIP-13 identity index under the pool's recovery phrase (seeded pools only). */
  identityIndex?: number
}

export interface Pool {
  /** The pool's network tag, e.g. `devnet-sakura`. */
  network: string
  personas: PoolIdentityEntry[]
  /** The recovery phrase seeded personas derive from (normalized), when the pool names one. */
  mnemonic?: string
}

export interface PersonaKey {
  keyId: number
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export interface Persona {
  personaIdx: number
  identityId: string
  identityIdBytes: Uint8Array
  /** Parsed and checked once per persona selection. */
  key(role: PoolKeyRole): PersonaKey
  /** Its App Connect keys: DIP-13 for a seeded persona, the legacy scheme otherwise. */
  connect: ConnectKeys
}

export function loadPool(path: string | undefined = process.env[POOL_ENV_VAR]): Pool {
  if (!path) {
    throw new Error(`${POOL_ENV_VAR} is not set: point it at the sakura ops identities.json (ENGINE.md §12.3)`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // The message of a JSON syntax error can quote file content: report the
    // error class only.
    throw new Error(`Cannot read the pool at ${path} (${error instanceof Error ? error.name : 'error'})`)
  }
  const mnemonicFile = (parsed as { mnemonicFile?: unknown } | null)?.mnemonicFile
  let mnemonic: string | undefined
  if (typeof mnemonicFile === 'string') {
    const mnemonicPath = resolve(dirname(path), mnemonicFile)
    try {
      mnemonic = normalizeRecoveryPhrase(readFileSync(mnemonicPath, 'utf8'))
    } catch (error) {
      throw new Error(`Cannot read the pool's recovery phrase at ${mnemonicPath} (${error instanceof Error ? error.name : 'error'})`)
    }
  }
  return parsePool(parsed, mnemonic)
}

export function parsePool(value: unknown, mnemonic?: string): Pool {
  const root = value as { network?: unknown; identities?: unknown }
  if (!root || typeof root !== 'object' || !Array.isArray(root.identities)) {
    throw new Error('Pool file has no identities[] array')
  }
  return {
    network: typeof root.network === 'string' ? root.network : '',
    personas: root.identities as PoolIdentityEntry[],
    ...(mnemonic ? { mnemonic } : {}),
  }
}

/** The DIP-13 network a pool tag derives on: coin 5' for mainnet, 1' for testnet and devnets. */
function poolDip13Network(tag: string): Dip13Network {
  return tag === 'mainnet' ? 'mainnet' : 'testnet'
}

const wallets = new WeakMap<Pool, Dip13Wallet>()

/** The pool's phrase, opened once (`ensureInitialized` from evo-sdk must have run). */
function poolWallet(pool: Pool): Dip13Wallet {
  let wallet = wallets.get(pool)
  if (!wallet) {
    if (!pool.mnemonic) throw new Error('The pool names no recovery phrase')
    try {
      wallet = dip13Wallet(WasmSdk, pool.mnemonic, poolDip13Network(pool.network))
    } catch {
      throw new Error('The pool\'s recovery phrase is not a valid BIP-39 phrase')
    }
    wallets.set(pool, wallet)
  }
  return wallet
}

export function selectPersona(pool: Pool, personaIdx: number): Persona {
  const entry = pool.personas.find((candidate) => candidate.personaIdx === personaIdx)
  if (!entry) throw new Error(`Persona ${personaIdx} is not in the pool`)
  if (typeof entry.identityId !== 'string' || !Array.isArray(entry.identityKeys)) {
    throw new Error(`Persona ${personaIdx} has no identityId or identityKeys`)
  }
  const identityIdBytes = decodeYapprIdentityId(entry.identityId)
  const keys = new Map<PoolKeyRole, PersonaKey>()

  function resolveKey(role: PoolKeyRole): PersonaKey {
    const expected = POOL_KEYS[role]
    const found = entry!.identityKeys.find((key) => key.keyId === expected.keyId)
    if (!found || found.purpose !== expected.purpose || found.securityLevel !== expected.securityLevel) {
      throw new Error(`Persona ${personaIdx} keyId ${expected.keyId} is not ${expected.purpose}/${expected.securityLevel}`)
    }
    // Validated first so no error can echo key material.
    if (typeof found.privateKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(found.privateKeyHex)) {
      throw new Error(`Persona ${personaIdx} keyId ${expected.keyId} privateKeyHex is not 32 bytes of hex`)
    }
    const privateKey = hexToBytes(found.privateKeyHex)
    const publicKey = secp256k1.getPublicKey(privateKey, true)
    if (bytesToHex(publicKey) !== String(found.publicKeyHex).toLowerCase()) {
      throw new Error(`Persona ${personaIdx} keyId ${expected.keyId}: private key does not match publicKeyHex`)
    }
    return { keyId: expected.keyId, privateKey, publicKey }
  }

  function key(role: PoolKeyRole): PersonaKey {
    let found = keys.get(role)
    if (!found) {
      found = resolveKey(role)
      keys.set(role, found)
    }
    return found
  }

  return {
    personaIdx,
    identityId: entry.identityId,
    identityIdBytes,
    key,
    connect: seededConnectKeys(pool, entry, identityIdBytes) ?? legacyConnectKeys(() => key('critical').privateKey, identityIdBytes),
  }
}

/**
 * DIP-13 keys for a persona the pool's phrase holds. Checked once: the
 * persona's MASTER key must be the phrase's key 0 at its identity index, so a
 * wrong index fails here instead of registering keys of another identity.
 */
function seededConnectKeys(pool: Pool, entry: PoolIdentityEntry, identityIdBytes: Uint8Array): ConnectKeys | undefined {
  if (entry.identityIndex === undefined) return undefined
  if (!Number.isInteger(entry.identityIndex) || entry.identityIndex < 0) {
    throw new Error(`Persona ${entry.personaIdx} identityIndex is not a non-negative integer`)
  }
  const network = poolDip13Network(pool.network)
  const wallet = poolWallet(pool)
  const master = entry.identityKeys.find((candidate) => candidate.keyId === POOL_KEYS.master.keyId)
  const derived = wallet.derive(identityAuthKeyPath(network, entry.identityIndex, POOL_KEYS.master.keyId))
  derived.privateKey.fill(0)
  if (!master || bytesToHex(derived.publicKey) !== String(master.publicKeyHex).toLowerCase()) {
    throw new Error(`Persona ${entry.personaIdx}: the pool's recovery phrase does not hold its MASTER key at identity index ${entry.identityIndex}`)
  }
  return dip13ConnectKeys(wallet, network, identityIdBytes)
}
