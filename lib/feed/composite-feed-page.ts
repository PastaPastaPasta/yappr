import type { EvoSDK } from '@dashevo/evo-sdk';
import { logger } from '@/lib/logger';
import {
  DPNS_CONTRACT_ID,
  DPNS_DOCUMENT_TYPE,
  YAPPR_CONTRACT_ID,
  YAPPR_PROFILE_CONTRACT_ID,
} from '@/lib/constants';
import {
  bookmarkIndexFor,
  likeIndexFor,
  quoteFieldFor,
  referencesAreEnforced,
  replyCountFieldFor,
  repostIndexFor,
} from '@/lib/contract-topology';
import type {
  PostStats,
  PreloadedEnrichment,
  ProfileData,
  UserInteractions,
} from '@/hooks/use-progressive-enrichment';
import { Post } from '@/lib/types';
import { getEvoSdk } from '@/lib/services/evo-sdk-service';
import { dpnsService } from '@/lib/services/dpns-service';
import { resolvePostAuthorsBatch } from '@/lib/services/post-enrichment-helpers';
import { documentToPlainObject, identifierToBase58 } from '@/lib/services/sdk-helpers';
import { unifiedProfileService } from '@/lib/services/unified-profile-service';
import { getPrimaryUsername } from '@/lib/utils/username';
import { transformRawPost } from './transform-raw-post';

/**
 * One For You feed page as ONE composite document query.
 *
 * The node answers the page and everything a card needs to render it
 * under a single merged proof: the four engagement counts, the posts the
 * page quotes, the authors' profiles and DPNS names, and (logged in) the
 * viewer's own likes, reposts and bookmarks on the page. The SDK derives
 * every sub-query from the PROVEN page, so nothing here can be steered by
 * the responding node. Compared with the legacy loaders this replaces
 * about ten round trips per page with one.
 *
 * The composite surface needs an evo-sdk that exposes
 * `documents.composite` and a v6 (refersTo-enforced) contract; where either
 * is missing this module reports `null` and the caller keeps the legacy
 * path. Nothing downstream changes shape: the result is the same raw page
 * plus a `PreloadedEnrichment` the progressive-enrichment hook merges and
 * then skips over, so `PostCard` and the per-card fallbacks are untouched.
 */

// ---- Wire types (mirror wasm-sdk's `CompositeDocumentsQuery` / `Result`) ----

type WhereClause = [string, string, unknown];
type OrderByClause = [string, 'asc' | 'desc'];

interface CompositeBind {
  source?: 'page' | number;
  sourceProperty: string;
  field: string;
}

interface CompositeSubQuery {
  dataContractId?: string;
  documentType: string;
  kind?: 'documents' | 'counts';
  where?: WhereClause[];
  orderBy?: OrderByClause[];
  limit?: number;
  bind?: CompositeBind;
}

interface CompositeDocumentsQuery {
  dataContractId: string;
  documentType: string;
  where?: WhereClause[];
  orderBy?: OrderByClause[];
  limit: number;
  subQueries: CompositeSubQuery[];
}

type CompositeSubResult =
  | { kind: 'documents'; documents: unknown[] }
  | { kind: 'counts'; counts: Map<string, bigint> };

interface CompositeDocumentsResult {
  pageDocuments: unknown[];
  subResults: CompositeSubResult[];
}

interface CompositeDocumentsFacade {
  composite(query: CompositeDocumentsQuery): Promise<CompositeDocumentsResult>;
}

/** The evo-sdk build in use may predate the composite surface. */
function compositeFacade(sdk: EvoSDK): CompositeDocumentsFacade | null {
  const documents = sdk.documents as unknown as Partial<CompositeDocumentsFacade>;
  return typeof documents.composite === 'function'
    ? (documents as CompositeDocumentsFacade)
    : null;
}

// ---- Availability ----

/** At most this many sub-queries per request (the platform's `MAX_SUB_QUERIES`). */
const MAX_SUB_QUERIES = 10;
/** DPNS `records.identity` is a non-unique index, so the lookup needs a per-identity cap. */
const DPNS_NAMES_PER_IDENTITY = 3;
/** After a composite failure, use the legacy loaders for this long before retrying. */
const RETRY_BACKOFF_MS = 60_000;

let unsupportedLogged = false;
let retryAfter = 0;

