import type { AuthorDTO, NotificationDTO, NotificationFilter, PostDTO, SettingsDTO } from '@engine/api';

/**
 * What the Notifications tab shows, as pure functions of the engine's
 * `NotificationDTO`s (PRD NOTIF-01 – NOTIF-06, UX_SPEC §4.18 and copy §5.8).
 */

export type NotificationType = NotificationDTO['type'];
type NotificationToggles = SettingsDTO['notificationSettings'];
type SensitiveMode = SettingsDTO['sensitiveContentMode'];

/** The 1.0 filters (NOTIF-02): web's tabs without Blog and Private. */
export type MobileFilter = Extract<NotificationFilter, 'all' | 'like' | 'repost' | 'reply' | 'follow' | 'mention'>;

interface FilterDef {
  value: MobileFilter;
  label: string;
  /** The per-type toggle that hides this filter when off (NOTIF-05); `all` has none. */
  toggle: keyof NotificationToggles | null;
  empty: string;
}

export const FILTERS: readonly FilterDef[] = [
  { value: 'all', label: 'All', toggle: null, empty: "When someone interacts with you, you'll see it here" },
  { value: 'like', label: 'Likes', toggle: 'likes', empty: "When someone likes your post, you'll see it here" },
  {
    value: 'repost',
    label: 'Reposts',
    toggle: 'reposts',
    empty: "When someone reposts or quotes your post, you'll see it here",
  },
  {
    value: 'reply',
    label: 'Replies',
    toggle: 'replies',
    empty: "When someone replies to your post, you'll see it here",
  },
  { value: 'follow', label: 'Follows', toggle: 'follows', empty: "When someone follows you, you'll see it here" },
  {
    value: 'mention',
    label: 'Mentions',
    toggle: 'mentions',
    empty: "When someone mentions you, you'll see it here",
  },
];

/** A `?filter=` param, or a stored choice, as a 1.0 filter; anything else is All. */
export function parseFilter(value: unknown): MobileFilter {
  return FILTERS.find((filter) => filter.value === value)?.value ?? 'all';
}

/** Filters whose type is turned off in Settings are absent from the row (NOTIF-02). Unknown settings show all. */
export function visibleFilters(toggles: NotificationToggles | undefined): readonly FilterDef[] {
  if (!toggles) return FILTERS;
  return FILTERS.filter((filter) => filter.toggle === null || toggles[filter.toggle]);
}

export function emptyCopy(filter: MobileFilter): string {
  return FILTERS.find((def) => def.value === filter)?.empty ?? FILTERS[0].empty;
}

/** The per-type switches of Settings → Notifications (copy §5.10, NOTIF-05). */
export const TOGGLES: readonly { key: keyof NotificationToggles; label: string; description: string }[] = [
  { key: 'likes', label: 'Likes', description: 'When someone likes your posts' },
  { key: 'reposts', label: 'Reposts', description: 'When someone reposts your content' },
  { key: 'replies', label: 'Replies', description: 'When someone replies to you' },
  { key: 'follows', label: 'Follows', description: 'When someone follows you' },
  { key: 'mentions', label: 'Mentions', description: 'When someone mentions you' },
];

/** One row of the list: a single notification, or the likes of one post grouped (NOTIF-06). */
export interface NotificationRowModel {
  /** Stable across pages: the newest notification's id, or `likes:<post>` for a group. */
  key: string;
  type: NotificationType;
  /** Newest first, each identity once. */
  actors: AuthorDTO[];
  /** How many identities the row stands for: more than `actors` when v11 aggregated likes (NOTIF-06). */
  total: number;
  /** v11 likes keep no time: `at` is when this device noticed them ("Noticed 2h ago"). */
  noticed: boolean;
  /** Every notification the row stands for (a tap marks them all read). */
  ids: string[];
  unreadIds: string[];
  /** The newest of them. */
  at: Date;
  target: NotificationDTO['target'];
  preview: PostDTO | null;
  blog?: NotificationDTO['blog'];
}

/**
 * The loaded notifications as rows, newest first. Likes of the same post
 * collapse into one row at the position of the newest ("Alice and 2 others
 * liked your post"), so a popular post doesn't flood the list. Everything
 * else is one row per notification.
 */
