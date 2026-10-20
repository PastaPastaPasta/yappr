import type { Post } from '@/lib/types';
import type { CompositeDocumentsQuery, CompositeSubQuery } from '@dashevo/wasm-sdk';
import { DPNS_CONTRACT_ID, DPNS_DOCUMENT_TYPE } from '@/lib/constants';
import { profileBaseSource, profileExtensionSource } from '@/lib/profile/v10-profile';
import { likesAreIndexOnly } from '@/lib/contract-topology';
import { logger } from '@/lib/logger';
import { loadCompositeFeedPage, usernamesByIdentity, type CompositeFeedPage } from '@/lib/feed/composite-feed-page';
import { dpnsService } from '@/lib/services/dpns-service';
import { getEvoSdk } from '@/lib/services/evo-sdk-service';
import { postService } from '@/lib/services/post-service';
import { topLikedPosts } from '@/lib/services/ranked-likes';
import { documentToPlainObject } from '@/lib/services/sdk-helpers';
import { unifiedProfileService, type UnifiedProfileDocument } from '@/lib/services/unified-profile-service';

/**
 * The anonymous homepage in two waves of document queries, on topologies with
 * a like ranking (v9) against nodes that serve composite pages.
 * Elsewhere, and whenever that path fails, the topology-agnostic loader
 * below takes over: a timeline of 50, its engagement counts, and per-slice
 * profile and name lookups.
 *
 * Wave 1, in parallel:
 * - a proved top-K ranking on the like count tree (which posts to feature),
 * - the grouped `post` count by `$ownerId` (top contributors, and how many
 *   people post; the grouping stops at 100 groups, shown as "100+"),
 * - the aggregate `post` count (the platform total). The grouping cannot
 *   stand in for it: Drive caps a grouped range-distinct count at 100 groups
 *   and the scan fallback stops at 10,000 posts, so its sum undercounts once
 *   the platform has more posting identities than that,
 * - the posts of the last 24 hours, a range count on the same timeline tree.
 *
 * Wave 2, each read starting as soon as the wave-1 read it needs lands (so a
 * slow or retried author ranking never holds back the featured cards):
 * - ONE composite by-id page over the featured ids carrying their engagement
 *   counts, quoted posts, author profiles and names, plus, only while fewer
 *   posts than the section shows have likes, ONE composite timeline page of
 *   the newest posts to fill it;
 * - ONE composite page of the top contributors' profiles (`$ownerId IN`) with
 *   their DPNS names bound to it. The contributors cannot ride the featured
 *   page: the node refuses two documents components on the same index path
 *   (profile owner index) unless both are told apart by derived values, and a
 *   sibling has none. A contributor the page leaves unnamed (no profile) costs
 *   one more name lookup, made only then.
 */

export interface HomepageTopUser {
  id: string;
  /** The DPNS name, or null for an identity without one. */
  username: string | null;
  displayName: string;
  postCount: number;
}

export interface HomepageSnapshot {
  totalPosts: number;
  /** Identities with a live post. */
  authorCount: number;
  /** True when `authorCount` hit the grouping's cap, so the real figure is higher. */
  authorCountCapped: boolean;
  /** Posts of the last 24 hours; null where the cut cannot count them. */
  postsToday: number | null;
  featuredPosts: Post[];
  topUsers: HomepageTopUser[];
}

const FEATURED_LIMIT = 10;
/**
 * Ranked pages hold liked posts only: v11's preallocated like trees list every
 * post, but `topLikedPosts` drops the zero-count groups, which rank last. A
 * moderator-removed (or v11 tombstoned) post drops out of the hydrated page,
 * so a little headroom is read for the featured cards.
 */
const RANKED_LIMIT = FEATURED_LIMIT + 2;
const TOP_USERS_LIMIT = 6;
/** Grouped author counts stop at this many groups (Drive's cap). */
const AUTHOR_GROUP_CAP = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `onFeatured`, when given, receives the featured posts as soon as they are
 * proved, ahead of the contributors and the stats, so the cards need not wait
 * on the slowest read. The snapshot that follows carries them too.
 */
export async function loadHomepage(onFeatured?: (posts: Post[]) => void): Promise<HomepageSnapshot> {
  if (!likesAreIndexOnly()) return loadHomepageLegacy();
  try {
    return await loadHomepageRanked(onFeatured);
  } catch (error) {
    logger.warn('Homepage: ranked/composite load failed, falling back to the timeline loader:', error);
    return loadHomepageLegacy();
  }
}

