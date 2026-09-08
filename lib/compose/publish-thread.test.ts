import { describe, expect, it } from 'vitest'
import { planPosts } from './publish-thread'

const thread = [
  { id: 'a', content: '  first  ', visibility: 'public' as const },
  { id: 'b', content: 'second', postedPostId: 'landed' },
  { id: 'c', content: '   ' },
  { id: 'd', content: 'fourth', teaser: ' tease ' },
]

describe('planPosts', () => {
  it('keeps unposted posts with content, trimmed, in order', () => {
    expect(planPosts(thread, undefined, false).map((p) => [p.threadPostId, p.content, p.teaser])).toEqual([
      ['a', 'first', undefined],
      ['d', 'fourth', 'tease'],
    ])
  })

  it('appends the image URL to the first post only when the content is encrypted', () => {
    expect(planPosts(thread, 'ipfs://cid', true)[0].content).toBe('first\n\nipfs://cid')
    expect(planPosts(thread, 'ipfs://cid', true)[1].content).toBe('fourth')
    expect(planPosts(thread, 'ipfs://cid', false)[0].content).toBe('first')
  })
})
