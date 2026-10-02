import type { NotificationDTO } from '@engine/api';

import { AUTHORS, fixturePost } from '~/ui/post/fixtures';

import {
  destinationOf,
  emptyCopy,
  groupNotifications,
  parseFilter,
  phraseOf,
  snippetOf,
  visibleFilters,
} from './notification-model';

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 1, 12) - minutesAgo * 60_000);

function notification(overrides: Partial<NotificationDTO> & Pick<NotificationDTO, 'id' | 'type'>): NotificationDTO {
  return {
    actor: AUTHORS.bob,
    at: at(1),
    read: false,
    target: null,
    preview: null,
    ...overrides,
  };
}

const ALL_ON = { likes: true, reposts: true, replies: true, follows: true, mentions: true, messages: true, blogPosts: true };
const target = (id: string, kind: 'post' | 'reply' = 'post') => ({ id, kind });

describe('filters', () => {
  it('lists the six 1.0 filters, hiding the types turned off (NOTIF-02)', () => {
    expect(visibleFilters(ALL_ON).map((f) => f.label)).toEqual([
      'All',
      'Likes',
      'Reposts',
      'Replies',
      'Follows',
      'Mentions',
    ]);
    expect(visibleFilters({ ...ALL_ON, likes: false, follows: false }).map((f) => f.value)).toEqual([
      'all',
      'repost',
      'reply',
      'mention',
    ]);
    expect(visibleFilters(undefined)).toHaveLength(6);
  });

  it('parses a filter param, defaulting to All', () => {
    expect(parseFilter('reply')).toBe('reply');
    expect(parseFilter('blogPost')).toBe('all');
    expect(parseFilter(undefined)).toBe('all');
  });

  it('has the per-filter empty copy (UX_SPEC §5.8)', () => {
    expect(emptyCopy('all')).toBe("When someone interacts with you, you'll see it here");
    expect(emptyCopy('repost')).toBe("When someone reposts or quotes your post, you'll see it here");
  });
});

