import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewPostsRetry, selectNewPosts } from '../../src/api/new-posts-retry'

const OVERLAP = 2
const post = (at: number) => ({ id: `p${at}`, at })
const timeOf = (p: { at: number }) => p.at

/** One check as feed.checkNew runs it: scan from the retry start, select, then settle. */
function check(retry: NewPostsRetry, since: number, known: string[], scan: (from: number) => { posts: { id: string; at: number }[]; complete: boolean }) {
  const overlapFrom = since - OVERLAP
  const from = retry.scanFrom('viewer', overlapFrom)
  const { posts, complete } = scan(from)
  const { offered, recovered } = selectNewPosts(posts.filter(p => p.at > from), timeOf, { since, overlapFrom, known: new Set(known) })
  retry.settle('viewer', from, complete, recovered)
  return { from, offered: offered.map(p => p.id) }
}

afterEach(() => vi.useRealTimers())

describe('the Following new-posts retry on mobile', () => {
  // The chain after 10:00: a 10:05 post and a 10:10 post (minutes as numbers).
  const all = [post(1010), post(1005)]
  const partial = () => ({ posts: [post(1010)], complete: false })
  const whole = () => ({ posts: all, complete: true })

  it('offers a recovered post on every check until the app inserts it, then releases the boundary', () => {
    const retry = new NewPostsRetry()
    // 10:00 on screen; a continuation fails and hides the 10:05 post.
    expect(check(retry, 1000, ['p1000'], partial).offered).toEqual(['p1010'])

    // The pill opens: since moves to 10:10 and the app holds p1010.
    const known = ['p1010', 'p1000']
    const recovered = check(retry, 1010, known, whole)
    expect(recovered.from).toBe(998)
    expect(recovered.offered).toEqual(['p1005'])

    // The pill is left unopened: the next answer replaces it, and still has the post.
    expect(check(retry, 1010, known, whole).offered).toEqual(['p1005'])

    // Opened: p1005 comes back in knownIds, nothing is owed, and the boundary goes.
    expect(check(retry, 1010, ['p1005', ...known], whole).offered).toEqual([])
    expect(retry.scanFrom('viewer', 1008)).toBe(1008)
  })

  it('keeps the boundary while scans stay incomplete', () => {
    const retry = new NewPostsRetry()
    check(retry, 1000, [], partial)
    check(retry, 1010, ['p1010'], partial)
    expect(retry.scanFrom('viewer', 1008)).toBe(998)
  })

  it('stops holding a boundary that is never acknowledged after ten minutes', () => {
    vi.useFakeTimers()
    const retry = new NewPostsRetry()
    check(retry, 1000, [], partial)
    check(retry, 1010, ['p1010'], whole)
    expect(retry.scanFrom('viewer', 1008)).toBe(998)
    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(retry.scanFrom('viewer', 1008)).toBe(1008)
  })

  it('offers nothing older than the overlap without a held boundary', () => {
    const { offered } = selectNewPosts([post(1009), post(1005)], timeOf, { since: 1010, overlapFrom: 1008, known: new Set() })
    // The scan only reads after its start, so a 10:05 post cannot be in it then; with one, it would be a recovery.
    expect(offered.map(p => p.id)).toEqual(['p1009', 'p1005'])
  })

  it('keeps viewers apart', () => {
    const retry = new NewPostsRetry()
    retry.settle('a', 998, false, 0)
    expect(retry.scanFrom('b', 1008)).toBe(1008)
  })
})
