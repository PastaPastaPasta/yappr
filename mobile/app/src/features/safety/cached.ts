import type { AuthorDTO, PostDTO } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { queryClient } from '~/state/query-client';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

/** The first object in the cached engine queries that `match` accepts, searched depth first. */
function findCached<T>(match: (object: Json) => boolean): T | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown): T | undefined => {
    if (!isObject(value) || seen.has(value) || value instanceof Date) return undefined;
    seen.add(value);
    if (!Array.isArray(value) && match(value)) return value as T;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })) {
    const found = visit(query.state.data);
    if (found) return found;
  }
  return undefined;
}

/**
 * A copy of a post some list already holds, so a sheet opened from its menu
 * paints at once (the sheet still reads it fresh).
 */
export function findCachedPost(postId: string): PostDTO | undefined {
  return findCached<PostDTO>(
    (o) => o.id === postId && isObject(o.stats) && typeof o.stats.likes === 'number' && isObject(o.author),
  );
}

/** A user's name and avatar from anything cached about them (a post's author, a profile, a user row). */
export function findCachedUser(userId: string): Pick<AuthorDTO, 'id' | 'username' | 'displayName' | 'avatar'> | undefined {
  return findCached(
    (o) => o.id === userId && typeof o.displayName === 'string' && isObject(o.avatar) && !('stats' in o && 'content' in o),
  );
}
