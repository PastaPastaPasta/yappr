/**
 * QA D-01 review finding on wallet requests: the nonce is reserved only once
 * the unsigned bytes exist, so a build that throws holds nothing back, and a
 * request abandoned before its QR went up can be discarded, under the write
 * lock like every other change to the shared reservation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ identities: { contractNonce: vi.fn() } }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('./token-service', () => ({ tokenService: { getTokenId: async () => 'token' } }))
vi.mock('@dashevo/wasm-sdk', () => ({
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

import { TokenTransferTransition } from '@dashevo/wasm-sdk'
import { YAPPR_CONTRACT_ID } from '../constants'
import { withIdentityWriteLock } from '@/lib/identity-write-lock'
import { loadReservation, withSdkSignedWrite, stillPending } from './identity-nonce'
import { buildUnsignedTokenBatch } from './token-transition-builder'

const OWNER = 'owner'

beforeEach(() => {
  storage.clear()
  sdk.identities.contractNonce.mockResolvedValue(BigInt(100))
})

afterEach(() => { vi.useRealTimers() })

async function settle<T>(promise: Promise<T>) {
  const outcome = promise.then(value => ({ value }), (error: unknown) => ({ error }))
  await vi.runAllTimersAsync()
  return outcome
}

const build = () => buildUnsignedTokenBatch('test', OWNER, base => new TokenTransferTransition({ base, recipientId: 'recipient', amount: BigInt(1) }))

describe('displayed wallet QR reservations (#777)', () => {
  it.each(['this tab', 'reload', 'second tab'])('allows another write with a separate nonce after abandonment in %s', async (context) => {
    vi.useFakeTimers()
    await build()
    vi.setSystemTime(Date.now() + 60 * 60 * 1000)
    let write = withSdkSignedWrite
    if (context !== 'this tab') {
      vi.resetModules()
      write = (await import('./identity-nonce')).withSdkSignedWrite
    }
    const sdkWrite = vi.fn(async () => 'sdk')
    const chosen = vi.fn(async (nonce: bigint) => {
      sdk.identities.contractNonce.mockResolvedValue(nonce | (BigInt(1) << (BigInt(40) + nonce - BigInt(102))))
      return `sent ${nonce}`
    })
    const startedAt = Date.now()
    expect(await settle(write(OWNER, YAPPR_CONTRACT_ID, sdkWrite, undefined, undefined, chosen))).toEqual({ value: 'sent 102' })
    expect(Date.now()).toBe(startedAt)
    expect(sdkWrite).not.toHaveBeenCalled()
    expect(chosen).toHaveBeenCalledWith(BigInt(102))
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending.map(p => p.nonce)).toEqual([BigInt(101)])
    if (context === 'second tab') {
      expect(await settle(withSdkSignedWrite(OWNER, YAPPR_CONTRACT_ID, sdkWrite, undefined, undefined, chosen))).toEqual({ value: 'sent 103' })
      expect(chosen.mock.calls.map(([nonce]) => nonce)).toEqual([BigInt(102), BigInt(103)])
    }
  })

  it('keeps a scanned QR safe to sign later without reusing its nonce', async () => {
    vi.useFakeTimers()
    await build()
    const chosen = vi.fn(async (nonce: bigint) => {
      sdk.identities.contractNonce.mockResolvedValue(nonce | (BigInt(1) << (BigInt(40) + nonce - BigInt(102))))
      return `sent ${nonce}`
    })
    const sdkWrite = vi.fn(async () => 'sdk')
    await settle(withSdkSignedWrite(OWNER, YAPPR_CONTRACT_ID, sdkWrite, undefined, undefined, chosen))
    // The app's 102 landed, but 101 is still a gap and the wallet can broadcast it.
    const missing101 = BigInt(102) | (BigInt(1) << BigInt(40))
    sdk.identities.contractNonce.mockResolvedValue(missing101)
    expect(stillPending(missing101, loadReservation(OWNER, YAPPR_CONTRACT_ID))).toHaveLength(1)
    await settle(withSdkSignedWrite(OWNER, YAPPR_CONTRACT_ID, sdkWrite, undefined, undefined, chosen))
    expect(chosen.mock.calls.map(([nonce]) => nonce)).toEqual([BigInt(102), BigInt(103)])
    // Now the wallet signs 101, and proof shows every nonce through 103 consumed.
    sdk.identities.contractNonce.mockResolvedValue(BigInt(103))
    expect(stillPending(BigInt(103), loadReservation(OWNER, YAPPR_CONTRACT_ID))).toEqual([])
    expect((await build()).bytes).toEqual(new Uint8Array([7]))
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending.map(p => p.nonce)).toEqual([BigInt(104)])
  })

  it('does not sign anything when the proof read fails', async () => {
    vi.useFakeTimers()
    await build()
    sdk.identities.contractNonce.mockRejectedValue(new Error('proof unavailable'))
    const chosen = vi.fn(async () => 'sent')
    const sdkWrite = vi.fn(async () => 'sdk')
    expect(await settle(withSdkSignedWrite(OWNER, YAPPR_CONTRACT_ID, sdkWrite, undefined, undefined, chosen))).toEqual({ error: new Error('proof unavailable') })
    expect(chosen).not.toHaveBeenCalled()
    expect(sdkWrite).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toHaveLength(1)
  })
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

    await request.discard()
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toEqual([])
  })

  it('discards under the write lock, so it cannot overwrite a reservation another write is making', async () => {
    const request = await buildUnsignedTokenBatch('test', OWNER, (base) => new TokenTransferTransition({ base, recipientId: 'recipient', amount: BigInt(1) }))
    let finishWrite = () => {}
    const held = withIdentityWriteLock(OWNER, YAPPR_CONTRACT_ID, () => new Promise<void>((resolve) => { finishWrite = resolve }))

    const discarded = request.discard()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Still held by the other write: the discard has not touched storage yet.
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toHaveLength(1)

    finishWrite()
    await held
    await discarded
    expect(loadReservation(OWNER, YAPPR_CONTRACT_ID)?.pending).toEqual([])
  })
})
