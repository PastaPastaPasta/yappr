import { logger } from '@/lib/logger';
import type {
  CompositeBind,
  CompositeDocumentsQuery,
  CompositeDocumentsResult,
  CompositeSubQuery,
} from '@dashevo/wasm-sdk';
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
 * Batch a feed page, engagement counts, quoted posts, author profiles/names
 * and viewer interactions through the composite documents surface. Initial
 * pages take one document request; subsequent pages first use the timeline's
 * cursor query, then fetch those exact ids with their enrichment here.
 *
 * Requires the dev.10 SDK and a dev.10 node exposing documents.composite.
 * Repost attribution, block/follow status and unseeded quoted authors still
 * need separate lookups; this is not a fixed total request count for the UI.
 */

// ---- Query limits ----

/** At most this many sub-queries per request (the platform's `MAX_SUB_QUERIES`). */
const MAX_SUB_QUERIES = 10;
/** Total DPNS document budget across ALL page authors, not per identity. */
const DPNS_QUERY_LIMIT = 100;
export interface CompositeFeedPageOptions {
  language: string;
  limit: number;
  /** Exact next-page ids selected by a timeline query using startAfter. */
  documentIds?: string[];
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
 * Load one feed page through the dev.10 composite surface.
 *
 * Composite support is a deployment requirement. SDK or node errors propagate
 * to the caller so a partially enriched response cannot be rendered.
 */
export async function loadCompositeFeedPage(
  options: CompositeFeedPageOptions
): Promise<CompositeFeedPage> {
  const sdk = await getEvoSdk();

  const { query, slots } = buildFeedPageQuery(options);
  const result = await sdk.documents.composite(query);
  validateCompositeResult(result, query);
  return decodeFeedPage(result, slots, options);
}

/** Validate the response shape before decode can seed any derived caches. */
function validateCompositeResult(
  result: CompositeDocumentsResult,
  query: CompositeDocumentsQuery
): asserts result is CompositeDocumentsResult {
  if (!Array.isArray(result.pageDocuments) || !Array.isArray(result.subResults) ||
      result.subResults.length !== query.subQueries.length) {
    throw new Error('Feed: incomplete composite result');
  }
  for (let i = 0; i < query.subQueries.length; i++) {
    const sub = result.subResults[i];
    const expectedKind = query.subQueries[i].kind ?? 'documents';
    if (!sub || sub.kind !== expectedKind) {
      throw new Error(`Feed: invalid composite result at sub-query ${i}`);
    }
    if (sub.kind === 'documents' && !Array.isArray(sub.documents)) {
      throw new Error(`Feed: invalid documents result at sub-query ${i}`);
    }
    if (sub.kind === 'counts' && !(sub.counts instanceof Map)) {
      throw new Error(`Feed: invalid counts result at sub-query ${i}`);
    }
  }
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
    limit: DPNS_QUERY_LIMIT,
  });

  let quotedAuthorProfiles = -1;
  let myLikes = -1;
  let myReposts = -1;
  let myBookmarks = -1;
  if (options.currentUserId) {
    // The viewer's marks on the page: `$ownerId == me` pins the owner-first
    // index, the bound post id is its terminal, so these are value-bounded.
    const mine = [['$ownerId', '==', options.currentUserId]];
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

  const query: CompositeDocumentsQuery = {
    dataContractId: YAPPR_CONTRACT_ID,
    documentType: 'post',
    where: options.documentIds
      ? [['$id', 'in', options.documentIds]]
      : [['language', '==', options.language], ['$createdAt', '>', 0]],
    orderBy: options.documentIds ? undefined : [['language', 'asc'], ['$createdAt', 'desc']],
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
  if (!sub || sub.kind !== 'documents') throw new Error('Feed: missing composite documents result');
  return sub.documents.map((doc) => documentToPlainObject(doc));
}

function countsAt(result: CompositeDocumentsResult, index: number): Map<string, number> {
  const counts = new Map<string, number>();
  if (index < 0) return counts;
  const sub = result.subResults[index];
  if (!sub || sub.kind !== 'counts') throw new Error('Feed: missing composite counts result');
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

/** Primary DPNS name per identity from a bound `domain` lookup, or empty when the lookup may have been truncated. */
export function usernamesByIdentity(records: Record<string, unknown>[], identityIds: readonly string[], pageSize: number): Map<string, string | null> {
  // At the cap, even returned authors may have unseen aliases that would
  // change their primary name. Leave the entire slice to normal enrichment;
  // never cache a missing name (or a partial primary name) as a proven result.
  // Empty bound identity branches can also consume a slot. Reserve one per
  // page document (including tombstones), conservatively covering every author.
  if (records.length + pageSize >= DPNS_QUERY_LIMIT) return new Map();
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
  let rawPosts = result.pageDocuments.map((doc) => documentToPlainObject(doc));
  if (options.documentIds) {
    // By-id queries return key order, which is different from timeline order.
    const byId = new Map(rawPosts.map(doc => [doc.$id, doc]));
    rawPosts = options.documentIds.flatMap(id => {
      const doc = byId.get(id);
      return doc ? [doc] : [];
    });
  }
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
  const usernames = usernamesByIdentity(documentsAt(result, slots.usernames), authorIds, rawPosts.length);
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
  // (now seeded) batch resolvers. Distinct quoted authors still need DPNS
  // lookups, and logged-in pages also need their profiles.
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
