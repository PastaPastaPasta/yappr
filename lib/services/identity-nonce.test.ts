/**
 * Nonce bookkeeping (QA D-01, #644): an SDK-signed write must never run while
 * a transition this browser signed may still execute (the polling budget used
 * to lapse into the write); nothing may take a nonce while an SDK-signed
 * transition may still execute; a lost answer stops holding writes back as
 * soon as Platform shows the transition landed; the mark and the floor never
 * go down; and nothing is signed unless its reservation is stored where every
 * tab sees it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  identities: { contractNonce: vi.fn() },
  wasm: { refreshIdentityNonce: vi.fn(async () => undefined) },
}))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }))
vi.mock('@dashevo/evo-sdk', () => ({ Identifier: class { constructor(readonly id: string) {} } }))

const storage = new Map<string, string>()
const storageFull = { value: false }
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (storageFull.value) throw new DOMException('quota', 'QuotaExceededError')
    storage.set(key, value)
  },
  removeItem: (key: string) => { storage.delete(key) },
})

import { NONCE_STORE_ERROR, PENDING_WRITE_ERROR } from '@/lib/error-utils'
import { WRITE_PRECONDITION_FAILED, allocateNonce, awaitNonce, loadReservation, releaseNonce, reserveNonce, settlePendingWrites, stillPending, withSdkSignedWrite } from './identity-nonce'

const n = (value: number) => BigInt(value)
const PENDING_STORE = NONCE_STORE_ERROR
const MINUTE = 60 * 1000
let owner = 0
let OWNER = ''
const CONTRACT = 'contract'

beforeEach(() => {
  storage.clear()
  storageFull.value = false
  // A fresh identity per test: this tab's in-memory copies are module state.
  OWNER = `owner-${++owner}`
  sdk.identities.contractNonce.mockReset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function settle<T>(promise: Promise<T>) {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  await vi.runAllTimersAsync()
  return outcome
}

const runSdkWrite = (write: () => Promise<string>) => settle(withSdkSignedWrite(OWNER, CONTRACT, write))

/** The nonce the next create gets, as `createDocument` asks for it. */
const nextCreateNonce = () => settle(awaitNonce(OWNER, CONTRACT, allocateNonce).then(({ value }) => value))

/** An SDK-signed write sent with Platform at `tip`, whose answer was lost after the broadcast. */
async function lostAnswer(tip: number) {
  sdk.identities.contractNonce.mockResolvedValue(n(tip))
  const outcome = await runSdkWrite(async () => { throw new Error('transport error: grpc error: Failed to fetch') })
  expect(outcome.ok).toBe(false)
  expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(1)
}

describe('reservation scope', () => {
  it('stores and reads back what a transition writes, and leaves it absent when unnamed', () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100), 'pollr-vote:p1')
    reserveNonce(OWNER, CONTRACT, n(102), n(100))

    const [scoped, unscoped] = loadReservation(OWNER, CONTRACT)?.pending ?? []
    expect(scoped).toMatchObject({ nonce: n(101), scope: 'pollr-vote:p1' })
    expect(unscoped).not.toHaveProperty('scope')
  })
})

