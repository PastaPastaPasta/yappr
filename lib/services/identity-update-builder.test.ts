import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'
import { ensureInitialized } from '@dashevo/evo-sdk'
import { IdentityUpdateTransition } from '@dashevo/wasm-sdk'
import { getPublicKey } from '@/lib/crypto/keys'
import { hash160 } from '@/lib/crypto/hash'

const ANCHOR = bs58.encode(new Uint8Array(32).fill(1))
const IDENTITY = bs58.encode(new Uint8Array(32).fill(7))

const mocks = vi.hoisted(() => ({ publicKeys: [] as unknown[] }))
vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({
    identities: {
      fetch: async () => ({ publicKeys: mocks.publicKeys, toJSON: () => ({ revision: 1 }) }),
      nonce: async () => BigInt(1),
    },
  }),
}))

describe('buildUnsignedBoundEncryptionKeyTransition', () => {
  it('refuses when the identity already has an enabled encryption key bound to the contract', async () => {
    const { buildUnsignedBoundEncryptionKeyTransition, BoundKeyExistsError } = await import('./identity-update-builder')
    mocks.publicKeys = [
      { keyId: 0, purposeNumber: 0 },
      { keyId: 4, purposeNumber: 1 },
      { keyId: 5, purposeNumber: 1, contractBounds: { $type: 'singleContract', id: ANCHOR } },
    ]
    await expect(buildUnsignedBoundEncryptionKeyTransition({
      identityId: IDENTITY,
      encryptionPrivateKey: new Uint8Array(32).fill(3),
      contractId: ANCHOR,
    })).rejects.toBeInstanceOf(BoundKeyExistsError)
  })
})

beforeAll(async () => {
  await ensureInitialized()
})

afterEach(() => {
  mocks.publicKeys = []
  vi.unstubAllEnvs()
})

describe('buildUnsignedKeyRegistrationTransition', () => {
  it('serializes the auth key as a 20-byte HASH160 and keeps the encryption point intact (PV14 rc.4)', async () => {
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', 'legacy')
    mocks.publicKeys = [{ keyId: 0 }]
    const { buildUnsignedKeyRegistrationTransition } = await import('./identity-update-builder')
    const authPrivateKey = new Uint8Array(32).fill(2)
    const encryptionPrivateKey = new Uint8Array(32).fill(3)
    const authPublicKey = getPublicKey(authPrivateKey)
    const encryptionPublicKey = getPublicKey(encryptionPrivateKey)
    const { transitionBytes } = await buildUnsignedKeyRegistrationTransition({
      identityId: IDENTITY, authPrivateKey, authPublicKey, encryptionPrivateKey, encryptionPublicKey,
    })
    const update = IdentityUpdateTransition.fromBytes(transitionBytes)
    const keys = update.publicKeyIdsToAdd
    try {
      expect(keys).toHaveLength(2)
      expect(keys[0].keyType.toLowerCase()).toBe('ecdsa_hash160')
      expect(keys[0].data).toHaveLength(20)
      expect(keys[0].data).toEqual(hash160(authPublicKey))
      expect(keys[0].signature).toHaveLength(0)
      expect(keys[1].keyType.toLowerCase()).toBe('ecdsa_secp256k1')
      expect(keys[1].data).toEqual(encryptionPublicKey)
      expect(keys[1].signature).toHaveLength(65)
    } finally {
      for (const key of keys) key.free()
      update.free()
    }
  })
})
