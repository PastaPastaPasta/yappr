import { describe, expect, it } from 'vitest'
import type { Reply, User } from '@/lib/types'
import { assembleFlatThread, assembleV2Thread, flattenThreads } from '../../src/dto/thread'

const user = (id: string): User => ({ id, username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) })

let clock = 0
/** A reply in thread `root`, by `author`, nested under `under` (a reply id) or directly under the root. */
const reply = (id: string, author: string, under?: string): Reply => ({
  id, author: user(author), content: id, createdAt: new Date(++clock), likes: 0, reposts: 0, replies: 0, views: 0,
  parentId: under ?? 'root', parentOwnerId: '', rootPostId: 'root', ...(under ? { replyToReplyId: under } : {}),
})

const rows = (threads: ReturnType<typeof assembleFlatThread>) =>
  flattenThreads(threads).map(({ reply, depth, isAuthorThread, hiddenReplyCount }) =>
    `${reply.id}@${depth}${isAuthorThread ? '*' : ''}${hiddenReplyCount ? `+${hiddenReplyCount}` : ''}`)

describe('flat thread assembly (use-post-detail.ts port)', () => {
  // OP's own continuation (a1 → a2), two others, a deep branch under b1.
  const replies = [
    reply('b1', 'bob'), reply('a1', 'op'), reply('c1', 'carol'),
    reply('a2', 'op', 'a1'), reply('b2', 'carol', 'b1'), reply('b3', 'bob', 'b2'), reply('b4', 'carol', 'b3'), reply('b5', 'bob', 'b4'),
  ]

  it('lists the author thread first, then the rest with one indent level and hidden counts past the cap', () => {
    const threads = assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, replies)
    expect(rows(threads)).toEqual(['a1@0*', 'a2@0*', 'b1@0', 'b2@1', 'b3@1+2', 'c1@0'])
  })

  it('renders the subtree of a focused reply', () => {
    const threads = assembleFlatThread({ id: 'b2', authorId: 'carol', isReply: true }, replies)
    // b3 is not carol's; b4 under it is, but the author thread only follows the focus author's direct line.
    expect(rows(threads)).toEqual(['b3@0', 'b4@1', 'b5@1'])
  })

  it("keeps the author's thread in reading order when they also reply to the post later (D-L2a-002)", () => {
    // A three-part thread (p1 → p2 → p3), then the author's own later reply to the post, and one by someone else.
    const thread = [reply('p1', 'op'), reply('p2', 'op', 'p1'), reply('p3', 'op', 'p2'), reply('late', 'op'), reply('d1', 'dan')]
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, thread)))
      .toEqual(['p1@0*', 'p2@0*', 'p3@0*', 'late@0*', 'd1@0'])
  })

  it('is order-independent (sorted by creation time)', () => {
    const shuffled = [...replies].reverse()
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, shuffled)))
      .toEqual(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, replies)))
  })
})

describe('removed-reply placeholders (v20)', () => {
  const stub = (id: string, under?: string, kept?: string): Reply => ({
    ...reply(id, '', under), content: '', deletedStub: true, ...(kept ? { keptParentId: kept } : {}),
  })

  it('nests a placeholder held at the top under its kept parent once a later page brings it, or it is the focus', () => {
    const page = [stub('gone', undefined, 'a'), reply('c', 'carol', 'gone')]
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, page))).toEqual(['gone@0', 'c@1'])
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, [...page, reply('a', 'bob')])))
      .toEqual(['a@0', 'gone@1', 'c@1'])
    expect(rows(assembleFlatThread({ id: 'a', authorId: 'bob', isReply: true }, page))).toEqual(['gone@0', 'c@1'])
  })

  it('never ends a branch at the depth cap on a placeholder, which cannot be opened', () => {
    const chain = [reply('a', 'bob'), reply('b', 'carol', 'a'), stub('gone', 'b'), reply('c', 'dan', 'gone'), reply('d', 'erin', 'c')]
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, chain))).toEqual(['a@0', 'b@1', 'gone@1', 'c@1+1'])
  })

  it('renders a branch through a placeholder past the cap, leaving only listed branches behind Continue thread', () => {
    const chain = [reply('a', 'bob'), reply('b', 'carol', 'a'), reply('x', 'dan', 'b'), stub('gone', 'x'), reply('c', 'erin', 'gone'), reply('y', 'fay', 'x'), reply('z', 'gus', 'y')]
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, chain))).toEqual(['a@0', 'b@1', 'x@1+2', 'gone@1', 'c@1'])
  })

  it('keeps a placeholder at the top while its kept parent is loaded but not yet connected to the thread', () => {
    const page = [stub('gone', undefined, 'a'), reply('c', 'carol', 'gone')]
    // a arrives, but its own parent x does not: gone and c stay visible at the top.
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, [...page, reply('a', 'bob', 'x')]))).toEqual(['gone@0', 'c@1'])
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, [...page, reply('a', 'bob', 'x'), reply('x', 'dan')])))
      .toEqual(['x@0', 'a@1', 'gone@1', 'c@1'])
  })
})

describe('v2 thread assembly', () => {
  it('walks the author continuation one level at a time, then nests the rest', async () => {
    const direct = [reply('x1', 'op'), reply('y1', 'yan')]
    const children = new Map<string, Reply[]>([
      ['x1', [reply('x2', 'op', 'x1'), reply('z1', 'zed', 'x1')]],
      ['x2', [reply('x3', 'op', 'x2')]],
      ['y1', [reply('y2', 'zed', 'y1')]],
    ])
    const asked: string[][] = []
    const nestedOf = async (ids: string[]) => {
      asked.push(ids)
      return new Map(ids.map(id => [id, children.get(id) ?? []]))
    }
    const threads = await assembleV2Thread({ id: 'root', authorId: 'op' }, direct, nestedOf)
    expect(rows(threads)).toEqual(['x1@0*', 'z1@1', 'x2@0*', 'x3@0*', 'y1@0', 'y2@1'])
    expect(asked).toEqual([['x1'], ['x2'], ['x3'], ['x1', 'y1', 'x2', 'x3']])
  })

  it("follows each of the author's lines to its end before the next (D-L2a-002)", async () => {
    const direct = [reply('p1', 'op'), reply('late', 'op')]
    const children = new Map<string, Reply[]>([
      ['p1', [reply('p2', 'op', 'p1')]],
      ['p2', [reply('p3', 'op', 'p2')]],
    ])
    const nestedOf = async (ids: string[]) => new Map(ids.map(id => [id, children.get(id) ?? []]))
    const threads = await assembleV2Thread({ id: 'root', authorId: 'op' }, direct, nestedOf)
    expect(rows(threads)).toEqual(['p1@0*', 'p2@0*', 'p3@0*', 'late@0*'])
  })
})
