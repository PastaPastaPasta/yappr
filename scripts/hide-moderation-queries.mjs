/**
 * The reads the "hide, don't delete" release set (social v18, blog v10,
 * storefront v11; docs/SOCIAL_V18.md) is cut to serve, as data: yap.pr's
 * default lane, every lane an archive or "uncensored" frontend merges, and the
 * moderation log. One catalogue feeds both checks, so the two cannot drift:
 *
 *   - `lib/contract-query-conformance.test.ts` judges each request against the
 *     committed files with the port of Drive's index selection;
 *   - `scripts/prove-v18-moderation.mjs` runs each one, proved, against
 *     throwaway copies of the same files on sakura.
 *
 * Lanes. `live` is 1 (listed) or 2 (written while its author was restricted);
 * `mod` is absent (listed, read as `mod == null`), 1 (hidden) or 2 (legal
 * hold). yap.pr reads `live == 1, mod == null` only. An archive reads each
 * (`live`, `mod`) lane with the same order and its own `startAfter` cursor and
 * k-way merges the pages; a count is the sum of the lanes. The moderation log
 * reads `mod == 1` and `mod == 2` on each type's `moderated [mod,
 * $moderatedAt]`, the restrictions' `log [state, $moderatedAt]`, and the
 * warning list through `sdk.contracts.moderationEntries` (not a document query).
 *
 * Each entry: `{ id, contract, docType, kind, purpose, lanes?, request(v) }`.
 * `kind` is documents | count | ranked | average; `purpose` default | archive | log.
 * `request(v)` builds the SDK request body (without `dataContractId` and
 * `documentTypeName`) from sample values `v` (base58 ids `author`, `me`, `post`,
 * `reply`, `blog`, `blogPost`, `store`, `item`, `target`; a stored `tag`) and, for a
 * laned entry, the lane in `v.live` / `v.mod` / `v.state`. No network, no keys.
 */

const MOD_VALUES = [null, 1, 2];
/** Every (`live`, `mod`) lane of a listing keyed on both. */
export const LIVE_MOD_LANES = Object.freeze([1, 2].flatMap((live) => MOD_VALUES.map((mod) => Object.freeze({ live, mod }))));
/** Every `mod` lane of a listing without `live`. */
export const MOD_LANES = Object.freeze(MOD_VALUES.map((mod) => Object.freeze({ mod })));
/** The moderation log's lanes: hidden and legal hold. */
export const LOG_LANES = Object.freeze([1, 2].map((mod) => Object.freeze({ mod })));
/** A restriction in force (1) and a lifted one (2). */
export const RESTRICTION_LANES = Object.freeze([1, 2].map((state) => Object.freeze({ state })));

const lane = (v) => [['live', '==', v.live], ['mod', '==', v.mod]];
const desc = (field) => [[field, 'desc']];
/** The like trend windows, as the client reads them (lib/services/ranked-likes.ts `windowClause`). */
const POST_WINDOW = { field: '$createdAt', selector: 'newest', grid: { range: 259200, step: 86400 } };
const TAG_WINDOW = { field: '$createdAt', selector: 'newest', grid: { range: 86400, step: 21600 } };

const entry = (contract, docType, kind, purpose, id, request, lanes) => ({ id, contract, docType, kind, purpose, request, ...(lanes ? { lanes } : {}) });