export interface CompositeFeedPageOptions {
  language: string;
  limit: number;
  /** Continue past this `$createdAt` (exclusive); omit for the first page. */
  beforeCreatedAt?: number;
  currentUserId?: string;
}

export interface CompositeFeedPage {
  /** The normalized page records, newest first, tombstones included. */
  rawPosts: Record<string, unknown>[];
  /** The page as feed posts, tombstones dropped, quoted posts attached. */
  posts: Post[];
  /** Everything the progressive enrichment would otherwise query for this page. */
  preloaded: PreloadedEnrichment;
  hasMore: boolean;
}

/**
 * Load one feed page through the composite surface, or `null` when the
 * surface is unavailable (older SDK, pre-v6 contract, recent failure), in
 * which case the caller falls back to the legacy per-query loaders.
 */
export async function loadCompositeFeedPage(
  options: CompositeFeedPageOptions
): Promise<CompositeFeedPage | null> {
  if (!referencesAreEnforced()) return null;
  if (Date.now() < retryAfter) return null;

  const sdk = await getEvoSdk();
  const facade = compositeFacade(sdk);
  if (!facade) {
    if (!unsupportedLogged) {
      unsupportedLogged = true;
      logger.info('Feed: this evo-sdk has no composite documents surface; using the legacy loaders');
    }
    return null;
  }

  const { query, slots } = buildFeedPageQuery(options);

  let result: CompositeDocumentsResult;
  try {
    result = await facade.composite(query);
  } catch (error) {
    retryAfter = Date.now() + RETRY_BACKOFF_MS;
    logger.warn('Feed: composite page failed, falling back to the legacy loaders', error);
    return null;
  }

  return decodeFeedPage(result, slots, options);
}

// ---- Query ----

interface SubQuerySlots {
  likeCounts: number;
  repostCounts: number;
  replyCounts: number;
  quoteCounts: number;
  quotedPosts: number;
  profiles: number;
  usernames: number;
  /** Anonymous only: the quoted posts' authors' profiles (bound to the join). */
  quotedAuthorProfiles: number;
  /** Logged in only. */
  myLikes: number;
  myReposts: number;
  myBookmarks: number;
}

function buildFeedPageQuery(options: CompositeFeedPageOptions): {
  query: CompositeDocumentsQuery;
  slots: SubQuerySlots;
} {
  const subQueries: CompositeSubQuery[] = [];
  const slot = (sub: CompositeSubQuery): number => subQueries.push(sub) - 1;
  const fromPage = (sourceProperty: string, field: string): CompositeBind => ({
    source: 'page',
    sourceProperty,
    field,
  });

  const like = likeIndexFor('post');
  const repost = repostIndexFor('post');
  const bookmark = bookmarkIndexFor('post');
  const quoteField = quoteFieldFor('post');
  const replyCountField = replyCountFieldFor('post');

  // Engagement counts: one grouped count per page id, each from the
  // `countable` index keyed by the target id alone.
  const likeCounts = slot({ documentType: like.docType, kind: 'counts', bind: fromPage('$id', like.field) });
  const repostCounts = repost
    ? slot({ documentType: repost.docType, kind: 'counts', bind: fromPage('$id', repost.field) })
    : -1;
  const replyCounts = slot({ documentType: 'reply', kind: 'counts', bind: fromPage('$id', replyCountField) });
  const quoteCounts = quoteField
    ? slot({ documentType: 'post', kind: 'counts', bind: fromPage('$id', quoteField) })
    : -1;

  // The posts this page quotes: a by-id JOIN through `refersTo`, so a
  // missing quoted post is a verification error rather than a hole.
  const quotedPosts = quoteField
    ? slot({ documentType: 'post', bind: fromPage(quoteField, '$id') })
    : -1;

  // Author identity, cross-contract: profiles sit on a unique `$ownerId`
  // index (value-bounded, no limit), DPNS names on a non-unique one.
  const profiles = slot({
    dataContractId: YAPPR_PROFILE_CONTRACT_ID,
    documentType: 'profile',
    bind: fromPage('$ownerId', '$ownerId'),
  });
  const usernames = slot({
    dataContractId: DPNS_CONTRACT_ID,
    documentType: DPNS_DOCUMENT_TYPE,
    bind: fromPage('$ownerId', 'records.identity'),
    limit: DPNS_NAMES_PER_IDENTITY,
  });

  let quotedAuthorProfiles = -1;
  let myLikes = -1;
  let myReposts = -1;
  let myBookmarks = -1;
  if (options.currentUserId) {
    // The viewer's marks on the page: `$ownerId == me` pins the owner-first
    // index, the bound post id is its terminal, so these are value-bounded.
    const mine: WhereClause[] = [['$ownerId', '==', options.currentUserId]];
    myLikes = slot({ documentType: like.docType, where: mine, bind: fromPage('$id', like.field) });
    if (repost) {
      myReposts = slot({ documentType: repost.docType, where: mine, bind: fromPage('$id', repost.field) });
    }
    if (bookmark) {
      myBookmarks = slot({ documentType: bookmark.docType, where: mine, bind: fromPage('$id', bookmark.field) });
    }
  } else if (quotedPosts >= 0) {
    // With the request budget free, chain the quoted posts' authors'
    // profiles off the join so embedded cards need no straggler hop.
    quotedAuthorProfiles = slot({
      dataContractId: YAPPR_PROFILE_CONTRACT_ID,
      documentType: 'profile',
      bind: { source: quotedPosts, sourceProperty: '$ownerId', field: '$ownerId' },
    });
  }

  if (subQueries.length > MAX_SUB_QUERIES) {
    throw new Error(`Feed: composite page needs ${subQueries.length} sub-queries, the limit is ${MAX_SUB_QUERIES}`);
  }

  const before = options.beforeCreatedAt;
  const query: CompositeDocumentsQuery = {
    dataContractId: YAPPR_CONTRACT_ID,
    documentType: 'post',
    where: [
      ['language', '==', options.language],
      before !== undefined ? ['$createdAt', '<', before] : ['$createdAt', '>', 0],
    ],
    orderBy: [['language', 'asc'], ['$createdAt', 'desc']],
    limit: options.limit,
    subQueries,
  };

  return {
    query,
    slots: {
      likeCounts,
      repostCounts,
      replyCounts,
      quoteCounts,
      quotedPosts,
      profiles,
      usernames,
      quotedAuthorProfiles,
      myLikes,
      myReposts,
      myBookmarks,
    },
  };
}

