import { describe, expect, it } from 'vitest'
import type { Post } from '@/lib/types'
import { readCachedFeedPage } from './feed-page-cache'

const posts = [{ id: 'post00000001' }] as Post[]
const window = { start: new Date('2026-10-20T00:00:00Z'), end: new Date('2026-10-21T00:00:00Z'), windowHours: 24 }

describe('readCachedFeedPage', () => {
  it('restores a For You page with its id cursor', () => {
    const page = { posts, hasMore: true, token: { kind: 'cursor', cursor: 'post00000001' } }
    expect(readCachedFeedPage(page, 'cursor')).toEqual(page)
  })

  it('restores a Following page with its window', () => {
    const page = { posts, hasMore: true, token: { kind: 'window', window } }
    expect(readCachedFeedPage(page, 'window')).toEqual(page)
  })

  it('accepts a last page that has no continuation', () => {
    expect(readCachedFeedPage({ posts, hasMore: false, token: { kind: 'window', window: null } }, 'window')).not.toBeNull()
    expect(readCachedFeedPage({ posts, hasMore: false, token: { kind: 'cursor', cursor: null } }, 'cursor')).not.toBeNull()
  })

  it.each([
    ['nothing', undefined],
    ['the pre-token shape', { posts, cursor: 'post00000001', hasMore: true }],
    ['a missing hasMore', { posts, token: { kind: 'cursor', cursor: 'post00000001' } }],
    ['a For You page with no cursor but more to read', { posts, hasMore: true, token: { kind: 'cursor', cursor: null } }],
    ['a token of the other feed', { posts, hasMore: true, token: { kind: 'window', window } }],
  ])('rejects %s for a cursor feed', (_name, value) => {
    expect(readCachedFeedPage(value, 'cursor')).toBeNull()
  })

  it.each([
    ['the pre-token shape', { posts, cursor: null, hasMore: true }],
    ['a Following page with no window but more to read', { posts, hasMore: true, token: { kind: 'window', window: null } }],
    ['a window that lost its dates', { posts, hasMore: true, token: { kind: 'window', window: { start: '2026-10-20', end: '2026-10-21', windowHours: 24 } } }],
    ['a window without hours', { posts, hasMore: true, token: { kind: 'window', window: { start: window.start, end: window.end } } }],
    ['a cursor token', { posts, hasMore: true, token: { kind: 'cursor', cursor: 'post00000001' } }],
  ])('rejects %s for a window feed', (_name, value) => {
    expect(readCachedFeedPage(value, 'window')).toBeNull()
  })
})
