import { afterEach, describe, expect, it } from 'vitest'
import { countVisibleReplies, recordVisibleReplies, resetVisibleReplyCounts, shownReplyCount } from './visible-reply-counts'

interface Node { content: { deleted?: boolean; deletedStub?: boolean }; nestedReplies: Node[] }
const node = (content: Node['content'], nestedReplies: Node[] = []): Node => ({ content, nestedReplies })

afterEach(() => resetVisibleReplyCounts())

describe('countVisibleReplies', () => {
  it('counts live replies at every level', () => {
    expect(countVisibleReplies([node({}, [node({}), node({}, [node({})])]), node({})])).toBe(5)
  })

  it('does not count tombstones or deleted-parent stubs, but counts the live replies under them', () => {
    expect(countVisibleReplies([node({ deleted: true }, [node({})]), node({ deletedStub: true }, [node({}), node({ deleted: true })])])).toBe(2)
  })

  it('is zero for an empty thread', () => {
    expect(countVisibleReplies([])).toBe(0)
  })
})

describe('shownReplyCount', () => {
  it('shows the proved count until a thread was recorded', () => {
    expect(shownReplyCount('p', 1)).toBe(1)
  })

  it('shows what the thread showed while the proved count is unchanged (a tombstone-only thread reads 0)', () => {
    recordVisibleReplies('p', 1, 0)
    expect(shownReplyCount('p', 1)).toBe(0)
    expect(shownReplyCount('other', 1)).toBe(1)
  })

  it('goes back to the proved count once that count changes (a new reply landed)', () => {
    recordVisibleReplies('p', 1, 0)
    expect(shownReplyCount('p', 2)).toBe(2)
  })

  it('never raises a count, and a later full match clears the record', () => {
    recordVisibleReplies('p', 1, 3)
    expect(shownReplyCount('p', 1)).toBe(1)
    recordVisibleReplies('p', 2, 1)
    recordVisibleReplies('p', 2, 2)
    expect(shownReplyCount('p', 2)).toBe(2)
  })
})
