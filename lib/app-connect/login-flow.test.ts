import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import type { AppConnectCandidate, AppConnectGrant, AppConnectVerification, VerifyAppConnectCandidateInput } from 'platform-auth'
import { AppConnectLogin, parseStoredRequest, type AppConnectLoginState, type StoredAppConnectRequest } from './login-flow'
import type { AppConnectPlatformPort } from './platform-port'

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const ALICE = id(10)
const BOB = id(11)
const pins = { appId: id(1), groupId: id(2), groupOwner: id(3), members: [{ contractId: id(1), version: 1 }] }
const T0 = 1_791_676_800_000

function candidate(ownerId: string, fill = 1): AppConnectCandidate {
  return { ownerId, walletEphemeralPubKey: new Uint8Array(33).fill(fill), encryptedPayload: new Uint8Array(124).fill(fill) }
}

function grant(identityId: string): AppConnectGrant {
  return { identityId, authKeys: [{ role: 'contractGroup', bindingIndex: 0, privateKey: new Uint8Array(32).fill(9), key: { id: 5, type: 0, purpose: 0, securityLevel: 1, data: new Uint8Array(33) } }], encryptionKeys: [] }
}

interface Harness {
  login: AppConnectLogin
  states: AppConnectLoginState[]
  setCandidates: (list: AppConnectCandidate[]) => void
  records: { value: StoredAppConnectRequest | null }
  clock: { now: number }
  verified: string[]
  flush: () => Promise<void>
}

function harness(options: {
  protocolVersion?: number
  trusted?: boolean
  verify?: (input: VerifyAppConnectCandidateInput) => AppConnectVerification
} = {}): Harness {
  let candidates: AppConnectCandidate[] = []
  const clock = { now: T0 }
  const records = { value: null as StoredAppConnectRequest | null }
  const verified: string[] = []
  const port = {
    chainStatus: async () => ({ protocolVersion: options.protocolVersion ?? 14, blockTimeMs: clock.now }),
    listCandidates: async (_hash: Uint8Array, hint: string | undefined) => candidates.filter((c) => !hint || c.ownerId === hint),
  } as unknown as AppConnectPlatformPort
  const login = new AppConnectLogin({
    pins,
    network: 'devnet',
    port,
    trust: async () => (options.trusted === false
      ? { ok: false, reason: 'unexpected-members', group: { groupId: pins.groupId, members: [] } }
      : { ok: true, group: { groupId: pins.groupId, members: [] } }),
    connectionId: async () => 'ab'.repeat(16),
    records: {
      load: async () => records.value,
      save: async (r) => { records.value = r },
      clear: async () => { records.value = null },
    },
    origin: 'https://yap.pr',
    basePath: '/devnet',
    now: () => clock.now,
    // Each sleep advances the clock instead of waiting.
    sleep: async (ms) => {
      clock.now += ms
      await Promise.resolve()
    },
    verify: async (input) => {
      verified.push(input.candidate.ownerId)
      return options.verify?.(input) ?? { ok: true, grant: grant(input.candidate.ownerId) }
    },
  })
  const states: AppConnectLoginState[] = []
  login.subscribe((state) => states.push(state))
  return {
    login,
    states,
    setCandidates: (list) => { candidates = list },
    records,
    clock,
    verified,
    flush: async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve()
    },
  }
}

const last = (h: Harness) => h.states[h.states.length - 1]

