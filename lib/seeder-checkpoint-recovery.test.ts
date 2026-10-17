import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureInitialized } from '@dashevo/evo-sdk'
import { createDocWriter, createRecorder, fakeId, saveCheckpoint } from '../scripts/seed/feature-seed-lib.mjs'
import { createWithAgreement } from '../scripts/seed/seed-lib.mjs'

interface Checkpoint { docs: Record<string, string>; pendingCreates?: Record<string, string[]> }
interface CreateOptions { onDerivedId: (id: string) => void }
const candidate = fakeId('pending-poll')
const actor = { ownerId: fakeId('poll-owner'), lock: <T>(operation: () => Promise<T>) => operation() }
const data = { question: 'Resume this poll?' }
let directory: string
let file: string

beforeEach(async () => {
  await ensureInitialized()
  directory = mkdtempSync(join(tmpdir(), 'yappr-pending-poll-'))
  file = join(directory, 'checkpoint.json')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function writer(create: (_sdk: unknown, options: CreateOptions) => Promise<{ id: string }>, visible: (id: string) => boolean) {
  return createDocWriter({
    handle: { sdk: { documents: {
      get: async (_contract: string, _type: string, id: string) => visible(id) ? {} : null,
      query: async () => { throw new Error('where clause on non indexed property'); },
    } }, reconnect: async () => {} },
    contractId: fakeId('poll-contract'), entropyFor: () => new Uint8Array(32).fill(1),
    paymentInfo: () => ({}), wait: async () => {}, create,
  })
}
const disk = () => JSON.parse(readFileSync(file, 'utf8')) as Checkpoint

describe('no-index poll checkpoints', () => {
  it('persists before broadcast and resumes a landed create with a fresh writer and recorder', async () => {
    const firstCreate = vi.fn(async (_sdk: unknown, { onDerivedId }: CreateOptions) => {
      onDerivedId(candidate)
      expect(disk().pendingCreates?.poll).toEqual([candidate])
      expect(disk().docs.poll).toBeUndefined()
      throw new Error('504 Gateway Timeout')
    })
    const first = createRecorder({ writer: writer(firstCreate, () => false), state: { docs: {} }, file })
    expect(await first.createDoc(actor, 'poll', 'poll', data, { persistPending: true })).toBeNull()
    expect(firstCreate).toHaveBeenCalledTimes(1)
    expect(disk().pendingCreates?.poll).toEqual([candidate])

    const sendAgain = vi.fn(async () => ({ id: fakeId('duplicate') }))
    const resumed = createRecorder({ writer: writer(sendAgain, id => id === candidate), state: disk(), file })
    expect(await resumed.createDoc(actor, 'poll', 'poll', data, { persistPending: true })).toBe(candidate)
    expect(sendAgain).not.toHaveBeenCalled()
    expect(disk().docs.poll).toBe(candidate)
    expect(disk().pendingCreates?.poll).toBeUndefined()
  })

  it('keeps an unresolved candidate and refuses another send or unrelated adoption on restart', async () => {
    const state: Checkpoint = { docs: {}, pendingCreates: { poll: [candidate] } }
    const send = vi.fn(async () => ({ id: fakeId('duplicate') }))
    const adopt = vi.fn(async () => fakeId('unrelated-poll'))
    const resumed = createRecorder({ writer: writer(send, () => false), state, file })
    expect(await resumed.createDoc(actor, 'poll', 'poll', data, { persistPending: true, adopt })).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
    expect(state.pendingCreates?.poll).toEqual([candidate])
    expect(state.docs.poll).toBeUndefined()
  })

  it.each(['consensus schema refusal code=10101', 'balance is not enough code=30001'])('clears definite refusal %s so a corrected create can be retried', async (reason) => {
    const state: Checkpoint = { docs: {} }
    const refused = vi.fn(async (_sdk: unknown, { onDerivedId }: CreateOptions) => {
      onDerivedId(candidate)
      throw new Error(reason)
    })
    const first = createRecorder({ writer: writer(refused, () => false), state, file })
    expect(await first.createDoc(actor, 'poll', 'poll', data, { persistPending: true })).toBeNull()
    expect(refused).toHaveBeenCalledTimes(1)
    expect(disk().pendingCreates?.poll).toBeUndefined()

    const corrected = fakeId('corrected-poll')
    const create = vi.fn(async (_sdk: unknown, { onDerivedId }: CreateOptions) => {
      onDerivedId(corrected)
      return { id: corrected }
    })
    const resumed = createRecorder({ writer: writer(create, id => id === corrected), state: disk(), file })
    expect(await resumed.createDoc(actor, 'poll', 'poll', data, { persistPending: true })).toBe(corrected)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('keeps a nonce-used refusal pending because a prior SDK broadcast may have landed', async () => {
    const create = vi.fn(async (_sdk: unknown, { onDerivedId }: CreateOptions) => {
      onDerivedId(candidate)
      throw new Error('identity contract nonce already present at tip code=20001')
    })
    const recorder = createRecorder({ writer: writer(create, () => false), state: { docs: {} }, file })
    expect(await recorder.createDoc(actor, 'poll', 'poll', data, { persistPending: true })).toBeNull()
    expect(create).toHaveBeenCalledTimes(1)
    expect(disk().pendingCreates?.poll).toEqual([candidate])
    const sendAgain = vi.fn(async () => ({ id: fakeId('duplicate') }))
    const resumed = createRecorder({ writer: writer(sendAgain, id => id === candidate), state: disk(), file })
    expect(await resumed.createDoc(actor, 'poll', 'poll', data, { persistPending: true })).toBe(candidate)
    expect(sendAgain).not.toHaveBeenCalled()
  })

  it('does not checkpoint an ID when local signing fails before broadcast', async () => {
    const onDerivedId = vi.fn()
    const broadcastAndWait = vi.fn()
    await expect(createWithAgreement({
      wasm: { getIdentityContractNonce: async () => 0n },
      stateTransitions: { broadcastAndWait },
    }, {
      contractId: fakeId('poll-contract'), docType: 'poll', ownerId: actor.ownerId,
      wif: 'invalid-wif', identityKey: {}, agreement: undefined, data, entropy: new Uint8Array(32).fill(1), onDerivedId,
    })).rejects.toThrow(/invalid|base58|WIF/i)
    expect(onDerivedId).not.toHaveBeenCalled()
    expect(broadcastAndWait).not.toHaveBeenCalled()
  })

  it('does not broadcast if saving the pre-broadcast checkpoint fails', async () => {
    const blocked = join(directory, 'blocked')
    writeFileSync(blocked, 'a file cannot be a checkpoint directory')
    const broadcast = vi.fn()
    const create = async (_sdk: unknown, { onDerivedId }: CreateOptions) => {
      onDerivedId(candidate)
      broadcast()
      return { id: candidate }
    }
    const state: Checkpoint = { docs: {} }
    const recorder = createRecorder({ writer: writer(create, () => false), state, file: join(blocked, 'checkpoint.json') })
    expect(await recorder.createDoc(actor, 'poll', 'poll', data, { persistPending: true })).toBeNull()
    expect(broadcast).not.toHaveBeenCalled()
    expect(state.pendingCreates).toBeUndefined()
    saveCheckpoint(file, state)
    expect(disk().pendingCreates).toBeUndefined()
  })
})
