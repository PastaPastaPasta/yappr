/**
 * QA D-01 review finding on wallet requests: the nonce is reserved only once
 * the unsigned bytes exist, so a build that throws holds nothing back, and a
 * request abandoned before its QR went up can be discarded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ identities: { contractNonce: vi.fn() } }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./token-service', () => ({ tokenService: { getTokenId: async () => 'token' } }))
vi.mock('@dashevo/evo-sdk', () => ({
  Identifier: class { constructor(readonly id: string) {} },
  TokenBaseTransition: class { constructor(readonly options: unknown) {} },
  TokenTransition: class { constructor(readonly inner: unknown) {} },
  TokenTransferTransition: class { constructor(readonly options: unknown) {} },
  BatchedTransition: class { constructor(readonly inner: unknown) {} },
  BatchTransition: {
    fromBatchedTransitions: () => ({ toStateTransition: () => ({ setIdentityContractNonce: () => undefined, toBytes: () => new Uint8Array([7]) }) }),
  },
}))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
})

import { TokenTransferTransition } from '@dashevo/evo-sdk'
import { YAPPR_CONTRACT_ID } from '../constants'
import { loadReservation } from './identity-nonce'
import { buildUnsignedTokenBatch } from './token-transition-builder'

const OWNER = 'owner'

beforeEach(() => {
  storage.clear()
  sdk.identities.contractNonce.mockResolvedValue(BigInt(100))
})

describe('buildUnsignedTokenBatch', () => {
  it('reserves nothing when the build throws', async () => {
    await expect(buildUnsignedTokenBatch('test', OWNER, () => { throw new Error('bad amount') })).rejects.toThrow('bad amount')
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)).toBeNull()
  })

  it('reserves the nonce of a built request until it is discarded', async () => {
    const request = await buildUnsignedTokenBatch('test', OWNER, (base) => new TokenTransferTransition({ base, recipientId: 'recipient', amount: BigInt(1) }))
    expect(request.bytes).toEqual(new Uint8Array([7]))
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending.map((p) => p.nonce)).toEqual([BigInt(101)])

    request.discard()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toEqual([])
  })
})
