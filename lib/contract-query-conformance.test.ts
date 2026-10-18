/**
 * Query → index conformance: every document read the client sends on the
 * release cut must be one Drive (platform v5.0.0-rc.3, protocol 14) serves
 * through an index of the committed contract. It fails whenever a client
 * query shape has no such index.
 *
 * How: the real services run in node against a fake SDK
 * (`contract-query-conformance/capture-sdk.ts`) that records every
 * `documents.query/count/ranked/average/composite/get` request and answers
 * empty. The fake is installed on the real `evoSdkService.getSdk()`, the seam
 * every `getEvoSdk()` call goes through (a `vi.mock` of the module is not
 * enough: concurrent first `import()`s of a mocked module inside the services
 * can resolve the real one). Each recorded request is then judged by the port
 * of Drive's index selection in `contract-query-conformance/query-index-model.ts`
 * (proved reads, as the SDK always sends them) against:
 *
 *   social      contracts/yappr-social-contract-v17.json  NEXT_PUBLIC_CONTRACT_TOPOLOGY=v17
 *   blog        contracts/yappr-blog-contract.json        NEXT_PUBLIC_BLOG_TOPOLOGY=v9
 *   storefront  contracts/yappr-storefront-contract.json  NEXT_PUBLIC_STOREFRONT_TOPOLOGY=v10
 *   pollr       contracts/pollr-contract.json             NEXT_PUBLIC_POLLR_TOPOLOGY=v8
 *   blocks      contracts/yappr-blocks-contract.json
 *   DM v5       contracts/yappr-dm-contract-v5.json       NEXT_PUBLIC_DM_TOPOLOGY=v5
 *
 * Requests to any other contract (DPNS, DashPay, the profile contract, token
 * history, key exchange, moderation charters) are not judged.
 *
 * Readers driven (the list in `readers()` below):
 *   post-service      getTimeline (+cursor), getUserPosts (+forDisplay), getPostById,
 *                     getPostsByIds, getPostsByIdsForDisplay, countUserPosts, countAllPosts,
 *                     getPostsByHashtag, countPostsByHashtag, getQuotePosts (post/reply),
 *                     countQuotes, countQuotesForPosts, getOwnQuotes, getAuthorPostCounts,
 *                     getTopPostsByLikes, getFollowingFeed, getBatchPostStats,
 *                     fetchPostsOrReplies, enrichPostsBatch; post-stats-helpers
 *                     fetchBatchUserInteractions; document-service
 *                     queryPostsByOwnersSince, queryPostsSince
 *   reply-service     getReplies, getUserReplies, getRepliesToMyContent (notification
 *                     windows), getNestedReplies, countReplies (post/reply),
 *                     countRepliesForPosts (post/reply), getReplyById, getRepliesByIds
 *   like-service      isLiked, getPostLikes, getUserLikedPostIds, countLikes,
 *                     countLikesForPosts (post and reply targets), getRecentTargetLikeCounts
 *                     (post/reply), getLikersOf
 *   follow-service    isFollowing, getFollowers, listFollowers, getRecentFollowers,
 *                     getFollowing, countFollowers, countFollowing, countFollowersBatch,
 *                     countFollowingBatch
 *   bookmark-service  isBookmarked, getUserBookmarks, getUserBookmarksForPosts
 *   mention-service   getPostsMentioningUser
 *   hashtag-service   getPostCountByHashtag, getTrendingHashtags
 *   notification-service  getNewFollowers, getLikeNotifications, getRepostNotifications,
 *                     getQuoteNotifications, getReplyNotifications, getNewMentions,
 *                     getPrivateFeedNotifications, getBlogPostNotifications,
 *                     getBlogCommentNotifications, getStoreNotifications
 *   report-service    getOwnReport (post/reply/profile), listView (open/open+cursor/status/moderatedBy),
 *                     listForTarget (post/profile)
 *   block-service     getBlock, getUserBlocks, getBloomFilter, getBloomFiltersBatch,
 *                     getBlockFollows, checkBlockedBatch, getBlockSourcesBatch
 *   ranked-likes      topLikedPosts (all/today; hashtag all/today; author), topHashtagsByLikes
 *                     (all/today), topCreatorsByLikes (all/today), mostFollowedUsers,
 *                     topAuthorsByPostCount
 *   social-stats      loadUserStats, loadEngagementCounts (post/reply)
 *   feeds             loadCompositeFeedPage (timeline page, explicit ids, replies),
 *                     loadForYouFeed, loadPostEnrichment, fetchReplyParents,
 *                     provenAbsent (post/reply), loadHomepage
 *   private feed      privateFeedService getLatestKeyGeneration, getPrivateFollowers,
 *                     getPrivateFollowerCount; privateFeedFollowerService
 *                     getFollowRequestsForOwner, getFollowRequest, getGrant
 *   blog              blog-post-service getLatestPosts, getPostsByBlog, getPostsByBlogs,
 *                     getPostBySlug, getPost, getRecentPosts; blog-service getBlog,
 *                     getBlogsByOwner, getBlogTimelinePage, getNewestBlogs;
 *                     blog-comment-service getCommentsByPost, countCommentsByPost,
 *                     countCommentsByPostBatch, getCommentsOnMyPosts; blog-follow-service
 *                     isFollowingBlog, getFollowedBlogs, getBlogFollowers,
 *                     countBlogFollowers; blog-stats mostFollowedBlogs, trendingBlogs,
 *                     mostDiscussedPosts
 *   storefront        store-service getByOwner, getById, getNewestActiveStores,
 *                     getNewestActiveStoresInCategory, hasStore; store-item-service getById,
 *                     getManyFresh, getManyOrThrow, getByStore (all/active), getAllByStore;
 *                     shipping-zone getByStore; store-order getBuyerOrders,
 *                     getSellerOrders, getStoreOrders; store-review getStoreReviews,
 *                     getOrderReviews; item-review getItemReviews; item-deliverable
 *                     getForItems; order-delivery getForOrders, getForBuyer;
 *                     saved-address getForUser; order-status getLatestStatuses,
 *                     getLatestStatus; store-stats getStoreRatingSummary(ies),
 *                     getItemRatingSummary, getItemReviewCounts, topRatedStores,
 *                     mostOrderedStores, topStoreCategories, topItemsInStore,
 *                     loadBuyerOrdersComposite, countSellerOrders;
 *                     store-notification getNotifications
 *   pollr             pollr-poll-service getPoll, countBallots; pollr-vote-service
 *                     getBallotState, getMyBallot, getTally
 *   DM v5             SdkDmChain messagesByTags, invitesSince, invitesNewestFirst,
 *                     groupDocs, selfState
 *
 * Not driven, with the reason:
 *   - every write path (create/replace/delete, and the reads a write makes to
 *     check itself): writes are not index reads.
 *   - readers v17 gates off, which would read doctypes v17 does not have:
 *     repost-service (v17 reposts are quote posts: `repostsAreQuotes()`; its
 *     callers, e.g. enrich-posts, load-following-feed, post-stats-helpers and
 *     social-stats, check `repostIndexFor`/`repostsAreQuotes` first and are
 *     driven), hashtag-service getHashtagForPost/getHashtagsForPost/
 *     getPostIdsByHashtag/getRecentHashtags and mention-service getMentionForPost/
 *     getMentionsForPost (`postHashtag`/`postMention`; v17 tags and mentions are
 *     inline, `hashtagsAreInline()`/`mentionsAreInline()`), report-service
 *     listRecent (only reached when `!reportsAreResolved()`),
 *     likeService.getLikesOnMyPosts (v17 likes carry no author-time index; the
 *     like notifications read getRecentTargetLikeCounts and getLikersOf),
 *     privateFeedService.hasPrivateFeed/getPrivateFeedState (no reads on v17,
 *     `privateFeedClientSupported()`).
 *   - followService.getFollowStatusBatch, blogFollowService.getFollowStatusBatch:
 *     they reuse getFollowing / getFollowedBlogIds (driven, deduplicated).
 *   - moderation-service / moderation-election-service: they read moderation
 *     state through `sdk.contracts.*`, not document queries; the document reads
 *     they make are `$id` primary-key reads.
 *   - unified-profile-service, dpns-service, dashpay-contacts-service,
 *     identity-service, identity-batch, key-exchange-service,
 *     messaging-key-service, token-service, tip-history-service: they read the
 *     profile, DPNS, DashPay, key-exchange and token-history contracts, which
 *     this spec does not judge (their composite sub-queries on judged contracts,
 *     e.g. loadUserStats's counts, are judged).
 *   - direct-message-service (DM v3/v4) and the DM v5 engine above SdkDmChain:
 *     the release reads DM v5 only through SdkDmChain, driven directly.
 *   - private-feed key recovery and catch-up (catchUp, recover*, sync*): they
 *     read behind decrypted key state the node harness cannot hold, and on v17
 *     the client offers no private feed.
 *   - cart-service: it reads items through store-item-service (getManyOrThrow
 *     and `$id ==` reads, driven).
 *   - load-following-feed: drives followService.getFollowing and
 *     postService.getFollowingFeed (both driven) behind DOM callbacks.
 *   - fallback paths taken only when a primary read throws or answers an
 *     unexpected shape (per-id count fallbacks, scans after a refused ranked
 *     read): the fake answers every read successfully and empty, so only the
 *     primary shapes are captured. Reads that follow only a non-empty answer
 *     (keyset second pages such as getPostLikes' `$ownerId > last`,
 *     getLikersOf's full-page branch, loadHomepage's second wave) are not
 *     captured either; readers that need documents to go further are driven
 *     with sample posts instead (enrichPostsBatch, loadPostEnrichment,
 *     fetchReplyParents, the replies page).
 *   - model limits (see query-index-model.ts): a composite sub-query's walk
 *     direction agreeing with its page's, merged-proof path checks,
 *     integerRange, having, sums and range averages are not judged.
 */

