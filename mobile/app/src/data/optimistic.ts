import type { Page, PostDTO, PostStatsDTO, ViewerStateDTO } from '@engine/api/dto';
import { create } from 'zustand';

import { queryClient } from '~/state/query-client';

import { queryKeys } from './keys';

/**
 * Optimistic cache updates (src/data/README.md "Optimistic updates"). The
 * helpers walk every cached engine query structurally and return their undo.
 */

type Json = Record<string, unknown>;

/** Anything cached with a post's `id` and `stats`: a PostDTO (or a subtype) or an `engage.stats` entry. */
export interface CachedPost {
  id: string;
  stats: PostStatsDTO;
  viewer?: Partial<ViewerStateDTO>;
  author?: { id: string };
}

const isPlainObject = (value: unknown): value is Json =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// `stats.likes` tells a post from a profile (whose stats count posts and followers).
const isCachedPost = (value: Json): value is Json & CachedPost =>
  typeof value.id === 'string' && isPlainObject(value.stats) && typeof value.stats.likes === 'number';

/**
 * Rebuilds `value` with `visit` applied to every plain object, children
 * first. Untouched branches keep their identity, so memoized cells of other
 * posts don't re-render.
 */
function mapObjects(value: unknown, visit: (object: Json) => Json): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = mapObjects(item, visit);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (!isPlainObject(value)) return value;
  let next: Json = value;
  for (const [key, child] of Object.entries(value)) {
    const mapped = mapObjects(child, visit);
    if (mapped !== child) {
      if (next === value) next = { ...value };
      next[key] = mapped;
    }
  }
  return visit(next);
}

/**
 * Applies `visit` to every plain object in the cached engine queries (or only
 * those named), and returns the hashes of the queries it changed. A changed
 * query keeps its age, so stale data still refetches, and a fetch already in
 * flight is cancelled, so it can't land the pre-write state over the change.
 * The cancel reverts the query to its state before that fetch (so it stays
 * `success`, never a `CancelledError`), and the patch then applies on top.
 */
function updateCache(visit: (object: Json) => Json, only?: ReadonlySet<string>): Set<string> {
  const changed = new Set<string>();
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })) {
    const data = query.state.data;
    if (data === undefined || (only && !only.has(query.queryHash))) continue;
    const next = mapObjects(data, visit);
    if (next === data) continue;
    changed.add(query.queryHash);
    if (query.state.fetchStatus === 'fetching') {
      queryClient.cancelQueries({ queryKey: query.queryKey, exact: true }).catch(() => undefined);
    }
    queryClient.setQueryData(query.queryKey, next, { updatedAt: query.state.dataUpdatedAt });
  }
  return changed;
}

/** Every cached copy of a post; returns the hashes of the queries it changed. */
export function updateCachedPosts(
  postId: string,
  update: (post: CachedPost) => CachedPost,
  only?: ReadonlySet<string>,
): Set<string> {
  return updateCache(
    (object) => (isCachedPost(object) && object.id === postId ? (update(object) as Json & CachedPost) : object),
    only,
  );
}

/** A signed-in viewer's marks before anything is known: nothing liked, followed or blocked. */
export const EMPTY_VIEWER: ViewerStateDTO = {
  liked: false,
  reposted: false,
  bookmarked: false,
  ownQuoteId: null,
  authorBlocked: false,
  followsAuthor: false,
};

/** The viewer marks an engagement toggles; the counts follow the flags. */
export type ViewerPatch = Partial<Pick<ViewerStateDTO, 'liked' | 'reposted' | 'bookmarked' | 'ownQuoteId'>>;

const FLAGS = ['liked', 'reposted', 'bookmarked'] as const;
const COUNTED: Partial<Record<(typeof FLAGS)[number], 'likes' | 'reposts'>> = { liked: 'likes', reposted: 'reposts' };

/**
 * Changes only the patched marks; fields the copy doesn't know stay unknown.
 * Counts move only where the copy knew the mark before, since otherwise the
 * previous state, and so the right count, is unknown.
 */
function applyViewerPatch(post: CachedPost, patch: ViewerPatch): CachedPost {
  const known = post.viewer;
  const viewer: Partial<ViewerStateDTO> = { ...known };
  const stats = { ...post.stats };
  let changed = false;
  for (const flag of FLAGS) {
    const value = patch[flag];
    if (value === undefined || viewer[flag] === value) continue;
    const knewIt = typeof known?.[flag] === 'boolean';
    viewer[flag] = value;
    changed = true;
    const count = COUNTED[flag];
    if (count && knewIt) stats[count] = Math.max(0, stats[count] + (value ? 1 : -1));
  }
  if (patch.ownQuoteId !== undefined && viewer.ownQuoteId !== patch.ownQuoteId) {
    viewer.ownQuoteId = patch.ownQuoteId;
    changed = true;
  }
  return changed ? { ...post, viewer, stats } : post;
}

/**
 * Sets the viewer's marks on every cached copy of a post, moving the like and
 * repost counts with the flags (a copy already in that state is left alone).
 * The undo sets the opposite marks on every copy, including copies cached
 * since (a detail screen seeded from a patched card), and refetches the
 * post's detail family so a copy that was already right comes back right.
 */
