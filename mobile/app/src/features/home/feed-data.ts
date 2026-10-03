import type { Page, PostDTO } from '@engine/api';
import type { InfiniteData } from '@tanstack/react-query';

import { isTransportFailure } from '~/data/read-error';

/**
 * Pure helpers over the home feed's cached pages (TanStack `InfiniteData`)
 * and the engine's errors.
 */

export type FeedData = InfiniteData<Page<PostDTO>, string | null>;

/** `feed.checkNew` returns at most this many (engine `NEW_POSTS_LIMIT`); a full answer may have a gap behind it. */
export const NEW_POSTS_LIMIT = 50;

/** The previous Yappr deployment web links to at the end of a feed (`lib/constants` `LEGACY_APP_URL`). */
export const LEGACY_APP_URL = 'https://yappr-v2.thepasta.org';

/** When the item entered the feed: a repost's time, else the post's (lib `getFeedItemTimestamp`). */
export function feedTimestamp(post: PostDTO): number {
  return (post.repostTimestamp ?? post.createdAt).getTime();
}

/**
 * The newest feed time among `posts`, or null for none. A post whose time
 * did not parse (an Invalid Date from a just-broadcast document) is skipped:
 * its NaN would turn the new-posts check off (FEED-05).
 */
export function newestTimestamp(posts: readonly PostDTO[]): number | null {
  let newest: number | null = null;
  for (const post of posts) {
    const at = feedTimestamp(post);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * `posts` on top of the first page, skipping any id already cached, so the
 * list grows at the top without a refetch (the new-posts pill, the viewer's
 * own new post).
 */
export function prependToFirstPage(data: FeedData | undefined, posts: readonly PostDTO[]): FeedData | undefined {
  const first = data?.pages[0];
  if (!data || !first || posts.length === 0) return data;
  const cached = new Set(data.pages.flatMap((page) => page.items.map((item) => item.id)));
  const fresh = posts.filter((post) => !cached.has(post.id));
  if (fresh.length === 0) return data;
  return { ...data, pages: [{ ...first, items: [...fresh, ...first.items] }, ...data.pages.slice(1)] };
}

/**
 * The first page alone. A refetch of an infinite query re-reads every page it
 * holds, so a refresh (and the cold start, PRD FEED-11) starts from one.
 */
export function keepFirstPage(data: FeedData | undefined): FeedData | undefined {
  if (!data || data.pages.length <= 1) return data;
  return { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) };
}

/** UX_SPEC §5.12, `lib/error-utils.ts`. */
export const UNAVAILABLE_MESSAGE = 'Dash Platform is temporarily unavailable. Please try again in a few moments.';
export const NETWORK_MESSAGE = 'Network error. Please check your connection and try again.';
export const SESSION_MESSAGE = 'Your session has expired. Please sign in again.';

const UNAVAILABLE_CODES = new Set([
  'ENGINE_UNAVAILABLE',
  'ENGINE_BUSY',
  'ENGINE_RESTARTED',
  'ENGINE_DISCONNECTED',
  'ENGINE_HELLO_TIMEOUT',
  'RPC_TIMEOUT',
  'UNAVAILABLE',
  'TIMEOUT',
]);

/**
 * The categorized copy for a failed read (PRD G-11), from the engine's error
 * code; for an error without one (lib's own text, such as a quorum or DAPI
 * request failure during boot), from what it says. While the phone is
 * `offline`, the network copy. Undefined when there is nothing specific to
 * say: the error state then shows only "Something went wrong".
 */
export function readErrorMessage(error: unknown, { offline = false }: { offline?: boolean } = {}): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'NOT_SIGNED_IN') return SESSION_MESSAGE;
  if (offline) return NETWORK_MESSAGE;
  if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return UNAVAILABLE_MESSAGE;
  if (code === 'NETWORK') return NETWORK_MESSAGE;
  if (isTransportFailure(error)) return UNAVAILABLE_MESSAGE;
  return undefined;
}
