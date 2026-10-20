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
    /** `feed.checkNew`: posts newer than `since` (epoch ms) for the new-posts pill. Never persisted. */
    newPosts: (tab: FeedTab, since: number) => [...root, 'feed', 'newPosts', { tab, since }] as const,
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
    /** Every `posts.poll`: a prefix of the key above. */
    pollAll: [...root, 'poll'] as const,
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
    /** `posts.mentionCandidates` (compose's @-suggestions). */
    mentions: (prefix: string) => [...root, 'explore', 'mentions', prefix.toLowerCase()] as const,
  },

  blog: {
    /** Every blog query: a prefix that invalidates them all. */
    all: [...root, 'blogs'] as const,
    /** `blogs.info`: the cut's capabilities, limits and theme presets. */
    info: [...root, 'blogs', 'info'] as const,
    /** `blogs.discover`. */
    discover: [...root, 'blogs', 'discover'] as const,
    /** `blogs.latestPosts`. */
    latestPosts: [...root, 'blogs', 'latestPosts'] as const,
    /** `blogs.followed` (the viewer's). */
    followed: [...root, 'blogs', 'followed'] as const,
    /** `blogs.mine`. */
    mine: [...root, 'blogs', 'mine'] as const,
    /** `blogs.myPosts`. */
    myPosts: [...root, 'blogs', 'myPosts'] as const,
    /** `blogs.get`; a prefix of the blog's posts and follow state. */
    detail: (id: string) => [...root, 'blogs', 'blog', id] as const,
    /** `blogs.posts`. */
    posts: (id: string) => [...root, 'blogs', 'blog', id, 'posts'] as const,
    /** `blogs.followState`. */
    follow: (id: string) => [...root, 'blogs', 'blog', id, 'follow'] as const,
    /** `blogs.post`; a prefix of its comments. */
    post: (id: string) => [...root, 'blogs', 'post', id] as const,
    /** `blogs.postBySlug`. */
    postBySlug: (blogId: string, slug: string) => [...root, 'blogs', 'slug', blogId, slug] as const,
    /** Every `blogs.postBySlug` of one blog: a prefix. */
    slugs: (blogId: string) => [...root, 'blogs', 'slug', blogId] as const,
    /** `blogs.comments`. */
    comments: (postId: string) => [...root, 'blogs', 'post', postId, 'comments'] as const,
    /** `blogs.reportsOpen`. */
    reportsOpen: [...root, 'blogs', 'reportsOpen'] as const,
    /** `blogs.ownReport`. */
    ownReport: (docType: string, id: string) => [...root, 'blogs', 'ownReport', docType, id] as const,
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
  /** `safety.followedBlockLists`: how many block lists the viewer follows. */
  blockLists: [...root, 'blockLists'] as const,
  /** `safety.blockListChoices`: followed accounts and whether their block lists are followed. */
  blockListChoices: [...root, 'blockListChoices'] as const,
  /** `dpns.registration`: whether usernames are registered here or in the wallet. */
  dpnsRegistration: [...root, 'dpnsRegistration'] as const,
  /** `safety.reportsOpen`: whether a report can be filed now, or goes by email. */
  reportsOpen: [...root, 'reportsOpen'] as const,

  /** `settings.get`. */
  settings: [...root, 'settings'] as const,

  /** Direct messages. Never persisted: decrypted text must not reach MMKV. */
  dm: {
    all: [...root, 'dm'] as const,
    status: [...root, 'dm', 'status'] as const,
    conversations: [...root, 'dm', 'conversations'] as const,
    messages: (key: string) => [...root, 'dm', 'messages', key] as const,
    /** `profiles.batch` for conversation members and blocked people, in the order given. */
    people: (ids: readonly string[]) => [...root, 'dm', 'people', ids.join(',')] as const,
    /** Every `people` read, whatever the ids. */
    peopleAll: [...root, 'dm', 'people'] as const,
  },

  /** `session.appConnectConnections`: the keys the account's wallets granted Yappr. Never persisted. */
  walletConnections: (identityId: string) => [...root, 'walletConnections', identityId] as const,

  /** Private feeds. Never persisted: decrypted text must not reach MMKV. */
  privateFeed: {
    /** Every private-feed read: a prefix of the keys below. */
    all: [...root, 'privateFeed'] as const,
    /** `privateFeed.read`: one private post or reply, decrypted or why not. */
    post: (id: string) => [...root, 'privateFeed', 'post', id] as const,
    /** Every `post` read: a prefix of the key above. */
    posts: [...root, 'privateFeed', 'post'] as const,
    /** `privateFeed.access`: where the viewer stands with one owner's private feed. */
    access: (ownerId: string) => [...root, 'privateFeed', 'access', ownerId] as const,
    /** Every `access` read: a prefix of the key above. */
    accessAll: [...root, 'privateFeed', 'access'] as const,
    /** `privateFeed.replySource`: whether a reply to this private post is private (its thread is). */
    replySource: (id: string) => [...root, 'privateFeed', 'replySource', id] as const,
    /** The viewer's own feed: `overview`, `requests`, `followers` and `renewal`. */
    owner: [...root, 'privateFeed', 'owner'] as const,
    overview: [...root, 'privateFeed', 'owner', 'overview'] as const,
    requests: [...root, 'privateFeed', 'owner', 'requests'] as const,
    followers: [...root, 'privateFeed', 'owner', 'followers'] as const,
    renewal: [...root, 'privateFeed', 'owner', 'renewal'] as const,
  },
} as const;
