import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Reply } from '@/lib/types'

const shape = vi.hoisted(() => ({ liveThreads: false, outlive: true }))
vi.mock('@/lib/contract-topology', async (load) => ({
  ...await load<object>(),
  replyThreadsCarryLiveMarker: () => shape.liveThreads,
  repliesOutliveTheirParent: () => shape.outlive,
}))
// v17: the thread hides a tombstone unless a live reply nests under it.
vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v17')
const { deletedReplyStubs, unloadedReplyParents, withMissingReplyParents } = await import('./deleted-reply-stubs')
const { assembleFlatThread } = await import('./reply-thread')

const author = { id: 'A', username: 'a', displayName: 'A', avatar: '', followers: 0, following: 0, verified: false, joinedAt: new Date(0) }
const reply = (id: string, replyToReplyId: string | undefined, at: number): Reply => ({
  id, author, content: id, createdAt: new Date(at), likes: 0, reposts: 0, replies: 0, views: 0,
  parentId: replyToReplyId ?? 'ROOT', parentOwnerId: 'P', rootPostId: 'ROOT', replyToReplyId,
})

describe('unloadedReplyParents', () => {
  it('lists nesting targets missing from the loaded thread, once each', () => {
    const replies = [reply('r1', undefined, 1), reply('r2', 'r1', 2), reply('r3', 'gone', 3), reply('r4', 'gone', 4)]
    expect(unloadedReplyParents(replies)).toEqual(['gone'])
  })

  it('is empty when every parent is loaded', () => {
    expect(unloadedReplyParents([reply('r1', undefined, 1), reply('r2', 'r1', 2)])).toEqual([])
  })
})

describe('deletedReplyStubs', () => {
  it('stubs a proved-deleted parent at the top of the thread, dated by its earliest child', () => {
    const replies = [reply('r3', 'gone', 30), reply('r2', 'gone', 20)]
    const [stub, ...rest] = deletedReplyStubs(replies, new Set(['gone']))
    expect(rest).toEqual([])
    expect(stub).toMatchObject({ id: 'gone', deletedStub: true, rootPostId: 'ROOT', content: '' })
    expect(stub.replyToReplyId).toBeUndefined()
    expect(stub.createdAt.getTime()).toBe(20)
    expect(stub.author.id).toBe('')
  })

  it('does not stub a parent that is merely unloaded', () => {
    expect(deletedReplyStubs([reply('r2', 'elsewhere', 2)], new Set(['gone']))).toEqual([])
  })

  it('does not stub a parent that is loaded, including an earlier stub', () => {
    const stub = deletedReplyStubs([reply('r2', 'gone', 2)], new Set(['gone']))
    expect(deletedReplyStubs([...stub, reply('r2', 'gone', 2), reply('r5', 'gone', 5)], new Set(['gone']))).toEqual([])
  })
})

