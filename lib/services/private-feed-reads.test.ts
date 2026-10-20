import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }))
import { fetchGrantsTo, readGrantsTo } from './private-feed-reads'

const owner = '11111111111111111111111111111111'
const viewer = '22222222222222222222222222222222'

beforeEach(() => query.mockReset().mockResolvedValue(new Map()))

describe('grant reads', () => {
  it('shares one read between private posts of one owner asking together', async () => {
    await Promise.all([readGrantsTo(owner, viewer), readGrantsTo(owner, viewer)])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('never lets a decision after a write join a read that started before it', async () => {
    let answer: (docs: Map<string, unknown>) => void = () => undefined
    query.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const before = readGrantsTo(owner, viewer)
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    // A grant is written, then a revocation check reads: a read of its own.
    await fetchGrantsTo(owner, viewer)
    expect(query).toHaveBeenCalledTimes(2)
    answer(new Map())
    await before
  })
})
