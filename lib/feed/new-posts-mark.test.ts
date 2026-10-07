import { describe, expect, it } from 'vitest'
import { markAfterCheck, newPostsCheckFrom } from './new-posts-mark'

const post = (at: number) => ({ $id: `p${at}`, $createdAt: at })

describe('the new-posts mark', () => {
  it('a complete check moves the mark to the newest post it read', () => {
    const mark = markAfterCheck(null, 1, 10_000, { posts: [post(10_010), post(10_005)], complete: true })
    expect(mark).toEqual({ generation: 1, at: 10_010 })
    expect(newPostsCheckFrom(10_000, mark, 1)).toBe(10_010)
  })

  it('a partial check leaves the mark, so the stretch it may have missed is read again', () => {
    // The first page held a 10:10 post; a failed continuation hid another owner's 10:05 post.
    const before = { generation: 1, at: 10_000 }
    const after = markAfterCheck(before, 1, 10_000, { posts: [post(10_010)], complete: false })
    expect(after).toBe(before)
    expect(newPostsCheckFrom(10_000, after, 1)).toBe(10_000)
  })

  it('an empty complete check keeps the start as the mark', () => {
    expect(markAfterCheck(null, 2, 9_000, { posts: [], complete: true })).toEqual({ generation: 2, at: 9_000 })
  })

  it('ignores the mark of another feed view', () => {
    expect(newPostsCheckFrom(5_000, { generation: 1, at: 99_000 }, 2)).toBe(5_000)
  })
})