describe('a reply under a hidden parent (v18)', () => {
  const hiddenReply = (id: string, replyToReplyId: string | undefined, at: number): Reply => ({
    ...reply(id, replyToReplyId, at), content: 'secret text', media: [{ id: 'm', type: 'image', url: 'https://x/y.png' }], moderation: { mod: 1, modLabel: 2 },
  })
  const root = { id: 'ROOT', author: { ...author, id: 'B' }, content: 'root', createdAt: new Date(0), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0 }
  const reads = (stored: Reply[]) => ({
    getMany: vi.fn(async (ids: string[]) => stored.filter((r) => ids.includes(r.id))),
    provenAbsent: vi.fn(async () => new Set<string>()),
  })

  const shownIds = (threads: ReturnType<typeof assembleFlatThread>): unknown[] => threads.map((t) => [t.content.id, shownIds(t.nestedReplies)])

  beforeEach(() => {
    shape.liveThreads = true
    shape.outlive = false
  })
  afterEach(() => vi.unstubAllEnvs())

  it('keeps the reply under a placeholder with no content, in the hidden reply\'s place', async () => {
    // h2 is hidden and nests under h1, also hidden; the child c1 sits under h2.
    const r = reads([hiddenReply('h1', undefined, 1), hiddenReply('h2', 'h1', 2)])
    const replies = await withMissingReplyParents([reply('c1', 'h2', 10)], r)
    expect(r.getMany.mock.calls).toEqual([[['h2']], [['h1']]])
    const stubs = replies.filter((x) => x.hiddenStub)
    expect(stubs.map((x) => x.id).sort()).toEqual(['h1', 'h2'])
    for (const stub of stubs) {
      expect(stub).toMatchObject({ content: '', likes: 0, rootPostId: 'ROOT' })
      expect(stub.media).toBeUndefined()
      expect(stub.moderation).toBeUndefined()
      expect(stub.author.id).toBe('')
      expect(stub.deletedStub).toBeUndefined()
    }
    const thread = assembleFlatThread(root, replies)
    const shown = (threads: typeof thread): unknown[] => threads.map((t) => [t.content.id, shown(t.nestedReplies)])
    expect(shown(thread)).toEqual([['h1', [['h2', [['c1', []]]]]]])
  })

  it('still stubs a deleted parent the usual way, and mixes with hidden ones', async () => {
    const tomb: Reply = { ...reply('t1', undefined, 1), content: '', deleted: true }
    const r = reads([tomb, hiddenReply('h1', undefined, 2)])
    const replies = await withMissingReplyParents([reply('c1', 't1', 10), reply('c2', 'h1', 11)], r)
    expect(replies.filter((x) => x.hiddenStub).map((x) => x.id)).toEqual(['h1'])
    expect(replies.find((x) => x.id === 't1')).toBe(tomb)
  })

  it('stubs a parent written under a restriction (lane 2) the same way, and shows it on an archival build', async () => {
    const restrictedReply = (id: string, at: number): Reply => ({ ...reply(id, undefined, at), content: 'from a restricted account', moderation: { restricted: true } })
    const r = reads([restrictedReply('r1', 1)])
    const replies = await withMissingReplyParents([reply('c1', 'r1', 10)], r)
    const [stub] = replies.filter((x) => x.hiddenStub)
    expect(stub).toMatchObject({ id: 'r1', content: '', hiddenStub: true })
    expect(stub.moderation).toBeUndefined()
    expect(shownIds(assembleFlatThread(root, replies))).toEqual([['r1', [['c1', []]]]])

    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    expect((await withMissingReplyParents([reply('c1', 'r1', 10)], reads([restrictedReply('r1', 1)]))).map((x) => x.id)).toEqual(['c1'])
  })

  it('does not stub a parent that is merely unlisted for another reason', async () => {
    const r = reads([reply('plain', undefined, 1)])
    const replies = await withMissingReplyParents([reply('c1', 'plain', 10)], r)
    expect(replies.map((x) => x.id)).toEqual(['c1'])
  })

  it('stubs nothing on an archival build, which lists the hidden reply itself', async () => {
    vi.stubEnv('NEXT_PUBLIC_MODERATION_VIEW', 'all')
    const r = reads([hiddenReply('h1', undefined, 1)])
    const replies = await withMissingReplyParents([reply('c1', 'h1', 10)], r)
    expect(replies.map((x) => x.id)).toEqual(['c1'])
  })

  it('is pruned with the tombstones when nothing live nests under it', async () => {
    const { pruneHiddenTombstones } = await import('./hidden-tombstones')
    const stub: Reply = { ...reply('h1', undefined, 1), content: '', hiddenStub: true }
    const tomb: Reply = { ...reply('t1', 'h1', 2), content: '', deleted: true }
    expect(pruneHiddenTombstones([stub, tomb]).map((x) => x.id)).toEqual([])
    expect(pruneHiddenTombstones([stub, tomb, reply('c1', 't1', 3)]).map((x) => x.id)).toEqual(['h1', 't1', 'c1'])
  })

  it('does not count as a reply in the visible total', async () => {
    const { countVisibleReplies } = await import('./visible-reply-counts')
    expect(countVisibleReplies([{ content: { hiddenStub: true }, nestedReplies: [{ content: {}, nestedReplies: [] }] }])).toBe(1)
  })
})