import bs58 from 'bs58'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCaptureSdk, type CapturedRequest } from './contract-query-conformance/capture-sdk'
import {
  checkAverageQuery,
  checkCompositePage,
  checkCompositeSubQuery,
  checkCountQuery,
  checkDocumentsQuery,
  checkRankedQuery,
  parseContract,
  type ModelContract,
  type Verdict,
} from './contract-query-conformance/query-index-model'
import type { Post } from '@/lib/types'
import type { Poll } from '@/lib/services/pollr-poll-service'
import socialV16 from '@/contracts/yappr-social-contract-v16.json'
import socialV17 from '@/contracts/yappr-social-contract-v17.json'
import blogContract from '@/contracts/yappr-blog-contract.json'
import storefrontContract from '@/contracts/yappr-storefront-contract.json'
import pollrContract from '@/contracts/pollr-contract.json'
import blocksContract from '@/contracts/yappr-blocks-contract.json'
import dmV5Contract from '@/contracts/yappr-dm-contract-v5.json'

const capture = createCaptureSdk()

vi.mock('@/lib/logger', () => ({ logger: capture.logger }))

/** A 32-byte identifier filled with `n`, as base58. */
const ident = (n: number) => bs58.encode(new Uint8Array(32).fill(n))

const CONTRACT_IDS = {
  social: ident(1),
  blog: ident(2),
  storefront: ident(3),
  pollr: ident(4),
  blocks: ident(5),
  dmV5: ident(6),
} as const

type ContractKey = keyof typeof CONTRACT_IDS

const MODELS: Record<ContractKey, ModelContract> = {
  social: parseContract(socialV17),
  blog: parseContract(blogContract),
  storefront: parseContract(storefrontContract),
  pollr: parseContract(pollrContract),
  blocks: parseContract(blocksContract),
  dmV5: parseContract(dmV5Contract),
}

const CONTRACT_BY_ID = new Map<string, ContractKey>(
  (Object.entries(CONTRACT_IDS) as [ContractKey, string][]).map(([key, id]) => [id, key]),
)

/**
 * Social v17 private-feed reads EXPECTED to be refused until the multi-feed
 * private feed client lands: v17 replaces `privateFeedState` with
 * `privateFeed` and keys grants and rekeys by `(owner, feed)`, and this
 * build's private-feed client still speaks the single-state shape
 * (docs/SOCIAL_V17.md, `privateFeedClientSupported()` in
 * lib/contract-topology.ts). Scoped by doctype AND reader; each entry must
 * still be refused (the allowlist test fails on a stale one), and anything
 * else refused on these doctypes fails the main assertion.
 */