// ---- Result ----

function documentsAt(result: CompositeDocumentsResult, index: number): Record<string, unknown>[] {
  if (index < 0) return [];
  const sub = result.subResults[index];
  if (!sub || sub.kind !== 'documents') return [];
  return sub.documents.map((doc) => documentToPlainObject(doc));
}

function countsAt(result: CompositeDocumentsResult, index: number): Map<string, number> {
  const counts = new Map<string, number>();
  if (index < 0) return counts;
  const sub = result.subResults[index];
  if (!sub || sub.kind !== 'counts') return counts;
  sub.counts.forEach((count, key) => counts.set(key, Number(count)));
  return counts;
}

/** The post ids named by a set of owned documents (likes, reposts, bookmarks). */
function targetIdsOf(records: Record<string, unknown>[], field: string): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    const id = identifierToBase58(record[field]);
    if (id) ids.add(id);
  }
  return ids;
}

function usernamesByIdentity(records: Record<string, unknown>[], identityIds: readonly string[]): Map<string, string | null> {
  const names = new Map<string, string[]>();
  for (const doc of records) {
    const data = (doc.data || doc) as Record<string, unknown>;
    const domainRecords = data.records as Record<string, unknown> | undefined;
    const identityId = identifierToBase58(domainRecords?.identity || domainRecords?.dashUniqueIdentityId);
    const label = data.label || data.normalizedLabel;
    if (!identityId || !label) continue;
    const parentDomain = data.normalizedParentDomainName || 'dash';
    const existing = names.get(identityId) || [];
    existing.push(`${label}.${parentDomain}`);
    names.set(identityId, existing);
  }
  const usernames = new Map<string, string | null>();
  for (const id of identityIds) {
    const candidates = names.get(id);
    usernames.set(id, candidates ? getPrimaryUsername(candidates) : null);
  }
  return usernames;
}

