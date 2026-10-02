import type { TagDTO, UserSummaryDTO } from '@engine/api';
import { useEffect, useState } from 'react';

import { queryKeys } from '~/data/keys';
import { engineQueryOptions, useEngineQuery, type EngineRemote } from '~/data/queries';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';

import { readFollowStatus, withFollowStatus } from './FollowableUserRow';
import { tagFromParam } from './tags';

/** People, and the engine's tag search, wait for 3 characters, as web's search does. */
export const SEARCH_MIN_LENGTH = 3;
/** PRD EXPL-05: searches run after 300 ms without typing. */
export const SEARCH_DEBOUNCE_MS = 300;
/** A pasted identity id (base58, 43–44 characters). */
const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export type SearchKind = 'people' | 'hashtags' | 'posts';

export const SEARCH_KINDS: readonly SearchKind[] = ['people', 'hashtags', 'posts'];

export const SEARCH_TITLES: Record<SearchKind, string> = {
  people: 'People',
  hashtags: 'Hashtags',
  posts: 'Recent posts',
};

export function isSearchKind(value: string | undefined): value is SearchKind {
  return SEARCH_KINDS.includes(value as SearchKind);
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * People by DPNS name prefix (an exact name resolves too, in the engine),
 * plus the identity itself when the query is a pasted identity id, with the
 * viewer's follow of each.
 */
async function searchPeople(api: EngineRemote, q: string): Promise<UserSummaryDTO[]> {
  const [byName, byId] = await Promise.all([api.explore.searchUsers(q), IDENTITY_ID.test(q) ? findById(api, q) : []]);
  const users = [...byId, ...byName.filter((user) => !byId.some((found) => found.id === user.id))];
  const status = await readFollowStatus(api, users.map((user) => user.id));
  return users.map((user) => withFollowStatus(user, status));
}

/**
 * The identity a pasted id names. `profiles.batch` answers for any id, so a
 * row with no name, profile name or bio (a mistyped id, or an identity with
 * nothing to show) is left out; a failed read just finds no one.
 */
async function findById(api: EngineRemote, id: string): Promise<UserSummaryDTO[]> {
  try {
    const users = await api.profiles.batch([id]);
    return users.filter((user) => user.username !== null || user.bio || user.displayName !== `User ${id.slice(-6)}`);
  } catch (error) {
    appendLog('warn', 'host', `Identity lookup failed: ${errorMessage(error)}`);
    return [];
  }
}

/** The tag search matches storage forms, so `$DASH` looks for `dash` (and finds `dash_cashtag`). */
const tagNeedle = (q: string) => q.replace(/^\$/, '');

/**
 * Tags for a query: the engine's search from 3 characters, the trending tags
 * below that. A `$TICKER` query also looks up its own storage form
 * (`dash_cashtag`), first: the ticker alone only finds the cashtag while it's
 * trending, since the engine's exact lookup would count `#dash`.
 */
async function searchTags(api: EngineRemote, q: string): Promise<TagDTO[]> {
  const needle = tagNeedle(q);
  const found = needle.length >= SEARCH_MIN_LENGTH ? api.explore.searchHashtags(needle) : searchTrendingTags(needle);
  const cashtag = q.startsWith('$') ? tagFromParam(q).storage : '';
  if (!cashtag) return found;
  const [exact, rest] = await Promise.all([api.explore.searchHashtags(cashtag), found]);
  return [...exact, ...rest.filter((tag) => !exact.some((hit) => hit.tag === tag.tag))];
}

/**
 * Tags for a 1–2 character query, which the engine's search doesn't serve
 * (PRD EXPL-05): the all-time trending tags (Explore's cached list on v2)
 * whose name contains it.
 */
async function searchTrendingTags(needle: string): Promise<TagDTO[]> {
  const text = needle.replace(/^#/, '').toLowerCase();
  const trending = await queryClient.fetchQuery(
    engineQueryOptions(queryKeys.explore.trending('all'), (api) => api.explore.trending({ window: 'all' }), {
      persist: true,
    }),
  );
  return trending.filter((tag) => tag.display.slice(1).toLowerCase().includes(text));
}

/**
 * The three searches for a (settled) query, or just `only`: people from 3
 * characters; hashtags and posts from 1 (shorter tag queries match the
 * trending tags; posts are a substring of the newest 100, PD-10).
 */
export function useSearch(query: string, only?: SearchKind) {
  const q = query.trim();
  const wanted = (kind: SearchKind) => only === undefined || only === kind;
  const enabled = {
    people: wanted('people') && q.length >= SEARCH_MIN_LENGTH,
    hashtags: wanted('hashtags') && tagNeedle(q).replace(/^#/, '').length > 0,
    posts: wanted('posts') && q.length > 0,
  };
  const people = useEngineQuery(queryKeys.explore.search('users', q), (api) => searchPeople(api, q), {
    enabled: enabled.people,
  });
  const hashtags = useEngineQuery(queryKeys.explore.search('hashtags', q), (api) => searchTags(api, q), {
    enabled: enabled.hashtags,
  });
  const posts = useEngineQuery(queryKeys.explore.search('posts', q), (api) => api.explore.searchPosts(q), {
    enabled: enabled.posts,
  });
  return { q, enabled, people, hashtags, posts };
}
