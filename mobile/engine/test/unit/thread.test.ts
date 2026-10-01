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

  it('is order-independent (sorted by creation time)', () => {
    const shuffled = [...replies].reverse()
    expect(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, shuffled)))
      .toEqual(rows(assembleFlatThread({ id: 'root', authorId: 'op', isReply: false }, replies)))
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
})
