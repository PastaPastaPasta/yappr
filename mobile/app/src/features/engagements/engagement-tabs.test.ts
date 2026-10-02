import { EMPTY_COPY, engagementTabs, initialTab, tabLabel } from './engagement-tabs';

describe('engagement tabs', () => {
  it('drops Reposts where the kind cannot be reposted (POST-06)', () => {
    expect(engagementTabs(true)).toEqual(['quotes', 'reposts', 'likes']);
    expect(engagementTabs(false)).toEqual(['quotes', 'likes']);
  });

  it('opens the requested tab when the post has it, else Likes', () => {
    expect(initialTab('quotes', engagementTabs(true))).toBe('quotes');
    expect(initialTab('reposts', engagementTabs(false))).toBe('likes');
    expect(initialTab(undefined, engagementTabs(true))).toBe('likes');
    expect(initialTab('nonsense', engagementTabs(true))).toBe('likes');
  });

  it('labels each tab with its count when known and non-zero', () => {
    const counts = { likes: 1234, reposts: 0, quotes: 4, truncated: false };
    expect(tabLabel('likes', counts)).toBe('Likes (1.2K)');
    expect(tabLabel('reposts', counts)).toBe('Reposts');
    expect(tabLabel('quotes', counts)).toBe('Quotes (4)');
    expect(tabLabel('likes', undefined)).toBe('Likes');
  });

  it('shows split counts as floors once the v10 quote list filled up', () => {
    const counts = { likes: 7, reposts: 100, quotes: 12, truncated: true };
    expect(tabLabel('reposts', counts)).toBe('Reposts (100+)');
    expect(tabLabel('quotes', counts)).toBe('Quotes (12+)');
    expect(tabLabel('likes', counts)).toBe('Likes (7)');
  });

  it('uses the web copy for empty tabs', () => {
    expect(EMPTY_COPY.likes).toEqual({
      title: 'No likes yet',
      description: "When people like this post, they'll appear here.",
    });
  });
});