describe('withSdkSignedWrite', () => {
  it('does not run the write while a nonce this browser signed is still ahead of Platform, however long it waits', async () => {
    // A create signed 101 and came back unconfirmed; Platform stays at 100.
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const write = vi.fn(async () => 'sent')

    const outcome = await runSdkWrite(write)

    expect(write).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(101), pending: [{ nonce: n(101) }] })
  })

  it('never lowers the mark when several nonces are outstanding', async () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    reserveNonce(OWNER, CONTRACT, n(102), n(100))
    reserveNonce(OWNER, CONTRACT, n(103), n(100))
    sdk.identities.contractNonce.mockResolvedValue(n(100))

    await runSdkWrite(async () => 'sent')

    expect(loadReservation(OWNER, CONTRACT)?.mark).toBe(n(103))
    expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(3)
  })

  it('sends and reserves nothing when its precondition fails under the lock', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const write = vi.fn(async () => 'sent')
    const outcome = await settle(withSdkSignedWrite(OWNER, CONTRACT, write, undefined, async () => false))

    expect(outcome).toEqual({ ok: false, error: new Error(WRITE_PRECONDITION_FAILED) })
    expect(write).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, CONTRACT)?.pending ?? []).toEqual([])
  })

  it('checks its precondition only once earlier transitions have settled', async () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    sdk.identities.contractNonce.mockResolvedValueOnce(n(100)).mockResolvedValue(n(101))
    const seen: bigint[] = []
    const precondition = vi.fn(async () => {
      seen.push(await sdk.identities.contractNonce(OWNER, CONTRACT))
      return true
    })

    expect(await settle(withSdkSignedWrite(OWNER, CONTRACT, async () => 'sent', undefined, precondition))).toEqual({ ok: true, value: 'sent' })
    // Called once, after Platform showed the earlier nonce consumed.
    expect(precondition).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([n(101)])
  })

  it('runs once Platform shows the pending nonce consumed', async () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    sdk.identities.contractNonce.mockResolvedValueOnce(n(100)).mockResolvedValue(n(101))
    const write = vi.fn(async () => 'sent')

    const outcome = await runSdkWrite(write)

    expect(outcome).toEqual({ ok: true, value: 'sent' })
    expect(write).toHaveBeenCalledTimes(1)
    expect(loadReservation(OWNER, CONTRACT)?.pending).toEqual([])
  })

  it('keeps an SDK write pending when it is refused as too far in future: a node behind may be the one answering', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const refused = await runSdkWrite(async () => {
      throw { code: 40204, message: 'Identity x is trying to set an invalid identity nonce. The current identity nonce is 76, we are setting 101, error is nonce too far in future' }
    })
    expect(refused.ok).toBe(false)
    expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(1)
  })

  it('releases an SDK write refused because its nonce is already present', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    await runSdkWrite(async () => {
      throw { code: 40204, message: 'Identity x is trying to set an invalid identity nonce. The current identity nonce is 101, we are setting 101, error is nonce already present at tip' }
    })
    expect(loadReservation(OWNER, CONTRACT)?.pending).toEqual([])
  })

  it('counts a refusal Platform does not show as having taken the last nonce it may carry: it may have been paid', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const refused = await runSdkWrite(async () => { throw { code: 40106, message: 'Document X has invalid revision' } })
    expect(refused.ok).toBe(false)
    // Refused before or after it executed: nothing tells, so the floor goes to the top of its range.
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ floor: n(101), pending: [] })
  })

  it('counts the nonce an SDK write took as spent once it is confirmed', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    expect(await runSdkWrite(async () => 'sent')).toEqual({ ok: true, value: 'sent' })
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(101), floor: n(101), pending: [] })
  })
})