export function setViewerState(postId: string, patch: ViewerPatch): () => void {
  let previousQuote: string | null | undefined;
  updateCachedPosts(postId, (post) => {
    previousQuote ??= post.viewer?.ownQuoteId ?? null;
    return applyViewerPatch(post, patch);
  });
  const undo: ViewerPatch = {};
  for (const flag of FLAGS) {
    if (patch[flag] !== undefined) undo[flag] = !patch[flag];
  }
  if (patch.ownQuoteId !== undefined) undo.ownQuoteId = previousQuote ?? null;
  return () => {
    updateCachedPosts(postId, (post) => applyViewerPatch(post, undo));
    queryClient.invalidateQueries({ queryKey: queryKeys.post.detail(postId) }).catch(() => undefined);
  };
}

/**
 * Follow state for an author everywhere it is cached: their posts'
 * `viewer.followsAuthor`, their profile (`viewer.follows` and the follower
 * count) and user rows (`viewerFollows`). Returns the undo.
 */
export function setFollowing(authorId: string, follows: boolean): () => void {
  const apply = (value: boolean) =>
    updateCache((object) => {
      if (isCachedPost(object)) {
        if (object.author?.id !== authorId || object.viewer?.followsAuthor === value) return object;
        return { ...object, viewer: { ...object.viewer, followsAuthor: value } };
      }
      if (object.id !== authorId) return object;
      const viewer = object.viewer as { follows?: boolean } | undefined;
      // ProfileDTO: `viewer.follows`, and the follower count moves with it.
      if (viewer && typeof viewer.follows === 'boolean' && isPlainObject(object.stats)) {
        if (viewer.follows === value) return object;
        const stats = object.stats as { followers: number };
        return {
          ...object,
          viewer: { ...viewer, follows: value },
          stats: { ...stats, followers: Math.max(0, stats.followers + (value ? 1 : -1)) },
        };
      }
      // UserSummaryDTO.
      if (typeof object.viewerFollows === 'boolean' && object.viewerFollows !== value) {
        return { ...object, viewerFollows: value };
      }
      return object;
    });
  apply(follows);
  return () => {
    apply(!follows);
    queryClient.invalidateQueries({ queryKey: queryKeys.profile.detail(authorId) }).catch(() => undefined);
  };
}

/**
 * The viewer's block of an author on every cached post of theirs (and every
 * quote of one): `viewer.authorBlocked`, which hides the post from lists and
 * collapses it in threads. Kept in the persisted cache, so a relaunch before
 * the lists are read again still hides them. Returns the undo.
 */
export function setAuthorBlocked(authorId: string, blocked: boolean): () => void {
  const apply = (value: boolean) =>
    updateCache((object) => {
      if (!isCachedPost(object) || object.author?.id !== authorId || object.viewer?.authorBlocked === value) return object;
      return { ...object, viewer: { ...object.viewer, authorBlocked: value } };
    });
  apply(blocked);
  return () => {
    apply(!blocked);
  };
}

const isPostPages = (data: unknown): data is { pages: Page<PostDTO>[] } =>
  isPlainObject(data) &&
  Array.isArray(data.pages) &&
  data.pages.every((page: unknown) => isPlainObject(page) && Array.isArray(page.items));

/**
 * Takes a deleted post, and bare reposts of it, out of every cached list
 * (feeds, profile tabs, bookmarks, search), so it stays out of them after a
 * relaunch too, as the delete dialog promises. Threads, details and quotes
 * keep their copy, which `markPostDeleted` turns into the "deleted" line.
 */
export function dropFromLists(postId: string): void {
  const gone = (item: PostDTO) => item.id === postId || (item.bareRepost && item.quotedPostId === postId);
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })) {
    const data = query.state.data;
    if (!isPostPages(data) || !data.pages.some((page) => page.items.some(gone))) continue;
    if (query.state.fetchStatus === 'fetching') {
      queryClient.cancelQueries({ queryKey: query.queryKey, exact: true }).catch(() => undefined);
    }
    const pages = data.pages.map((page) =>
      page.items.some(gone) ? { ...page, items: page.items.filter((item) => !gone(item)) } : page,
    );
    queryClient.setQueryData(query.queryKey, { ...data, pages }, { updatedAt: query.state.dataUpdatedAt });
  }
}

/** Marks every cached copy of a post deleted (the card renders the "deleted" line). */
export function markPostDeleted(postId: string): void {
  updateCachedPosts(postId, (post) => ({ ...post, deleted: true }) as CachedPost & Pick<PostDTO, 'deleted'>);
}

interface RemovedPosts {
  ids: ReadonlySet<string>;
}

/**
 * Posts removed on this device (an optimistic delete). `PostItem` renders
 * nothing for them, so a deleted post leaves every list at once.
 */
export const useRemovedPosts = create<RemovedPosts>()(() => ({ ids: new Set<string>() }));

/** Hides a post everywhere `PostItem` renders it. Returns the undo. */
export function hidePost(postId: string): () => void {
  const update = (add: boolean) =>
    useRemovedPosts.setState(({ ids }) => {
      const next = new Set(ids);
      if (add) next.add(postId);
      else next.delete(postId);
      return { ids: next };
    });
  update(true);
  return () => update(false);
}

/** Whether this device removed the post (render nothing). */
export function usePostRemoved(postId: string): boolean {
  return useRemovedPosts((s) => s.ids.has(postId));
}
