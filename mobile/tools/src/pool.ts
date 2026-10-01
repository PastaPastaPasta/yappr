/**
 * The sakura identity pool (ENGINE.md §12.3): the ops `identities.json`, found
 * through `YAPPR_SAKURA_IDENTITIES`. It is never copied into the repo and its
 * key material is never printed: errors name key ids and field names only.
 */
import { readFileSync } from 'node:fs'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decodeYapprIdentityId } from '../../../vendor/platform-auth/src/key-exchange/yappr-protocol'

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
}

export interface Pool {
  /** The pool's network tag, e.g. `devnet-sakura`. */
  network: string
  personas: PoolIdentityEntry[]
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
  return parsePool(parsed)
}

export function parsePool(value: unknown): Pool {
  const root = value as { network?: unknown; identities?: unknown }
  if (!root || typeof root !== 'object' || !Array.isArray(root.identities)) {
    throw new Error('Pool file has no identities[] array')
  }
  return {
    network: typeof root.network === 'string' ? root.network : '',
    personas: root.identities as PoolIdentityEntry[],
  }
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

  return {
    personaIdx,
    identityId: entry.identityId,
    identityIdBytes,
    key(role) {
      let key = keys.get(role)
      if (!key) {
        key = resolveKey(role)
        keys.set(role, key)
      }
      return key
    },
  }
}