describe('AppConnectLogin', () => {
  it('shows the QR code, then the verified identity for confirmation', async () => {
    const h = harness()
    await h.login.start()
    expect(last(h)).toMatchObject({ phase: 'waiting' })
    const waiting = last(h) as { uri: string }
    expect(waiting.uri).toMatch(/^dash-key:\w+\?n=d&v=2&cb=https%3A%2F%2Fyap\.pr%2Fdevnet%2Fconnect%2F%3Fr%3D[0-9a-f]{40}$/)
    expect(h.records.value?.createdAt).toBe(T0)

    h.setCandidates([candidate(ALICE)])
    h.login.pollNow()
    await h.flush()
    expect(last(h)).toMatchObject({ phase: 'confirm', candidates: [{ identityId: ALICE }] })
  })

  it('offers a chooser when several identities answer, and wipes the ones not chosen', async () => {
    const h = harness()
    h.setCandidates([candidate(ALICE), candidate(BOB, 2)])
    await h.login.start()
    await h.flush()
    const state = last(h)
    expect(state).toMatchObject({ phase: 'confirm' })
    const candidates = (state as { candidates: { identityId: string; grant: AppConnectGrant }[] }).candidates
    expect(candidates.map((c) => c.identityId)).toEqual([ALICE, BOB])

    const chosen = h.login.accept(BOB)
    expect(chosen?.identityId).toBe(BOB)
    expect(chosen?.authKeys[0].privateKey.every((b) => b === 9)).toBe(true)
    expect(candidates[0].grant.authKeys[0].privateKey.every((b) => b === 0)).toBe(true)
    expect(h.records.value).toBeNull()
  })

  it('"That\'s not me" starts a new request', async () => {
    const h = harness()
    h.setCandidates([candidate(ALICE)])
    await h.login.start()
    await h.flush()
    const firstHash = h.login.requestHashHex()
    h.setCandidates([])
    await h.login.reject()
    expect(last(h)).toMatchObject({ phase: 'waiting' })
    expect(h.login.requestHashHex()).not.toBe(firstHash)
  })

  it('accepts only the hinted identity on renewal', async () => {
    const h = harness()
    h.setCandidates([candidate(BOB, 2), candidate(ALICE)])
    await h.login.start({ identityHint: ALICE })
    await h.flush()
    expect(h.verified).toEqual([ALICE])
    expect(last(h)).toMatchObject({ phase: 'confirm', candidates: [{ identityId: ALICE }] })
  })

  it('drops a candidate that fails verification and keeps waiting', async () => {
    const h = harness({ verify: () => ({ ok: false, reason: 'decrypt', retryable: false }) })
    h.setCandidates([candidate(ALICE)])
    await h.login.start()
    await h.flush()
    h.login.pollNow()
    await h.flush()
    expect(h.verified).toEqual([ALICE])
    expect(last(h)).toMatchObject({ phase: 'waiting' })
  })

  it('retries a candidate whose keys are not visible yet, at most three times', async () => {
    const h = harness({ verify: () => ({ ok: false, reason: 'key-not-found', retryable: true }) })
    h.setCandidates([candidate(ALICE)])
    await h.login.start()
    for (let i = 0; i < 6; i++) {
      await h.flush()
      h.login.pollNow()
    }
    await h.flush()
    expect(h.verified).toEqual([ALICE, ALICE, ALICE])
  })

  it('times out silently after ten minutes and checks the same request again', async () => {
    const h = harness()
    await h.login.start()
    const hash = h.login.requestHashHex()
    h.clock.now += 10 * 60_000
    h.login.pollNow()
    await h.flush()
    expect(last(h)).toMatchObject({ phase: 'timeout' })
    await h.login.checkAgain()
    expect(last(h)).toMatchObject({ phase: 'waiting' })
    expect(h.login.requestHashHex()).not.toBe(hash)
  })

  it('resumes a stored request after a reload', async () => {
    const h = harness()
    await h.login.start()
    const hash = h.login.requestHashHex()
    h.login.dispose()
    const again = harness()
    again.records.value = h.records.value
    await again.login.start()
    expect(again.login.requestHashHex()).toBe(hash)
  })

  it('is unavailable before protocol 14 or when the group is not the pinned one', async () => {
    const old = harness({ protocolVersion: 13 })
    await old.login.start()
    expect(last(old)).toEqual({ phase: 'unavailable', reason: 'network-not-ready' })
    const untrusted = harness({ trusted: false })
    await untrusted.login.start()
    expect(last(untrusted)).toEqual({ phase: 'unavailable', reason: 'untrusted' })
    expect(untrusted.records.value).toBeNull()
  })
})

describe('AppConnectLogin teardown', () => {
  it('a dispose while start is still checking stops it: no request, no polling', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness()
    const port = (h.login as unknown as { deps: { port: { chainStatus: () => Promise<unknown> } } }).deps.port
    const chainStatus = port.chainStatus
    port.chainStatus = async () => { await gate; return chainStatus() }

    const starting = h.login.start()
    h.login.dispose()
    release()
    await starting
    await h.flush()
    expect(h.records.value).toBeNull()
    expect(h.login.requestHashHex()).toBeNull()
  })

  it('wipes the previous ephemeral key when a new request replaces it', async () => {
    const h = harness()
    await h.login.start()
    const first = (h.login as unknown as { active: { privateKey: Uint8Array } }).active.privateKey
    await h.login.start({ fresh: true })
    expect(first.every((byte) => byte === 0)).toBe(true)
  })

  it('keeps a live request across an unmount and forgets an expired one', async () => {
    const live = harness()
    await live.login.start()
    live.login.dispose()
    await live.flush()
    expect(live.records.value).not.toBeNull()

    const expired = harness()
    await expired.login.start()
    expired.clock.now += 10 * 60_000
    expired.login.dispose()
    await expired.flush()
    expect(expired.records.value).toBeNull()
  })

  it('wipes an answer an identity replaced by republishing', async () => {
    const grants: AppConnectGrant[] = []
    const h = harness({
      verify: (input) => {
        const g = grant(input.candidate.ownerId)
        grants.push(g)
        return { ok: true, grant: g }
      },
    })
    h.setCandidates([candidate(ALICE, 1)])
    await h.login.start()
    await h.flush()
    // Alice publishes a different answer to the same request; it is verified again.
    await h.login.checkAgain()
    h.setCandidates([candidate(ALICE, 3)])
    h.login.pollNow()
    await h.flush()
    expect(grants).toHaveLength(2)
    expect(grants[0].authKeys[0].privateKey.every((byte) => byte === 0)).toBe(true)
    expect(grants[1].authKeys[0].privateKey.every((byte) => byte === 9)).toBe(true)
  })
})

describe('parseStoredRequest', () => {
  const record = { ephemeralPrivateKey: '11'.repeat(32), createdAt: T0, connectionId: 'ab'.repeat(16) }

  it('accepts a fresh record and refuses a stale or malformed one', () => {
    expect(parseStoredRequest(record, T0 + 1000)).toEqual(record)
    expect(parseStoredRequest(record, T0 + 10 * 60_000)).toBeNull()
    expect(parseStoredRequest({ ...record, ephemeralPrivateKey: 'zz' }, T0)).toBeNull()
    expect(parseStoredRequest({ ...record, connectionId: 5 }, T0)).toBeNull()
    expect(parseStoredRequest(null, T0)).toBeNull()
  })
})