export function groupNotifications(items: readonly NotificationDTO[]): NotificationRowModel[] {
  const rows: NotificationRowModel[] = [];
  const likeGroups = new Map<string, NotificationRowModel>();
  for (const item of items) {
    const groupKey = item.type === 'like' && item.target ? `likes:${item.target.id}` : null;
    const group = groupKey ? likeGroups.get(groupKey) : undefined;
    if (group) {
      group.ids.push(item.id);
      if (!item.read) group.unreadIds.push(item.id);
      const known = group.actors.some((actor) => actor.id === item.actor.id);
      if (!known) group.actors.push(item.actor);
      // A v11 batch counts its likers; a v10 like counts its actor once (a like, unlike, like).
      if (item.likers !== undefined || !known) group.total += item.likers ?? 1;
      continue;
    }
    const row: NotificationRowModel = {
      key: groupKey ?? item.id,
      type: item.type,
      actors: [item.actor],
      total: item.likers ?? 1,
      noticed: item.noticed === true,
      ids: [item.id],
      unreadIds: item.read ? [] : [item.id],
      at: item.at,
      target: item.target,
      preview: item.preview,
      ...(item.blog ? { blog: item.blog } : {}),
    };
    if (groupKey) likeGroups.set(groupKey, row);
    rows.push(row);
  }
  return rows;
}

const PHRASES: Record<NotificationType, string> = {
  follow: 'started following you',
  mention: 'mentioned you in a post',
  like: 'liked your post',
  repost: 'reposted your post',
  quote: 'quoted your post',
  reply: 'replied to your post',
  blogPost: 'published a new blog post',
  blogComment: 'commented on your blog post',
  privateFeedRequest: 'requested access to your private feed',
  privateFeedApproved: 'approved your private feed request',
  privateFeedRevoked: 'revoked your private feed access',
};

/** Where the topology can tell a reply from a post, the phrase says "your reply" (web `notificationMessage`). */
const REPLY_PHRASES: Partial<Record<NotificationType, string>> = {
  like: 'liked your reply',
  reply: 'replied to your reply',
  repost: 'reposted your reply',
  quote: 'quoted your reply',
};

/** The sentence after the actor's name: "liked your post", "and 2 others liked your reply". */
export function phraseOf(row: Pick<NotificationRowModel, 'type' | 'target' | 'total'>): string {
  const base =
    (row.target?.kind === 'reply' ? REPLY_PHRASES[row.type] : undefined) ??
    PHRASES[row.type] ??
    'interacted with you';
  const others = row.total - 1;
  if (others <= 0) return base;
  return `and ${others} ${others === 1 ? 'other' : 'others'} ${base}`;
}

/** The two-line snippet under a post notification, or null (NOTIF-01). */
export function snippetOf(
  preview: PostDTO | null,
  mode: SensitiveMode | undefined,
  viewerId: string | null,
): string | null {
  if (!preview || preview.deleted) return null;
  // The gate applies here too (G-14): only "Always show" reveals a flagged post's text. As on
  // web, a preview of the viewer's own post (what was liked or reposted) is not gated.
  if (preview.sensitive && mode !== 'show' && preview.author.id !== viewerId) return 'NSFW content';
  if (preview.encrypted) return 'Private post';
  const text = preview.content.trim();
  return text ? text : null;
}

export type Destination =
  | { kind: 'post'; id: string; post: PostDTO | null }
  | { kind: 'user'; id: string }
  | { kind: 'web'; path: string }
  | null;

/**
 * Where a tap goes (NOTIF-01): follows and private-feed events open the
 * actor's profile; likes and reposts the liked post; replies, quotes and
 * mentions the new post (its thread shows the context); blog events the
 * blog post on the web (no blogs in 1.0).
 */
export function destinationOf(row: NotificationRowModel): Destination {
  if (row.type === 'blogPost' || row.type === 'blogComment') {
    if (!row.blog) return null;
    return {
      kind: 'web',
      path: `/blog?blog=${encodeURIComponent(row.blog.blogId)}&post=${encodeURIComponent(row.blog.slug)}`,
    };
  }
  if (row.target) {
    return { kind: 'post', id: row.target.id, post: row.preview?.id === row.target.id ? row.preview : null };
  }
  const actor = row.actors[0];
  return actor ? { kind: 'user', id: actor.id } : null;
}