describe('an SDK-signed write whose answer was lost (#644)', () => {
  it('records the nonces the SDK may have signed, and the last of them as the mark', async () => {
    await lostAnswer(100)
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(101), pending: [{ nonce: null, signedAfter: n(100), signedAtMost: n(101) }] })
  })

  it('settles whichever nonce the SDK signed, from the tip or past its own last one, when the mark is ahead', async () => {
    // A create refused at broadcast left the mark at 101 with Platform at 100.
    releaseNonce(OWNER, CONTRACT, reserveNonce(OWNER, CONTRACT, n(101), n(100)))
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(101), floor: n(100) })

    await lostAnswer(100)
    expect(loadReservation(OWNER, CONTRACT)?.pending[0]).toMatchObject({ signedAfter: n(100), signedAtMost: n(102) })
    // A fresh SDK signs 101; one whose last nonce was 101 signs 102, leaving 101 missing.
    expect(stillPending(n(101), loadReservation(OWNER, CONTRACT))).toEqual([])
    expect(stillPending(n(102) | (BigInt(1) << BigInt(40)), loadReservation(OWNER, CONTRACT))).toEqual([])
    // Nothing of it shows yet.
    expect(stillPending(n(100), loadReservation(OWNER, CONTRACT))).toHaveLength(1)
    // And nothing this browser builds takes either.
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT), Date.now() + 2 * MINUTE)).toBe(n(103))
  })

  it('never settles a lost answer off a nonce an earlier write of this browser took, when a node is behind', async () => {
    // W1 is refused with Platform at 100: this tab's SDK signed 101, which nothing took; nothing shows it, so the floor counts it.
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    await runSdkWrite(async () => { throw { code: 40106, message: 'Document X has invalid revision' } })
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(101), floor: n(101) })

    // W2: the SDK signs 102, past its own last nonce, and Platform then shows 102 with 101 missing.
    const shows102 = n(102) | (BigInt(1) << BigInt(40))
    sdk.identities.contractNonce.mockResolvedValueOnce(n(100)).mockResolvedValue(shows102)
    expect(await runSdkWrite(async () => 'sent')).toEqual({ ok: true, value: 'sent' })
    expect(loadReservation(OWNER, CONTRACT)?.floor).toBe(n(102))

    // W3 reads a node still at 100, and its answer is lost.
    await lostAnswer(100)
    expect(loadReservation(OWNER, CONTRACT)?.pending[0]).toMatchObject({ signedAfter: n(102), signedAtMost: n(103) })
    // W4 (another tab, a fresh SDK that would sign 103) reads 102: W2's nonce does not settle W3.
    expect(stillPending(shows102, loadReservation(OWNER, CONTRACT))).toHaveLength(1)
    expect(stillPending(n(103), loadReservation(OWNER, CONTRACT))).toEqual([])
  })

  it('never settles a lost answer off a paid refusal Platform showed only later', async () => {
    // W1 takes 101 as a paid error, but every read back still shows 100.
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    await runSdkWrite(async () => { throw { code: 40106, message: 'Document X has invalid revision' } })
    // W2 reads 100, its SDK signs 102 past its own last nonce, and its answer is lost.
    await lostAnswer(100)
    expect(loadReservation(OWNER, CONTRACT)?.pending[0]).toMatchObject({ signedAfter: n(101), signedAtMost: n(102) })
    // Another tab now reads W1's 101: W2 still holds writes back.
    expect(stillPending(n(101), loadReservation(OWNER, CONTRACT))).toHaveLength(1)
    expect(allocateNonce(n(101), loadReservation(OWNER, CONTRACT))).toBeNull()
  })

  it('keeps a floor it raised when localStorage refused to store it', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const outcome = settle(withSdkSignedWrite(OWNER, CONTRACT, async () => {
      storageFull.value = true
      return 'sent'
    }))
    expect(await outcome).toEqual({ ok: true, value: 'sent' })
    storageFull.value = false
    // Stored: floor 100 and the entry; read back: neither the entry nor the lower floor.
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ floor: n(101), pending: [] })
    expect(reserveNonce(OWNER, CONTRACT, null, n(100))).toMatchObject({ signedAfter: n(101) })
  })

  it('counts a refusal as spent when Platform shows it took a nonce (a paid error)', async () => {
    sdk.identities.contractNonce.mockResolvedValueOnce(n(100)).mockResolvedValue(n(101))
    await runSdkWrite(async () => { throw { code: 40106, message: 'Document X has invalid revision' } })
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ floor: n(101), pending: [] })
  })

  it('counts a confirmation Platform does not show yet as having taken the last nonce it may carry', async () => {
    // A refused create left the mark at 101, so the SDK may sign 101 or 102.
    releaseNonce(OWNER, CONTRACT, reserveNonce(OWNER, CONTRACT, n(101), n(100)))
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    expect(await runSdkWrite(async () => 'sent')).toEqual({ ok: true, value: 'sent' })
    expect(loadReservation(OWNER, CONTRACT)?.floor).toBe(n(102))
  })

  it('stops raising a floor that is above the tip once the SDK signs below the range', async () => {
    // An earlier confirmation Platform never showed left the floor at 102 while the tip is 101.
    releaseNonce(OWNER, CONTRACT, reserveNonce(OWNER, CONTRACT, n(102), n(101)), n(102))
    // The SDK, fresh, signs 102 (below the range 103..103); Platform then shows 102.
    sdk.identities.contractNonce.mockResolvedValueOnce(n(101)).mockResolvedValue(n(102))
    expect(await runSdkWrite(async () => 'sent')).toEqual({ ok: true, value: 'sent' })
    expect(loadReservation(OWNER, CONTRACT)?.floor).toBe(n(102))
  })

  it('counts its minute from when the answer was lost, however long the SDK took to lose it', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const slow = () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('transport error: Failed to fetch')), 70_000))
    expect((await runSdkWrite(slow)).ok).toBe(false)
    const lostAt = Date.now()
    expect(stillPending(n(100), loadReservation(OWNER, CONTRACT), lostAt + MINUTE - 1)).toHaveLength(1)
    expect(stillPending(n(100), loadReservation(OWNER, CONTRACT), lostAt + MINUTE + 1)).toEqual([])
  })

  it('holds every write back while Platform does not show the nonce after that tip consumed', async () => {
    await lostAnswer(100)
    const next = vi.fn(async () => 'sent')

    expect(await runSdkWrite(next)).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
    expect(next).not.toHaveBeenCalled()
    expect(await nextCreateNonce()).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBeNull()
  })

  it('lets every later write go once it landed: a replace, a delete, a create, a token action', async () => {
    await lostAnswer(100)
    // It landed at 101.
    sdk.identities.contractNonce.mockResolvedValue(n(101))
    const next = vi.fn(async () => 'sent')

    expect(await nextCreateNonce()).toEqual({ ok: true, value: n(102) })
    expect(await runSdkWrite(next)).toEqual({ ok: true, value: 'sent' })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('lets the write that follows wait the few seconds a node takes to show it landed', async () => {
    await lostAnswer(100)
    sdk.identities.contractNonce.mockResolvedValueOnce(n(100)).mockResolvedValueOnce(n(100)).mockResolvedValue(n(101))
    expect(await runSdkWrite(async () => 'sent')).toEqual({ ok: true, value: 'sent' })
  })

  it('is settled when another transition took that nonce: it can no longer execute', async () => {
    await lostAnswer(100)
    // Tip 103 with 101 among the missing (bit 40 + (103 - 101 - 1)): 101 is not consumed.
    const withMissing101 = n(103) | (BigInt(1) << BigInt(41))
    expect(stillPending(withMissing101, loadReservation(OWNER, CONTRACT))).toHaveLength(1)
    expect(stillPending(n(103), loadReservation(OWNER, CONTRACT))).toEqual([])
  })

  it('stops holding writes back after a minute when Platform never shows that nonce, and nothing built takes it', async () => {
    await lostAnswer(100)
    const later = Date.now() + MINUTE + 1
    expect(stillPending(n(100), loadReservation(OWNER, CONTRACT), later)).toEqual([])
    // Past the nonce it may still carry, should it execute late.
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT), later)).toBe(n(102))
  })

  it('signs past the floor, not a tip a lagging node reports behind this browser\'s own writes', async () => {
    // A replace confirmed with Platform at 100: it took 101.
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    expect(await runSdkWrite(async () => 'sent')).toEqual({ ok: true, value: 'sent' })
    expect(loadReservation(OWNER, CONTRACT)?.floor).toBe(n(101))

    // The next one reads a node still at 100, while the SDK reads one at 101 and signs 102.
    await lostAnswer(100)
    expect(loadReservation(OWNER, CONTRACT)?.pending[0]).toMatchObject({ signedAfter: n(101) })
    // 101 consumed proves nothing about 102.
    expect(stillPending(n(101), loadReservation(OWNER, CONTRACT))).toHaveLength(1)
    expect(stillPending(n(102), loadReservation(OWNER, CONTRACT))).toEqual([])
  })

  it('takes the floor from creates that took their nonce, but not from one refused at broadcast', () => {
    const confirmed = reserveNonce(OWNER, CONTRACT, n(101), n(100))
    releaseNonce(OWNER, CONTRACT, confirmed, n(101))
    expect(loadReservation(OWNER, CONTRACT)?.floor).toBe(n(101))

    const refused = reserveNonce(OWNER, CONTRACT, n(102), n(100))
    releaseNonce(OWNER, CONTRACT, refused)
    expect(loadReservation(OWNER, CONTRACT)).toMatchObject({ mark: n(102), floor: n(101) })
    // An SDK-signed write now signs past 101, the nonce Platform has executed, and at most past the mark.
    expect(reserveNonce(OWNER, CONTRACT, null, n(100))).toMatchObject({ signedAfter: n(101), signedAtMost: n(103) })
  })

  it('reads an entry stored without its range (or with the missing-revision bits) as one that only expires', async () => {
    await lostAnswer(100)
    const [key] = [...storage.keys()]
    const stored = JSON.parse(storage.get(key) ?? '{}') as { floor?: string; pending: Record<string, unknown>[] }
    delete stored.floor
    for (const p of stored.pending) {
      delete p.signedAtMost
      p.signedAfter = ((BigInt(1) << BigInt(45)) | n(100)).toString()
    }
    storage.set(key, JSON.stringify(stored))
    vi.resetModules()
    const reloaded = await import('./identity-nonce')

    const reservation = reloaded.loadReservation(OWNER, CONTRACT)
    expect(reservation?.floor).toBe(n(0))
    expect(reservation?.pending[0]).not.toHaveProperty('signedAfter')
    expect(reloaded.stillPending(n(105), reservation)).toHaveLength(1)
    expect(reloaded.stillPending(n(105), reservation, Date.now() + 2 * MINUTE)).toEqual([])
  })

  it('is seen by every tab, and settled by every tab once it landed', async () => {
    await lostAnswer(100)
    vi.resetModules()
    const otherTab = await import('./identity-nonce')
    expect(otherTab.allocateNonce(n(100), otherTab.loadReservation(OWNER, CONTRACT))).toBeNull()
    expect(otherTab.allocateNonce(n(101), otherTab.loadReservation(OWNER, CONTRACT))).toBe(n(102))
  })
})

