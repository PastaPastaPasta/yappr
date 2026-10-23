/**
 * The charters creates the release CLI and the app both sign, built offline
 * with the real wasm: the id is derived, the bytes decode and re-encode
 * exactly, and an application states exactly the reviewed 0.5 DASH.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as w from '@dashevo/evo-sdk'
import bs58 from 'bs58'
import type { EvoSDK } from '@dashevo/evo-sdk'
import { CHARTERS_CONTRACT_ID, CONTEST_FUND_CREDITS } from './rules.mjs'
import { charterIdBytes, charterKeyInCreation, charterNonceConsumed, nextCharterNonce, signCharterCreate } from './transitions.mjs'

const OWNER = bs58.encode(new Uint8Array(32).fill(2))
const TARGET = bs58.encode(new Uint8Array(32).fill(5))
const PRIVATE_KEY_HEX = '0101010101010101010101010101010101010101010101010101010101010101'

beforeAll(async () => {
  await w.ensureInitialized()
})

function signer() {
  const privateKey = w.PrivateKey.fromHex(PRIVATE_KEY_HEX, 'testnet')
  const identityKey = new w.IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'critical', keyType: 'ecdsa_secp256k1', data: privateKey.getPublicKey().toBytes() })
  return { privateKey, identityKey }
}

const sdkWithFund = (credits: bigint) => ({
  documents: { contestFundToJoin: vi.fn().mockResolvedValue({ credits, free: vi.fn() }) },
}) as unknown as EvoSDK

describe('signed charters creates', () => {
  it('signs a proposal under the given nonce with a derived id, and the bytes round-trip exactly', async () => {
    const step = await signCharterCreate(w, sdkWithFund(0n), {
      type: 'submittedCharter', ownerId: OWNER, nonce: 3n, ...signer(),
      data: { targetContractId: charterIdBytes(w, TARGET), description: 'We hide spam.', reasons: [new Uint8Array(32).fill(4)], moderatorsShare: 60, rewardSplit: { leader: 40, equal: 30, actions: 30 } },
    })
    expect(step).toMatchObject({ type: 'submittedCharter', owner: OWNER, nonce: '3' })
    expect(bs58.decode(step.id)).toHaveLength(32)
    expect(step.id).not.toBe(bs58.encode(new Uint8Array(32)))
    const decoded = w.StateTransition.fromBytes(step.bytes)
    expect(decoded.toBytes()).toEqual(step.bytes)
    expect(decoded.identityContractNonce).toBe(3n)
    expect(decoded.ownerId?.toBase58()).toBe(OWNER)
  })

  it('states the 0.5 DASH contest fund on an application, and refuses any other amount before signing', async () => {
    const data = { targetContractId: charterIdBytes(w, TARGET), submittedCharterId: new Uint8Array(32).fill(6), members: [] }
    const ok = sdkWithFund(CONTEST_FUND_CREDITS)
    const step = await signCharterCreate(w, ok, { type: 'electedCharter', ownerId: OWNER, nonce: 4n, ...signer(), data, fund: true })
    expect(ok.documents.contestFundToJoin).toHaveBeenCalledOnce()
    expect(w.StateTransition.fromBytes(step.bytes).toBytes()).toEqual(step.bytes)
    // Doubled once a contest is crowded: stop and review rather than pay it.
    await expect(signCharterCreate(w, sdkWithFund(CONTEST_FUND_CREDITS * 2n), { type: 'electedCharter', ownerId: OWNER, nonce: 4n, ...signer(), data, fund: true }))
      .rejects.toThrow('0.5 DASH')
  })

  it('builds a charter key bound to one charters document type', () => {
    const key = charterKeyInCreation(w, { keyId: 7, purpose: 'ENCRYPTION', documentType: 'joinRequest', publicKey: w.PrivateKey.fromHex(PRIVATE_KEY_HEX, 'testnet').getPublicKey().toBytes() })
    const json = key.toJSON() as { id?: number; keyId?: number; contractBounds?: { id?: string; documentTypeName?: string } }
    expect(json.contractBounds).toMatchObject({ id: CHARTERS_CONTRACT_ID, documentTypeName: 'joinRequest' })
  })
})

describe('charters nonces', () => {
  it('counts a nonce behind the tip whose missing bit is still set as able to execute', async () => {
    // Tip 137, nonce 136 still missing (bit 40), 135 filled in.
    const sdk = { wasm: { getIdentityContractNonce: vi.fn().mockResolvedValue((1n << 40n) | 137n) } } as unknown as EvoSDK
    expect(await charterNonceConsumed(sdk, OWNER, 136n)).toBe(false)
    expect(await charterNonceConsumed(sdk, OWNER, 137n)).toBe(true)
    expect(await charterNonceConsumed(sdk, OWNER, 135n)).toBe(true)
    expect(await charterNonceConsumed(sdk, OWNER, 138n)).toBe(false)
    expect(await charterNonceConsumed(sdk, OWNER, 100n)).toBe(true)
  })

  it('takes one past the tip, ignoring the revision bits, and waits for a read behind a proved write', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn().mockResolvedValueOnce(4n).mockResolvedValue((1n << 40n) | 5n)
      const sdk = { wasm: { getIdentityContractNonce: read } } as unknown as EvoSDK
      const next = nextCharterNonce(sdk, OWNER, 5n)
      await vi.advanceTimersByTimeAsync(5000)
      expect(await next).toBe(6n)
      expect(await charterNonceConsumed(sdk, OWNER, 5n)).toBe(true)
      expect(await charterNonceConsumed(sdk, OWNER, 6n)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