function topAuthors(authorCounts: ReadonlyMap<string, number>): [string, number][] {
  return Array.from(authorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_USERS_LIMIT);
}

function authorStats(authorCounts: ReadonlyMap<string, number>): Pick<HomepageSnapshot, 'authorCount' | 'authorCountCapped'> {
  return { authorCount: authorCounts.size, authorCountCapped: authorCounts.size >= AUTHOR_GROUP_CAP };
}

/** The pre-composite shape: works on every topology and every node version. */
async function loadHomepageLegacy(): Promise<HomepageSnapshot> {
  const [totalPosts, featuredPosts, authorCounts, postsToday] = await Promise.all([
    postService.countAllPosts(),
    postService.getTopPostsByLikes(FEATURED_LIMIT),
    postService.getAuthorPostCounts(),
    postService.countPostsSince(Date.now() - DAY_MS),
  ]);
  return {
    totalPosts, postsToday, featuredPosts, ...authorStats(authorCounts),
    topUsers: await topContributors(authorCounts, lookUpContributors),
  };
}

type ContributorIdentities = { profiles: Map<string, UnifiedProfileDocument>; usernames: Map<string, string | null> };

/** The most prolific authors, with the names and profiles `lookUp` finds for them. */
async function topContributors(
  authorCounts: ReadonlyMap<string, number>,
  lookUp: (ids: readonly string[]) => Promise<ContributorIdentities>
): Promise<HomepageTopUser[]> {
  const sortedAuthors = topAuthors(authorCounts);
  if (sortedAuthors.length === 0) return [];
  const { profiles, usernames } = await lookUp(sortedAuthors.map(([id]) => id));
  return buildTopUsers(sortedAuthors, profiles, usernames);
}

/** Per-slice profile and name lookups: the loader that works on every topology. */
async function lookUpContributors(ids: readonly string[]): Promise<ContributorIdentities> {
  const [profiles, usernames] = await Promise.all([
    unifiedProfileService.getProfilesByIdentityIds([...ids]),
    dpnsService.resolveUsernamesBatch([...ids]),
  ]);
  const profileMap = new Map<string, UnifiedProfileDocument>();
  for (const profile of profiles) {
    if (profile.$ownerId) profileMap.set(profile.$ownerId, profile);
  }
  return { profiles: profileMap, usernames };
}

