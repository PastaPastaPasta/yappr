/**
 * QA D-01 review findings on the SDK-signed write path: a write whose nonce
 * the SDK picks must never run while a nonce this browser signed may still
 * execute (the polling budget used to lapse into the write), and the nonces
 * this browser picks next must go past anything the SDK could have signed,
 * whichever node either of them asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  identities: { contractNonce: vi.fn() },
  wasm: { refreshIdentityNonce: vi.fn(async () => undefined) },
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('@dashevo/evo-sdk', () => ({ Identifier: class { constructor(readonly id: string) {} } }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
})

import { PENDING_WRITE_ERROR } from '@/lib/error-utils'
import { allocateNonce, loadReservation, releaseNonce, reserveNonce, sdkSignedRange, stillPending, withSdkSignedWrite } from './identity-nonce'

const OWNER = 'owner'
const CONTRACT = 'contract'
const n = (value: number) => BigInt(value)
const one = (nonce: number) => ({ from: n(nonce), to: n(nonce) })

beforeEach(() => {
  storage.clear()
  sdk.identities.contractNonce.mockReset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function runSdkWrite(write: () => Promise<string>) {
  const outcome = withSdkSignedWrite(OWNER, CONTRACT, write).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  await vi.runAllTimersAsync()
  return outcome
}

describe('withSdkSignedWrite', () => {
  it('does not run the write while a nonce this browser signed is still ahead of Platform, however long it waits', async () => {
    // A create signed 101 and came back unconfirmed; Platform stays at 100.
    reserveNonce(OWNER, CONTRACT, one(101), n(100))
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const write = vi.fn(async () => 'sent')

    const outcome = await runSdkWrite(write)

    expect(write).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
    // The pending create is still recorded, and the mark did not move.
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(101), pending: [one(101)] })
  })

  it('never lowers the mark when several nonces are outstanding', async () => {
    reserveNonce(OWNER, CONTRACT, one(101), n(100))
    reserveNonce(OWNER, CONTRACT, one(102), n(100))
    reserveNonce(OWNER, CONTRACT, one(103), n(100))
    sdk.identities.contractNonce.mockResolvedValue(n(100))

    await runSdkWrite(async () => 'sent')

    expect(loadReservation(OWNER, CONTRACT)?.mark).toBe(n(103))
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(104))
  })

  it('runs once Platform shows the pending nonce consumed, and records what the SDK may sign', async () => {
    reserveNonce(OWNER, CONTRACT, one(101), n(100))
    sdk.identities.contractNonce.mockResolvedValueOnce(n(100)).mockResolvedValue(n(101))
    const write = vi.fn(async () => 'sent')

    const outcome = await runSdkWrite(write)

    expect(outcome).toEqual({ ok: true, value: 'sent' })
    expect(write).toHaveBeenCalledTimes(1)
    // It executed: nothing pending, and nothing the SDK could have signed is handed out again.
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(102), seen: n(102), pending: [] })
  })

  it('keeps an SDK write whose outcome is unknown pending, so the next SDK write waits on it', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const timedOut = await runSdkWrite(async () => { throw new Error('waitForResponse timed out') })
    expect(timedOut.ok).toBe(false)
    expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(1)

    const next = vi.fn(async () => 'sent')
    const outcome = await runSdkWrite(next)
    expect(next).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
  })

  it('releases an SDK write the network refused', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const refused = await runSdkWrite(async () => { throw { code: 40106, message: 'Document X has invalid revision' } })
    expect(refused.ok).toBe(false)
    expect(loadReservation(OWNER, CONTRACT)?.pending).toEqual([])
  })
})

describe('the nonce the SDK signs and the nonce this browser picks next never meet (differing node responses)', () => {
  it('covers an SDK that read a node a block ahead of the one this browser read', () => {
    // This browser reads 100; the SDK's node already reports 101 and it signs 102.
    const range = sdkSignedRange(n(100), null)
    reserveNonce(OWNER, CONTRACT, range, n(100))
    expect(range.from).toBe(n(101))
    // Either way it ends up executed or pending; a create that then reads a lagging 100 goes past both.
    releaseNonce(OWNER, CONTRACT, range, true)
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBeGreaterThan(n(101))
  })

  it('goes past every nonce the SDK could have signed, given what this browser already signed', () => {
    // A create signed 101 and has executed; the SDK's cache may still say 101 (it signs 102),
    // or a node may say 101 (it signs 102): the range covers both.
    reserveNonce(OWNER, CONTRACT, one(101), n(100))
    releaseNonce(OWNER, CONTRACT, one(101), true)
    const range = sdkSignedRange(n(101), loadReservation(OWNER, CONTRACT))
    expect(range).toEqual({ from: n(102), to: n(102) })
    reserveNonce(OWNER, CONTRACT, range, n(101))
    // A create that now reads a lagging node (100) still skips 102.
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(103))
  })

  it('does not treat a pending nonce as settled because a lagging node reports a lower tip', () => {
    reserveNonce(OWNER, CONTRACT, one(105), n(104))
    expect(stillPending(n(100), loadReservation(OWNER, CONTRACT))).toHaveLength(1)
    expect(stillPending(n(105), loadReservation(OWNER, CONTRACT))).toHaveLength(0)
  })
})

describe('allocateNonce', () => {
  it('refuses to hand out a nonce when the only one Drive accepts may still be taken by a pending transition', () => {
    // 24 signed and none executed: one past the mark is too far ahead for Drive.
    for (let nonce = 101; nonce <= 124; nonce++) reserveNonce(OWNER, CONTRACT, one(nonce), n(100))
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBeNull()
  })

  it('falls back to the one after the tip once nothing signed may still execute', () => {
    for (let nonce = 101; nonce <= 124; nonce++) reserveNonce(OWNER, CONTRACT, one(nonce), n(100))
    for (let nonce = 101; nonce <= 124; nonce++) releaseNonce(OWNER, CONTRACT, one(nonce), false)
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(101))
  })

  it('stops waiting on a transition nobody broadcast within its lifetime', () => {
    reserveNonce(OWNER, CONTRACT, one(101), n(100))
    const later = Date.now() + 16 * 60 * 1000
    expect(stillPending(n(100), loadReservation(OWNER, CONTRACT), later)).toEqual([])
  })
})
