/**
 * The sakura identity pool for the engine's write suite (ENGINE.md §12.3).
 *
 * The pool is the sakura ops `identities.json`, found through
 * `YAPPR_SAKURA_IDENTITIES`. It is never committed, copied or printed: this
 * module reads only the personas listed in `test/contract/write/slots.json`
 * (persona indexes 90–99, reserved for mobile so corpus seeding never
 * collides), and its errors name persona indexes, key ids and fields only.
 *
 * Sign-in uses keyId 2 (AUTHENTICATION/HIGH) as hex, which exercises the hex
 * path of `session.signInWithKey`; keyId 4 is the encryption key for DM
 * tests. keyId 0 (MASTER) is never handed out: only the test-wallet responder
 * signs `dash-st:` with it.
 */
import { readFileSync } from 'node:fs'
import slots from '../test/contract/write/slots.json'

const POOL_ENV_VAR = 'YAPPR_SAKURA_IDENTITIES'
const POOL_UNSET = `${POOL_ENV_VAR} is not set (the sakura ops identities.json; ENGINE.md §12.3)`

/** The fixed key layout of every pool persona. */
const POOL_KEYS = {
  high: { keyId: 2, purpose: 'authentication', securityLevel: 'high' },
  critical: { keyId: 1, purpose: 'authentication', securityLevel: 'critical' },
  encryption: { keyId: 4, purpose: 'encryption', securityLevel: 'medium' },
} as const

export type PoolKeyRole = keyof typeof POOL_KEYS

interface PoolKeyEntry {
  keyId: number
  purpose: string
  securityLevel: string
  privateKeyHex: string
}

interface PoolIdentityEntry {
  personaIdx: number
  identityId: string
  identityKeys: PoolKeyEntry[]
}

export interface PoolPersona {
  personaIdx: number
  identityId: string
  /** The private key for `role`, as 64 hex characters. Never log it. */
  keyHex(role: PoolKeyRole): string
}

/** Why the pool cannot be used here, or null when it can. */
export function poolUnavailableReason(): string | null {
  return process.env[POOL_ENV_VAR] ? null : POOL_UNSET
}

/** Load the reserved personas. Throws without echoing file content or key material. */
export function loadPoolPersonas(file: string | undefined = process.env[POOL_ENV_VAR]): PoolPersona[] {
  if (!file) throw new Error(POOL_UNSET)
  let root: { identities?: unknown }
  try {
    root = JSON.parse(readFileSync(file, 'utf8')) as { identities?: unknown }
  } catch (error) {
    // A JSON syntax error can quote the file: report the error class only.
    throw new Error(`Cannot read the pool at ${file} (${error instanceof Error ? error.name : 'error'})`)
  }
  if (!Array.isArray(root.identities)) throw new Error('The pool file has no identities[] array')
  const entries = root.identities as PoolIdentityEntry[]
  return slots.personaIdx.map(personaIdx => {
    const entry = entries.find(candidate => candidate.personaIdx === personaIdx)
    if (!entry || typeof entry.identityId !== 'string' || !Array.isArray(entry.identityKeys)) {
      throw new Error(`Persona ${personaIdx} is missing from the pool or has no identityId/identityKeys`)
    }
    return {
      personaIdx,
      identityId: entry.identityId,
      keyHex(role) {
        const expected = POOL_KEYS[role]
        const key = entry.identityKeys.find(candidate => candidate.keyId === expected.keyId)
        if (!key || key.purpose !== expected.purpose || key.securityLevel !== expected.securityLevel) {
          throw new Error(`Persona ${personaIdx} keyId ${expected.keyId} is not ${expected.purpose}/${expected.securityLevel}`)
        }
        if (typeof key.privateKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key.privateKeyHex)) {
          throw new Error(`Persona ${personaIdx} keyId ${expected.keyId} has no 32-byte privateKeyHex`)
        }
        return key.privateKeyHex
      },
    }
  })
}
