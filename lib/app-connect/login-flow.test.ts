import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { appConnectRequestHash, parseAppConnectUri } from 'platform-auth'
import type { AppConnectCandidate, AppConnectGrant, AppConnectVerification, VerifyAppConnectCandidateInput } from 'platform-auth'
import { bytesToHex } from '@/lib/bytes'
import { AppConnectLogin, parseStoredRequest, type AppConnectAcceptance, type AppConnectLoginState, type StoredAppConnectRequest } from './login-flow'
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
  network?: 'mainnet' | 'testnet' | 'devnet'
  carriers?: readonly ['dashpay' | 'dash-key', ...('dashpay' | 'dash-key')[]]
  verify?: (input: VerifyAppConnectCandidateInput) => AppConnectVerification
  beforeHandout?: (current: () => boolean) => Promise<boolean>
  /** Shared with another harness: one browser's pending-request slot, seen from two tabs. */
  records?: { value: StoredAppConnectRequest | null }
  returnTo?: string
  registerUsername?: boolean
  callbackRequestHash?: string
  onCarry?: (requestHashHex: string) => void
  /** Runs before the stored request is taken. */
  beforeTake?: () => Promise<void>
} = {}): Harness {
  let candidates: AppConnectCandidate[] = []
  const clock = { now: T0 }
  const records = options.records ?? { value: null as StoredAppConnectRequest | null }
  const verified: string[] = []
  const port = {
    chainStatus: async () => ({ protocolVersion: options.protocolVersion ?? 14, blockTimeMs: clock.now }),
    listCandidates: async (_hash: Uint8Array, hint: string | undefined) => candidates.filter((c) => !hint || c.ownerId === hint),
  } as unknown as AppConnectPlatformPort
  const login = new AppConnectLogin({
    pins,
    network: options.network ?? 'devnet',
    ...(options.carriers ? { carriers: options.carriers } : {}),
    port,
    trust: async () => (options.trusted === false
      ? { ok: false, reason: 'unexpected-members', group: { groupId: pins.groupId, members: [] } }
      : { ok: true, group: { groupId: pins.groupId, members: [] } }),
    connectionId: async () => 'ab'.repeat(16),
    records: {
      load: async () => records.value,
      save: async (r) => { records.value = r },
      clear: async (record) => { if (records.value?.ephemeralPrivateKey === record.ephemeralPrivateKey) records.value = null },
      take: async (record) => {
        await options.beforeTake?.()
        const ours = records.value?.ephemeralPrivateKey === record.ephemeralPrivateKey
        if (ours) records.value = null
        return ours
      },
    },
    origin: 'https://yap.pr',
    basePath: '/devnet',
    ...(options.beforeHandout ? { beforeHandout: options.beforeHandout } : {}),
    returnTo: options.returnTo,
    registerUsername: options.registerUsername,
    callbackRequestHash: options.callbackRequestHash,
    onCarry: options.onCarry,
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

  it('shows a dashpay://connect QR code when the carrier is dashpay, and on mainnet by default', async () => {
    const devnet = harness({ carriers: ['dashpay'] })
    await devnet.login.start()
    expect((last(devnet) as { uri: string }).uri).toMatch(/^dashpay:\/\/connect\?v=2&n=d&r=[\w-]+&cb=https%3A%2F%2Fyap\.pr%2Fdevnet%2Fconnect%2F%3Fr%3D[0-9a-f]{40}$/)

    const mainnet = harness({ network: 'mainnet' })
    await mainnet.login.start()
    expect((last(mainnet) as { uri: string }).uri).toMatch(/^dashpay:\/\/connect\?v=2&n=m&r=/)
  })

  it('renders one request in both carriers: dash-key: first, the same body, and one request to poll', async () => {
    const h = harness({ carriers: ['dash-key', 'dashpay'] })
    await h.login.start()
    const waiting = last(h) as Extract<AppConnectLoginState, { phase: 'waiting' }>
    expect(waiting.uris.map((entry) => entry.carrier)).toEqual(['dash-key', 'dashpay'])
    expect(waiting.uri).toBe(waiting.uris[0].uri)
    expect(waiting.uris[0].uri).toMatch(/^dash-key:/)
    expect(waiting.uris[1].uri).toMatch(/^dashpay:\/\/connect\?v=2&n=d&r=/)

    // Same bytes (base58 in one, base64url in the other), same return link.
    const [dashKey, dashpay] = waiting.uris.map((entry) => parseAppConnectUri(entry.uri))
    expect(bytesToHex(dashpay.requestBytes)).toBe(bytesToHex(dashKey.requestBytes))
    expect(dashpay.callbackUrl).toBe(dashKey.callbackUrl)
    expect(bytesToHex(appConnectRequestHash(dashpay.request))).toBe(h.login.requestHashHex())

    // One stored request, whichever URI a wallet reads.
    expect(h.records.value).not.toBeNull()
    const phases = h.states.map((state) => state.phase)
    expect(phases.filter((phase) => phase === 'waiting')).toHaveLength(1)

    // Checking again re-shows the same URIs without a new request.
    const key = h.records.value?.ephemeralPrivateKey
    await h.login.checkAgain()
    expect((last(h) as Extract<AppConnectLoginState, { phase: 'waiting' }>).uris).toEqual(waiting.uris)
    expect(h.records.value?.ephemeralPrivateKey).toBe(key)
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

  it('keeps polling while confirming, so a later second answer turns into the chooser', async () => {
    const h = harness()
    h.setCandidates([candidate(ALICE)])
    await h.login.start()
    await h.flush()
    expect(last(h)).toMatchObject({ phase: 'confirm', candidates: [{ identityId: ALICE }] })

    h.setCandidates([candidate(ALICE), candidate(BOB, 2)])
    h.login.pollNow()
    await h.flush()
    const state = last(h) as { phase: string; candidates: { identityId: string }[] }
    expect(state.phase).toBe('confirm')
    expect(state.candidates.map((c) => c.identityId)).toEqual([ALICE, BOB])
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

  it('asks before handing out a request it has chosen, and hands out none it is refused', async () => {
    const asked: (StoredAppConnectRequest | null)[] = []
    const ok = harness({ beforeHandout: async () => { asked.push(ok.records.value); return true } })
    await ok.login.start()
    expect(asked).toEqual([ok.records.value])
    expect(last(ok)).toMatchObject({ phase: 'waiting' })

    const refused = harness({ beforeHandout: async () => false })
    await refused.login.start()
    expect(last(refused)).toEqual({ phase: 'unavailable', reason: 'storage' })
    expect(refused.states.some((state) => state.phase === 'waiting')).toBe(false)
    await refused.flush()
    expect(refused.records.value).toBeNull()

    const offline = harness({ protocolVersion: 13, beforeHandout: async () => { throw new Error('not asked') } })
    await offline.login.start()
    expect(last(offline)).toEqual({ phase: 'unavailable', reason: 'network-not-ready' })
  })
})

describe('AppConnectLogin handout hook', () => {
  it('tells a hook still running that a newer start overtook it, and the overtaken start hands nothing out', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const overtaken: boolean[] = []
    let calls = 0
    const h = harness({
      beforeHandout: async (current) => {
        calls += 1
        if (calls > 1) return true
        await gate
        overtaken.push(!current())
        return true
      },
    })
    const first = h.login.start()
    await h.flush()
    expect(calls).toBe(1)
    await h.login.start()
    const waiting = h.states.filter((state) => state.phase === 'waiting').length
    expect(waiting).toBe(1)
    release()
    await first
    expect(overtaken).toEqual([true])
    expect(h.states.filter((state) => state.phase === 'waiting').length).toBe(waiting)
    expect(last(h)).toMatchObject({ phase: 'waiting' })
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

  it('a start superseded while preparing its request never stores it over the newer one', async () => {
    let releaseFirst: () => void = () => undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const h = harness()
    const deps = (h.login as unknown as { deps: { connectionId: () => Promise<string> } }).deps
    let calls = 0
    deps.connectionId = async () => {
      calls += 1
      if (calls === 1) await firstGate
      return 'ab'.repeat(16)
    }

    const first = h.login.start({ fresh: true })
    await h.flush()
    const second = h.login.start({ fresh: true })
    await second
    const stored = h.records.value
    releaseFirst()
    await first
    await h.flush()

    expect(stored).not.toBeNull()
    expect(h.records.value).toBe(stored)
    expect(h.login.requestHashHex()).not.toBeNull()
  })

  it('a finish while start is preparing its request stops it: nothing stored, activated or polled', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness()
    const deps = (h.login as unknown as { deps: { connectionId: () => Promise<string> } }).deps
    deps.connectionId = async () => {
      await gate
      return 'ab'.repeat(16)
    }

    const starting = h.login.start({ fresh: true })
    await h.flush()
    h.login.finish()
    release()
    await starting
    await h.flush()

    expect(h.records.value).toBeNull()
    expect(h.login.requestHashHex()).toBeNull()
  })

  it('a finish after start issued its save still clears the request and activates nothing', async () => {
    let releaseSave: () => void = () => undefined
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
    const h = harness()
    // An ordered store: the clear runs after the save already issued.
    let queue = Promise.resolve()
    const deps = (h.login as unknown as { deps: { records: { save: (r: StoredAppConnectRequest) => Promise<void>; clear: () => Promise<void> } } }).deps
    deps.records.save = (r) => (queue = queue.then(async () => { await saveGate; h.records.value = r }))
    deps.records.clear = () => (queue = queue.then(() => { h.records.value = null }))

    const starting = h.login.start({ fresh: true })
    await h.flush()
    h.login.finish()
    releaseSave()
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

describe('AppConnectLogin without storage', () => {
  it('says so instead of spinning when the connection id cannot be kept', async () => {
    const h = harness()
    ;(h.login as unknown as { deps: { connectionId: () => Promise<string> } }).deps.connectionId = async () => {
      throw new Error('IndexedDB is unavailable')
    }
    await h.login.start()
    expect(last(h)).toEqual({ phase: 'unavailable', reason: 'storage' })
  })
})

describe('AppConnectLogin and other tabs', () => {
  it('finishing never clears a newer request another tab stored in the same slot', async () => {
    const h = harness()
    await h.login.start()
    const newer: StoredAppConnectRequest = { ephemeralPrivateKey: '22'.repeat(32), createdAt: T0 + 1, connectionId: 'ab'.repeat(16) }
    h.records.value = newer
    h.login.finish()
    await h.flush()
    expect(h.records.value).toBe(newer)
  })
})

describe('AppConnectLogin return page', () => {
  /** The tab a sign-in starts on: its request, stored with `returnTo`. */
  async function origin(returnTo?: string) {
    const h = harness({ returnTo })
    await h.login.start()
    return { records: h.records, hash: h.login.requestHashHex() ?? '', h }
  }

  /** The wallet's callback tab: resumes the shared slot, naming the request the wallet returned for. */
  async function callbackTab(records: Harness['records'], callbackRequestHash: string, returnTo?: string) {
    const h = harness({ records, callbackRequestHash, returnTo })
    await h.login.start()
    return h
  }

  /** Signed in with the grant, and no page. */
  function expectNoPage(accepted: AppConnectAcceptance | null) {
    expect(accepted?.grant.identityId).toBe(ALICE)
    expect(accepted).not.toHaveProperty('returnTo')
  }

  async function confirm(h: Harness) {
    h.setCandidates([candidate(ALICE)])
    h.login.pollNow()
    await h.flush()
    expect(last(h)).toMatchObject({ phase: 'confirm' })
  }

  it('stores the sanitized page with a new request, and refuses an unsafe one', async () => {
    expect((await origin('/post?id=1#reply')).records.value?.returnTo).toBe('/post?id=1#reply')
    expect((await origin('//evil.example')).records.value).not.toHaveProperty('returnTo')
    expect((await origin()).records.value).not.toHaveProperty('returnTo')
  })

  it('a tab resuming the request reads its page and never sets it', async () => {
    const { records, hash } = await origin('/messages')
    const tab = await callbackTab(records, hash, '/settings')
    expect(tab.login.requestHashHex()).toBe(hash)
    expect(records.value?.returnTo).toBe('/messages')
  })

  it('the callback tab signs in to the page of the request the wallet returned for', async () => {
    const { records, hash } = await origin('/messages')
    const tab = await callbackTab(records, hash)
    await confirm(tab)
    expect(await tab.login.acceptCarrying(ALICE)).toMatchObject({ grant: { identityId: ALICE }, returnTo: '/messages' })
  })

  it('applies no page in the tab that started the request, or in a tab the wallet did not return to', async () => {
    const { records, h } = await origin('/messages')
    await confirm(h)
    expectNoPage(await h.login.acceptCarrying(ALICE))

    const again = await origin('/messages')
    const other = harness({ records: again.records })
    await other.login.start()
    expect(other.login.requestHashHex()).toBe(again.hash)
    await confirm(other)
    expectNoPage(await other.login.acceptCarrying(ALICE))
    expect(records.value).toBeNull()
  })

  it('never pairs the callback with a different request resumed from the shared slot', async () => {
    const first = await origin('/messages')
    // The starting tab replaced its request; the wallet returns for the old one.
    const second = await origin('/settings')
    const tab = await callbackTab(second.records, first.hash)
    expect(tab.login.requestHashHex()).toBe(second.hash)
    await confirm(tab)
    expectNoPage(await tab.login.acceptCarrying(ALICE))
  })

  it('an expired request carries nothing: the callback tab starts a request of its own, with no page', async () => {
    const { records, hash, h } = await origin('/messages')
    h.clock.now += 10 * 60_000
    records.value = parseStoredRequest(records.value, h.clock.now)
    const tab = await callbackTab(records, hash)
    expect(tab.login.requestHashHex()).not.toBe(hash)
    expect(records.value).not.toHaveProperty('returnTo')
    await confirm(tab)
    expectNoPage(await tab.login.acceptCarrying(ALICE))
  })

  it('a confirmation left open until the request runs out signs in without the page', async () => {
    const { records, hash } = await origin('/messages')
    const tab = await callbackTab(records, hash)
    await confirm(tab)
    tab.clock.now = T0 + 10 * 60_000
    expectNoPage(await tab.login.acceptCarrying(ALICE))
  })

  it('signs in without the page once another tab cleared or replaced the stored request', async () => {
    const cleared = await origin('/messages')
    const tab = await callbackTab(cleared.records, cleared.hash)
    await confirm(tab)
    cleared.records.value = null
    expectNoPage(await tab.login.acceptCarrying(ALICE))

    const replaced = await origin('/messages')
    const other = await callbackTab(replaced.records, replaced.hash)
    await confirm(other)
    const newer = (await origin('/settings')).records.value
    replaced.records.value = newer
    expectNoPage(await other.login.acceptCarrying(ALICE))
    expect(replaced.records.value).toBe(newer)
  })

  it('takes the stored request with the page, so of two callback tabs only one carries it', async () => {
    const { records, hash } = await origin('/messages')
    const a = await callbackTab(records, hash)
    const b = await callbackTab(records, hash)
    await confirm(a)
    await confirm(b)
    const results = await Promise.all([a.login.acceptCarrying(ALICE), b.login.acceptCarrying(ALICE)])
    expect(results.map((result) => result?.grant.identityId)).toEqual([ALICE, ALICE])
    expect(results.filter((result) => result?.returnTo === '/messages')).toHaveLength(1)
  })

  it('accepts nothing once "That\'s not me" restarts the flow while the request is being taken', async () => {
    const { records, hash } = await origin('/messages')
    let release = () => {}
    const taking = new Promise<void>((resolve) => { release = resolve })
    const tab = harness({ records, callbackRequestHash: hash, beforeTake: () => taking })
    await tab.login.start()
    await confirm(tab)
    const accepting = tab.login.acceptCarrying(ALICE)
    tab.setCandidates([])
    const restarting = tab.login.reject()
    release()
    expect(await accepting).toBeNull()
    await restarting
    expect(last(tab)).toMatchObject({ phase: 'waiting' })
    expect(tab.login.requestHashHex()).not.toBe(hash)
  })

  it('replacements keep exactly the replaced request\'s page, and the callback tab still applies it', async () => {
    const { records, hash } = await origin('/messages')
    const tab = await callbackTab(records, hash, '/elsewhere')

    await confirm(tab)
    await tab.login.reject()
    expect(tab.login.requestHashHex()).not.toBe(hash)
    expect(records.value?.returnTo).toBe('/messages')

    tab.clock.now += 10 * 60_000
    await tab.login.checkAgain()
    expect(records.value?.returnTo).toBe('/messages')

    await tab.login.start({ fresh: true })
    expect(records.value?.returnTo).toBe('/messages')

    // "Try again": a plain start resumes this tab's own replacement and keeps carrying it.
    await tab.login.start()
    await confirm(tab)
    expect(await tab.login.acceptCarrying(ALICE)).toMatchObject({ returnTo: '/messages' })
  })

  it('names its own replacement, so a remount or reload of the callback tab keeps carrying it', async () => {
    const { records, hash } = await origin('/messages')
    const named: string[] = []
    const tab = harness({ records, callbackRequestHash: hash, onCarry: (h) => named.push(h) })
    await tab.login.start()
    expect(named).toEqual([])
    await tab.login.start({ fresh: true })
    const replacement = tab.login.requestHashHex() ?? ''
    expect(named).toEqual([replacement])
    tab.login.dispose()

    const remounted = await callbackTab(records, named[named.length - 1])
    expect(remounted.login.requestHashHex()).toBe(replacement)
    await confirm(remounted)
    expect(await remounted.login.acceptCarrying(ALICE)).toMatchObject({ returnTo: '/messages' })
  })

  it('a replacement of a request with no page carries none, whatever page the tab is on', async () => {
    const { records, hash } = await origin()
    const tab = await callbackTab(records, hash, '/elsewhere')
    await tab.login.start({ fresh: true })
    expect(records.value).not.toHaveProperty('returnTo')
    await confirm(tab)
    expectNoPage(await tab.login.acceptCarrying(ALICE))
  })

  it('carries the username step with the request, separately from its page, and replacements keep it', async () => {
    const h = harness({ returnTo: '/messages', registerUsername: true })
    await h.login.start()
    expect(h.records.value).toMatchObject({ returnTo: '/messages', registerUsername: true })
    const tab = harness({ records: h.records, callbackRequestHash: h.login.requestHashHex() ?? '', registerUsername: false })
    await tab.login.start()
    await tab.login.start({ fresh: true })
    expect(h.records.value).toMatchObject({ returnTo: '/messages', registerUsername: true })
    await confirm(tab)
    expect(await tab.login.acceptCarrying(ALICE)).toMatchObject({ returnTo: '/messages', registerUsername: true })

    // The step alone, with no page to go on to, is carried too.
    const bare = harness({ registerUsername: true })
    await bare.login.start()
    const bareTab = harness({ records: bare.records, callbackRequestHash: bare.login.requestHashHex() ?? '' })
    await bareTab.login.start()
    await confirm(bareTab)
    const accepted = await bareTab.login.acceptCarrying(ALICE)
    expect(accepted).toMatchObject({ registerUsername: true })
    expect(accepted).not.toHaveProperty('returnTo')
  })

  it('stops carrying once a retry resumes another tab\'s newer request', async () => {
    const { records, hash } = await origin('/messages')
    const tab = await callbackTab(records, hash)
    const newer = await origin('/settings')
    records.value = newer.records.value
    await tab.login.start()
    expect(tab.login.requestHashHex()).toBe(newer.hash)
    await confirm(tab)
    expectNoPage(await tab.login.acceptCarrying(ALICE))
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

  it('keeps a safe return page and drops an unsafe one, keeping the request', () => {
    expect(parseStoredRequest({ ...record, returnTo: '/messages?tab=1' }, T0)).toEqual({ ...record, returnTo: '/messages?tab=1' })
    for (const returnTo of ['//evil.example', 'https://evil.example', '/login', 5]) {
      expect(parseStoredRequest({ ...record, returnTo }, T0)).toEqual(record)
    }
  })

  it('keeps the username step only when it is exactly true', () => {
    expect(parseStoredRequest({ ...record, registerUsername: true }, T0)).toEqual({ ...record, registerUsername: true })
    for (const registerUsername of [false, 'true', 1, '/dpns/register']) {
      expect(parseStoredRequest({ ...record, registerUsername }, T0)).toEqual(record)
    }
  })
})
