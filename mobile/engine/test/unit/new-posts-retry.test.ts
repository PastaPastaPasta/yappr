import { describe, expect, it } from 'vitest'
import { NewPostsRetry } from '../../src/api/new-posts-retry'

describe('the Following new-posts retry boundary', () => {
  it('reads from the app\'s since while every scan is complete', () => {
    const retry = new NewPostsRetry()
    expect(retry.scanFrom('viewer', 10_000)).toBe(10_000)
    retry.settle('viewer', 10_000, true, ['p10010'])
    expect(retry.scanFrom('viewer', 10_010)).toBe(10_010)
    expect(retry.owes('viewer', 'p10005')).toBe(false)
  })

  it('keeps an incomplete scan\'s start after the app shows its answer and since moves past it', () => {
    const retry = new NewPostsRetry()
    // A scan from 10:00 returns a 10:10 post; a failed continuation hid a 10:05 post.
    retry.settle('viewer', 10_000, false, ['p10010'])
    // The pill opens: the app's since is now 10:10.
    expect(retry.scanFrom('viewer', 10_008)).toBe(10_000)
    // The missed post is owed; the one already handed back is not.
    expect(retry.owes('viewer', 'p10005')).toBe(true)
    expect(retry.owes('viewer', 'p10010')).toBe(false)
  })

  it('keeps the earliest start across incomplete scans and clears it on a complete one', () => {
    const retry = new NewPostsRetry()
    retry.settle('viewer', 10_000, false, [])
    retry.settle('viewer', 10_008, false, ['p10009'])
    expect(retry.scanFrom('viewer', 10_020)).toBe(10_000)
    retry.settle('viewer', 10_000, true, ['p10005'])
    expect(retry.scanFrom('viewer', 10_020)).toBe(10_020)
    expect(retry.owes('viewer', 'p10005')).toBe(false)
  })

  it('keeps viewers apart', () => {
    const retry = new NewPostsRetry()
    retry.settle('a', 10_000, false, [])
    expect(retry.scanFrom('b', 10_020)).toBe(10_020)
  })
})
