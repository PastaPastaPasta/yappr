/**
 * A synthetic pool in the sakura `identities.json` shape. The keys are fixed
 * test scalars, not pool keys: unit tests never read the real pool.
 */
import bs58 from 'bs58'
import * as secp256k1 from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils.js'
import { WasmSdk } from '@dashevo/evo-sdk'
import { parsePool, selectPersona, type Persona, type Pool } from '../src/pool'
import { dip13Wallet, identityAuthKeyPath, type Dip13Network } from '../../../lib/crypto/dip13'

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

/** BIP-39's public all-zero-entropy phrase: the reference wallet's pinned vectors use it. */
export const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
export const SEEDED_PERSONA_IDX = 96

/**
 * A pool naming TEST_PHRASE, with one persona at DIP-13 identity index
 * `identityIndex` whose identity keys are the phrase's at `keysAtIndex` (by
 * default the same index), key id = key index as a DashPay build registers
 * them. evo-sdk's wasm must be initialised first.
 */
export function seededPool(options: { network?: string; identityIdBytes?: Uint8Array; identityIndex?: number; keysAtIndex?: number } = {}): Pool {
  const network = options.network ?? 'testnet'
  const dip13Network: Dip13Network = network === 'mainnet' ? 'mainnet' : 'testnet'
  const wallet = dip13Wallet(WasmSdk, TEST_PHRASE, dip13Network)
  const identityIndex = options.identityIndex ?? 0
  return parsePool({
    network,
    identities: [{
      personaIdx: SEEDED_PERSONA_IDX,
      identityId: bs58.encode(options.identityIdBytes ?? new Uint8Array(32).fill(0x35)),
      identityIndex,
      identityKeys: LAYOUT.slice(0, 4).map((key) => {
        const derived = wallet.derive(identityAuthKeyPath(dip13Network, options.keysAtIndex ?? identityIndex, key.keyId))
        return { ...key, privateKeyHex: bytesToHex(derived.privateKey), publicKeyHex: bytesToHex(derived.publicKey) }
      }),
    }],
  }, TEST_PHRASE)
}
