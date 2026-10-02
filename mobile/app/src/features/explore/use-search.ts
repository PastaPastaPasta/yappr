import type { UserSummaryDTO } from '@engine/api';
import { useEffect, useState } from 'react';

import { queryKeys } from '~/data/keys';
import { useEngineQuery, type EngineRemote } from '~/data/queries';

import { readFollowStatus, withFollowStatus } from './FollowableUserRow';

/** People and tags wait for 3 characters, as the engine (and web's DPNS search) does. */
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
  const [byName, byId] = await Promise.all([
    api.explore.searchUsers(q),
    IDENTITY_ID.test(q) ? api.profiles.batch([q]) : Promise.resolve<UserSummaryDTO[]>([]),
  ]);
  const users = [...byId, ...byName.filter((user) => !byId.some((found) => found.id === user.id))];
  const status = await readFollowStatus(api, users.map((user) => user.id));
  return users.map((user) => withFollowStatus(user, status));
}

/** The tag search matches storage forms, so `$DASH` looks for `dash` (and finds `dash_cashtag`). */
const tagNeedle = (q: string) => q.replace(/^\$/, '');

/**
 * The three searches for a (settled) query, or just `only`: people and
 * hashtags from 3 characters, posts from 1 (a substring of the newest 100
 * posts, PD-10).
 */
export function useSearch(query: string, only?: SearchKind) {
  const q = query.trim();
  const wanted = (kind: SearchKind) => only === undefined || only === kind;
  const enabled = {
    people: wanted('people') && q.length >= SEARCH_MIN_LENGTH,
    hashtags: wanted('hashtags') && tagNeedle(q).length >= SEARCH_MIN_LENGTH,
    posts: wanted('posts') && q.length > 0,
  };
  const people = useEngineQuery(queryKeys.explore.search('users', q), (api) => searchPeople(api, q), {
    enabled: enabled.people,
  });
  const hashtags = useEngineQuery(
    queryKeys.explore.search('hashtags', q),
    (api) => api.explore.searchHashtags(tagNeedle(q)),
    { enabled: enabled.hashtags },
  );
  const posts = useEngineQuery(queryKeys.explore.search('posts', q), (api) => api.explore.searchPosts(q), {
    enabled: enabled.posts,
  });
  return { q, enabled, people, hashtags, posts };
}