describe('settlePendingWrites', () => {
  it('drops what Platform shows can no longer execute and keeps the rest', async () => {
    await lostAnswer(100)
    reserveNonce(OWNER, CONTRACT, n(102), n(100))
    sdk.identities.contractNonce.mockResolvedValue(n(101))

    expect(await settle(settlePendingWrites(OWNER, CONTRACT))).toEqual({ ok: true, value: 1 })
    expect(loadReservation(OWNER, CONTRACT)?.pending.map((p) => p.nonce)).toEqual([n(102)])
  })

  it('drops nothing when the nonce cannot be read: a failure proves nothing', async () => {
    await lostAnswer(100)
    sdk.identities.contractNonce.mockRejectedValue(new Error('no available addresses'))

    expect(await settle(settlePendingWrites(OWNER, CONTRACT))).toEqual({ ok: true, value: 0 })
    expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(1)
  })

  it('reads nothing when nothing is pending', async () => {
    expect(await settle(settlePendingWrites(OWNER, CONTRACT))).toEqual({ ok: true, value: 0 })
    expect(sdk.identities.contractNonce).not.toHaveBeenCalled()
  })
})

describe('a transition whose nonce is known (a create, a wallet request)', () => {
  it('stays pending, however long ago, until Platform shows its nonce consumed', async () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    vi.setSystemTime(Date.now() + 60 * MINUTE)
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const write = vi.fn(async () => 'sent')

    const blocked = await runSdkWrite(write)

    expect(write).not.toHaveBeenCalled()
    expect(blocked).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(102))

    sdk.identities.contractNonce.mockResolvedValue(n(101))
    expect(await runSdkWrite(write)).toEqual({ ok: true, value: 'sent' })
  })

  it('never holds back a create, whose nonce goes past it', async () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    expect(await nextCreateNonce()).toEqual({ ok: true, value: n(102) })
  })
})

