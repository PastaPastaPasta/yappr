/**
 * A synthetic pool in the sakura `identities.json` shape. The keys are fixed
 * test scalars, not pool keys: unit tests never read the real pool.
 */
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { parsePool, selectPersona, type Persona, type Pool } from '../src/pool'

export const PERSONA_IDX = 90
export const IDENTITY_ID_BYTES = new Uint8Array(32).fill(0x42)
export const IDENTITY_ID = bs58.encode(IDENTITY_ID_BYTES)
/** Personas 90–95; 90 is the one most tests answer as. */
export const PERSONA_IDXS = [90, 91, 92, 93, 94, 95]

const LAYOUT = [
  { keyId: 0, purpose: 'authentication', securityLevel: 'master' },
  { keyId: 1, purpose: 'authentication', securityLevel: 'critical' },
  { keyId: 2, purpose: 'authentication', securityLevel: 'high' },
  { keyId: 3, purpose: 'transfer', securityLevel: 'critical' },
  { keyId: 4, purpose: 'encryption', securityLevel: 'medium' },
]

/** Persona 90's keyId k test private key: 32 bytes of k + 1 (other personas shift by 16 per index). */
export function testPrivateKey(keyId: number, personaIdx = PERSONA_IDX): Uint8Array {
  return new Uint8Array(32).fill(keyId + 1 + 16 * (personaIdx - PERSONA_IDX))
}

export function testIdentityIdBytes(personaIdx: number): Uint8Array {
  return new Uint8Array(32).fill(0x42 + personaIdx - PERSONA_IDX)
}

export function testPool(): Pool {
  return parsePool({
    network: 'devnet-test',
    identities: PERSONA_IDXS.map((personaIdx) => ({
      personaIdx,
      identityId: bs58.encode(testIdentityIdBytes(personaIdx)),
      identityKeys: LAYOUT.map((key) => ({
        ...key,
        privateKeyHex: bytesToHex(testPrivateKey(key.keyId, personaIdx)),
        publicKeyHex: bytesToHex(secp256k1.getPublicKey(testPrivateKey(key.keyId, personaIdx), true)),
      })),
    })),
  })
}

export function testPersona(personaIdx = PERSONA_IDX): Persona {
  return selectPersona(testPool(), personaIdx)
}
