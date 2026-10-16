/**
 * A second starter-grant claim is refused for good (40722). wasm-sdk
 * 4.2.0-beta.6 delivers it with the code on `error.code` and the prose "...
 * already claimed the once-per-identity distribution ..." behind the operation
 * prefix, neither of which the old labelled-code-or-"alreadyclaimed" check saw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { claim, directPurchase, transfer, topology, signedWrite } = vi.hoisted(() => ({
  claim: vi.fn(),
  directPurchase: vi.fn(),
  transfer: vi.fn(),
  topology: { locked: false },
  signedWrite: vi.fn(),
}))

vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({ tokens: { claim, directPurchase, transfer }, identities: { fetch: async () => ({ publicKeys: [] }) } }),
}))
// The nonce lock reads Platform's nonce; these tests are about the claim, so it just runs the write.
vi.mock('./identity-nonce', () => ({ withSdkSignedWrite: (...args: [string, string, () => Promise<unknown>]) => signedWrite(...args) }))
vi.mock('./signer-service', () => ({ signerService: { createSignerFromWasmKey: () => ({ signer: true, identityKey: true }) } }))
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: true, key: {} }) }))
vi.mock('../contract-topology', () => ({ starterGrantAmount: () => BigInt(100), yappIsLocked: () => topology.locked }))
vi.mock('@dashevo/evo-sdk', () => ({ Identifier: class { constructor(readonly value: string) {} } }))

import { tokenService } from './token-service'

const CLAIMANT = 'Clm111111111111111111111111111111111111111'
const PROSE = "Failed to claim tokens: Protocol error: Token claim error: identity 'Clm1' already claimed the once-per-identity distribution of token 'Tok1' at 1790000000000"

beforeEach(() => {
  signedWrite.mockReset().mockImplementation((...args: [string, string, () => Promise<unknown>]) => args[2]())
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

describe('a token write whose answer could not be verified', () => {
  // wasm-sdk 5.0.0-beta.6 during a quorum rotation: the transition may well have executed.
  const QKU = { name: 'Proof', code: -1, message: 'Proof verification error: quorum key unavailable for quorum 107:1c64: invalid quorum: Quorum not found in cache for hash: 1c64' }

  it.each([
    ['an unverifiable result proof', QKU],
    ['a timed-out wait', new Error('waitForResponse timed out after 10s')],
    ['a transport failure', new Error('transport error: TypeError: Failed to fetch')],
    ['a nonce refusal, which an SDK re-broadcast of this very transfer also produces', new Error('Identity C is trying to set an invalid identity nonce. error is nonce already present at tip')],
  ])('reports a purchase or transfer sent into %s as unconfirmed, never as a failure to retry', async (_label, error) => {
    directPurchase.mockRejectedValue(error)
    transfer.mockRejectedValue(error)
    expect(await tokenService.buyYapp(CLAIMANT, BigInt(100), BigInt(1), 'wif')).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
    expect(await tokenService.transfer(CLAIMANT, 'Rcp1', BigInt(5), undefined, 'wif')).toMatchObject({ success: false, errorCode: 'UNCONFIRMED' })
    expect(directPurchase).toHaveBeenCalledTimes(1)
    expect(transfer).toHaveBeenCalledTimes(1)
  })

  it('reports a read that failed before anything was sent as a plain failure', async () => {
    // The nonce read under the write lock hit the gap: the transfer was never handed to the SDK.
    signedWrite.mockRejectedValue(QKU)
    expect(await tokenService.transfer(CLAIMANT, 'Rcp1', BigInt(5), undefined, 'wif')).toMatchObject({ success: false, errorCode: 'NETWORK_ERROR' })
    expect(transfer).not.toHaveBeenCalled()
  })
})
