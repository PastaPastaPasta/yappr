import { describe, expect, it } from 'vitest'
import { mergeFeedItems, transformRawPost } from './transform-raw-post'

const post = (id: string, at: number) => transformRawPost({ $id: id, $ownerId: 'owner0000001', $createdAt: at, content: id })

describe('mergeFeedItems', () => {
  it('places a post recovered from a partial check by time, below newer posts already shown', () => {
    // The feed showed up to 10:00, then the pill opened with the 10:10 post from a partial check.
    const shown = [post('p10010', 10_010), post('p10000', 10_000)]
    // The recovered check finds the 10:05 post.
    expect(mergeFeedItems([post('p10005', 10_005)], shown).map(p => p.content)).toEqual(['p10010', 'p10005', 'p10000'])
  })

  it('keeps pending batches in time order when a later check finds an older post', () => {
    const pending = [post('p10010', 10_010)]
    expect(mergeFeedItems([post('p10005', 10_005)], pending).map(p => p.content)).toEqual(['p10010', 'p10005'])
  })

  it('lists each id once, the incoming copy winning', () => {
    const merged = mergeFeedItems([{ ...post('a', 2), content: 'new' }], [post('a', 2), post('b', 1)])
    expect(merged.map(p => p.content)).toEqual(['new', 'b'])
  })
})
