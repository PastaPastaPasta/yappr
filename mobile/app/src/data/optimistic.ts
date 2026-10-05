import type { Page, PostDTO, PostStatsDTO, ProfileDTO, ViewerStateDTO } from '@engine/api/dto';
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
function updateCache(visit: (object: Json, queryHash: string) => Json, only?: ReadonlySet<string>): Set<string> {
  const changed = new Set<string>();
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })) {
    const data = query.state.data;
    if (data === undefined || (only && !only.has(query.queryHash))) continue;
    const next = mapObjects(data, (object) => visit(object, query.queryHash));
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
  update: (post: CachedPost, queryHash: string) => CachedPost,
  only?: ReadonlySet<string>,
): Set<string> {
  return updateCache(
    (object, queryHash) => (isCachedPost(object) && object.id === postId ? (update(object, queryHash) as Json & CachedPost) : object),
    only,
  );
}

/**
 * What a change found in each query it changed, kept with the time that
 * query's data was read: a copy is restored from its own query's snapshot
 * only while the query has not been read again since (an optimistic patch
 * keeps that time). Copies in different queries can be at different
 * versions; copies in one query were read together.
 */
function snapshots<T>() {
  const byQuery = new Map<string, { at: number; value: T }>();
  const readAt = (hash: string) => queryClient.getQueryCache().get(hash)?.state.dataUpdatedAt;
  return {
    keep: (hash: string, value: T) => {
      const at = readAt(hash);
      if (at !== undefined && !byQuery.has(hash)) byQuery.set(hash, { at, value });
    },
    /** The query's own snapshot, if it still holds what the change patched. */
    own: (hash: string): { value: T } | undefined => {
      const kept = byQuery.get(hash);
      return kept && kept.at === readAt(hash) ? { value: kept.value } : undefined;
    },
  };
}

/** A signed-in viewer's marks before anything is known: nothing liked, followed or blocked. */
export const EMPTY_VIEWER: ViewerStateDTO = {
  liked: false,
  reposted: false,
  bookmarked: false,
  ownQuoteId: null,
  ownQuoteBare: false,
  authorBlocked: false,
  followsAuthor: false,
};

/** The viewer marks an engagement toggles; the counts follow the flags. */
export type ViewerPatch = Partial<Pick<ViewerStateDTO, 'liked' | 'reposted' | 'bookmarked' | 'ownQuoteId' | 'ownQuoteBare'>>;

const FLAGS = ['liked', 'reposted', 'bookmarked'] as const;
const COUNTED: Partial<Record<(typeof FLAGS)[number], 'likes' | 'reposts'>> = { liked: 'likes', reposted: 'reposts' };

/**
 * The count the viewer's repost is in. v10 has no repost documents: the
 * slot's post (`ownQuoteId`, a bare repost or a quote with text) is read back
 * among the quotes. A repost made here, its post not read back yet, is in
 * `reposts` until then, as every repost is on v2 and v9.
 */
function repostCount(before: Partial<ViewerStateDTO> | undefined, after: Partial<ViewerStateDTO>): 'reposts' | 'quotes' {
  const slot = after.reposted ? after : before;
  return slot?.ownQuoteId ? 'quotes' : 'reposts';
}

/**
 * Changes only the patched marks; fields the copy doesn't know stay unknown.
 * Counts move only where the copy knew the mark before, since otherwise the
 * previous state, and so the right count, is unknown. A copy whose patched
 * flags already read that way is left alone, its slot too: it is in that
 * state already, or stale, and either way not this change's to move.
 */
function applyViewerPatch(post: CachedPost, patch: ViewerPatch): CachedPost {
  const known = post.viewer;
  const flags = FLAGS.filter((flag) => patch[flag] !== undefined);
  if (flags.length > 0 && flags.every((flag) => known?.[flag] === patch[flag])) return post;
  const viewer: Partial<ViewerStateDTO> = { ...known };
  const stats = { ...post.stats };
  let changed = false;
  if (patch.ownQuoteId !== undefined && viewer.ownQuoteId !== patch.ownQuoteId) {
    viewer.ownQuoteId = patch.ownQuoteId;
    changed = true;
  }
  if (patch.ownQuoteBare !== undefined && viewer.ownQuoteBare !== patch.ownQuoteBare) {
    viewer.ownQuoteBare = patch.ownQuoteBare;
    changed = true;
  }
  for (const flag of FLAGS) {
    const value = patch[flag];
    if (value === undefined || viewer[flag] === value) continue;
    const knewIt = typeof known?.[flag] === 'boolean';
    viewer[flag] = value;
    changed = true;
    const count = flag === 'reposted' ? repostCount(known, viewer) : COUNTED[flag];
    if (count && knewIt) stats[count] = Math.max(0, stats[count] + (value ? 1 : -1));
  }
  return changed ? { ...post, viewer, stats } : post;
}

