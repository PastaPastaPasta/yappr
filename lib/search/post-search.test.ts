import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Post } from '@/lib/types'

const mocks = vi.hoisted(() => ({ timeline: vi.fn() }))
vi.mock('@/lib/services/post-service', () => ({ postService: { getTimeline: mocks.timeline } }))
import { searchPostPage } from './post-search'

const post = (index: number, content = 'ordinary post', deleted = false) => ({
  id: `post-${index}`, content, deleted, createdAt: new Date(1000), author: { id: 'author' },
}) as Post

beforeEach(() => vi.resetAllMocks())

describe('Explore post search continuation', () => {
  it('reaches older matches after a full page with no matches', async () => {
    const first = Array.from({ length: 100 }, (_, i) => post(i))
    mocks.timeline.mockResolvedValueOnce({ documents: first })
      .mockResolvedValueOnce({ documents: [post(100, 'A masternode story'), post(101)] })
    const initial = await searchPostPage('  MASTERNODE  ')
    expect(initial).toMatchObject({ posts: [], scanned: 100, cursor: 'post-99', hasMore: true })
    const older = await searchPostPage('  MASTERNODE  ', initial.cursor)
    expect(mocks.timeline).toHaveBeenLastCalledWith({ limit: 100, startAfter: 'post-99' })
    expect(older.posts.map(value => value.id)).toEqual(['post-100'])
    expect(older).toMatchObject({ scanned: 2, cursor: 'post-101', hasMore: false })
  })

  it('advances across deleted last records and equal timestamps', async () => {
    const records = Array.from({ length: 100 }, (_, i) => post(i, 'match', i === 99))
    mocks.timeline.mockResolvedValue({ documents: records })
    const page = await searchPostPage('match')
    expect(page.posts).toHaveLength(99)
    expect(page.cursor).toBe('post-99')
    expect(page.hasMore).toBe(true)
  })

  it('finishes on an empty page and exposes failures for retry', async () => {
    mocks.timeline.mockResolvedValueOnce({ documents: [] }).mockRejectedValueOnce(new Error('offline'))
    expect(await searchPostPage('needle', 'last')).toMatchObject({ posts: [], scanned: 0, cursor: 'last', hasMore: false })
    await expect(searchPostPage('needle', 'last')).rejects.toThrow('offline')
  })
})