const PRIVATE_FEED_ALLOWLIST: readonly { docType: string; reader: string }[] = [
  { docType: 'privateFeedRekey', reader: 'privateFeedService.getLatestKeyGeneration' },
  { docType: 'privateFeedGrant', reader: 'privateFeedService.getPrivateFollowers' },
  { docType: 'privateFeedGrant', reader: 'privateFeedService.getPrivateFollowerCount' },
]

/**
 * Client shapes Drive refuses on the release cut that a builder still has to
 * fix (none today). Matched by request signature; each must still be refused,
 * so an entry has to go once its builder is fixed.
 */
const PENDING_BUILDER_FIXES: readonly { signature: string; fix: string }[] = []

/** Logged warnings that are not failed reads (node has no localStorage). */
const BENIGN_LOGS: readonly RegExp[] = [/^Like notifications: the snapshot could not be saved/]

// Sample identities and documents the readers are driven with.
const ME = ident(11)
const OTHER = ident(12)
const POST = ident(21)
const POST2 = ident(22)
const REPLY = ident(31)
const BLOG = ident(41)
const BLOG_POST = ident(42)
const STORE = ident(51)
const ITEM = ident(52)
const ORDER = ident(53)
const POLL = ident(61)
const SINCE = 1_700_000_000_000

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v17')
  vi.stubEnv('NEXT_PUBLIC_BLOG_TOPOLOGY', 'v9')
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v10')
  vi.stubEnv('NEXT_PUBLIC_POLLR_TOPOLOGY', 'v8')
  vi.stubEnv('NEXT_PUBLIC_DM_TOPOLOGY', 'v5')
  vi.stubEnv('NEXT_PUBLIC_YAPPR_CONTRACT_ID', CONTRACT_IDS.social)
  vi.stubEnv('NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID', CONTRACT_IDS.blog)
  vi.stubEnv('NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID', CONTRACT_IDS.storefront)
  vi.stubEnv('NEXT_PUBLIC_POLLR_CONTRACT_ID', CONTRACT_IDS.pollr)
  vi.stubEnv('NEXT_PUBLIC_YAPPR_BLOCKS_CONTRACT_ID', CONTRACT_IDS.blocks)
  vi.stubEnv('NEXT_PUBLIC_YAPPR_DM_V5_CONTRACT_ID', CONTRACT_IDS.dmV5)
  vi.resetModules()
  const { evoSdkService } = await import('@/lib/services/evo-sdk-service')
  vi.spyOn(evoSdkService, 'getSdk').mockImplementation(async () => capture.sdk)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function samplePost(id: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    targetKind: 'post',
    author: { id: OTHER, username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) },
    content: 'hello #dash',
    createdAt: new Date(SINCE),
    likes: 0,
    reposts: 0,
    replies: 0,
    quotes: 0,
    views: 0,
    tags: ['dash'],
    ...overrides,
  }
}

function sampleReply(id: string): Post {
  return samplePost(id, { targetKind: 'reply', rootPostId: POST, parentId: POST, parentOwnerId: OTHER })
}

/** One reader: a label and the call that drives it (modules are imported after the env is stubbed). */
interface Reader {
  name: string
  run: () => Promise<unknown>
}

