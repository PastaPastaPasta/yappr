import type { Post } from '@/lib/types';
import type { CompositeDocumentsQuery } from '@dashevo/wasm-sdk';
import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE, YAPPR_PROFILE_CONTRACT_ID } from '@/lib/constants';
import { likeCountsArePreallocated, likesAreIndexOnly } from '@/lib/contract-topology';
import { logger } from '@/lib/logger';
import { loadCompositeFeedPage, usernamesByIdentity } from '@/lib/feed/composite-feed-page';
import { dpnsService } from '@/lib/services/dpns-service';
import { getEvoSdk } from '@/lib/services/evo-sdk-service';
import { postService } from '@/lib/services/post-service';
import { topLikedPosts } from '@/lib/services/ranked-likes';
import { documentToPlainObject } from '@/lib/services/sdk-helpers';
import { unifiedProfileService, type UnifiedProfileDocument } from '@/lib/services/unified-profile-service';

/**
 * The anonymous homepage in two waves of document queries, on topologies with
 * a like ranking (v4 and later) against nodes that serve composite pages.
 * Elsewhere, and whenever that path fails, the topology-agnostic loader
 * below takes over: a timeline of 50, its engagement counts, and per-slice
 * profile and name lookups.
 *
 * Wave 1, in parallel:
 * - a proved top-K ranking on the like count tree (which posts to feature),
 * - the grouped `post` count by `$ownerId` (top contributors),
 * - the aggregate `post` count (the platform total). The grouping cannot
 *   stand in for it: Drive caps a grouped range-distinct count at 100 groups
 *   and the scan fallback stops at 10,000 posts, so its sum undercounts once
 *   the platform has more posting identities than that.
 *
 * Wave 2, in parallel:
 * - ONE composite by-id page over the featured ids carrying their engagement
 *   counts, quoted posts, author profiles and names;
 * - ONE composite page of the top contributors' profiles (`$ownerId IN`) with
 *   their DPNS names bound to it. The contributors cannot ride the featured
 *   page: the node refuses two documents components on the same index path
 *   (profile owner index) unless both are told apart by derived values, and a
 *   sibling has none.
 *
 * Replaces the 16-query shape (timeline of 50 + four stat counts twice +
 * per-slice profile/name lookups) with 5 queries in 2 waves.
 */

export interface HomepageTopUser {
  id: string;
  username: string;
  displayName: string;
  postCount: number;
}

export interface HomepageSnapshot {
  totalPosts: number;
  featuredPosts: Post[];
  topUsers: HomepageTopUser[];
}

const FEATURED_LIMIT = 5;
/**
 * Ranked pages on PREALLOCATED indexes (v4–v7) carry zero-count groups for
 * never-liked posts, so the page over-asks and trims. v8 lost preallocation
 * (a moderator-deletable post is not a permanentDocument target) and its
 * ranked pages hold liked posts only.
 */
const rankedLimit = () => (likeCountsArePreallocated() ? 10 : FEATURED_LIMIT);
const TOP_USERS_LIMIT = 6;

export async function loadHomepage(): Promise<HomepageSnapshot> {
  if (!likesAreIndexOnly()) return loadHomepageLegacy();
  try {
    return await loadHomepageRanked();
  } catch (error) {
    logger.warn('Homepage: ranked/composite load failed, falling back to the timeline loader:', error);
    return loadHomepageLegacy();
  }
}

/** The pre-composite shape: works on every topology and every node version. */
async function loadHomepageLegacy(): Promise<HomepageSnapshot> {
  const [totalPosts, featuredPosts, authorCounts] = await Promise.all([
    postService.countAllPosts(),
    postService.getTopPostsByLikes(FEATURED_LIMIT),
    postService.getAuthorPostCounts(),
  ]);
  const sortedAuthors = Array.from(authorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_USERS_LIMIT);
  const ids = sortedAuthors.map(([id]) => id);
  if (ids.length === 0) return { totalPosts, featuredPosts, topUsers: [] };
  const [profiles, usernames] = await Promise.all([
    unifiedProfileService.getProfilesByIdentityIds(ids),
    dpnsService.resolveUsernamesBatch(ids),
  ]);
  const profileMap = new Map<string, UnifiedProfileDocument>();
  for (const profile of profiles) {
    if (profile.$ownerId) profileMap.set(profile.$ownerId, profile);
  }
  return { totalPosts, featuredPosts, topUsers: buildTopUsers(sortedAuthors, profileMap, usernames) };
}

