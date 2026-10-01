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

const LAYOUT = [
  { keyId: 0, purpose: 'authentication', securityLevel: 'master' },
  { keyId: 1, purpose: 'authentication', securityLevel: 'critical' },
  { keyId: 2, purpose: 'authentication', securityLevel: 'high' },
  { keyId: 3, purpose: 'transfer', securityLevel: 'critical' },
  { keyId: 4, purpose: 'encryption', securityLevel: 'medium' },
]

/** keyId k's test private key: 32 bytes of k + 1. */
export function testPrivateKey(keyId: number): Uint8Array {
  return new Uint8Array(32).fill(keyId + 1)
}

export function testPool(): Pool {
  return parsePool({
    network: 'devnet-test',
    identities: [
      {
        personaIdx: PERSONA_IDX,
        identityId: IDENTITY_ID,
        identityKeys: LAYOUT.map((key) => ({
          ...key,
          privateKeyHex: bytesToHex(testPrivateKey(key.keyId)),
          publicKeyHex: bytesToHex(secp256k1.getPublicKey(testPrivateKey(key.keyId), true)),
        })),
      },
    ],
  })
}

export function testPersona(): Persona {
  return selectPersona(testPool(), PERSONA_IDX)
}
