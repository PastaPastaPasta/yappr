import { afterEach, describe, expect, it } from 'vitest'
import { TtlMap } from '@/lib/caches/ttl-map'
import { decodeCursor, encodeCursor } from '../../src/dto/cursor'
import { endOnProofDirectionBug, pageOfList } from '../../src/dto/paging'

const setBundleHash = (hash: string | undefined) => {
  (globalThis as { __YAPPR_ENGINE_BUNDLE_HASH__?: string }).__YAPPR_ENGINE_BUNDLE_HASH__ = hash
}

afterEach(() => setBundleHash(undefined))

describe('cursors', () => {
  it('round-trip as opaque base64url strings', () => {
    const cursor = encodeCursor('tag:dash', { after: 'Abc/+=', n: 3, seen: ['x', 'y'] })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(cursor, 'tag:dash')).toEqual({ after: 'Abc/+=', n: 3, seen: ['x', 'y'] })
    expect(decodeCursor(null, 'tag:dash')).toBeNull()
    expect(decodeCursor(undefined, 'tag:dash')).toBeNull()
  })

  it('reject another kind, another engine build and garbage with BAD_CURSOR', () => {
    const cursor = encodeCursor('forYou', { after: 'x' })
    expect(() => decodeCursor(cursor, 'following')).toThrow(expect.objectContaining({ code: 'BAD_CURSOR' }))
    expect(() => decodeCursor('not a cursor!', 'forYou')).toThrow(expect.objectContaining({ code: 'BAD_CURSOR' }))
    expect(() => decodeCursor('', 'forYou')).toThrow(expect.objectContaining({ code: 'BAD_CURSOR' }))
    setBundleHash('0123456789abcdef')
    expect(() => decodeCursor(cursor, 'forYou')).toThrow(expect.objectContaining({ code: 'BAD_CURSOR' }))
  })
})

describe('endOnProofDirectionBug (dashpay/platform#5244)', () => {
  const bug = new Error('grovedb: invalid proof: Invalid V1 proof verification parameters: invalid proof error Proof op family does not match the query direction: upright op in a right-to-left walk')

  it('turns the bug into the end of the list on a continuation only', async () => {
    await expect(endOnProofDirectionBug(true, () => Promise.reject(bug), () => 'end')).resolves.toBe('end')
    await expect(endOnProofDirectionBug(false, () => Promise.reject(bug), () => 'end')).rejects.toBe(bug)
  })

  it('recognises the SDK error, which is not an Error subclass', async () => {
    const wasmError = Object.create({ get message() { return bug.message } }) as object
    await expect(endOnProofDirectionBug(true, () => Promise.reject(wasmError), () => 'end')).resolves.toBe('end')
  })

  it('passes results and other errors through', async () => {
    await expect(endOnProofDirectionBug(true, () => Promise.resolve('page'), () => 'end')).resolves.toBe('page')
    const other = new Error('timeout')
    await expect(endOnProofDirectionBug(true, () => Promise.reject(other), () => 'end')).rejects.toBe(other)
  })
})

describe('pageOfList', () => {
  const list = Array.from({ length: 7 }, (_, index) => index)

  it('reads the list once per scroll and pages it, the last page without a cursor', async () => {
    let loads = 0
    const cache = new TtlMap<string, number[]>(60_000)
    const read = (cursor: string | null) => pageOfList({
      kind: 'n', key: 'k', cursor, size: 3, cache,
      load: async () => { loads++; return list },
      hydrate: async (slice) => slice.map(n => n * 10),
    })
    const first = await read(null)
    expect(first).toMatchObject({ items: [0, 10, 20], hasMore: true })
    const second = await read(first.cursor)
    expect(second).toMatchObject({ items: [30, 40, 50], hasMore: true })
    const third = await read(second.cursor)
    expect(third).toEqual({ items: [60], cursor: null, hasMore: false })
    expect(loads).toBe(1)
    // A new first page re-reads (pull to refresh).
    await read(null)
    expect(loads).toBe(2)
  })

  it('rejects a cursor issued for another list', async () => {
    const base = { kind: 'n', size: 3, cache: new TtlMap<string, number[]>(60_000), load: async () => list, hydrate: async (slice: number[]) => slice }
    const { cursor } = await pageOfList({ ...base, key: 'a', cursor: null })
    await expect(pageOfList({ ...base, key: 'b', cursor })).rejects.toMatchObject({ code: 'BAD_CURSOR' })
  })
})