async function loadHomepageRanked(): Promise<HomepageSnapshot> {
  // Wave 1.
  const [ranked, authorCounts, totalPosts] = await Promise.all([
    topLikedPosts({ limit: rankedLimit(), window: 'all' }),
    postService.getAuthorPostCounts(),
    postService.countAllPosts(),
  ]);

  const featuredIds = ranked.slice(0, FEATURED_LIMIT).map((entry) => entry.postId);
  const likesById = new Map(ranked.map((entry) => [entry.postId, entry.likes]));

  const sortedAuthors = Array.from(authorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_USERS_LIMIT);
  const contributorIds = sortedAuthors.map(([id]) => id);

  // Wave 2.
  const [page, contributors] = await Promise.all([
    featuredIds.length > 0
      ? loadCompositeFeedPage({ language: 'en', limit: featuredIds.length, documentIds: featuredIds })
      : Promise.resolve(null),
    contributorIds.length > 0
      ? loadContributorIdentities(contributorIds)
      : Promise.resolve({ profiles: new Map<string, UnifiedProfileDocument>(), usernames: new Map<string, string | null>() }),
  ]);

  // Author identity for the cards: the composite page proved the profiles
  // and names under the same root as the posts.
  const featuredPosts = (page?.posts ?? []).map((post) => {
    const authorId = post.author.id;
    const username = page?.preloaded.usernames?.get(authorId);
    const displayName = page?.preloaded.profiles?.get(authorId)?.displayName;
    const avatar = page?.preloaded.avatars?.get(authorId);
    const rankedLikes = likesById.get(post.id);
    return {
      ...post,
      likes: rankedLikes ?? post.likes,
      author: {
        ...post.author,
        username: username ?? post.author.username,
        displayName: displayName || username || post.author.displayName,
        avatar: avatar || post.author.avatar,
        hasDpns: username === undefined ? post.author.hasDpns : username !== null,
      },
    };
  });

  return {
    totalPosts,
    featuredPosts,
    topUsers: buildTopUsers(sortedAuthors, contributors.profiles, contributors.usernames),
  };
}

/** Total DPNS document budget across all contributors (the lookup's limit). */
const DPNS_QUERY_LIMIT = 100;

/**
 * The contributors' profiles as a composite page with their DPNS names bound
 * to it: one proved request for both. Seeds the profile and name caches so
 * later lookups for these identities are hits.
 */
async function loadContributorIdentities(ids: readonly string[]): Promise<{
  profiles: Map<string, UnifiedProfileDocument>;
  usernames: Map<string, string | null>;
}> {
  const sdk = await getEvoSdk();
  const query: CompositeDocumentsQuery = {
    dataContractId: YAPPR_PROFILE_CONTRACT_ID,
    documentType: 'profile',
    where: [['$ownerId', 'in', [...ids]]],
    orderBy: [['$ownerId', 'asc']],
    limit: ids.length,
    subQueries: [
      {
        dataContractId: DPNS_CONTRACT_ID,
        documentType: DPNS_DOCUMENT_TYPE,
        bind: { source: 'page', sourceProperty: '$ownerId', field: 'records.identity' },
        limit: DPNS_QUERY_LIMIT,
      },
    ],
  };
  const result = await sdk.documents.composite(query);
  const names = result.subResults[0];
  if (!names || names.kind !== 'documents') {
    throw new Error('Homepage: incomplete contributors composite result');
  }
  const profileRecords = result.pageDocuments.map((doc) => documentToPlainObject(doc));
  const profiles = unifiedProfileService.seedProfileDocuments(profileRecords, ids);
  const usernames = usernamesByIdentity(
    names.documents.map((doc) => documentToPlainObject(doc)),
    ids,
    ids.length
  );
  dpnsService.seedUsernames(usernames);
  return { profiles, usernames };
}

function buildTopUsers(
  sortedAuthors: [string, number][],
  profiles: ReadonlyMap<string, { displayName?: string }>,
  usernames: ReadonlyMap<string, string | null>
): HomepageTopUser[] {
  return sortedAuthors.map(([authorId, postCount]) => {
    const username = usernames.get(authorId) || `${authorId.substring(0, 8)}...`;
    return {
      id: authorId,
      username,
      displayName: profiles.get(authorId)?.displayName || username,
      postCount,
    };
  });
}
