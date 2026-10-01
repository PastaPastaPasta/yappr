import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function load(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return import('./hidden-tombstones')
}

const reply = (id: string, replyToReplyId?: string, deleted?: true) => ({ id, replyToReplyId, deleted })

describe('hidden tombstones', () => {
  it('hides tombstones on v11 only', async () => {
    const posts = [{ id: 'a' }, { id: 'b', deleted: true }]
    expect((await load('v11')).withoutHiddenTombstones(posts).map((p) => p.id)).toEqual(['a'])
    for (const topology of ['v2', 'v9', 'v10']) {
      expect((await load(topology)).withoutHiddenTombstones(posts).map((p) => p.id)).toEqual(['a', 'b'])
    }
  })

  it('keeps a tombstoned reply a live reply nests under, and drops a childless one', async () => {
    const { pruneHiddenTombstones } = await load('v11')
    const thread = [reply('t1', undefined, true), reply('live', 't1'), reply('t2', undefined, true)]
    expect(pruneHiddenTombstones(thread).map((r) => r.id)).toEqual(['t1', 'live'])
  })

  it('drops a whole chain of tombstones that nothing live hangs under', async () => {
    const { pruneHiddenTombstones } = await load('v11')
    const thread = [reply('t1', undefined, true), reply('t2', 't1', true), reply('t3', 't2', true), reply('live')]
    expect(pruneHiddenTombstones(thread).map((r) => r.id)).toEqual(['live'])
  })

  it('keeps the tombstones between a live reply and the top of the thread', async () => {
    const { pruneHiddenTombstones } = await load('v11')
    const thread = [reply('t1', undefined, true), reply('t2', 't1', true), reply('live', 't2'), reply('t3', 't1', true)]
    expect(pruneHiddenTombstones(thread).map((r) => r.id)).toEqual(['t1', 't2', 'live'])
  })

  it('leaves v9 threads alone: a tombstone stays in place there', async () => {
    const { pruneHiddenTombstones } = await load('v9')
    const thread = [reply('t1', undefined, true), reply('live')]
    expect(pruneHiddenTombstones(thread)).toEqual(thread)
  })
})
