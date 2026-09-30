/**
 * A second starter-grant claim is refused for good (40722). wasm-sdk
 * 4.2.0-beta.6 delivers it with the code on `error.code` and the prose "...
 * already claimed the once-per-identity distribution ..." behind the operation
 * prefix, neither of which the old labelled-code-or-"alreadyclaimed" check saw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { claim, directPurchase, transfer, topology } = vi.hoisted(() => ({
  claim: vi.fn(),
  directPurchase: vi.fn(),
  transfer: vi.fn(),
  topology: { locked: false },
}))

vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({ tokens: { claim, directPurchase, transfer }, identities: { fetch: async () => ({ publicKeys: [] }) } }),
}))
vi.mock('./signer-service', () => ({ signerService: { createSignerFromWasmKey: () => ({ signer: true, identityKey: true }) } }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true, key: {} }) }))
vi.mock('../contract-topology', () => ({ starterGrantAmount: () => BigInt(100), yappIsLocked: () => topology.locked }))
vi.mock('@dashevo/evo-sdk', () => ({ Identifier: class { constructor(readonly value: string) {} } }))

import { tokenService } from './token-service'

const CLAIMANT = 'Clm111111111111111111111111111111111111111'
const PROSE = "Failed to claim tokens: Protocol error: Token claim error: identity 'Clm1' already claimed the once-per-identity distribution of token 'Tok1' at 1790000000000"

beforeEach(() => {
  claim.mockReset()
  directPurchase.mockReset()
  transfer.mockReset()
  topology.locked = false
})

describe('claimStarterGrant: an identity that already claimed', () => {
  it.each([
    ['the beta.6 SDK error, code on `code`', { code: 40722, message: 'Failed to claim tokens: Protocol error: refused', name: 'Protocol' }],
    ['the prose alone, as an older node sends it', { code: -1, message: PROSE, name: 'Protocol' }],
  ])('is told apart by %s', async (_label, error) => {
    claim.mockRejectedValue(error)
    const result = await tokenService.claimStarterGrant(CLAIMANT, 'wif')
    expect(result).toMatchObject({ success: false, errorCode: 'ALREADY_CLAIMED' })
  })

  it('does not read an unrelated refusal as already claimed', async () => {
    claim.mockRejectedValue({ code: 1, message: 'rejected', name: 'Protocol' })
    const result = await tokenService.claimStarterGrant(CLAIMANT, 'wif')
    expect(result.errorCode).not.toBe('ALREADY_CLAIMED')
  })
})

describe('a locked YAPP (v10)', () => {
  it('refuses purchases and transfers without broadcasting', async () => {
    topology.locked = true
    expect(await tokenService.buyYapp(CLAIMANT, BigInt(100), BigInt(1), 'wif')).toMatchObject({ success: false, errorCode: 'NOT_AUTHORIZED' })
    expect(await tokenService.transfer(CLAIMANT, 'Rcp1', BigInt(5), undefined, 'wif')).toMatchObject({ success: false, errorCode: 'NOT_AUTHORIZED' })
    expect(directPurchase).not.toHaveBeenCalled()
    expect(transfer).not.toHaveBeenCalled()
  })

  it('still pays out the starter grant', async () => {
    topology.locked = true
    claim.mockResolvedValue(undefined)
    expect(await tokenService.claimStarterGrant(CLAIMANT, 'wif')).toEqual({ success: true })
  })

  it('leaves purchases and transfers alone where YAPP is not locked', async () => {
    directPurchase.mockResolvedValue(undefined)
    transfer.mockResolvedValue(undefined)
    expect(await tokenService.buyYapp(CLAIMANT, BigInt(100), BigInt(1), 'wif')).toEqual({ success: true })
    expect(await tokenService.transfer(CLAIMANT, 'Rcp1', BigInt(5), undefined, 'wif')).toEqual({ success: true })
  })
})
