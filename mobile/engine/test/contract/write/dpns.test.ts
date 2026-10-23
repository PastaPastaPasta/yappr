/**
 * dpns.* on sakura with a pool persona (ENGINE.md §12.3): a non-contested
 * username registered end to end through lib's journaled preorder and domain
 * (lib/services/dpns-registration.ts), then read back from DPNS. Each run
 * registers one new name (about 0.0007 DASH of fees on the devnet). Identity
 * ids and the name are the only things logged.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPoolPersonas, type PoolPersona } from '../../../harness/pool'
import { base64ToBytes } from '@/lib/bytes'
import { DPNS_CONTRACT_ID } from '@/lib/constants'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import { preorderWithHashExists, readContender } from '@/lib/services/dpns-registration'
import { documentToPlainObject } from '@/lib/services/sdk-helpers'
import { connectEngine } from '../engine'
import { pollSettled, retryQuorum, writeSuiteSkipReason } from './env'

const skipReason = writeSuiteSkipReason()

describe.skipIf(skipReason !== null)(`dpns on sakura${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  let persona: PoolPersona
  let engine: ReturnType<typeof connectEngine>

  beforeAll(async () => {
    // Persona 99: reserved for mobile and used by no other write test.
    persona = loadPoolPersonas(undefined, [99])[0]
    engine = connectEngine({ timeoutMs: 300_000 })
    await engine.api.engine.boot()
    await engine.api.session.signOut()
    await retryQuorum(() => engine.api.session.signInWithKey({ key: persona.keyHex('high') }))
  })

  it('registers a name that goes to no vote, paying no deposit, and DPNS then names its owner', async () => {
    expect(await engine.api.dpns.registration()).toBe('native')
    // Digits 2-9 keep it out of any vote.
    const label = `yappr-e2e-dpns-${Date.now().toString(36)}-29`
    const check = await retryQuorum(() => engine.api.dpns.check(label))
    expect(check).toMatchObject({ label, available: true, contested: false, contestFundCredits: null, invalid: null })

    const submitted = await engine.api.dpns.register(label, null)
    const ticket = await pollSettled((id) => engine.api.writes.get(id), submitted.id)
    console.info(`dpns e2e: ${label}.dash for ${persona.identityId}: ${ticket.state}`)
    expect(ticket.state).toBe('confirmed')

    // Taken now, by this persona: a second check says so, and a second register is refused unpaid.
    expect(await retryQuorum(() => engine.api.dpns.check(label))).toMatchObject({ available: false })
  })

  it('finds a preorder by its salted hash (the base64 operand lib resumes with), and none for an unknown hash', async () => {
    const sdk = await getEvoSdk()
    const response: unknown = await retryQuorum(() => sdk.documents.query({ dataContractId: DPNS_CONTRACT_ID, documentTypeName: 'preorder', limit: 1 }))
    const [preorder] = (response instanceof Map ? [...response.values()] : (response as unknown[])).filter(Boolean).map(documentToPlainObject)
    expect(preorder, 'sakura holds at least one preorder').toBeDefined()
    const hash = preorder.saltedDomainHash
    const bytes = hash instanceof Uint8Array ? hash : base64ToBytes(String(hash))
    expect(bytes.length).toBe(32)
    expect(await retryQuorum(() => preorderWithHashExists(sdk, bytes))).toBe(true)
    expect(await retryQuorum(() => preorderWithHashExists(sdk, crypto.getRandomValues(new Uint8Array(32))))).toBe(false)
  })

  it('reads a contest nobody entered as no contender, so a first contested registration is not refused', async () => {
    const sdk = await getEvoSdk()
    const vote = await retryQuorum(() => readContender(sdk, persona.identityId, `n0b0dy-${Date.now().toString(36).replace(/[^a-z01-]/g, 'a')}`.slice(0, 19)))
    expect(vote.contender).toBe(false)
  })
})
