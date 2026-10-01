/**
 * session.* on sakura with pool personas (ENGINE.md §12.3): sign in with a
 * HIGH key as hex, restore after a restart, add and switch accounts, refresh
 * the balance, sign out. Serial; identity ids are the only thing logged.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPoolPersonas, type PoolPersona } from '../../../harness/pool'
import { connectEngine, MIN_POOL_CREDITS } from './engine'
import { writeSuiteSkipReason } from './env'

const skipReason = writeSuiteSkipReason()

describe.skipIf(skipReason !== null)(`session on sakura${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  let alice: PoolPersona
  let bob: PoolPersona
  let engine: ReturnType<typeof connectEngine>

  beforeAll(async () => {
    [alice, bob] = loadPoolPersonas()
    engine = connectEngine()
    await engine.api.engine.boot()
    // A stale session from an aborted run would block the sign-in below.
    await engine.api.session.signOut()
  })

  it('signs in with a HIGH key given as hex, and has credits to write with', async () => {
    const session = await engine.api.session.signInWithKey({ key: alice.keyHex('high') })
    expect(session).toMatchObject({ identityId: alice.identityId, network: 'devnet', method: 'key' })
    expect(session.credits, `persona ${alice.personaIdx} is low: top up via sakura ops (treasury asset lock)`).toBeGreaterThanOrEqual(MIN_POOL_CREDITS)
    expect(engine.events).toContainEqual({ event: 'session.changed', payload: { session, reason: 'signed-in' } })
  })

  it('restores the session after an engine restart', async () => {
    engine = connectEngine()
    expect((await engine.api.session.restore())?.identityId).toBe(alice.identityId)
    expect(engine.events).toContainEqual(expect.objectContaining({ event: 'session.changed', payload: expect.objectContaining({ reason: 'restored' }) }))
  })

  it('refreshes the balance', async () => {
    const { credits } = await engine.api.session.refreshBalance()
    expect(credits).toBeGreaterThan(0n)
  })

  it('adds a second account, then switches back through a restart', async () => {
    await engine.api.session.prepareAddAccount()
    engine = connectEngine()
    expect(await engine.api.session.restore()).toBeNull()
    expect((await engine.api.session.signInWithKey({ key: bob.keyHex('critical') })).identityId).toBe(bob.identityId)
    expect((await engine.api.session.accounts()).map(a => [a.identityId, a.active])).toEqual([[bob.identityId, true], [alice.identityId, false]])

    await engine.api.session.switchAccount(alice.identityId)
    engine = connectEngine()
    expect((await engine.api.session.restore())?.identityId).toBe(alice.identityId)
    expect(engine.events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ reason: 'switched' }) }))
  })

  it('signs both accounts out, offline', async () => {
    await engine.api.session.signOut({ identityId: bob.identityId })
    await engine.api.session.signOut()
    expect(await engine.api.session.current()).toBeNull()
    expect(await engine.api.session.accounts()).toEqual([])
  })

  it.todo('signs in through the M3 test-wallet responder (dash-key: and first-login dash-st:), once mobile/tools lands')
})