async function readers(): Promise<Reader[]> {
  const { getEvoSdk } = await import('@/lib/services/evo-sdk-service')
  if ((await getEvoSdk()) !== capture.sdk) throw new Error('the fake SDK is not installed')
  const { postService } = await import('@/lib/services/post-service')
  const { queryPostsByOwnersSince, queryPostsSince } = await import('@/lib/services/document-service')
  const { replyService } = await import('@/lib/services/reply-service')
  const { fetchBatchUserInteractions } = await import('@/lib/services/post-stats-helpers')
  const { likeService } = await import('@/lib/services/like-service')
  const { followService } = await import('@/lib/services/follow-service')
  const { bookmarkService } = await import('@/lib/services/bookmark-service')
  const { mentionService } = await import('@/lib/services/mention-service')
  const { hashtagService } = await import('@/lib/services/hashtag-service')
  const { notificationService } = await import('@/lib/services/notification-service')
  const { reportService } = await import('@/lib/services/report-service')
  const { blockService } = await import('@/lib/services/block-service')
  const ranked = await import('@/lib/services/ranked-likes')
  const socialStats = await import('@/lib/services/social-stats-service')
  const { loadCompositeFeedPage } = await import('@/lib/feed/composite-feed-page')
  const { loadForYouFeed } = await import('@/lib/feed/load-for-you-feed')
  const { loadPostEnrichment } = await import('@/lib/feed/load-post-enrichment')
  const { fetchReplyParents } = await import('@/lib/feed/resolve-reply-parents')
  const { provenAbsent } = await import('@/lib/feed/prove-absent')
  const { loadHomepage } = await import('@/lib/home/load-homepage')
  const { privateFeedService } = await import('@/lib/services/private-feed-service')
  const { privateFeedFollowerService } = await import('@/lib/services/private-feed-follower-service')
  const { blogPostService } = await import('@/lib/services/blog-post-service')
  const { blogService } = await import('@/lib/services/blog-service')
  const { blogCommentService } = await import('@/lib/services/blog-comment-service')
  const { blogFollowService } = await import('@/lib/services/blog-follow-service')
  const { blogStatsService } = await import('@/lib/services/blog-stats-service')
  const { storeService } = await import('@/lib/services/store-service')
  const { storeItemService } = await import('@/lib/services/store-item-service')
  const { shippingZoneService } = await import('@/lib/services/shipping-zone-service')
  const { storeOrderService } = await import('@/lib/services/store-order-service')
  const { storeReviewService } = await import('@/lib/services/store-review-service')
  const { itemReviewService } = await import('@/lib/services/item-review-service')
  const { itemDeliverableService } = await import('@/lib/services/item-deliverable-service')
  const { orderDeliveryService } = await import('@/lib/services/order-delivery-service')
  const { savedAddressService } = await import('@/lib/services/saved-address-service')
  const { orderStatusService } = await import('@/lib/services/order-status-service')
  const { storeStatsService } = await import('@/lib/services/store-stats-service')
  const { storeNotificationService } = await import('@/lib/services/store-notification-service')
  const { pollrPollService } = await import('@/lib/services/pollr-poll-service')
  const { pollrVoteService } = await import('@/lib/services/pollr-vote-service')
  const { SdkDmChain } = await import('@/lib/services/dm-v5/sdk-chain')

  const post = samplePost(POST)
  const reply = sampleReply(REPLY)
  const postTarget = { id: POST, kind: 'post' as const }
  const replyTarget = { id: REPLY, kind: 'reply' as const, rootPostId: POST }
  const poll: Poll = {
    id: POLL, ownerId: OTHER, question: 'q', options: ['a', 'b'], multiChoice: false,
    endsAt: SINCE + 86_400_000, createdAt: new Date(SINCE),
  }
  const ignore = () => undefined
  const dm = new SdkDmChain(bs58.decode(ME))
  const handle = new Uint8Array(32).fill(7)

  return [
    // ---- posts ----
    { name: 'postService.getTimeline', run: () => postService.getTimeline({ limit: 20 }) },
    { name: 'postService.getTimeline (cursor)', run: () => postService.getTimeline({ limit: 20, startAfter: POST2 }) },
    { name: 'postService.getUserPosts', run: () => postService.getUserPosts(OTHER, { limit: 20 }) },
    { name: 'postService.getUserPosts (forDisplay)', run: () => postService.getUserPosts(OTHER, { limit: 20, forDisplay: true }) },
    { name: 'postService.getPostById', run: () => postService.getPostById(POST) },
    { name: 'postService.getPostsByIds', run: () => postService.getPostsByIds([POST, POST2]) },
    { name: 'postService.getPostsByIdsForDisplay', run: () => postService.getPostsByIdsForDisplay([POST, POST2]) },
    { name: 'postService.countUserPosts', run: () => postService.countUserPosts(OTHER) },
    { name: 'postService.countAllPosts', run: () => postService.countAllPosts() },
    { name: 'postService.getPostsByHashtag', run: () => postService.getPostsByHashtag('dash', { limit: 20 }) },
    { name: 'postService.countPostsByHashtag', run: () => postService.countPostsByHashtag('dash') },
    { name: 'postService.getQuotePosts (post)', run: () => postService.getQuotePosts(POST, 'post', { limit: 20 }) },
    { name: 'postService.getQuotePosts (reply)', run: () => postService.getQuotePosts(REPLY, 'reply', { limit: 20 }) },
    { name: 'postService.countQuotes', run: () => postService.countQuotes(POST, 'post') },
    { name: 'postService.countQuotesForPosts', run: () => postService.countQuotesForPosts([POST, POST2], 'post') },
    { name: 'postService.getOwnQuotes', run: () => postService.getOwnQuotes(ME, [POST, POST2], 'post') },
    { name: 'postService.getAuthorPostCounts', run: () => postService.getAuthorPostCounts() },
    { name: 'postService.getTopPostsByLikes', run: () => postService.getTopPostsByLikes(5) },
    { name: 'postService.getFollowingFeed', run: () => postService.getFollowingFeed(ME, { followingIds: [OTHER], timeWindowStart: new Date(SINCE), timeWindowEnd: new Date(SINCE + 3_600_000) }) },
    { name: 'postService.getBatchPostStats', run: () => postService.getBatchPostStats([postTarget, replyTarget]) },
    { name: 'fetchBatchUserInteractions', run: () => fetchBatchUserInteractions([postTarget, replyTarget], ME) },
    { name: 'postService.fetchPostsOrReplies', run: () => postService.fetchPostsOrReplies([POST, REPLY]) },
    { name: 'postService.enrichPostsBatch', run: () => postService.enrichPostsBatch([post]) },
    { name: 'queryPostsByOwnersSince', run: () => queryPostsByOwnersSince([OTHER, ME], SINCE) },
    { name: 'queryPostsSince', run: () => queryPostsSince(SINCE) },
    // ---- replies ----
    { name: 'replyService.getReplies', run: () => replyService.getReplies(POST, { limit: 20 }) },
    { name: 'replyService.getUserReplies', run: () => replyService.getUserReplies(OTHER, { limit: 20 }) },
    { name: 'replyService.getRepliesToMyContent', run: () => replyService.getRepliesToMyContent(ME, new Date(SINCE)) },
    { name: 'replyService.getNestedReplies', run: () => replyService.getNestedReplies([REPLY], { rootPostId: POST }) },
    { name: 'replyService.countReplies (post)', run: () => replyService.countReplies(POST, 'post') },
    { name: 'replyService.countReplies (reply)', run: () => replyService.countReplies(REPLY, 'reply', POST) },
    { name: 'replyService.countRepliesForPosts (post)', run: () => replyService.countRepliesForPosts([POST, POST2], 'post', new Map()) },
    { name: 'replyService.countRepliesForPosts (reply)', run: () => replyService.countRepliesForPosts([REPLY], 'reply', new Map([[REPLY, POST]])) },
    { name: 'replyService.getReplyById', run: () => replyService.getReplyById(REPLY) },
    { name: 'replyService.getRepliesByIds', run: () => replyService.getRepliesByIds([REPLY]) },
    // ---- likes ----
    { name: 'likeService.isLiked (post)', run: () => likeService.isLiked(POST, ME, 'post') },
    { name: 'likeService.isLiked (reply)', run: () => likeService.isLiked(REPLY, ME, 'reply') },
    { name: 'likeService.getPostLikes', run: () => likeService.getPostLikes(POST, 'post') },
    { name: 'likeService.getUserLikedPostIds (post)', run: () => likeService.getUserLikedPostIds(ME, [POST, POST2], 'post') },
    { name: 'likeService.getUserLikedPostIds (reply)', run: () => likeService.getUserLikedPostIds(ME, [REPLY], 'reply') },
    { name: 'likeService.countLikes (post)', run: () => likeService.countLikes(POST, 'post') },
    { name: 'likeService.countLikes (reply)', run: () => likeService.countLikes(REPLY, 'reply') },
    { name: 'likeService.countLikesForPosts', run: () => likeService.countLikesForPosts([POST, POST2], 'post') },
    { name: 'likeService.countLikesForPosts (reply)', run: () => likeService.countLikesForPosts([REPLY], 'reply') },
    { name: 'likeService.getRecentTargetLikeCounts', run: () => likeService.getRecentTargetLikeCounts(ME, 'post') },
    { name: 'likeService.getRecentTargetLikeCounts (reply)', run: () => likeService.getRecentTargetLikeCounts(ME, 'reply') },
    { name: 'likeService.getLikersOf', run: () => likeService.getLikersOf(ME, [POST], 'post') },
    // ---- follows ----
    { name: 'followService.isFollowing', run: () => followService.isFollowing(OTHER, ME) },
    { name: 'followService.getFollowers', run: () => followService.getFollowers(OTHER) },
    { name: 'followService.listFollowers', run: () => followService.listFollowers(OTHER, 50) },
    { name: 'followService.getRecentFollowers', run: () => followService.getRecentFollowers(OTHER, 10) },
    { name: 'followService.getFollowing', run: () => followService.getFollowing(ME) },
    { name: 'followService.countFollowers', run: () => followService.countFollowers(OTHER) },
    { name: 'followService.countFollowing', run: () => followService.countFollowing(OTHER) },
    { name: 'followService.countFollowersBatch', run: () => followService.countFollowersBatch([OTHER, ME]) },
    { name: 'followService.countFollowingBatch', run: () => followService.countFollowingBatch([OTHER, ME]) },
    // ---- bookmarks, reposts, mentions, hashtags ----
    { name: 'bookmarkService.isBookmarked', run: () => bookmarkService.isBookmarked(POST, ME) },
    { name: 'bookmarkService.getUserBookmarks', run: () => bookmarkService.getUserBookmarks(ME) },
    { name: 'bookmarkService.getUserBookmarksForPosts', run: () => bookmarkService.getUserBookmarksForPosts(ME, [POST, POST2]) },
    { name: 'mentionService.getPostsMentioningUser', run: () => mentionService.getPostsMentioningUser(ME) },
    { name: 'hashtagService.getPostCountByHashtag', run: () => hashtagService.getPostCountByHashtag('dash') },
    { name: 'hashtagService.getTrendingHashtags', run: () => hashtagService.getTrendingHashtags() },
    // ---- notifications ----
    { name: 'notificationService.getNewFollowers', run: () => notificationService.getNewFollowers(ME, SINCE) },
    { name: 'notificationService.getLikeNotifications', run: () => notificationService.getLikeNotifications(ME, SINCE) },
    { name: 'notificationService.getRepostNotifications', run: () => notificationService.getRepostNotifications(ME, SINCE) },
    { name: 'notificationService.getQuoteNotifications', run: () => notificationService.getQuoteNotifications(ME, SINCE) },
    { name: 'notificationService.getReplyNotifications', run: () => notificationService.getReplyNotifications(ME, SINCE) },
    { name: 'notificationService.getNewMentions', run: () => notificationService.getNewMentions(ME, SINCE) },
    { name: 'notificationService.getPrivateFeedNotifications', run: () => notificationService.getPrivateFeedNotifications(ME, SINCE) },
    { name: 'notificationService.getBlogPostNotifications', run: () => notificationService.getBlogPostNotifications(ME, SINCE, ignore) },
    { name: 'notificationService.getBlogCommentNotifications', run: () => notificationService.getBlogCommentNotifications(ME, SINCE) },
    { name: 'notificationService.getStoreNotifications', run: () => notificationService.getStoreNotifications(ME, SINCE, ignore) },
    // ---- reports ----
    { name: 'reportService.getOwnReport (post)', run: () => reportService.getOwnReport(ME, 'post', POST) },
    { name: 'reportService.getOwnReport (reply)', run: () => reportService.getOwnReport(ME, 'reply', REPLY) },
    { name: 'reportService.getOwnReport (profile)', run: () => reportService.getOwnReport(ME, 'profile', OTHER) },
    { name: 'reportService.listView (open)', run: () => reportService.listView({ kind: 'open' }) },
    { name: 'reportService.listView (open, cursor)', run: () => reportService.listView({ kind: 'open' }, { id: POST, createdAt: SINCE }) },
    { name: 'reportService.listView (status)', run: () => reportService.listView({ kind: 'status', status: 2 }) },
    { name: 'reportService.listView (moderatedBy)', run: () => reportService.listView({ kind: 'moderatedBy', moderatorId: OTHER }) },
    { name: 'reportService.listForTarget (post)', run: () => reportService.listForTarget('post', POST) },
    { name: 'reportService.listForTarget (profile)', run: () => reportService.listForTarget('profile', OTHER) },
    // ---- blocks ----
    { name: 'blockService.getBlock', run: () => blockService.getBlock(OTHER, ME) },
    { name: 'blockService.getUserBlocks', run: () => blockService.getUserBlocks(ME) },
    { name: 'blockService.getBloomFilter', run: () => blockService.getBloomFilter(ME) },
    { name: 'blockService.getBloomFiltersBatch', run: () => blockService.getBloomFiltersBatch([ME, OTHER]) },
    { name: 'blockService.getBlockFollows', run: () => blockService.getBlockFollows(ME) },
    { name: 'blockService.checkBlockedBatch', run: () => blockService.checkBlockedBatch(ME, [OTHER]) },
    { name: 'blockService.getBlockSourcesBatch', run: () => blockService.getBlockSourcesBatch(ME, [OTHER]) },
    // ---- rankings and stats ----
    { name: 'topLikedPosts', run: () => ranked.topLikedPosts({ limit: 10 }) },
    { name: 'topLikedPosts (today)', run: () => ranked.topLikedPosts({ limit: 10, window: 'today' }) },
    { name: 'topLikedPosts (hashtag)', run: () => ranked.topLikedPosts({ limit: 10, hashtag: 'dash' }) },
    { name: 'topLikedPosts (hashtag, today)', run: () => ranked.topLikedPosts({ limit: 10, hashtag: 'dash', window: 'today' }) },
    { name: 'topLikedPosts (author)', run: () => ranked.topLikedPosts({ limit: 10, postAuthor: OTHER }) },
    { name: 'topHashtagsByLikes', run: () => ranked.topHashtagsByLikes(12) },
    { name: 'topHashtagsByLikes (today)', run: () => ranked.topHashtagsByLikes(12, 'today') },
    { name: 'topCreatorsByLikes', run: () => ranked.topCreatorsByLikes(10) },
    { name: 'topCreatorsByLikes (today)', run: () => ranked.topCreatorsByLikes(10, 'today') },
    { name: 'mostFollowedUsers', run: () => ranked.mostFollowedUsers(10) },
    { name: 'topAuthorsByPostCount', run: () => ranked.topAuthorsByPostCount(100) },
    { name: 'loadUserStats', run: () => socialStats.loadUserStats(OTHER) },
    { name: 'loadEngagementCounts (post)', run: () => socialStats.loadEngagementCounts(POST, 'post') },
    { name: 'loadEngagementCounts (reply)', run: () => socialStats.loadEngagementCounts(REPLY, 'reply') },
    // ---- feeds ----
    { name: 'loadCompositeFeedPage', run: () => loadCompositeFeedPage({ language: 'en', limit: 20, currentUserId: ME }) },
    { name: 'loadCompositeFeedPage (ids)', run: () => loadCompositeFeedPage({ language: 'en', limit: 2, documentIds: [POST, POST2], currentUserId: ME }) },
    { name: 'loadCompositeFeedPage (replies)', run: () => loadCompositeFeedPage({ language: 'en', limit: 1, documentIds: [REPLY], kind: 'reply', sourcePosts: [reply], currentUserId: ME }) },
    { name: 'loadForYouFeed', run: () => loadForYouFeed({ currentUserId: ME }) },
    { name: 'loadPostEnrichment', run: () => loadPostEnrichment([post, reply], ME) },
    { name: 'fetchReplyParents', run: () => fetchReplyParents([reply]) },
    { name: 'provenAbsent (post)', run: () => provenAbsent('post', [POST]) },
    { name: 'provenAbsent (reply)', run: () => provenAbsent('reply', [REPLY]) },
    { name: 'loadHomepage', run: () => loadHomepage() },
    // ---- private feed ----
    { name: 'privateFeedService.getLatestKeyGeneration', run: () => privateFeedService.getLatestKeyGeneration(OTHER) },
    { name: 'privateFeedService.getPrivateFollowers', run: () => privateFeedService.getPrivateFollowers(ME) },
    { name: 'privateFeedService.getPrivateFollowerCount', run: () => privateFeedService.getPrivateFollowerCount(ME) },
    { name: 'privateFeedFollowerService.getFollowRequestsForOwner', run: () => privateFeedFollowerService.getFollowRequestsForOwner(ME) },
    { name: 'privateFeedFollowerService.getFollowRequest', run: () => privateFeedFollowerService.getFollowRequest(OTHER, ME) },
    { name: 'privateFeedFollowerService.getGrant', run: () => privateFeedFollowerService.getGrant(OTHER, ME) },
    // ---- blog ----
    { name: 'blogPostService.getOwnerPostsPage', run: () => blogPostService.getOwnerPostsPage(ME, { limit: 20 }) },
    { name: 'blogPostService.getLatestPosts', run: () => blogPostService.getLatestPosts({ limit: 20 }) },
    { name: 'blogPostService.getPostsByBlog', run: () => blogPostService.getPostsByBlog(BLOG, { limit: 20 }) },
    { name: 'blogPostService.getPostsByBlogs', run: () => blogPostService.getPostsByBlogs([BLOG, ident(43)], 5) },
    { name: 'blogPostService.getPostBySlug', run: () => blogPostService.getPostBySlug(BLOG, 'hello-world') },
    { name: 'blogPostService.getPost', run: () => blogPostService.getPost(BLOG_POST) },
    { name: 'blogPostService.getRecentPosts', run: () => blogPostService.getRecentPosts([BLOG], 20) },
    { name: 'blogService.getBlog', run: () => blogService.getBlog(BLOG) },
    { name: 'blogService.getBlogsByOwner', run: () => blogService.getBlogsByOwner(OTHER) },
    { name: 'blogService.getBlogTimelinePage', run: () => blogService.getBlogTimelinePage({ limit: 20 }) },
    { name: 'blogService.getNewestBlogs', run: () => blogService.getNewestBlogs(50) },
    { name: 'blogCommentService.getCommentsByPost', run: () => blogCommentService.getCommentsByPost(BLOG_POST) },
    { name: 'blogCommentService.countCommentsByPost', run: () => blogCommentService.countCommentsByPost(BLOG_POST) },
    { name: 'blogCommentService.countCommentsByPostBatch', run: () => blogCommentService.countCommentsByPostBatch([BLOG_POST, ident(44)]) },
    { name: 'blogCommentService.getCommentsOnMyPosts', run: () => blogCommentService.getCommentsOnMyPosts(ME, SINCE) },
    { name: 'blogFollowService.isFollowingBlog', run: () => blogFollowService.isFollowingBlog(ME, BLOG) },
    { name: 'blogFollowService.getFollowedBlogs', run: () => blogFollowService.getFollowedBlogs(ME) },
    { name: 'blogFollowService.getBlogFollowers', run: () => blogFollowService.getBlogFollowers(BLOG) },
    { name: 'blogFollowService.countBlogFollowers', run: () => blogFollowService.countBlogFollowers(BLOG) },
    { name: 'blogStatsService.mostFollowedBlogs', run: () => blogStatsService.mostFollowedBlogs(20) },
    { name: 'blogStatsService.trendingBlogs', run: () => blogStatsService.trendingBlogs(20) },
    { name: 'blogStatsService.mostDiscussedPosts', run: () => blogStatsService.mostDiscussedPosts(20) },
    // ---- storefront ----
    { name: 'storeService.getByOwner', run: () => storeService.getByOwner(OTHER) },
    { name: 'storeService.getById', run: () => storeService.getById(STORE) },
    { name: 'storeService.getNewestActiveStores', run: () => storeService.getNewestActiveStores(50) },
    { name: 'storeService.getNewestActiveStoresInCategory', run: () => storeService.getNewestActiveStoresInCategory('art', 50) },
    { name: 'storeService.hasStore', run: () => storeService.hasStore(OTHER) },
    { name: 'storeItemService.getById', run: () => storeItemService.getById(ITEM) },
    { name: 'storeItemService.getManyFresh', run: () => storeItemService.getManyFresh([ITEM, ident(54)]) },
    { name: 'storeItemService.getManyOrThrow', run: () => storeItemService.getManyOrThrow([ITEM]) },
    { name: 'storeItemService.getByStore', run: () => storeItemService.getByStore(STORE, { limit: 20 }) },
    { name: 'storeItemService.getByStore (active)', run: () => storeItemService.getByStore(STORE, { limit: 20, activeOnly: true }) },
    { name: 'storeItemService.getAllByStore', run: () => storeItemService.getAllByStore(STORE) },
    { name: 'shippingZoneService.getByStore', run: () => shippingZoneService.getByStore(STORE) },
    { name: 'storeOrderService.getBuyerOrders', run: () => storeOrderService.getBuyerOrders(ME, { limit: 20 }) },
    { name: 'storeOrderService.getSellerOrders', run: () => storeOrderService.getSellerOrders(OTHER, { limit: 20 }) },
    { name: 'storeOrderService.getStoreOrders', run: () => storeOrderService.getStoreOrders(STORE, { limit: 20 }) },
    { name: 'storeReviewService.getStoreReviews', run: () => storeReviewService.getStoreReviews(STORE, { limit: 20 }) },
    { name: 'storeReviewService.getOrderReviews', run: () => storeReviewService.getOrderReviews([ORDER]) },
    { name: 'itemReviewService.getItemReviews', run: () => itemReviewService.getItemReviews(ITEM, { limit: 20 }) },
    { name: 'itemDeliverableService.getForItems', run: () => itemDeliverableService.getForItems([ITEM]) },
    { name: 'orderDeliveryService.getForOrders', run: () => orderDeliveryService.getForOrders([ORDER]) },
    { name: 'orderDeliveryService.getForBuyer', run: () => orderDeliveryService.getForBuyer(ME) },
    { name: 'savedAddressService.getForUser', run: () => savedAddressService.getForUser(ME) },
    { name: 'orderStatusService.getLatestStatuses', run: () => orderStatusService.getLatestStatuses([ORDER, ident(56)]) },
    { name: 'orderStatusService.getLatestStatus', run: () => orderStatusService.getLatestStatus(ORDER) },
    { name: 'storeStatsService.getStoreRatingSummary', run: () => storeStatsService.getStoreRatingSummary(STORE) },
    { name: 'storeStatsService.getStoreRatingSummaries', run: () => storeStatsService.getStoreRatingSummaries([STORE, ident(55)]) },
    { name: 'storeStatsService.getItemRatingSummary', run: () => storeStatsService.getItemRatingSummary(ITEM, STORE) },
    { name: 'storeStatsService.getItemReviewCounts', run: () => storeStatsService.getItemReviewCounts([ITEM], STORE) },
    { name: 'storeStatsService.topRatedStores', run: () => storeStatsService.topRatedStores(20) },
    { name: 'storeStatsService.mostOrderedStores', run: () => storeStatsService.mostOrderedStores(20) },
    { name: 'storeStatsService.topStoreCategories', run: () => storeStatsService.topStoreCategories(20) },
    { name: 'storeStatsService.topItemsInStore', run: () => storeStatsService.topItemsInStore(STORE, 100) },
    { name: 'storeStatsService.loadBuyerOrdersComposite', run: () => storeStatsService.loadBuyerOrdersComposite(ME, 50) },
    { name: 'storeStatsService.countSellerOrders', run: () => storeStatsService.countSellerOrders(OTHER, STORE) },
    { name: 'storeNotificationService.getNotifications', run: () => storeNotificationService.getNotifications(ME, SINCE, ignore) },
    // ---- pollr ----
    { name: 'pollrPollService.getPoll', run: () => pollrPollService.getPoll(POLL) },
    { name: 'pollrPollService.countBallots', run: () => pollrPollService.countBallots(POLL) },
    { name: 'pollrVoteService.getBallotState', run: () => pollrVoteService.getBallotState(poll, ME) },
    { name: 'pollrVoteService.getMyBallot', run: () => pollrVoteService.getMyBallot(poll, ME) },
    { name: 'pollrVoteService.getTally', run: () => pollrVoteService.getTally(poll) },
    // ---- DM v5 ----
    { name: 'SdkDmChain.messagesByTags', run: () => dm.messagesByTags([handle]) },
    { name: 'SdkDmChain.invitesSince', run: () => dm.invitesSince([1, 2], SINCE) },
    { name: 'SdkDmChain.invitesNewestFirst', run: () => dm.invitesNewestFirst(1, null) },
    { name: 'SdkDmChain.groupDocs', run: () => dm.groupDocs(bs58.decode(OTHER), [handle]) },
    { name: 'SdkDmChain.selfState', run: () => dm.selfState() },
  ]
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

function judge(contract: ModelContract, request: CapturedRequest): Verdict | 'unknownDoctype' {
  const type = contract.get(request.documentTypeName)
  if (!type) return 'unknownDoctype'
  switch (request.surface) {
    case 'documents':
      return checkDocumentsQuery(type, request)
    case 'compositePage':
      return checkCompositePage(type, { ...request, subQueryCount: request.subQueryCount ?? 0 })
    case 'get':
      return type.indexOnly
        ? { servable: false, reason: 'indexOnly documents cannot be fetched by id', closestIndex: null }
        : { servable: true, route: 'primaryKey', index: null }
    case 'count':
      return checkCountQuery(type, request)
    case 'ranked':
      return checkRankedQuery(type, {
        groupBy: request.rankedGroupBy ?? '',
        limit: request.limit,
        aggregate: request.aggregate ?? { type: 'count' },
        where: request.where,
        timeRange: request.timeRange,
      })
    case 'average':
      return checkAverageQuery(type, { where: request.where, groupBy: request.groupBy, sumProperty: request.sumProperty ?? '' })
    case 'compositeSub':
      return checkCompositeSubQuery(type, request.subQuery ?? {}, request.pageAscending ?? true)
  }
}

/** A request's contract, doctype, surface, where fields with operators and ordering, values elided. */
function signature(contract: ContractKey, request: CapturedRequest): string {
  const where = (request.where ?? request.subQuery?.where ?? []).map(([field, operator]) => `${field} ${operator}`)
  const orderBy = (request.orderBy ?? request.subQuery?.orderBy ?? []).map(([field, direction]) => `${field} ${direction}`)
  const surface = request.surface === 'compositePage' ? 'documents' : request.surface
  return `${contract}.${request.documentTypeName} ${surface} | ${where.join(', ')} | ${orderBy.join(', ')}`
}

function render(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return `<${item.length} bytes>`
    if (typeof item === 'bigint') return item.toString()
    return item
  })
}