describe('allocateNonce', () => {
  it('goes past every nonce this browser chose, whether or not it executed, and whatever a lagging node reports', () => {
    const entry = reserveNonce(OWNER, CONTRACT, n(101), n(100))
    releaseNonce(OWNER, CONTRACT, entry)
    expect(allocateNonce(n(99), loadReservation(OWNER, CONTRACT))).toBe(n(102))
  })

  it('does not treat a pending nonce as settled because a lagging node reports a lower tip', () => {
    reserveNonce(OWNER, CONTRACT, n(105), n(104))
    expect(stillPending(n(100), loadReservation(OWNER, CONTRACT))).toHaveLength(1)
    expect(stillPending(n(105), loadReservation(OWNER, CONTRACT))).toHaveLength(0)
  })

  it('refuses to hand out a nonce when the only one Drive accepts may still be taken by a pending transition', () => {
    for (let nonce = 101; nonce <= 124; nonce++) reserveNonce(OWNER, CONTRACT, n(nonce), n(100))
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBeNull()
  })

  it('falls back to the one after the tip once nothing signed may still execute', () => {
    const entries = []
    for (let nonce = 101; nonce <= 124; nonce++) entries.push(reserveNonce(OWNER, CONTRACT, n(nonce), n(100)))
    for (const entry of entries) releaseNonce(OWNER, CONTRACT, entry)
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(101))
  })
})

