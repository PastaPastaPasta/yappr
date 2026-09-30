import { describe, expect, it } from 'vitest'
import type { Reply } from '@/lib/types'
import { deletedReplyStubs, unloadedReplyParents } from './deleted-reply-stubs'

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
