import type { PreloadedEnrichment } from '@/hooks/use-progressive-enrichment';
import type { Post } from '@/lib/types';
import { likesAreIndexOnly, targetKindOf } from '@/lib/contract-topology';
import { chunk, mapLimit } from '@/lib/services/pagination-utils';
import { logger } from '@/lib/logger';
import { loadCompositeFeedPage } from './composite-feed-page';

/** Shared by list/detail/thread enrichment. Existing page selection and reply
 * linkage stay with the caller; each proved by-id page supplies its counts,
 * viewer marks and identities together. Older deployments use ordinary reads.
 * Failed chunks supply no cacheable absences and fall back independently. */
export async function loadPostEnrichment(posts: Post[], currentUserId?: string): Promise<PreloadedEnrichment> {
  if (!likesAreIndexOnly() || posts.length === 0) return {};
  const groups = (['post', 'reply'] as const).flatMap(kind =>
    chunk(Array.from(new Map(posts.filter(post => targetKindOf(post) === kind).map(post => [post.id, post])).values()), 100)
      .map(sourcePosts => ({ kind, sourcePosts }))
  );
  const pages = await mapLimit(groups, 2, async ({ kind, sourcePosts }) => {
    try {
      return (await loadCompositeFeedPage({
        language: 'en', limit: sourcePosts.length, kind, sourcePosts,
        documentIds: sourcePosts.map(post => post.id), currentUserId,
      })).preloaded;
    } catch (error) {
      logger.warn('Composite enrichment failed; using ordinary enrichment for this batch', error);
      return {} as PreloadedEnrichment;
    }
  });
  return mergePostEnrichment(pages);
}

export function mergePostEnrichment(pages: PreloadedEnrichment[]): PreloadedEnrichment {
  const merged: PreloadedEnrichment = {};
  for (const page of pages) {
    // Explicit fields keep the value types coupled to their map keys.
    merged.usernames = new Map([...merged.usernames ?? [], ...page.usernames ?? []]);
    merged.profiles = new Map([...merged.profiles ?? [], ...page.profiles ?? []]);
    merged.avatars = new Map([...merged.avatars ?? [], ...page.avatars ?? []]);
    merged.stats = new Map([...merged.stats ?? [], ...page.stats ?? []]);
    merged.interactions = new Map([...merged.interactions ?? [], ...page.interactions ?? []]);
  }
  return merged;
}