function describeRequest(contractKey: ContractKey, request: CapturedRequest): string {
  const parts = [`${contractKey}.${request.documentTypeName} ${request.surface}`, `where=${render(request.where ?? request.subQuery?.where ?? [])}`]
  const orderBy = request.orderBy ?? request.subQuery?.orderBy
  if (orderBy) parts.push(`orderBy=${render(orderBy)}`)
  if (request.groupBy) parts.push(`groupBy=${render(request.groupBy)}`)
  if (request.rankedGroupBy) parts.push(`rankedGroupBy=${request.rankedGroupBy} aggregate=${render(request.aggregate)}`)
  if (request.timeRange) parts.push(`timeRange=${render(request.timeRange)}`)
  if (request.subQuery) parts.push(`sub=${render({ kind: request.subQuery.kind, bind: request.subQuery.bind, limit: request.subQuery.limit })}`)
  if (request.startAfter || request.startAt) parts.push('(cursor)')
  return parts.join(' ')
}

interface Judged {
  reader: string
  contract: ContractKey
  request: CapturedRequest
  verdict: Verdict | 'unknownDoctype'
}

function failureLine(entry: Judged): string {
  const head = `[${entry.reader}] ${describeRequest(entry.contract, entry.request)}`
  if (entry.verdict === 'unknownDoctype') return `${head}\n    → doctype "${entry.request.documentTypeName}" is not in the ${entry.contract} contract`
  if (entry.verdict.servable) return head
  return `${head}\n    → ${entry.verdict.reason}\n    closest index: ${entry.verdict.closestIndex ?? '(none)'}`
}

