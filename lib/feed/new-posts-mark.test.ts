import { describe, expect, it } from 'vitest'
import { markAfterCheck, newPostsCheckFrom } from './new-posts-mark'

const post = (at: number) => ({ $id: `p${at}`, $createdAt: at })

describe('the new-posts mark', () => {
  it('starts from the newest post on screen until the view has a mark', () => {
    expect(newPostsCheckFrom(10_000, null, 1)).toBe(10_000)
  })

  it('a complete check moves the mark to the newest post it read', () => {
    const mark = markAfterCheck(1, 10_000, { posts: [post(10_010), post(10_005)], complete: true })
    expect(mark).toEqual({ generation: 1, at: 10_010 })
    expect(newPostsCheckFrom(10_000, mark, 1)).toBe(10_010)
  })

  it('a partial check sets the mark at its start, even with no mark yet', () => {
    // The first page held a 10:10 post; a failed continuation hid another owner's 10:05 post.
    const mark = markAfterCheck(1, 10_000, { posts: [post(10_010)], complete: false })
    expect(mark).toEqual({ generation: 1, at: 10_000 })
    expect(newPostsCheckFrom(10_000, mark, 1)).toBe(10_000)
  })

  it('opening the pill before recovery does not move the check past the unread stretch', () => {
    const mark = markAfterCheck(1, 10_000, { posts: [post(10_010)], complete: false })
    // showNewPosts moves the newest post on screen to 10:10.
    expect(newPostsCheckFrom(10_010, mark, 1)).toBe(10_000)
    // The recovered check finds the 10:05 post and only then moves on.
    const recovered = markAfterCheck(1, 10_000, { posts: [post(10_005), post(10_010)], complete: true })
    expect(newPostsCheckFrom(10_010, recovered, 1)).toBe(10_010)
  })

  it('an empty complete check keeps the start as the mark', () => {
    expect(markAfterCheck(2, 9_000, { posts: [], complete: true })).toEqual({ generation: 2, at: 9_000 })
  })

  it('ignores the mark of another feed view', () => {
    expect(newPostsCheckFrom(5_000, { generation: 1, at: 99_000 }, 2)).toBe(5_000)
  })
})
