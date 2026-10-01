import type { PostDTO, PostStatsDTO, ViewerStateDTO } from '@engine/api/dto';
import { create } from 'zustand';

import { queryClient } from '~/state/query-client';

import { queryKeys } from './keys';

/**
 * Optimistic cache updates (src/data/README.md). An engagement changes a post
 * wherever it is cached: every feed page, profile tab, thread, detail, quote
 * embed and `engage.stats` entry holding that id. The helpers walk the engine
 * queries' data structurally, so a screen's new query shape is covered
 * without registering it, and each returns the change that undoes it.
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

/** Applies `visit` to every plain object in every cached engine query. */
function updateCache(visit: (object: Json) => Json): void {
  for (const [key, data] of queryClient.getQueriesData({ queryKey: queryKeys.all })) {
    if (data === undefined) continue;
    const next = mapObjects(data, visit);
    if (next !== data) queryClient.setQueryData(key, next);
  }
}

/** Every cached copy of a post, in every engine query. */
export function updateCachedPosts(postId: string, update: (post: CachedPost) => CachedPost): void {
  updateCache((object) => (isCachedPost(object) && object.id === postId ? (update(object) as Json & CachedPost) : object));
}

/** The first cached copy of a post, if any. */
export function findCachedPost(postId: string): CachedPost | undefined {
  let found: CachedPost | undefined;
  updateCache((object) => {
    if (!found && isCachedPost(object) && object.id === postId) found = object;
    return object;
  });
  return found;
}

const EMPTY_VIEWER: ViewerStateDTO = {
  liked: false,
  reposted: false,
  bookmarked: false,
  ownQuoteId: null,
  authorBlocked: false,
  followsAuthor: false,
};

/** The viewer marks an engagement toggles; the counts follow the flags. */
export type ViewerPatch = Partial<Pick<ViewerStateDTO, 'liked' | 'reposted' | 'bookmarked' | 'ownQuoteId'>>;

const COUNTED = { liked: 'likes', reposted: 'reposts' } as const;

function applyViewerPatch(post: CachedPost, patch: ViewerPatch): CachedPost {
  const viewer = { ...EMPTY_VIEWER, ...post.viewer };
  const stats = { ...post.stats };
  let changed = false;
  for (const flag of ['liked', 'reposted', 'bookmarked'] as const) {
    const value = patch[flag];
    if (value === undefined || viewer[flag] === value) continue;
    viewer[flag] = value;
    changed = true;
    const count = flag === 'bookmarked' ? null : COUNTED[flag];
    if (count) stats[count] = Math.max(0, stats[count] + (value ? 1 : -1));
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
 * Returns the undo: the opposite flags and the previous `ownQuoteId`.
 */
export function setViewerState(postId: string, patch: ViewerPatch): () => void {
  const before = findCachedPost(postId)?.viewer;
  updateCachedPosts(postId, (post) => applyViewerPatch(post, patch));
  const undo: ViewerPatch = {};
  for (const flag of ['liked', 'reposted', 'bookmarked'] as const) {
    if (patch[flag] !== undefined) undo[flag] = !patch[flag];
  }
  if (patch.ownQuoteId !== undefined) undo.ownQuoteId = before?.ownQuoteId ?? null;
  return () => updateCachedPosts(postId, (post) => applyViewerPatch(post, undo));
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
        return { ...object, viewer: { ...EMPTY_VIEWER, ...object.viewer, followsAuthor: value } };
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
  return () => apply(!follows);
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