describe('client query shapes on the v17 release cut', () => {
  const judged: Judged[] = []
  const skippedContracts = new Set<string>()
  const silentReaders: string[] = []

  beforeAll(async () => {
    for (const reader of await readers()) {
      const before = capture.requests.length
      await capture.drive(reader.name, reader.run)
      if (capture.requests.length === before) silentReaders.push(reader.name)
    }
    // Every request is judged (limits, operands and windows can change a
    // verdict); only identical failure lines are de-duplicated below.
    for (const request of capture.requests) {
      const contract = CONTRACT_BY_ID.get(request.dataContractId)
      if (!contract) {
        skippedContracts.add(`${request.dataContractId}.${request.documentTypeName}`)
        continue
      }
      judged.push({ reader: request.reader, contract, request, verdict: judge(MODELS[contract], request) })
    }
  }, 120_000)

  const refused = () => judged.filter((entry) => entry.verdict === 'unknownDoctype' || !entry.verdict.servable)
  const allowlisted = (entry: Judged) => entry.contract === 'social' &&
    PRIVATE_FEED_ALLOWLIST.some(({ docType, reader }) => docType === entry.request.documentTypeName && reader === entry.reader)
  const pending = (entry: Judged) => PENDING_BUILDER_FIXES.some((fix) => fix.signature === signature(entry.contract, entry.request))

  it('drives every listed reader to at least one request, with no read failing', () => {
    const errors = capture.failures.map(({ reader, error }) => `${reader}: ${error instanceof Error ? error.message : String(error)}`)
    // A reader that swallows a failed read logs it: such a read was never captured.
    const swallowed = capture.logged
      .filter(({ message }) => !BENIGN_LOGS.some((benign) => benign.test(message)))
      .map(({ reader, level, message }) => `${reader} (${level}): ${message}`)
    expect({ silentReaders, errors, swallowed }).toEqual({ silentReaders: [], errors: [], swallowed: [] })
  })

  it('captures reads on every judged contract', () => {
    const contracts = new Set(judged.map((entry) => entry.contract))
    expect([...contracts].sort()).toEqual((Object.keys(CONTRACT_IDS) as ContractKey[]).sort())
  })

  it('serves every captured request through an index of its contract', () => {
    const failures = refused().filter((entry) => !allowlisted(entry) && !pending(entry)).map(failureLine)
    expect([...new Set(failures)]).toEqual([])
  })

  it('still refuses every allowlisted private-feed read (docs/SOCIAL_V17.md); a stale entry must go', () => {
    const refusedEntries = refused().filter(allowlisted)
    const stale = PRIVATE_FEED_ALLOWLIST.filter(({ docType, reader }) =>
      !refusedEntries.some((entry) => entry.request.documentTypeName === docType && entry.reader === reader))
    expect(stale).toEqual([])
  })

  it('still refuses every pending builder fix; a fixed one must leave PENDING_BUILDER_FIXES', () => {
    const refusedSignatures = new Set(refused().map((entry) => signature(entry.contract, entry.request)))
    expect(PENDING_BUILDER_FIXES.filter((fix) => !refusedSignatures.has(fix.signature)).map((fix) => fix.fix)).toEqual([])
  })
})

describe('the spec bites', () => {
  const unpinnedTimeline = { where: [['$createdAt', '>', 0]] as const, orderBy: [['$createdAt', 'desc']] as const }

  it('reports an unpinned timeline read unservable on v17 but servable on v16', () => {
    const v17 = parseContract(socialV17).get('post')
    const v16 = parseContract(socialV16).get('post')
    if (!v17 || !v16) throw new Error('post doctype missing')
    const onV17 = checkDocumentsQuery(v17, unpinnedTimeline)
    expect(onV17.servable).toBe(false)
    expect(onV17.servable ? null : onV17.closestIndex).toContain('timeline [live, $createdAt]')
    expect(checkDocumentsQuery(v16, unpinnedTimeline)).toEqual({ servable: true, route: 'index', index: 'timeline [$createdAt]' })
    expect(checkDocumentsQuery(v17, { ...unpinnedTimeline, where: [['live', '==', true], ['$createdAt', '>', 0]] }))
      .toEqual({ servable: true, route: 'index', index: 'timeline [live, $createdAt]' })
  })
})
