import { logger } from '@/lib/logger';
import { postService } from '@/lib/services/post-service';
import { Post } from '@/lib/types';
import type { PreloadedEnrichment } from '@/hooks/use-progressive-enrichment';
import { loadCompositeFeedPage } from './composite-feed-page';

/**
 * Timeline documents arrive with `createDefaultUser` placeholders
 * (`hasDpns: false`, "Unknown User"). The feed renders before enrichment, and
 * PostCard reads `hasDpns === undefined` as "still resolving" (skeleton) versus
 * `false` as "no DPNS name" (identity-id button), so the placeholder is reset
 * to the loading shape here to avoid a flash of identity ids on every card.
 */
function withLoadingAuthor(post: Post): Post {
  return {
    ...post,
    author: { ...post.author, username: '', displayName: '', avatar: '', hasDpns: undefined },
  };
}

const PAGE_SIZE = 20;

interface FeedPage {
  posts: Post[];
  cursor: string | null;
  hasMore: boolean;
  preloaded?: PreloadedEnrichment;
}

async function fetchFeedPage(options: {
  startAfter?: string;
  language?: string;
  currentUserId?: string;
}): Promise<FeedPage> {
  const compositeOptions = {
    language: options.language || 'en',
    limit: PAGE_SIZE,
    currentUserId: options.currentUserId,
  };

  // The first page uses the ordered composite query directly. Composite has
  // no document cursor, so later pages use the timeline's cursor to select
  // exact ids (including timestamp ties), then composite-enrich that bounded
  // set while preserving the raw cursor.
  if (!options.startAfter) {
    const page = await loadCompositeFeedPage(compositeOptions);
    const last = page.rawPosts[page.rawPosts.length - 1];
    const cursor = last ? String(last.$id) : null;
    return { posts: page.posts, cursor, hasMore: page.hasMore, preloaded: page.preloaded };
  }

  const raw = (await postService.getTimeline({
    limit: PAGE_SIZE,
    startAfter: options.startAfter,
    language: options.language,
  })).documents;
  const cursor = raw.length ? raw[raw.length - 1].id : null;
  const hasMore = raw.length === PAGE_SIZE;
  if (raw.length) {
    const page = await loadCompositeFeedPage({
      ...compositeOptions,
      documentIds: raw.map(post => post.id),
    });
    return { posts: page.posts, cursor, hasMore, preloaded: page.preloaded };
  }

  const posts = raw.filter(post => !post.deleted).map(withLoadingAuthor);
  return { posts, cursor, hasMore };
}

/**
 * A page whose every document is a tombstone must not read as the end of the
 * feed, so this many further pages are tried before an empty page is returned.
 */
const MAX_EMPTY_PAGES = 5;

/**
 * One For You page. Short pages (tombstones thin most of them on a feed with
 * many deleted posts) are NOT topped up here: the feed list's infinite-scroll
 * sentinel already auto-loads while it stays on screen, and a background fill
 * running next to it fetched every page twice.
 */
export async function loadForYouFeed(options: {
  startAfter?: string;
  feedLanguage?: string;
  currentUserId?: string;
}): Promise<FeedPage> {
  const pageOptions = { language: options.feedLanguage, currentUserId: options.currentUserId };

  logger.debug('Feed: Loading posts', options.startAfter ? `starting after ${options.startAfter}` : '');
  let page = await fetchFeedPage({ ...pageOptions, startAfter: options.startAfter });

  for (let skipped = 0; page.posts.length === 0 && page.hasMore && page.cursor && skipped < MAX_EMPTY_PAGES; skipped++) {
    logger.debug(`Feed: Page after ${page.cursor} held only tombstones, loading the next one`);
    page = await fetchFeedPage({ ...pageOptions, startAfter: page.cursor });
  }

  logger.debug(`Feed: Page has ${page.posts.length} posts`);
  return page;
}
