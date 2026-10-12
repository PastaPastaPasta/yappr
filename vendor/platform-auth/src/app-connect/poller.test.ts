import bs58 from 'bs58'
import { describe, expect, it, vi } from 'vitest'
import {
  appConnectCandidateKey,
  appConnectPollDelayMs,
  listAppConnectCandidates,
  type AppConnectCandidate,
  type AppConnectResponsePort,
} from './poller'

/** Ids with distinct leading bytes, so byte order is obvious; one has a leading zero byte (shorter base58). */
const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n * 16 : 7))))

function candidate(ownerId: string): AppConnectCandidate {
  return { ownerId, walletEphemeralPubKey: new Uint8Array(33).fill(2), encryptedPayload: new Uint8Array(60) }
}

/** A port over `owners` that honours the cursor, the hint and the limit like Platform does. */
function port(owners: string[]): AppConnectResponsePort & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    async listCandidates(_hash, hint, startAfter, limit) {
      calls.push([hint, startAfter, limit])
      const after = startAfter === undefined ? 0 : owners.indexOf(startAfter) + 1
      return owners.slice(after).filter((o) => hint === undefined || o === hint).slice(0, limit).map(candidate)
    },
  }
}

describe('listAppConnectCandidates', () => {
  it('pages with the last owner as cursor until a short page', async () => {
    const p = port(ids.slice(0, 7))
    const { candidates, truncated } = await listAppConnectCandidates(p, new Uint8Array(20), { pageSize: 3 })
    expect(candidates.map((c) => c.ownerId)).toEqual(ids.slice(0, 7))
    expect(truncated).toBe(false)
    expect(p.calls).toEqual([[undefined, undefined, 3], [undefined, ids[2], 3], [undefined, ids[5], 3]])
  })

  it('stops at maxCandidates and reports truncation', async () => {
    const { candidates, truncated } = await listAppConnectCandidates(port(ids), new Uint8Array(20), { pageSize: 5, maxCandidates: 8 })
    expect(candidates).toHaveLength(8)
    expect(truncated).toBe(true)
  })

  it('passes the hint and drops anything else a port returns', async () => {
    const sloppy: AppConnectResponsePort = { listCandidates: async () => [candidate(ids[1]), candidate(ids[2])] }
    const { candidates } = await listAppConnectCandidates(sloppy, new Uint8Array(20), { hint: ids[2] })
    expect(candidates.map((c) => c.ownerId)).toEqual([ids[2]])
    const p = port(ids)
    await listAppConnectCandidates(p, new Uint8Array(20), { hint: ids[4] })
    expect(p.calls[0][0]).toBe(ids[4])
  })

  it('stops when a port ignores the cursor instead of looping', async () => {
    const listCandidates = vi.fn(async () => [candidate(ids[0]), candidate(ids[1])])
    const { candidates } = await listAppConnectCandidates({ listCandidates }, new Uint8Array(20), { pageSize: 2 })
    expect(candidates.map((c) => c.ownerId)).toEqual([ids[0], ids[1]])
    expect(listCandidates).toHaveBeenCalledTimes(2)
  })

  it('orders the cursor by bytes, not by base58 text', async () => {
    // ids[0] has a leading zero byte, so its base58 form is shorter and sorts oddly as text.
    expect(ids[0].length).toBeLessThan(ids[1].length)
    const { candidates } = await listAppConnectCandidates(port(ids.slice(0, 4)), new Uint8Array(20), { pageSize: 1 })
    expect(candidates.map((c) => c.ownerId)).toEqual(ids.slice(0, 4))
  })
})

describe('appConnectPollDelayMs', () => {
  it('polls every 2 s for a minute, then every 4 s, and stops at 10 minutes', () => {
    expect(appConnectPollDelayMs(0)).toBe(2000)
    expect(appConnectPollDelayMs(59_999)).toBe(2000)
    expect(appConnectPollDelayMs(60_000)).toBe(4000)
    expect(appConnectPollDelayMs(10 * 60_000 - 1)).toBe(4000)
    expect(appConnectPollDelayMs(10 * 60_000)).toBeNull()
  })
})

describe('appConnectCandidateKey', () => {
  it('changes when a response is republished with different contents', () => {
    const a = candidate(ids[1])
    const b = { ...a, encryptedPayload: Uint8Array.from(a.encryptedPayload, (_, i) => (i === 0 ? 1 : 0)) }
    expect(appConnectCandidateKey(a)).toBe(appConnectCandidateKey(candidate(ids[1])))
    expect(appConnectCandidateKey(a)).not.toBe(appConnectCandidateKey(b))
    expect(appConnectCandidateKey(a).startsWith(`${ids[1]}:`)).toBe(true)
  })
})