/** The hashes of the cached engine queries. */
const cachedQueries = () =>
  new Set(queryClient.getQueryCache().findAll({ queryKey: queryKeys.all }).map((query) => query.queryHash));

/**
 * Sets the viewer's marks on every cached copy of a post, moving the like and
 * repost counts with the flags (a copy already in that state is left alone).
 * The undo sets the opposite marks on the copies it changed and on copies
 * cached since (a detail screen seeded from a patched card), never on a copy
 * that already read that way (a stale card would gain a repost), even one in
 * a query it changed. It puts back the slot (`ownQuoteId`, `ownQuoteBare`)
 * each query's changed copy had itself (copies of a post can be at different
 * versions); a copy cached or read since gets the one a changed copy had,
 * preferring one that knew the slot was held. It refetches the post's detail family so
 * a copy that was already right comes back right.
 */
export function setViewerState(postId: string, patch: ViewerPatch): () => void {
  const before = cachedQueries();
  // By identity: a copy left alone keeps its object through the patch (and the query's
  // structural sharing), while a patched copy's object is replaced.
  const leftAlone = new WeakSet<CachedPost>();
  // The slot each query's patched copy had itself.
  const slots = snapshots<Partial<ViewerStateDTO> | undefined>();
  let previous: Partial<ViewerStateDTO> | undefined;
  const changed = updateCachedPosts(postId, (post, queryHash) => {
    const next = applyViewerPatch(post, patch);
    if (next === post) leftAlone.add(post);
    else {
      slots.keep(queryHash, post.viewer);
      if (previous === undefined || (!previous.ownQuoteId && post.viewer?.ownQuoteId)) previous = post.viewer;
    }
    return next;
  });
  const undoFrom = (slot: Partial<ViewerStateDTO> | undefined): ViewerPatch => {
    const undo: ViewerPatch = {};
    for (const flag of FLAGS) {
      if (patch[flag] !== undefined) undo[flag] = !patch[flag];
    }
    if (patch.ownQuoteId !== undefined) undo.ownQuoteId = slot?.ownQuoteId ?? null;
    if (patch.ownQuoteBare !== undefined) undo.ownQuoteBare = slot?.ownQuoteBare ?? false;
    return undo;
  };
  return () => {
    const touched = new Set([...cachedQueries()].filter((hash) => changed.has(hash) || !before.has(hash)));
    updateCachedPosts(
      postId,
      (post, queryHash) => (leftAlone.has(post) ? post : applyViewerPatch(post, undoFrom((slots.own(queryHash) ?? { value: previous }).value))),
      touched,
    );
    queryClient.invalidateQueries({ queryKey: queryKeys.post.detail(postId) }).catch(() => undefined);
  };
}

/**
 * The viewer's quote with text `quoteId` of `quotedId`, published on dev
 * (`repostsAreQuotes`), fills their one quote-or-repost slot: every cached
 * copy of the quoted post reads as reposted by that quote, so its repost
 * sheet offers "Delete your quote" / "View your quote" and never a second
 * repost (PRD ENG-02). The counts stay: the quote count moved with the publish.
 */
export function holdOwnQuote(quotedId: string, quoteId: string): void {
  updateCachedPosts(quotedId, (post) =>
    post.viewer?.reposted === true && post.viewer.ownQuoteId === quoteId && post.viewer.ownQuoteBare === false
      ? post
      : { ...post, viewer: { ...post.viewer, reposted: true, ownQuoteId: quoteId, ownQuoteBare: false } },
  );
}

/**
 * Follow state for an author everywhere it is cached (or in the queries
 * named only): their posts' `viewer.followsAuthor`, their profile
 * (`viewer.follows` and the follower count) and user rows (`viewerFollows`).
 * Returns the hashes of the queries it changed.
 */
