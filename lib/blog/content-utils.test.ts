import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  blogAuthorHandle,
  blogCommentsDefault,
  blogPostDate,
  createCommentReads,
  isPublishedBlogPost,
  labelProblem,
  labelsFromStored,
  mergeComments,
  publishedPostsNewestFirst,
  storedLabels,
} from './content-utils'
import { ListLimitError } from '@/lib/typed-array-codecs'

afterEach(() => {
  vi.unstubAllEnvs()
})

const day = (n: number) => Date.UTC(2026, 8, n)

describe('drafts are not public (QA D-27)', () => {
  it('treats a post with no publishedAt as a draft', () => {
    expect(isPublishedBlogPost({})).toBe(false)
    expect(isPublishedBlogPost({ publishedAt: 0 })).toBe(true)
    expect(isPublishedBlogPost({ publishedAt: day(2) })).toBe(true)
  })

  it('drops drafts from a public listing and orders it by publication date', () => {
    const createdToday = new Date(day(27))
    const posts = [
      { id: 'draft', createdAt: new Date(day(28)) },
      { id: 'sep-2', publishedAt: day(2), createdAt: createdToday },
      { id: 'sep-16', publishedAt: day(16), createdAt: createdToday },
      { id: 'sep-6', publishedAt: day(6), createdAt: createdToday },
    ]
    expect(publishedPostsNewestFirst(posts).map((post) => post.id)).toEqual(['sep-16', 'sep-6', 'sep-2'])
  })
})