/** A composite page's posts carrying the author names, profiles and avatars it proved with them. */
function postsWithAuthors(page: CompositeFeedPage | null, likesById: ReadonlyMap<string, number>): Post[] {
  if (!page) return [];
  return page.posts.map((post) => {
    const authorId = post.author.id;
    const username = page.preloaded.usernames?.get(authorId);
    const displayName = page.preloaded.profiles?.get(authorId)?.displayName;
    const avatar = page.preloaded.avatars?.get(authorId);
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
}

async function loadHomepageRanked(onFeatured?: (posts: Post[]) => void): Promise<HomepageSnapshot> {
  const featured = loadFeaturedPosts().then((posts) => {
    onFeatured?.(posts);
    return posts;
  });
  const authors = postService.getAuthorPostCounts().then(async (authorCounts) => ({
    authorCounts,
    // A failed composite costs the contributors only their composite: they fall
    // back to per-slice lookups, so featured cards already shown are never re-read.
    topUsers: await topContributors(authorCounts, (ids) => loadContributorIdentities(ids).catch((error: unknown) => {
      logger.warn('Homepage: contributors composite failed, looking them up one slice at a time:', error);
      return lookUpContributors(ids);
    })),
  }));
  const [featuredPosts, { authorCounts, topUsers }, totalPosts, postsToday] = await Promise.all([
    featured,
    authors,
    postService.countAllPosts(),
    postService.countPostsSince(Date.now() - DAY_MS),
  ]);
  return { totalPosts, postsToday, ...authorStats(authorCounts), featuredPosts, topUsers };
}

/** The proved like ranking hydrated as one composite page, topped up with the newest posts. */
async function loadFeaturedPosts(): Promise<Post[]> {
  const ranked = await topLikedPosts({ limit: RANKED_LIMIT, window: 'all' });
  // Every ranked id, headroom included: a removed post drops out of the page.
  const featuredIds = ranked.map((entry) => entry.postId);
  const rank = new Map(featuredIds.map((id, index) => [id, index]));
  const likesById = new Map(ranked.map((entry) => [entry.postId, entry.likes]));

  const [page, newest] = await Promise.all([
    featuredIds.length > 0
      ? loadCompositeFeedPage({ language: 'en', limit: featuredIds.length, documentIds: featuredIds })
      : Promise.resolve(null),
    // Optional filler: its failure must not throw the ranked page away.
    featuredIds.length < FEATURED_LIMIT
      ? loadCompositeFeedPage({ language: 'en', limit: FEATURED_LIMIT }).catch((error: unknown) => {
        logger.warn('Homepage: newest-posts filler failed:', error);
        return null;
      })
      : Promise.resolve(null),
  ]);

  // The most liked first, then the newest to fill the section.
  const featuredPosts = postsWithAuthors(page, likesById)
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .slice(0, FEATURED_LIMIT);
  const shown = new Set(featuredPosts.map((post) => post.id));
  for (const post of postsWithAuthors(newest, likesById)) {
    if (featuredPosts.length >= FEATURED_LIMIT) break;
    if (!shown.has(post.id)) featuredPosts.push(post);
  }
  return featuredPosts;
}

/** Total DPNS document budget across all contributors (the lookup's limit). */
const DPNS_QUERY_LIMIT = 100;

/**
 * The contributors' profiles as a composite page with their DPNS names bound
 * to it: one proved request for both. Seeds the profile and name caches so
 * later lookups for these identities are hits. A contributor the page leaves
 * unnamed (no profile to bind to) gets a direct name lookup.
 */
async function loadContributorIdentities(ids: readonly string[]): Promise<ContributorIdentities> {
  const sdk = await getEvoSdk();
  const base = profileBaseSource();
  const subQueries: CompositeSubQuery[] = [
    {
      dataContractId: DPNS_CONTRACT_ID,
      documentType: DPNS_DOCUMENT_TYPE,
      bind: { source: 'page', sourceProperty: '$ownerId', field: 'records.identity' },
      limit: DPNS_QUERY_LIMIT,
    },
  ];
  // v10: the page is the DashPay profiles; their `yapprProfile` extensions join after the names.
  const extension = profileExtensionSource();
  if (extension) {
    subQueries.push({
      dataContractId: extension.contractId,
      documentType: extension.documentType,
      bind: { source: 'page', sourceProperty: '$ownerId', field: '$ownerId' },
    });
  }
  const query: CompositeDocumentsQuery = {
    dataContractId: base.contractId,
    documentType: base.documentType,
    where: [['$ownerId', 'in', [...ids]]],
    orderBy: [['$ownerId', 'asc']],
    limit: ids.length,
    subQueries,
  };
  const result = await sdk.documents.composite(query);
  const names = result.subResults[0];
  const extensions = extension ? result.subResults[1] : undefined;
  if (!names || names.kind !== 'documents' || (extension && extensions?.kind !== 'documents')) {
    throw new Error('Homepage: incomplete contributors composite result');
  }
  if (extensions?.kind === 'documents') {
    unifiedProfileService.seedProfileDocuments(extensions.documents.map((doc) => documentToPlainObject(doc)), ids, 'extension');
  }
  const profileRecords = result.pageDocuments.map((doc) => documentToPlainObject(doc));
  const profiles = unifiedProfileService.seedProfileDocuments(profileRecords, ids);
  // Names bind to the profile page, so a contributor without a profile was never looked up:
  // leave them out rather than seed an unproven "no name".
  const pageOwners = new Set(profileRecords.map((record) => record.$ownerId));
  const usernames = usernamesByIdentity(
    names.documents.map((doc) => documentToPlainObject(doc)),
    ids.filter((id) => pageOwners.has(id)),
    ids.length
  );
  dpnsService.seedUsernames(usernames);
  const unnamed = ids.filter((id) => !usernames.has(id));
  if (unnamed.length > 0) {
    const resolved = await dpnsService.resolveUsernamesBatch(unnamed).catch((error: unknown) => {
      logger.warn('Homepage: contributor name lookup failed:', error);
      return new Map<string, string | null>();
    });
    for (const [id, name] of resolved) usernames.set(id, name);
  }
  return { profiles, usernames };
}

function buildTopUsers(
  sortedAuthors: [string, number][],
  profiles: ReadonlyMap<string, { displayName?: string }>,
  usernames: ReadonlyMap<string, string | null>
): HomepageTopUser[] {
  return sortedAuthors.map(([authorId, postCount]) => {
    const username = usernames.get(authorId) || null;
    return {
      id: authorId,
      username,
      displayName: profiles.get(authorId)?.displayName || username || `${authorId.substring(0, 8)}…`,
      postCount,
    };
  });
}