describe('localStorage, the one store every tab shares', () => {
  it('is where a reservation lives: another tab (a fresh module) sees it and goes past it', async () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    vi.resetModules()
    const otherTab = await import('./identity-nonce')
    expect(otherTab.allocateNonce(n(100), otherTab.loadReservation(OWNER, CONTRACT))).toBe(n(102))
  })

  it('refuses to reserve when it cannot store, so nothing is signed that another tab could not see', () => {
    storageFull.value = true
    expect(() => reserveNonce(OWNER, CONTRACT, n(101), n(100))).toThrow(PENDING_STORE)
    storageFull.value = false
    expect(loadReservation(OWNER, CONTRACT)).toBeNull()
  })

  it('does not run an SDK-signed write it cannot record as pending', async () => {
    storageFull.value = true
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const write = vi.fn(async () => 'sent')

    const outcome = await runSdkWrite(write)

    expect(write).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: false, error: new Error(NONCE_STORE_ERROR) })
  })

  it('never brings a released entry back when the release could not be stored', () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    const entry = reserveNonce(OWNER, CONTRACT, null, n(100))
    storageFull.value = true
    releaseNonce(OWNER, CONTRACT, entry)
    storageFull.value = false
    expect(loadReservation(OWNER, CONTRACT)?.pending.map((p) => p.nonce)).toEqual([n(101)])
    // Past 102 too: the SDK may have signed it.
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(103))
  })

  it('gives every pending entry its own id, even on the same clock tick in two tabs, so releasing one never releases another', async () => {
    vi.setSystemTime(1_000_000)
    vi.resetModules()
    const tabA = await import('./identity-nonce')
    vi.resetModules()
    const tabB = await import('./identity-nonce')
    const first = tabA.reserveNonce(OWNER, CONTRACT, n(101), n(100))
    const second = tabB.reserveNonce(OWNER, CONTRACT, n(102), n(100))
    expect(second.id).not.toBe(first.id)
    tabB.releaseNonce(OWNER, CONTRACT, second)
    expect(tabA.loadReservation(OWNER, CONTRACT)?.pending.map((p) => p.nonce)).toEqual([n(101)])
  })
})
