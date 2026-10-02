import type { PostDTO } from '@engine/api/dto';

import { queryKeys } from '~/data/keys';
import { queryClient } from '~/state/query-client';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

const isPost = (value: Json, id: string): boolean =>
  value.id === id && Array.isArray(value.media) && isObject(value.stats) && isObject(value.author);

function find(value: unknown, id: string, depth: number): PostDTO | undefined {
  if (depth > 12 || !isObject(value)) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = find(item, id, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value instanceof Date) return undefined;
  if (isPost(value, id)) return value as unknown as PostDTO;
  for (const child of Object.values(value)) {
    const hit = find(child, id, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The freshest cached copy of a post anywhere in the engine queries: its
 * detail, a feed page, a thread or a quote. The image viewer opens from any
 * card, so this is how it finds the post's media without a read.
 */
export function findCachedPost(id: string): PostDTO | undefined {
  if (!id) return undefined;
  const queries = queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.all })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  for (const query of queries) {
    const hit = find(query.state.data, id, 0);
    if (hit) return hit;
  }
  return undefined;
}