describe('withMissingReplyParents', () => {
  const tombstone = (id: string, replyToReplyId: string | undefined, at: number): Reply => ({ ...reply(id, replyToReplyId, at), content: '', deleted: true })
  // Tomb2 (a tombstone) nests under Tomb1 (another); Live sits on a later page; Gone was removed.
  const stored = new Map([tombstone('tomb1', undefined, 1), tombstone('tomb2', 'tomb1', 2), reply('live', undefined, 3)].map((r) => [r.id, r]))
  const reads = () => ({
    getMany: vi.fn(async (ids: string[]) => ids.flatMap((id) => stored.get(id) ?? [])),
    provenAbsent: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => id === 'gone'))),
  })
  const page = [reply('c1', 'tomb2', 10), reply('c2', 'live', 11), reply('c3', 'gone', 12)]

  beforeEach(() => {
    shape.liveThreads = false
    shape.outlive = true
  })

  it('reads tombstoned parents by id, a chain level by level, and stubs only the parents proved gone, where repliesOf is live-keyed', async () => {
    shape.liveThreads = true
    const r = reads()
    const replies = await withMissingReplyParents(page, r)
    expect(r.getMany.mock.calls).toEqual([[['tomb2', 'live', 'gone']], [['tomb1']]])
    // The live parent is left to its own page; it is neither added nor proved.
    expect(r.provenAbsent).toHaveBeenCalledWith(['live', 'gone'])
    expect(replies.map((x) => [x.id, x.deleted === true, x.deletedStub === true])).toEqual([
      ['gone', false, true], ['tomb1', true, false], ['tomb2', true, false], ['c1', false, false], ['c2', false, false], ['c3', false, false],
    ])
    // The thread shows c1 under the two placeholders and c3 under the stub; c2 waits for its parent's page.
    // A root by someone else, so none of A's replies are hoisted into an author thread.
    const root = { id: 'ROOT', author: { ...author, id: 'B' }, content: 'root', createdAt: new Date(0), likes: 0, reposts: 0, replies: 0, quotes: 0, views: 0 }
    const thread = assembleFlatThread(root, replies)
    const shown = (threads: typeof thread): unknown[] => threads.map((t) => [t.content.id, shown(t.nestedReplies)])
    expect(shown(thread)).toEqual([['tomb1', [['tomb2', [['c1', []]]]]], ['gone', [['c3', []]]]])
  })

  it('reads nothing by id on the earlier shape, where tombstones are listed, and only stubs the proved-gone', async () => {
    const r = reads()
    const replies = await withMissingReplyParents(page, r)
    expect(r.getMany).not.toHaveBeenCalled()
    expect(r.provenAbsent).toHaveBeenCalledWith(['tomb2', 'live', 'gone'])
    expect(replies.map((x) => x.id)).toEqual(['gone', 'c1', 'c2', 'c3'])
  })

  it('follows a chain of tombstoned parents of any depth, reading each once', async () => {
    shape.liveThreads = true
    const chain = Array.from({ length: 12 }, (_, i) => tombstone(`t${i}`, i === 0 ? undefined : `t${i - 1}`, i + 1))
    const byId = new Map(chain.map((r) => [r.id, r]))
    const getMany = vi.fn(async (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []))
    const replies = await withMissingReplyParents([reply('leaf', 't11', 100)], { getMany, provenAbsent: async () => new Set<string>() })
    expect(getMany).toHaveBeenCalledTimes(12)
    expect(new Set(replies.map((x) => x.id))).toEqual(new Set(['leaf', ...chain.map((r) => r.id)]))
  })

  it('neither reads nor proves a parent an earlier page already shows', async () => {
    shape.liveThreads = true
    const r = reads()
    const replies = await withMissingReplyParents(page, r, new Set(['tomb2', 'live']))
    expect(r.getMany.mock.calls).toEqual([[['gone']]])
    expect(r.provenAbsent).toHaveBeenCalledWith(['gone'])
    expect(replies.map((x) => x.id)).toEqual(['gone', 'c1', 'c2', 'c3'])
  })

  it('proves nothing where a reply cannot outlive its parent, and passes a failed read on', async () => {
    shape.outlive = false
    const r = reads()
    expect(await withMissingReplyParents(page, r)).toEqual(page)
    expect(r.provenAbsent).not.toHaveBeenCalled()
    shape.liveThreads = true
    await expect(withMissingReplyParents(page, { ...r, getMany: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  })
})
