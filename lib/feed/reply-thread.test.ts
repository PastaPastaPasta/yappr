import { describe, expect, it } from 'vitest'
import type { Post, Reply } from '@/lib/types'
import { assembleFlatThread, authorThreadDepthFirst, buildReplyTree } from './reply-thread'

const author = { id: 'author', username: 'author', displayName: 'Author', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) }
const root: Post = { id: 'root', author, content: 'root', createdAt: new Date(0), likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 }
const reply = (id: string, at: number, parent?: string): Reply => ({
  ...root, id, createdAt: new Date(at), parentId: 'root', parentOwnerId: 'author', rootPostId: 'root', replyToReplyId: parent,
})

describe('post detail author thread order (#672)', () => {
  it.each([
    ['root', 'part2', 'part3'],
    ['part2', 'part3', 'part4'],
  ])('keeps v2 continuations together when viewing %s', (id, firstId, continuationId) => {
    const v2Reply = (replyId: string, at: number, parentId: string): Reply => ({
      ...root, id: replyId, createdAt: new Date(at), parentId, parentOwnerId: 'author',
    })
    const part2 = v2Reply(firstId, 1, id)
    const part3 = v2Reply(continuationId, 2, part2.id)
    const late = v2Reply('late', 3, id)
    const childrenOf = new Map([[part2.id, [part3]], [late.id, []], [part3.id, []]])
    const ordered = authorThreadDepthFirst(author.id, [late, part2], childrenOf)
    const threads = buildReplyTree(ordered, [], childrenOf)
    expect(threads.map(thread => thread.content.id)).toEqual([firstId, continuationId, 'late'])
    expect(threads.map(thread => thread.isThreadContinuation)).toEqual([false, true, true])
  })

  it('keeps each continuation together before a later reply to the root', () => {
    const threads = assembleFlatThread(root, [reply('late', 3), reply('part3', 2, 'part2'), reply('part2', 1)])
    expect(threads.map(thread => thread.content.id)).toEqual(['part2', 'part3', 'late'])
  })

  it('uses depth-first order on a focused reply too', () => {
    const focus = { ...root, id: 'part2', parentId: 'root', parentOwnerId: 'author', rootPostId: 'root' }
    const threads = assembleFlatThread(focus, [reply('part3', 2, 'part2'), reply('late', 4, 'part2'), reply('part4', 3, 'part3')])
    expect(threads.map(thread => thread.content.id)).toEqual(['part3', 'part4', 'late'])
  })
})