describe('the date a reader sees (QA D-51)', () => {
  it('is publishedAt, not the document creation time', () => {
    const post = { publishedAt: day(2), createdAt: new Date(day(27)) }
    expect(blogPostDate(post).getTime()).toBe(day(2))
  })

  it('does not let an author date a post after the network recorded it', () => {
    const createdAt = new Date(day(27))
    expect(blogPostDate({ publishedAt: Date.UTC(2099, 0, 1), createdAt }).getTime()).toBe(day(27))
  })

  it('keeps the date a draft was published by a later revision', () => {
    const published = { publishedAt: day(28), createdAt: new Date(day(1)), $revision: 2 }
    expect(blogPostDate(published, day(28) + 1).getTime()).toBe(day(28))
    const older = { publishedAt: day(15), createdAt: new Date(day(15)) }
    vi.useFakeTimers({ now: day(28) + 1 })
    try {
      expect(publishedPostsNewestFirst([older, published])).toEqual([published, older])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still does not let a revised post date itself in the future', () => {
    const revised = { publishedAt: Date.UTC(2099, 0, 1), createdAt: new Date(day(1)), $revision: 2 }
    expect(blogPostDate(revised, day(28)).getTime()).toBe(day(1))
  })

  it('falls back to the creation time for a post without one', () => {
    const createdAt = new Date(day(27))
    expect(blogPostDate({ createdAt })).toBe(createdAt)
  })
})

describe('author handle (QA D-52)', () => {
  it('is @username when there is one', () => {
    expect(blogAuthorHandle('alice', '8DSffvR5abcdefghijklmnopqrstuvosiL')).toBe('@alice')
  })

  it('is a shortened identity id, never a bare "@", without a DPNS name', () => {
    for (const missing of ['', null, undefined]) {
      expect(blogAuthorHandle(missing, '8DSffvR5abcdefghijklmnopqrstuvosiL')).toBe('8DSffvR5...uvosiL')
    }
  })
})

describe('comments default (QA D-53)', () => {
  it('is on when the blog never set it, matching what new posts do', () => {
    expect(blogCommentsDefault({})).toBe(true)
    expect(blogCommentsDefault(undefined)).toBe(true)
  })

  it('keeps an explicit choice', () => {
    expect(blogCommentsDefault({ commentsEnabledDefault: false })).toBe(false)
    expect(blogCommentsDefault({ commentsEnabledDefault: true })).toBe(true)
  })
})

describe('just-created comments survive a lagging reload (QA D-28)', () => {
  const at = (n: number) => new Date(day(28) + n)
  const older = { id: 'a', createdAt: at(1) }
  const mine = { id: 'mine', createdAt: at(3) }

  it('keeps a created comment the read did not return, in time order', () => {
    const newer = { id: 'b', createdAt: at(5) }
    expect(mergeComments([older, newer], [mine]).map((comment) => comment.id)).toEqual(['a', 'mine', 'b'])
  })

  it('does not duplicate a created comment the read already returned', () => {
    expect(mergeComments([older, mine], [mine]).map((comment) => comment.id)).toEqual(['a', 'mine'])
  })

  const onPost = <T extends { id: string; createdAt: Date }>(comment: T) => ({ ...comment, blogPostId: 'post' })
  const ids = (list: { id: string }[] | null) => list?.map((comment) => comment.id) ?? null

  it('ignores an initial read that completes after the post-submit refresh', () => {
    const reads = createCommentReads<ReturnType<typeof onPost>>()
    const initial = reads.begin()
    reads.added(onPost(mine))
    const refresh = reads.begin()
    const afterWrite = [onPost(older), onPost(mine)]
    expect(ids(reads.settle(refresh, 'post', afterWrite, afterWrite))).toEqual(['a', 'mine'])
    // The older read returns its pre-write list last; it must not replace the newer one.
    expect(reads.settle(initial, 'post', [onPost(older)], [onPost(older)])).toBeNull()
    expect(reads.isCurrent(initial)).toBe(false)
  })

  it('keeps a created comment until a current read returns it, and lets a later read drop it', () => {
    const reads = createCommentReads<ReturnType<typeof onPost>>()
    reads.added(onPost(mine))
    const lagging = reads.begin()
    expect(ids(reads.settle(lagging, 'post', [onPost(older)], [onPost(older)]))).toEqual(['a', 'mine'])
    const caughtUp = reads.begin()
    expect(ids(reads.settle(caughtUp, 'post', [onPost(mine)], [onPost(mine)]))).toEqual(['mine'])
    const removed = reads.begin()
    expect(ids(reads.settle(removed, 'post', [], []))).toEqual([])
  })

  it('does not let a read begun before a delete restore the deleted comment', () => {
    const reads = createCommentReads<ReturnType<typeof onPost>>()
    reads.added(onPost(mine))
    const refresh = reads.begin()
    reads.removed('mine')
    const beforeDelete = [onPost(older), onPost(mine)]
    expect(ids(reads.settle(refresh, 'post', beforeDelete, beforeDelete))).toEqual(['a'])
    const lagging = reads.begin()
    expect(ids(reads.settle(lagging, 'post', beforeDelete, beforeDelete))).toEqual(['a'])
  })

  it('does not show a comment created on another post', () => {
    const reads = createCommentReads<ReturnType<typeof onPost>>()
    reads.added({ ...onPost(mine), blogPostId: 'other' })
    const read = reads.begin()
    expect(ids(reads.settle(read, 'post', [], []))).toEqual([])
  })
})

describe('labels are a list (QA D-55)', () => {
  it('keeps a label containing a comma whole on blog v4', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v4')
    expect(storedLabels(['alpha,beta', 'gamma'], 'blog')).toEqual(['alpha,beta', 'gamma'])
    expect(labelsFromStored(['alpha,beta', 'gamma'])).toEqual(['alpha,beta', 'gamma'])
  })

  it('refuses a comma on the CSV cuts instead of silently splitting the label', () => {
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v3')
    expect(() => storedLabels(['alpha,beta'], 'blog')).toThrow(ListLimitError)
    expect(storedLabels(['alpha', 'beta'], 'blog')).toBe('alpha,beta')
    // The editor asks the same question as the label is typed, not at publish.
    expect(labelProblem('alpha,beta')).toMatch(/comma/)
    expect(labelProblem('alpha')).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v4')
    expect(labelProblem('alpha,beta')).toBeNull()
  })

  it('reads a v1-v3 CSV string as a list and omits an empty one', () => {
    expect(labelsFromStored('oncall, databases')).toEqual(['oncall', 'databases'])
    expect(labelsFromStored('')).toBeUndefined()
    expect(labelsFromStored([])).toBeUndefined()
    expect(storedLabels([], 'post')).toBeUndefined()
  })
})
