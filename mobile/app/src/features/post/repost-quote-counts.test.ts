import { splitRepostCounts } from './repost-quote-counts';

const stats = (reposts: number, quotes: number) => ({ likes: 0, replies: 0, reposts, quotes });
const read = (reposts: number, quotes: number, truncated = false) => ({ likes: 0, reposts, quotes, truncated });

describe('splitRepostCounts (D-L4a-009)', () => {
  it('reads a bare repost, held among the quote posts, as a repost', () => {
    expect(splitRepostCounts(stats(0, 1), read(1, 0))).toEqual({ reposts: 1, quotes: 0, truncated: false });
    expect(splitRepostCounts(stats(0, 3), read(2, 1))).toEqual({ reposts: 2, quotes: 1, truncated: false });
  });

  it('is unknown until the quote list is split, unless there are no quote posts at all', () => {
    expect(splitRepostCounts(stats(0, 2), undefined)).toBeNull();
    expect(splitRepostCounts(stats(1, 0), undefined)).toEqual({ reposts: 1, quotes: 0, truncated: false });
  });

  it("keeps the card's total, which optimistic reposts and undos move", () => {
    // The viewer reposted here: it sits in `reposts` until read back.
    expect(splitRepostCounts(stats(1, 1), read(0, 1))).toEqual({ reposts: 1, quotes: 1, truncated: false });
    // The viewer undid their bare repost after the split was read.
    expect(splitRepostCounts(stats(0, 1), read(1, 1))).toEqual({ reposts: 0, quotes: 1, truncated: false });
  });

  it('carries a floor from a quote list that filled up', () => {
    expect(splitRepostCounts(stats(0, 100), read(60, 40, true))).toEqual({ reposts: 60, quotes: 40, truncated: true });
  });
});
