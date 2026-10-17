import { describe, expect, it, vi } from 'vitest'
import bs58 from 'bs58'

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
