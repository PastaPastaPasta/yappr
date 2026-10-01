/**
 * session.* on sakura with pool personas (ENGINE.md §12.3): sign in with a
 * HIGH key as hex, restore after a restart, add and switch accounts, refresh
 * the balance, sign out. Serial; identity ids are the only thing logged.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPoolPersonas, type PoolPersona } from '../../../harness/pool'
import { connectEngine } from '../engine'
import { retryQuorum, writeSuiteSkipReason } from './env'

/** 0.05 DASH in credits (1 DASH = 1e11 credits), many suite runs: below it a pool persona needs a top-up. */
const MIN_POOL_CREDITS = 5_000_000_000n

const skipReason = writeSuiteSkipReason()

const execFileAsync = promisify(execFile)
const RESPONDER = fileURLToPath(new URL('../../../../tools/test-wallet-responder.mjs', import.meta.url))

/** Answer a `dash-key:` or `dash-st:` URI as the persona's wallet would (mobile/tools, M3). Its keys never leave that process. */
function respond(uri: string, personaIdx: number): Promise<void> {
  return retryQuorum(async () => {
    await execFileAsync(process.execPath, [RESPONDER, '--uri', uri, '--persona', String(personaIdx)], { env: process.env, timeout: 180_000 })
  })
}

describe.skipIf(skipReason !== null)(`session on sakura${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  let alice: PoolPersona
  let bob: PoolPersona
  let engine: ReturnType<typeof connectEngine>

  beforeAll(async () => {
    [alice, bob] = loadPoolPersonas()
    engine = connectEngine({ timeoutMs: 300_000 })
    await engine.api.engine.boot()
    // A stale session from an aborted run would block the sign-in below.
    await engine.api.session.signOut()
  })

  it('signs in with a HIGH key given as hex, and has credits to write with', async () => {
    const session = await retryQuorum(() => engine.api.session.signInWithKey({ key: alice.keyHex('high') }))
    expect(session).toMatchObject({ identityId: alice.identityId, network: 'devnet', method: 'key' })
    expect(session.credits, `persona ${alice.personaIdx} is low: top up via sakura ops (treasury asset lock)`).toBeGreaterThanOrEqual(MIN_POOL_CREDITS)
    expect(engine.events).toContainEqual({ event: 'session.changed', payload: { session, reason: 'signed-in' } })
  })

  it('restores the session after an engine restart', async () => {
    engine = connectEngine({ timeoutMs: 300_000 })
    expect((await engine.api.session.restore())?.identityId).toBe(alice.identityId)
    expect(engine.events).toContainEqual(expect.objectContaining({ event: 'session.changed', payload: expect.objectContaining({ reason: 'restored' }) }))
  })

  it('refreshes the balance', async () => {
    const { credits } = await engine.api.session.refreshBalance()
    expect(credits).toBeGreaterThan(0n)
  })

  it('adds a second account, then switches back through a restart', async () => {
    await engine.api.session.prepareAddAccount()
    engine = connectEngine({ timeoutMs: 300_000 })
    expect(await engine.api.session.restore()).toBeNull()
    expect((await engine.api.session.signInWithKey({ key: bob.keyHex('critical') })).identityId).toBe(bob.identityId)
    expect((await engine.api.session.accounts()).map(a => [a.identityId, a.active])).toEqual([[bob.identityId, true], [alice.identityId, false]])

    await engine.api.session.switchAccount(alice.identityId)
    engine = connectEngine({ timeoutMs: 300_000 })
    expect((await engine.api.session.restore())?.identityId).toBe(alice.identityId)
    expect(engine.events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ reason: 'switched' }) }))
  })

  it('signs both accounts out, offline', async () => {
    await engine.api.session.signOut({ identityId: bob.identityId })
    await engine.api.session.signOut()
    expect(await engine.api.session.current()).toBeNull()
    expect(await engine.api.session.accounts()).toEqual([])
  })

  it('signs in through the M3 test-wallet responder (dash-key:, then dash-st: on a first login)', async () => {
    const carol = loadPoolPersonas()[6]
    const request = await engine.api.session.startKeyExchange()
    await respond(request.uri, carol.personaIdx)
    let step = await engine.api.session.awaitKeyExchange(request.requestId, { waitMs: 120_000 })
    // A first login on this persona: the wallet registers the derived keys with MASTER.
    if (step.status === 'needs-registration') {
      await respond(step.uri, carol.personaIdx)
      step = await engine.api.session.awaitKeyRegistration(request.requestId, { waitMs: 120_000 })
    }
    expect(step).toMatchObject({ status: 'signed-in', session: { identityId: carol.identityId, method: 'key-exchange' } })
    await engine.api.session.signOut()
  })
})