describe('groupNotifications', () => {
  it('collapses likes of one post into the newest one’s row (NOTIF-06)', () => {
    const rows = groupNotifications([
      notification({ id: 'l1', type: 'like', actor: AUTHORS.bob, target: target('p1'), at: at(1) }),
      notification({ id: 'f1', type: 'follow', actor: AUTHORS.carol, at: at(2) }),
      notification({ id: 'l2', type: 'like', actor: AUTHORS.carol, target: target('p1'), at: at(3), read: true }),
      notification({ id: 'l3', type: 'like', actor: AUTHORS.nameless, target: target('p1'), at: at(4) }),
      notification({ id: 'l4', type: 'like', actor: AUTHORS.bob, target: target('p2'), at: at(5) }),
      // The same person again (a like, unlike, like): one face.
      notification({ id: 'l5', type: 'like', actor: AUTHORS.bob, target: target('p1'), at: at(6), read: true }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(['likes:p1', 'f1', 'likes:p2']);
    const [likes] = rows;
    expect(likes.ids).toEqual(['l1', 'l2', 'l3', 'l5']);
    expect(likes.unreadIds).toEqual(['l1', 'l3']);
    expect(likes.actors.map((a) => a.id)).toEqual([AUTHORS.bob.id, AUTHORS.carol.id, AUTHORS.nameless.id]);
    expect(likes.at).toEqual(at(1));
    expect(phraseOf(likes)).toBe('and 2 others liked your post');
  });

  it('counts the likers of v11 aggregated likes, and keeps their noticed time (NOTIF-06)', () => {
    const [row] = groupNotifications([
      notification({ id: 'b2', type: 'like', target: target('p1'), likers: 3, noticed: true }),
      notification({ id: 'b1', type: 'like', target: target('p1'), actor: AUTHORS.carol, noticed: true }),
    ]);
    expect(row.total).toBe(4);
    expect(row.noticed).toBe(true);
    expect(phraseOf(row)).toBe('and 3 others liked your post');
    expect(groupNotifications([notification({ id: 'f', type: 'follow' })])[0]).toMatchObject({ total: 1, noticed: false });
  });

  it('keeps every other type one row each', () => {
    const rows = groupNotifications([
      notification({ id: 'r1', type: 'repost', target: target('p1') }),
      notification({ id: 'r2', type: 'repost', target: target('p1'), actor: AUTHORS.carol }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(['r1', 'r2']);
  });
});

describe('phraseOf', () => {
  it.each([
    ['follow', null, 'started following you'],
    ['mention', 'post', 'mentioned you in a post'],
    ['like', 'post', 'liked your post'],
    ['like', 'reply', 'liked your reply'],
    ['repost', 'post', 'reposted your post'],
    ['quote', 'reply', 'quoted your reply'],
    ['reply', 'post', 'replied to your post'],
    ['privateFeedRequest', null, 'requested access to your private feed'],
  ] as const)('%s on a %s reads "%s"', (type, kind, phrase) => {
    expect(phraseOf({ type, target: kind ? target('x', kind) : null, total: 1 })).toBe(phrase);
  });

  it('counts one other in the singular', () => {
    expect(phraseOf({ type: 'like', target: target('x'), total: 2 })).toBe(
      'and 1 other liked your post',
    );
  });
});

describe('snippetOf', () => {
  const post = fixturePost({ content: '  hello world  ', author: AUTHORS.bob });

  it('shows the trimmed text', () => {
    expect(snippetOf(post, 'blur', AUTHORS.alice.id)).toBe('hello world');
    expect(snippetOf(null, 'blur', AUTHORS.alice.id)).toBeNull();
    expect(snippetOf({ ...post, content: ' ' }, 'blur', AUTHORS.alice.id)).toBeNull();
    expect(snippetOf({ ...post, deleted: true }, 'blur', AUTHORS.alice.id)).toBeNull();
    expect(snippetOf({ ...post, encrypted: true }, 'blur', AUTHORS.alice.id)).toBe('Private post');
  });

  it('gates a flagged post unless NSFW mode is "Always show", but never the viewer’s own (G-14)', () => {
    const flagged = { ...post, sensitive: true };
    expect(snippetOf(flagged, 'blur', AUTHORS.alice.id)).toBe('NSFW content');
    expect(snippetOf(flagged, 'hide', AUTHORS.alice.id)).toBe('NSFW content');
    expect(snippetOf(flagged, 'show', AUTHORS.alice.id)).toBe('hello world');
    expect(snippetOf(flagged, 'blur', AUTHORS.bob.id)).toBe('hello world');
  });
});

describe('destinationOf', () => {
  const [like, follow, reply, blog, blogless] = groupNotifications([
    notification({ id: 'l1', type: 'like', target: target('mine'), preview: fixturePost({ id: 'mine' }) }),
    notification({ id: 'f1', type: 'follow', actor: AUTHORS.carol }),
    notification({ id: 'r1', type: 'reply', target: target('their-reply', 'reply') }),
    notification({ id: 'b1', type: 'blogComment', blog: { blogId: 'blog 1', slug: 'hi&there' } }),
    notification({ id: 'b2', type: 'blogPost' }),
  ]);

  it('opens the post by id, never seeding it with the preview', () => {
    expect(destinationOf(like)).toEqual({ kind: 'post', id: 'mine' });
    expect(destinationOf(reply)).toEqual({ kind: 'post', id: 'their-reply' });
  });

  it('opens the actor for a follow', () => {
    expect(destinationOf(follow)).toEqual({ kind: 'user', id: AUTHORS.carol.id });
  });

  it('sends blog events to the web, or nowhere without coordinates', () => {
    expect(destinationOf(blog)).toEqual({ kind: 'web', path: '/blog?blog=blog%201&post=hi%26there' });
    expect(destinationOf(blogless)).toBeNull();
  });
});
