import type { RankingWindow } from '@engine/api/dto';
import type { FeedTab } from '@engine/api/feed';
import type { NotificationFilter } from '@engine/api/notifications';
import type { EngagementTab } from '@engine/api/posts';
import type { ProfileTab } from '@engine/api/profiles';

import { engineNetworkKey } from '~/engine';

/**
 * The one query-key factory for engine data (src/data/README.md). Every key
 * starts with `['engine', <network>]`, so a cache can never serve another
 * network's data, and keys nest so a prefix invalidates a family:
 * `queryKeys.post.detail(id)` covers that post's thread, engagements and
 * stats too.
 *
 * Shared file: add new keys at the end of their section, and don't reorder.
 */

const root = ['engine', engineNetworkKey] as const;

type Sort = 'recent' | 'top';

/** A sorted list's defaults, filled in so `{ tab }` and `{ tab, sort: 'recent' }` share a key. */
const sorted = <Q extends { sort?: Sort; window?: RankingWindow }>(q: Q) => ({
  ...q,
  sort: q.sort ?? 'recent',
  window: q.window ?? 'all',
});

export const queryKeys = {
  /** Every engine query on this network. */
  all: root,

  feed: {
    all: [...root, 'feed'] as const,
    /** `feed.home`. */
    home: (q: { tab: FeedTab; sort?: Sort; window?: RankingWindow }) =>
      [...root, 'feed', 'home', sorted(q)] as const,
    /** `feed.hashtag` (storage-form tag). */
    hashtag: (q: { tag: string; sort?: Sort; window?: RankingWindow }) =>
      [...root, 'feed', 'hashtag', sorted(q)] as const,
  },

  post: {
    all: [...root, 'post'] as const,
    /** `posts.get`. A prefix of everything below for the same id. */
    detail: (id: string) => [...root, 'post', id] as const,
    /** `posts.thread` (cumulative pages). */
    thread: (id: string) => [...root, 'post', id, 'thread'] as const,
    /** `posts.engagements`. */
    engagements: (id: string, tab: EngagementTab) => [...root, 'post', id, 'engagements', tab] as const,
    /** `posts.engagementCounts`. */
    engagementCounts: (id: string) => [...root, 'post', id, 'engagementCounts'] as const,
    /** `engage.stats` for one target, stored as `{ id, stats, viewer }` (optimistic updates find it). */
    stats: (id: string) => [...root, 'post', id, 'stats'] as const,
    /** `posts.poll`. */
    poll: (pollId: string) => [...root, 'poll', pollId] as const,
    /** `safety.ownReport`: the viewer's report on this post or reply. */
    ownReport: (id: string) => [...root, 'post', id, 'ownReport'] as const,
  },

  profile: {
    all: [...root, 'profile'] as const,
    /** `profiles.get` (identity id or DPNS name). */
    detail: (idOrName: string) => [...root, 'profile', idOrName] as const,
    /** `profiles.posts`. */
    posts: (id: string, tab: ProfileTab, window?: RankingWindow) =>
      [...root, 'profile', id, 'posts', { tab, window: window ?? 'all' }] as const,
    /** `graph.followers` / `graph.following`. */
    followers: (id: string) => [...root, 'profile', id, 'followers'] as const,
    following: (id: string) => [...root, 'profile', id, 'following'] as const,
  },

  explore: {
    all: [...root, 'explore'] as const,
    trending: (window: RankingWindow = 'all') => [...root, 'explore', 'trending', window] as const,
    topPosts: (window: RankingWindow = 'all') => [...root, 'explore', 'topPosts', window] as const,
    topCreators: (window: RankingWindow = 'all') => [...root, 'explore', 'topCreators', window] as const,
    search: (kind: 'users' | 'hashtags' | 'posts', q: string) => [...root, 'explore', 'search', kind, q] as const,
  },

  /** `engage.bookmarks`. */
  bookmarks: [...root, 'bookmarks'] as const,

  /** `notifications.list`. Never persisted. */
  notifications: (filter: NotificationFilter = 'all') => [...root, 'notifications', filter] as const,
  /** Every `notifications.list` filter: a prefix of the key above. */
  notificationsAll: [...root, 'notifications'] as const,

  /** `safety.blocked`. */
  blocked: [...root, 'blocked'] as const,
  /** `safety.isBlocked` for one account (batched by the caller). */
  blockStatus: (userId: string) => [...root, 'blockStatus', userId] as const,
  /** Every `blockStatus`: a prefix of the key above. */
  blockStatusAll: [...root, 'blockStatus'] as const,

  /** `settings.get`. */
  settings: [...root, 'settings'] as const,

  /** Direct messages. Never persisted: decrypted text must not reach MMKV. */
  dm: {
    all: [...root, 'dm'] as const,
    status: [...root, 'dm', 'status'] as const,
    conversations: [...root, 'dm', 'conversations'] as const,
    messages: (key: string) => [...root, 'dm', 'messages', key] as const,
  },
} as const;