export function applyFollowing(authorId: string, follows: boolean, only?: ReadonlySet<string>): Set<string> {
  return updateCache((object) => {
    if (isCachedPost(object)) {
      if (object.author?.id !== authorId || object.viewer?.followsAuthor === follows) return object;
      return { ...object, viewer: { ...object.viewer, followsAuthor: follows } };
    }
    if (object.id !== authorId) return object;
    const viewer = object.viewer as { follows?: boolean } | undefined;
    // ProfileDTO: `viewer.follows`, and the follower count moves with it.
    if (viewer && typeof viewer.follows === 'boolean' && isPlainObject(object.stats)) {
      if (viewer.follows === follows) return object;
      const stats = object.stats as { followers: number };
      return {
        ...object,
        viewer: { ...viewer, follows },
        stats: { ...stats, followers: Math.max(0, stats.followers + (follows ? 1 : -1)) },
      };
    }
    // UserSummaryDTO.
    if (typeof object.viewerFollows === 'boolean' && object.viewerFollows !== follows) {
      return { ...object, viewerFollows: follows };
    }
    return object;
  }, only);
}

/** {@link applyFollowing} everywhere; returns the undo, which also refetches the author's profile. */
export function setFollowing(authorId: string, follows: boolean): () => void {
  applyFollowing(authorId, follows);
  return () => {
    applyFollowing(authorId, !follows);
    queryClient.invalidateQueries({ queryKey: queryKeys.profile.detail(authorId) }).catch(() => undefined);
  };
}

/** The fields of a `ProfileDTO` an edit changes. `undefined` clears an optional one. */
export type ProfileChange = Partial<
  Pick<ProfileDTO, 'displayName' | 'bio' | 'location' | 'website' | 'pronouns' | 'bannerUrl' | 'nsfw' | 'avatar' | 'hasProfile'>
>;

/** A profile's `id`, `usernames` and `hasProfile` tell a `ProfileDTO` from a user row or an author. */
const isCachedProfile = (value: Json): boolean =>
  typeof value.id === 'string' && Array.isArray(value.usernames) && typeof value.hasProfile === 'boolean';

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a cached profile already reads as `change` says. */
const readsAs = (profile: Json, change: ProfileChange) =>
  Object.entries(change).every(([field, value]) => sameValue(profile[field], value));

function withChange(profile: Json, change: ProfileChange): Json {
  if (readsAs(profile, change)) return profile;
  const next: Json = { ...profile };
  for (const [field, value] of Object.entries(change)) {
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next;
}

/**
 * An edit on every cached copy of a profile (or in the queries named only);
 * returns the hashes of the queries it changed.
 */
export function applyProfileChange(identityId: string, change: ProfileChange, only?: ReadonlySet<string>): Set<string> {
  return updateCache((object) => (isCachedProfile(object) && object.id === identityId ? withChange(object, change) : object), only);
}

/**
 * {@link applyProfileChange} everywhere; returns the undo. Copies of a
 * profile (by identity, by name) are read separately and can be at different
 * versions, so each query's copy keeps what it had itself (`snapshots`). The
 * undo puts that back on each copy that still reads as the edit left it (a
 * read that differs stands), and marks those queries stale
 * without refetching them: a refetch under an open Edit profile form that is
 * past its freshness would swap the form for its loading state, and lose what
 * was typed. A copy that reads as the edit in a query read since (a `reapply`
 * over a read), or cached since, has nothing of its own to go back to: that
 * query is read again.
 */
export function setProfileChange(identityId: string, change: ProfileChange): () => void {
  const fields = Object.keys(change);
  const before = snapshots<ProfileChange>();
  updateCache((object, queryHash) => {
    if (!isCachedProfile(object) || object.id !== identityId || readsAs(object, change)) return object;
    before.keep(queryHash, Object.fromEntries(fields.map((field) => [field, object[field]])) as ProfileChange);
    return withChange(object, change);
  });
  return () => {
    const unknown = new Set<string>();
    const undone = updateCache((object, queryHash) => {
      if (!isCachedProfile(object) || object.id !== identityId || !readsAs(object, change)) return object;
      const own = before.own(queryHash);
      if (own) return withChange(object, own.value);
      unknown.add(queryHash);
      return object;
    });
    const cache = queryClient.getQueryCache();
    for (const hash of undone) cache.get(hash)?.invalidate();
    for (const hash of unknown) {
      const query = cache.get(hash);
      if (query) queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }).catch(() => undefined);
    }
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
  // Posts only (`stats.likes`): a notification or user row may share the id or carry the post.
  const gone = (item: unknown) =>
    isPlainObject(item) &&
    isCachedPost(item) &&
    (item.id === postId || (item.bareRepost === true && item.quotedPostId === postId));
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
/** A post hidden on this device (`hidePost`) shows again, wherever its cached copies are. */
export function showPost(postId: string): void {
  useRemovedPosts.setState(({ ids }) => {
    if (!ids.has(postId)) return { ids };
    const next = new Set(ids);
    next.delete(postId);
    return { ids: next };
  });
}

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
