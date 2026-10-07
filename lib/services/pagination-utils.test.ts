import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/lib/logger'
import { newestFirst, paginateCount, paginateFetchAll } from './pagination-utils'

/** An SDK over `total` documents d0..d{total-1}, paged by `limit` after `startAfter`. */
function pagedSdk(total: number, options: { shortContinuations?: boolean } = {}) {
  const query = vi.fn(async ({ limit, startAfter }: { limit: number; startAfter?: string }) => {
    const first = startAfter ? Number(startAfter.slice(1)) + 1 : 0
    // An `in` continuation page can come back one row short of the limit.
    const size = startAfter && options.shortContinuations ? limit - 1 : limit
    const ids = Array.from({ length: Math.max(0, Math.min(size, total - first)) }, (_, i) => `d${first + i}`)
    return new Map(ids.map(id => [id, { $id: id }]))
  })
  return { sdk: { documents: { query, count: vi.fn() } }, query }
}

const build = () => ({ dataContractId: 'contract', documentTypeName: 'follow' })

afterEach(() => vi.restoreAllMocks())

describe('paginateFetchAll', () => {
  it('reads past the default cap to the end when maxResults is Infinity', async () => {
    const { sdk, query } = pagedSdk(1234)
    const { documents, reachedLimit } = await paginateFetchAll(sdk, build, doc => doc.$id, { maxResults: Infinity })
    expect(documents).toHaveLength(1234)
    expect(documents.at(-1)).toBe('d1233')
    expect(reachedLimit).toBe(false)
    expect(query).toHaveBeenCalledTimes(13)
    expect(query.mock.calls[1][0]).toMatchObject({ limit: 100, startAfter: 'd99' })
  })

  it('stops at the default cap, reports it and logs it rather than passing the head off as the whole', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { sdk } = pagedSdk(1234)
    const { documents, reachedLimit } = await paginateFetchAll(sdk, build, doc => doc)
    expect(documents).toHaveLength(1000)
    expect(reachedLimit).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('result cap'), expect.objectContaining({ documentTypeName: 'follow', maxResults: 1000 }))
  })

  it('does not flag a list of exactly maxResults, and never returns more than the cap', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const exact = pagedSdk(1000)
    const atCap = await paginateFetchAll(exact.sdk, build, doc => doc)
    expect(atCap).toMatchObject({ reachedLimit: false })
    expect(atCap.documents).toHaveLength(1000)
    // The probe past the cap asks for one row.
    expect(exact.query.mock.calls.at(-1)?.[0]).toMatchObject({ limit: 1 })
    expect(warn).not.toHaveBeenCalled()

    const odd = await paginateFetchAll(pagedSdk(500).sdk, build, doc => doc, { maxResults: 150 })
    expect(odd.documents).toHaveLength(150)
    expect(odd.reachedLimit).toBe(true)
  })

  it('does not log a list that ends before the cap', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { sdk } = pagedSdk(250)
    expect((await paginateFetchAll(sdk, build, doc => doc)).reachedLimit).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('an `in` walk reads past a short continuation page and only stops on an empty one', async () => {
    const { sdk, query } = pagedSdk(250, { shortContinuations: true })
    const plain = await paginateFetchAll(sdk, build, doc => doc.$id)
    // A plain walk takes the short continuation for the end.
    expect(plain.documents).toHaveLength(199)

    query.mockClear()
    const inWalk = await paginateFetchAll(sdk, build, doc => doc.$id, { inClause: true })
    expect(inWalk.documents).toHaveLength(250)
    expect(new Set(inWalk.documents).size).toBe(250)
    // 100, 99, 51, then the empty page that proves the end.
    expect(query).toHaveBeenCalledTimes(4)
  })

  it('an empty first page of an `in` walk costs one query', async () => {
    const { sdk, query } = pagedSdk(0)
    expect((await paginateFetchAll(sdk, build, doc => doc, { inClause: true })).documents).toEqual([])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('throws instead of looping when the cursor does not advance', async () => {
    const page = new Map(Array.from({ length: 100 }, (_, i) => [`x${i}`, { $id: 'same' }]))
    const sdk = { documents: { query: vi.fn(async () => page), count: vi.fn() } }
    await expect(paginateFetchAll(sdk, build, doc => doc, { maxResults: Infinity })).rejects.toThrow('did not advance')
  })
})

describe('paginateCount', () => {
  it('counts every page and flags the cap', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(await paginateCount(pagedSdk(345).sdk, build)).toEqual({ count: 345, reachedLimit: false })
    expect(await paginateCount(pagedSdk(1500).sdk, build)).toEqual({ count: 1000, reachedLimit: true })
  })
})

describe('newestFirst', () => {
  it('sorts a copy by createdAt, newest first', () => {
    const items = [{ id: 'a', createdAt: new Date(1) }, { id: 'b', createdAt: new Date(3) }, { id: 'c', createdAt: new Date(2) }]
    expect(newestFirst(items).map(item => item.id)).toEqual(['b', 'c', 'a'])
    expect(items.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })
})
