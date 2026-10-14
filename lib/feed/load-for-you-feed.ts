import { logger } from '@/lib/logger';
import { likesAreIndexOnly } from '@/lib/contract-topology';
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

/**
 * The timeline read after a page that held only tombstones: the platform's
 * largest page. The global `timeline [$createdAt]` index lists tombstones, and
 * a run of them (a devnet's CI cleanup leaves hundreds) would otherwise cost a
 * round trip per 20. A tombstone is a few fields, so the wider read is cheap.
 */
const TOMBSTONE_RUN_READ = 100;

interface FeedPage {
  posts: Post[];
  cursor: string | null;
  hasMore: boolean;
  preloaded?: PreloadedEnrichment;
}

/**
 * The leading slice of a timeline read that holds at most `PAGE_SIZE` live
 * posts: the whole read, or up to and including its `PAGE_SIZE`th live post,
 * so a wide read never returns more than a page and its cursor resumes right
 * after what was shown.
 */
function takePage(raw: Post[]): Post[] {
  let live = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i].deleted && ++live === PAGE_SIZE) return raw.slice(0, i + 1);
  }
  return raw;
}

async function fetchFeedPage(options: {
  startAfter?: string;
  language?: string;
  currentUserId?: string;
  readLimit?: number;
}): Promise<FeedPage> {
  const compositeOptions = {
    language: options.language || 'en',
    limit: PAGE_SIZE,
    currentUserId: options.currentUserId,
  };

  // The first page uses the ordered composite query directly. Composite has
  // no document cursor, so later pages use the timeline's cursor to select
  // exact ids (including timestamp ties), then composite-enrich that bounded
  // set while preserving the raw cursor. Older deployments (the v2 testnet
  // contract) cannot serve composite pages, so they read the plain timeline
  // and leave enrichment to the progressive and quote passes.
  const composite = likesAreIndexOnly();
  if (composite && !options.startAfter) {
    const page = await loadCompositeFeedPage(compositeOptions);
    const last = page.rawPosts[page.rawPosts.length - 1];
    const cursor = last ? String(last.$id) : null;
    return { posts: page.posts, cursor, hasMore: page.hasMore, preloaded: page.preloaded };
  }

  const readLimit = options.readLimit ?? PAGE_SIZE;
  const raw = (await postService.getTimeline({
    limit: readLimit,
    startAfter: options.startAfter,
    language: options.language,
  })).documents;
  const taken = takePage(raw);
  const cursor = taken.length ? taken[taken.length - 1].id : null;
  const hasMore = taken.length < raw.length || raw.length === readLimit;
  // Only live posts are enriched: a tombstone renders nothing, and a page of
  // them needs no composite request at all.
  const live = taken.filter(post => !post.deleted);
  if (composite) {
    if (!live.length) return { posts: [], cursor, hasMore };
    const page = await loadCompositeFeedPage({
      ...compositeOptions,
      documentIds: live.map(post => post.id),
    });
    return { posts: page.posts, cursor, hasMore, preloaded: page.preloaded };
  }

  return { posts: live.map(withLoadingAuthor), cursor, hasMore };
}

/**
 * A page whose every document is a tombstone must not read as the end of the
 * feed, so this many further reads (each of `TOMBSTONE_RUN_READ` documents)
 * are tried before an empty page is returned.
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
    page = await fetchFeedPage({ ...pageOptions, startAfter: page.cursor, readLimit: TOMBSTONE_RUN_READ });
  }

  logger.debug(`Feed: Page has ${page.posts.length} posts`);
  return page;
}
