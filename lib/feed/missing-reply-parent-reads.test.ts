import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ getRemovals: vi.fn(), getManyOrThrow: vi.fn(), provenAbsent: vi.fn() }))
vi.mock('@/lib/services/moderation-service', () => ({ moderationService: { getRemovals: m.getRemovals } }))
vi.mock('@/lib/services/reply-service', () => ({ replyService: { getManyOrThrow: m.getManyOrThrow } }))
vi.mock('./prove-absent', () => ({ provenAbsent: m.provenAbsent }))

const { missingReplyParentReads: reads } = await import('./missing-reply-parent-reads')

const removal = (replyToReplyId?: string) => ({ kept: replyToReplyId ? { replyToReplyId, rootPostId: 'ROOT' } : { rootPostId: 'ROOT' } })

describe('missingReplyParentReads', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads tombstoned parents fresh and proves absence strictly, so a failed read fails the page', async () => {
    m.getManyOrThrow.mockRejectedValue(new Error('offline'))
    m.provenAbsent.mockResolvedValue(new Set(['gone']))
    await expect(reads.getMany(['t1'])).rejects.toThrow('offline')
    expect(await reads.provenAbsent(['gone', 'live'])).toEqual(new Set(['gone']))
    expect(m.provenAbsent).toHaveBeenCalledWith('reply', ['gone', 'live'], { throwOnError: true })
  })

  it('answers the kept parent of each removed nested reply, and nothing for a direct reply or a reply with no record', async () => {
    m.getRemovals.mockResolvedValue(new Map([['nested', removal('parent')], ['direct', removal()]]))
    expect(await reads.removedReplyParents?.(['nested', 'direct', 'unrecorded'])).toEqual(new Map([['nested', 'parent']]))
    expect(m.getRemovals.mock.calls).toEqual([['reply', ['nested', 'direct', 'unrecorded']]])
  })

  it('reads the records a hundred ids at a time', async () => {
    const ids = Array.from({ length: 230 }, (_, n) => `r${n}`)
    m.getRemovals.mockImplementation(async (_kind: string, batch: string[]) => new Map(batch.filter((id) => id.endsWith('0')).map((id) => [id, removal(`p-${id}`)])))
    const parents = await reads.removedReplyParents?.(ids)
    expect(m.getRemovals.mock.calls.map(([kind, batch]) => [kind, batch.length])).toEqual([['reply', 100], ['reply', 100], ['reply', 30]])
    expect(parents?.size).toBe(23)
    expect(parents?.get('r220')).toBe('p-r220')
  })

  it('places nothing when the record read fails: the lenient read answers no record', async () => {
    // `getRemovals` swallows a failed read and answers an empty map; the stub then stays at the top of the thread.
    m.getRemovals.mockResolvedValue(new Map())
    expect(await reads.removedReplyParents?.(['nested'])).toEqual(new Map())
  })
})
