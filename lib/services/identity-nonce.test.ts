/**
 * QA D-01 review findings on nonce bookkeeping: an SDK-signed write must never
 * run while a transition this browser signed may still execute (the polling
 * budget used to lapse into the write); nothing may take a nonce while an
 * SDK-signed transition whose nonce is unknown may still execute; the mark
 * never goes down; and nothing is signed unless its reservation is stored
 * where every tab sees it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  identities: { contractNonce: vi.fn() },
  documents: { get: vi.fn() },
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
import { WRITE_PRECONDITION_FAILED, allocateNonce, loadReservation, releaseNonce, reserveNonce, settleSupersededReplaces, stillPending, withSdkSignedWrite } from './identity-nonce'

const n = (value: number) => BigInt(value)
const PENDING_STORE = NONCE_STORE_ERROR
let owner = 0
let OWNER = ''
const CONTRACT = 'contract'

beforeEach(() => {
  storage.clear()
  storageFull.value = false
  // A fresh identity per test: this tab's in-memory copies are module state.
  OWNER = `owner-${++owner}`
  sdk.identities.contractNonce.mockReset()
  sdk.documents.get.mockReset()
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

describe('reservation scope', () => {
  it('stores and reads back what a transition writes, and leaves it absent when unnamed', () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100), undefined, 'pollr-vote:p1')
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
    const outcome = withSdkSignedWrite(OWNER, CONTRACT, write, undefined, undefined, async () => false).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
    await vi.runAllTimersAsync()

    expect(await outcome).toEqual({ ok: false, error: new Error(WRITE_PRECONDITION_FAILED) })
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
    const outcome = withSdkSignedWrite(OWNER, CONTRACT, async () => 'sent', undefined, undefined, precondition)
    await vi.runAllTimersAsync()

    expect(await outcome).toBe('sent')
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

  it('releases an SDK write the network refused', async () => {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const refused = await runSdkWrite(async () => { throw { code: 40106, message: 'Document X has invalid revision' } })
    expect(refused.ok).toBe(false)
    expect(loadReservation(OWNER, CONTRACT)?.pending).toEqual([])
  })
})

describe('an SDK-signed write whose outcome is unknown', () => {
  // Its nonce is whatever the SDK picked, from its cache or a node this code
  // never sees: 101, or 102 if that node was a block ahead.
  async function timedOutSdkWrite() {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const outcome = await runSdkWrite(async () => { throw new Error('waitForResponse timed out') })
    expect(outcome.ok).toBe(false)
  }

  it('holds up the next SDK-signed write even once the tip moves past some nonce it could have used', async () => {
    await timedOutSdkWrite()
    // Tip 101: the SDK write may have executed at 101, or signed 102 and still be waiting.
    sdk.identities.contractNonce.mockResolvedValue(n(101))
    const next = vi.fn(async () => 'sent')

    const outcome = await runSdkWrite(next)

    expect(next).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
  })

  it('gives a create no nonce at all, whatever node the create reads', () => {
    return timedOutSdkWrite().then(() => {
      for (const tip of [100, 101, 102]) expect(allocateNonce(n(tip), loadReservation(OWNER, CONTRACT))).toBeNull()
    })
  })

  it('stops holding writes up once it is too old to execute', async () => {
    await timedOutSdkWrite()
    const later = Date.now() + 16 * 60 * 1000
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT), later)).toBe(n(101))
  })
})

describe('settleSupersededReplaces: an SDK-signed replace Platform shows superseded', () => {
  const REPLACE = { documentType: 'dmSelfState', documentId: 'doc-1', revision: 3 }

  /** A replace of doc-1 to revision 3 whose answer was lost after the broadcast. */
  async function lostReplace(replaces: typeof REPLACE | null = REPLACE) {
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const outcome = withSdkSignedWrite(OWNER, CONTRACT, async () => { throw new Error('transport error: Failed to fetch') }, replaces ?? undefined)
      .then(() => undefined, () => undefined)
    await vi.runAllTimersAsync()
    await outcome
    expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(1)
  }

  async function settle() {
    const settled = settleSupersededReplaces(OWNER, CONTRACT)
    await vi.runAllTimersAsync()
    return settled
  }

  it('stores what the replace writes, and the nonce Platform reported before it, with its pending entry, for every tab', async () => {
    await lostReplace()
    expect(loadReservation(OWNER, CONTRACT)?.pending[0]).toMatchObject({ replaces: REPLACE, signedAfter: n(100) })
  })

  it('releases it once the document is at its revision or later and the next nonce is consumed, and the next SDK-signed write runs', async () => {
    await lostReplace()
    sdk.identities.contractNonce.mockResolvedValue(n(101))
    sdk.documents.get.mockResolvedValue({ $revision: 3 })
    expect(await settle()).toBe(1)
    expect(sdk.documents.get).toHaveBeenCalledWith(CONTRACT, 'dmSelfState', 'doc-1')
    expect(loadReservation(OWNER, CONTRACT)?.pending).toEqual([])
    const next = vi.fn(async () => 'sent')
    expect(await runSdkWrite(next)).toEqual({ ok: true, value: 'sent' })

    await lostReplace()
    sdk.identities.contractNonce.mockResolvedValue(n(101))
    sdk.documents.get.mockResolvedValue({ $revision: 5 })
    expect(await settle()).toBe(1)
  })

  it('keeps it pending while the nonce after the reported one is unconsumed: a stale-revision replace may still execute', async () => {
    await lostReplace()
    sdk.documents.get.mockResolvedValue({ $revision: 3 })
    expect(await settle()).toBe(0)
    expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(1)
  })

  it('keeps it pending while it may still execute, or when nothing can be proved', async () => {
    await lostReplace()
    sdk.identities.contractNonce.mockResolvedValue(n(101))
    for (const answer of [
      () => sdk.documents.get.mockResolvedValue({ $revision: 2 }),
      () => sdk.documents.get.mockResolvedValue(undefined),
      () => sdk.documents.get.mockRejectedValue(new Error('no available addresses')),
    ]) {
      answer()
      expect(await settle()).toBe(0)
      expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(1)
    }
  })

  it('never touches an SDK-signed write that named no replace, nor one whose nonce is known', async () => {
    await lostReplace(null)
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    sdk.documents.get.mockResolvedValue({ $revision: 99 })
    expect(await settle()).toBe(0)
    expect(sdk.documents.get).not.toHaveBeenCalled()
    expect(loadReservation(OWNER, CONTRACT)?.pending).toHaveLength(2)
  })
})

describe('a transition whose nonce is known (a create, a wallet request)', () => {
  it('stays pending, however long ago, until Platform shows its nonce consumed', async () => {
    reserveNonce(OWNER, CONTRACT, n(101), n(100))
    vi.setSystemTime(Date.now() + 60 * 60 * 1000)
    sdk.identities.contractNonce.mockResolvedValue(n(100))
    const write = vi.fn(async () => 'sent')

    const blocked = await runSdkWrite(write)

    expect(write).not.toHaveBeenCalled()
    expect(blocked).toEqual({ ok: false, error: new Error(PENDING_WRITE_ERROR) })
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(102))

    sdk.identities.contractNonce.mockResolvedValue(n(101))
    expect(await runSdkWrite(write)).toEqual({ ok: true, value: 'sent' })
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
    expect(allocateNonce(n(100), loadReservation(OWNER, CONTRACT))).toBe(n(102))
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