async function decodeFeedPage(
  result: CompositeDocumentsResult,
  slots: SubQuerySlots,
  options: CompositeFeedPageOptions
): Promise<CompositeFeedPage> {
  const rawPosts = result.pageDocuments.map((doc) => documentToPlainObject(doc));
  const posts = rawPosts
    .map((doc) => transformRawPost(doc))
    .filter((post) => !post.deleted);
  const pageIds = rawPosts
    .map((doc) => doc.$id)
    .filter((id): id is string => typeof id === 'string');
  const authorIds = Array.from(new Set(posts.map((post) => post.author.id).filter(Boolean)));

  // Stats, seeded to zero for every page id: a value without a count entry
  // is a proven zero.
  const likes = countsAt(result, slots.likeCounts);
  const reposts = countsAt(result, slots.repostCounts);
  const replies = countsAt(result, slots.replyCounts);
  const quotes = countsAt(result, slots.quoteCounts);
  const stats = new Map<string, PostStats>();
  for (const id of pageIds) {
    stats.set(id, {
      likes: likes.get(id) ?? 0,
      reposts: reposts.get(id) ?? 0,
      replies: replies.get(id) ?? 0,
      quotes: quotes.get(id) ?? 0,
      views: 0,
    });
  }

  // Author identity, and seed the service caches so any later lookup for
  // these authors (reposter names, quoted authors, profile pages) is a hit.
  const foundProfiles = unifiedProfileService.seedProfileDocuments(documentsAt(result, slots.profiles), authorIds);
  const profiles = new Map<string, ProfileData>();
  const avatars = new Map<string, string>();
  for (const id of authorIds) {
    const doc = foundProfiles.get(id);
    profiles.set(id, doc ? { displayName: doc.displayName, bio: doc.bio } : {});
    avatars.set(
      id,
      doc ? unifiedProfileService.parseAvatarField(doc.avatar, id) : unifiedProfileService.getDefaultAvatarUrl(id)
    );
  }
  const usernames = usernamesByIdentity(documentsAt(result, slots.usernames), authorIds);
  dpnsService.seedUsernames(usernames);

  // The viewer's marks; only meaningful when logged in.
  const preloaded: PreloadedEnrichment = { usernames, profiles, avatars, stats };
  if (options.currentUserId) {
    const liked = targetIdsOf(documentsAt(result, slots.myLikes), likeIndexFor('post').field);
    const reposted = targetIdsOf(documentsAt(result, slots.myReposts), repostIndexFor('post')?.field ?? 'postId');
    const bookmarked = targetIdsOf(documentsAt(result, slots.myBookmarks), bookmarkIndexFor('post')?.field ?? 'postId');
    const interactions = new Map<string, UserInteractions>();
    for (const id of pageIds) {
      interactions.set(id, { liked: liked.has(id), reposted: reposted.has(id), bookmarked: bookmarked.has(id) });
    }
    preloaded.interactions = interactions;
  }

  // Quoted posts, attached in place; their authors resolve through the
  // (now seeded) batch resolvers, so anonymous pages take no extra hop and
  // logged-in pages take at most one for the names.
  const quotedPosts = documentsAt(result, slots.quotedPosts)
    .map((doc) => transformRawPost(doc))
    .filter((post) => !post.deleted);
  if (quotedPosts.length > 0) {
    const quotedAuthorIds = Array.from(new Set(quotedPosts.map((post) => post.author.id).filter(Boolean)));
    if (slots.quotedAuthorProfiles >= 0) {
      unifiedProfileService.seedProfileDocuments(documentsAt(result, slots.quotedAuthorProfiles), quotedAuthorIds);
    }
    try {
      await resolvePostAuthorsBatch(quotedPosts);
    } catch (error) {
      logger.warn('Feed: quoted post authors did not resolve', error);
    }
    const quotedById = new Map(quotedPosts.map((post) => [post.id, post]));
    for (const post of posts) {
      const quoted = post.quotedPostId ? quotedById.get(post.quotedPostId) : undefined;
      if (quoted) post.quotedPost = quoted;
    }
  }

  for (const post of posts) {
    const postStats = stats.get(post.id);
    if (postStats) {
      post.likes = postStats.likes;
      post.reposts = postStats.reposts;
      post.replies = postStats.replies;
      post.quotes = postStats.quotes;
    }
    const mine = preloaded.interactions?.get(post.id);
    if (mine) {
      post.liked = mine.liked;
      post.reposted = mine.reposted;
      post.bookmarked = mine.bookmarked;
    }
  }

  return {
    rawPosts,
    posts,
    preloaded,
    hasMore: rawPosts.length === options.limit,
  };
}