/** Social v18 (`contracts/yappr-social-contract-v18.json`). */
const SOCIAL = [
  // ---- yap.pr's default lane, and the same shape per lane for an archive ----
  entry('social', 'post', 'documents', 'archive', 'post.timeline (Recent)', (v) => ({ where: [...lane(v), ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), LIVE_MOD_LANES),
  entry('social', 'post', 'count', 'archive', 'post.timeline count (live posts)', (v) => ({ where: lane(v) }), LIVE_MOD_LANES),
  entry('social', 'post', 'documents', 'archive', 'post.tagAndTime (a tag page)', (v) => ({ where: [...lane(v), ['tags', 'contains', v.tag], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), LIVE_MOD_LANES),
  entry('social', 'post', 'documents', 'archive', 'post.ownerAndTime (an author\'s posts)', (v) => ({ where: [...lane(v), ['$ownerId', '==', v.author], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), LIVE_MOD_LANES),
  entry('social', 'post', 'count', 'archive', 'post.ownerAndTime count (an author\'s post count)', (v) => ({ where: [...lane(v), ['$ownerId', '==', v.author]] }), LIVE_MOD_LANES),
  entry('social', 'post', 'ranked', 'archive', 'post.ownerAndTime ranked at $ownerId (top authors by post count)', (v) => ({ where: lane(v), groupBy: '$ownerId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 }), LIVE_MOD_LANES),
  entry('social', 'post', 'documents', 'archive', 'post.mentionedUserAndTime (mentions of me)', (v) => ({ where: [['mentionedUserIds', 'contains', v.me], ['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('social', 'reply', 'documents', 'archive', 'reply.ownerAndTime (an author\'s replies)', (v) => ({ where: [...lane(v), ['$ownerId', '==', v.author], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), LIVE_MOD_LANES),
  entry('social', 'reply', 'documents', 'archive', 'reply.repliesOf (a thread page)', (v) => ({ where: [...lane(v), ['rootPostId', '==', v.post]], orderBy: [['replyToReplyId', 'asc'], ['$createdAt', 'asc']], limit: 50 }), LIVE_MOD_LANES),
  entry('social', 'reply', 'documents', 'archive', 'reply.repliesOf (direct replies, replyToReplyId == null)', (v) => ({ where: [...lane(v), ['rootPostId', '==', v.post], ['replyToReplyId', '==', null]], orderBy: [['$createdAt', 'asc']], limit: 50 }), LIVE_MOD_LANES),
  entry('social', 'reply', 'documents', 'archive', 'reply.repliesOf (a reply\'s children)', (v) => ({ where: [...lane(v), ['rootPostId', '==', v.post], ['replyToReplyId', '==', v.reply]], orderBy: [['$createdAt', 'asc']], limit: 50 }), LIVE_MOD_LANES),
  entry('social', 'reply', 'count', 'archive', 'reply.repliesOf count (a thread\'s replies)', (v) => ({ where: [...lane(v), ['rootPostId', '==', v.post]] }), LIVE_MOD_LANES),
  entry('social', 'reply', 'count', 'archive', 'reply.repliesOf count (direct replies, two null pins)', (v) => ({ where: [...lane(v), ['rootPostId', '==', v.post], ['replyToReplyId', '==', null]] }), LIVE_MOD_LANES),
  entry('social', 'reply', 'count', 'archive', 'reply.repliesOf grouped count (several threads)', (v) => ({ where: [...lane(v), ['rootPostId', 'in', [v.post, v.reply]]], groupBy: ['rootPostId'] }), LIVE_MOD_LANES),
  entry('social', 'reply', 'ranked', 'archive', 'reply.repliesOf ranked at rootPostId (most replied)', (v) => ({ where: lane(v), groupBy: 'rootPostId', aggregate: { type: 'count' }, direction: 'desc', limit: 10 }), LIVE_MOD_LANES),
  entry('social', 'reply', 'documents', 'archive', 'reply.mentionedUserAndTime (reply mentions of me)', (v) => ({ where: [['mentionedUserIds', 'contains', v.me], ['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  // ---- likes: trending reads pin the post's lane (postLive), not mod (a like cannot read it) ----
  entry('social', 'like', 'ranked', 'archive', 'like.byTrendPost (trending posts, 72h)', (v) => ({ where: [['postLive', '==', v.live]], groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 10, timeRange: [POST_WINDOW] }), [{ live: 1 }, { live: 2 }]),
  entry('social', 'like', 'ranked', 'archive', 'like.byTrendHashtagPost (trending tags, 24h)', (v) => ({ where: [['postLive', '==', v.live]], groupBy: 'tags', aggregate: { type: 'count' }, direction: 'desc', limit: 12, timeRange: [TAG_WINDOW] }), [{ live: 1 }, { live: 2 }]),
  entry('social', 'like', 'ranked', 'archive', 'like.byTrendHashtagPost (top in a tag, 24h)', (v) => ({ where: [['postLive', '==', v.live], ['tags', 'contains', v.tag]], groupBy: 'postId', aggregate: { type: 'count' }, direction: 'desc', limit: 10, timeRange: [TAG_WINDOW] }), [{ live: 1 }, { live: 2 }]),
  // ---- the moderation log ----
  entry('social', 'post', 'documents', 'log', 'post.moderated (hidden posts, newest action first)', (v) => ({ where: [['mod', '==', v.mod], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), LOG_LANES),
  entry('social', 'reply', 'documents', 'log', 'reply.moderated', (v) => ({ where: [['mod', '==', v.mod], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), LOG_LANES),
  entry('social', 'yapprProfile', 'documents', 'log', 'yapprProfile.moderated', (v) => ({ where: [['mod', '==', v.mod], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), LOG_LANES),
  entry('social', 'restriction', 'documents', 'log', 'restriction.log (restrictions in force / lifted, newest action first)', (v) => ({ where: [['state', '==', v.state], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), RESTRICTION_LANES),
  entry('social', 'restriction', 'documents', 'default', 'restriction.byTarget (my standing, before a compose)', (v) => ({ where: [['target', '==', v.target]], limit: 1 })),
  entry('social', 'report', 'documents', 'log', 'report.byModerator (reports one moderator resolved)', (v) => ({ where: [['$moderatedBy', '==', v.me], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 })),
];

/** Blog v10 (`contracts/yappr-blog-contract-v10.json`). */
const BLOG = [
  entry('blog', 'blog', 'documents', 'archive', 'blog.timeline (newest blogs)', (v) => ({ where: [['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('blog', 'blogPost', 'documents', 'archive', 'blogPost.timeline (latest posts)', (v) => ({ where: [...lane(v), ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), LIVE_MOD_LANES),
  entry('blog', 'blogPost', 'documents', 'archive', 'blogPost.blogAndTime (a blog\'s posts)', (v) => ({ where: [...lane(v), ['blogId', '==', v.blog], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), LIVE_MOD_LANES),
  entry('blog', 'blogComment', 'documents', 'archive', 'blogComment.postAndTime (a post\'s comments)', (v) => ({ where: [['blogPostId', '==', v.blogPost], ['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('blog', 'blogComment', 'count', 'archive', 'blogComment.postAndTime count (a post\'s comment count)', (v) => ({ where: [['blogPostId', '==', v.blogPost], ['mod', '==', v.mod]] }), MOD_LANES),
  entry('blog', 'blog', 'documents', 'log', 'blog.moderated', (v) => ({ where: [['mod', '==', v.mod], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), LOG_LANES),
  entry('blog', 'blogPost', 'documents', 'log', 'blogPost.moderated', (v) => ({ where: [['mod', '==', v.mod], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), LOG_LANES),
  entry('blog', 'blogComment', 'documents', 'log', 'blogComment.moderated', (v) => ({ where: [['mod', '==', v.mod], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), LOG_LANES),
  entry('blog', 'restriction', 'documents', 'log', 'restriction.log (blog)', (v) => ({ where: [['state', '==', v.state], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), RESTRICTION_LANES),
];

/** Storefront v11 (`contracts/yappr-storefront-contract-v11.json`). */
const STOREFRONT = [
  entry('storefront', 'store', 'documents', 'archive', 'store.byStatus (newest active stores)', (v) => ({ where: [['status', '==', 'active'], ['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('storefront', 'store', 'documents', 'archive', 'store.byCategory (a category\'s stores)', (v) => ({ where: [['status', '==', 'active'], ['mod', '==', v.mod], ['category', '==', 'other'], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('storefront', 'store', 'ranked', 'archive', 'store.byCategory ranked at category (top categories)', (v) => ({ where: [['status', '==', 'active'], ['mod', '==', v.mod]], groupBy: 'category', aggregate: { type: 'count' }, direction: 'desc', limit: 10 }), MOD_LANES),
  entry('storefront', 'storeItem', 'documents', 'archive', 'storeItem.storeAndTime (a store\'s items)', (v) => ({ where: [['storeId', '==', v.store], ['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('storefront', 'storeItem', 'documents', 'archive', 'storeItem.storeStatusAndTime (a store\'s active items)', (v) => ({ where: [['storeId', '==', v.store], ['mod', '==', v.mod], ['status', '==', 'active'], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('storefront', 'storeReview', 'documents', 'archive', 'storeReview.storeReviews (a store\'s reviews)', (v) => ({ where: [['storeId', '==', v.store], ['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('storefront', 'storeReview', 'average', 'archive', 'storeReview.storeRating (a store\'s average rating)', (v) => ({ where: [['mod', '==', v.mod], ['storeId', '==', v.store]], sumProperty: 'rating' }), MOD_LANES),
  entry('storefront', 'storeReview', 'ranked', 'archive', 'storeReview.storeRating ranked (top rated stores)', (v) => ({ where: [['mod', '==', v.mod]], groupBy: 'storeId', aggregate: { type: 'avg', property: 'rating' }, direction: 'desc', limit: 10 }), MOD_LANES),
  entry('storefront', 'storeReview', 'count', 'archive', 'storeReview.storeRatingDistribution (stars histogram)', (v) => ({ where: [['storeId', '==', v.store], ['mod', '==', v.mod], ['rating', 'in', [1, 2, 3, 4, 5]]], groupBy: ['rating'] }), MOD_LANES),
  entry('storefront', 'itemReview', 'documents', 'archive', 'itemReview.itemReviews (an item\'s reviews)', (v) => ({ where: [['itemId', '==', v.item], ['mod', '==', v.mod], ['$createdAt', '>', 0]], orderBy: desc('$createdAt'), limit: 20 }), MOD_LANES),
  entry('storefront', 'itemReview', 'average', 'archive', 'itemReview.storeItemRating (an item\'s average rating)', (v) => ({ where: [['mod', '==', v.mod], ['storeId', '==', v.store], ['itemId', '==', v.item]], sumProperty: 'rating' }), MOD_LANES),
  entry('storefront', 'itemReview', 'ranked', 'archive', 'itemReview.storeItemRating ranked (top items in a store)', (v) => ({ where: [['mod', '==', v.mod], ['storeId', '==', v.store]], groupBy: 'itemId', aggregate: { type: 'avg', property: 'rating' }, direction: 'desc', limit: 10 }), MOD_LANES),
  ...['store', 'storeItem', 'storeReview', 'itemReview'].map((docType) =>
    entry('storefront', docType, 'documents', 'log', `${docType}.moderated`, (v) => ({ where: [['mod', '==', v.mod], ['$moderatedAt', '>', 0]], orderBy: desc('$moderatedAt'), limit: 20 }), LOG_LANES)),
];

export const HIDE_MODERATION_QUERIES = Object.freeze([...SOCIAL, ...BLOG, ...STOREFRONT]);

/**
 * Every concrete request of the catalogue: one per lane of a laned entry (the
 * default lane first, so `[0]` of an archive entry is yap.pr's read), one for
 * an unlaned one. Each carries `lane` (null when unlaned) and `isDefault`
 * (what yap.pr itself sends).
 */
export function expandQueries(values, queries = HIDE_MODERATION_QUERIES) {
  return queries.flatMap((query) => {
    const lanes = query.lanes ?? [null];
    return lanes.map((laneValues) => {
      const v = { ...values, ...(laneValues ?? {}) };
      const isDefault = query.purpose === 'default'
        || (query.purpose === 'archive' && (laneValues?.live ?? 1) === 1 && (laneValues?.mod ?? null) === null);
      return { ...query, lane: laneValues, isDefault, body: query.request(v) };
    });
  });
}
