/**
 * How the supervisor treats each engine method (ENGINE.md §3.4, §4.5).
 *
 * - `read`: replayed once on a fresh engine if the engine died mid-call.
 * - `write` / `session`: never replayed. A restart rejects them with
 *   ENGINE_RESTARTED; write tickets reconcile themselves on the next boot.
 * - `control`: engine plumbing (lifecycle, log level); never replayed.
 *
 * ENGINE §4.4 puts this table in `mobile/engine/src/protocol/methods.ts`,
 * shared with the engine. Until an engine PR adds it, the host keeps it, and
 * any path it does not know is treated as a write, so an unknown method is
 * never replayed by mistake.
 */
export type MethodKind = 'read' | 'write' | 'session' | 'control';

const READS = new Set([
  'engine.info',
  'posts.get',
  'posts.thread',
  'posts.engagements',
  'posts.engagementCounts',
  'posts.poll',
  'posts.mentionCandidates',
  'profiles.get',
  'profiles.posts',
  'profiles.batch',
  'profiles.avatarSvg',
  'graph.followers',
  'graph.following',
  'graph.status',
  'engage.stats',
  'writes.list',
  'writes.get',
  'settings.get',
  // Engine-local after the first load per account; a replayed poll only merges what arrived since its watermark.
  'notifications.list',
  'notifications.poll',
  'notifications.unreadCount',
  'safety.blocked',
  'safety.isBlocked',
  'safety.blockedBy',
  'safety.ownReport',
  'engage.bookmarks',
  // A proved read of an unconfirmed write: it can settle the ticket, which is the same whichever engine does it.
  'writes.check',
  // Engine-local snapshots of the DM backend (polling fills them); `open` and `markRead` are not reads.
  'dm.status',
  'dm.conversations',
  'dm.search',
  'dm.messages',
  'dm.createdGroup',
  // A poll now (pull to refresh, "Try again"): a fresh engine polls on its own, so a replay changes nothing.
  'dm.refresh',
  'safety.followedBlockLists',
  'safety.blockListChoices',
  'safety.reportsOpen',
  // Private feeds: reads (a replayed `read` may store keys it recovered, the same keys either engine would).
  'privateFeed.read',
  'privateFeed.access',
  'privateFeed.overview',
  'privateFeed.requests',
  'privateFeed.followers',
  'privateFeed.renewal',
  'privateFeed.replySource',
  // "Posting opens on <date>": a proved election read, the same whichever engine does it.
  'moderation.postingOpening',
  'dpns.registration',
  'dpns.check',
  // Blogs: reads only; every blog write is a ticket (`blogs.create`, `blogs.publish`, ...).
  'blogs.info',
  'blogs.discover',
  'blogs.latestPosts',
  'blogs.followed',
  'blogs.mine',
  'blogs.get',
  'blogs.posts',
  'blogs.post',
  'blogs.postBySlug',
  'blogs.comments',
  'blogs.followState',
  'blogs.myPosts',
  'blogs.reportsOpen',
  'blogs.ownReport',
  'blogs.publishAddressFree',
  'blogs.publishOutcome',
  'blogs.manage',
  'blogs.managePost',
]);
const READ_MODULES = new Set(['feed', 'explore']);
/**
 * The storefront's reads. Its writes (tickets, the cart, delivering and
 * saving delivery content) are never replayed.
 */
const STORE_READS = new Set([
  'store.discover', 'store.get', 'store.detail', 'store.items', 'store.item', 'store.reviews', 'store.itemReviews',
  'store.zones', 'store.mine', 'store.manage', 'store.checkout', 'store.paymentAmount', 'store.myOrders', 'store.sellerOrders', 'store.order',
  'store.deliveryPlan', 'store.kit', 'store.reviewsOpen', 'store.ownReport', 'cart.get',
]);
/**
 * Calls that run for minutes, never replayed: digital delivery reserves codes,
 * publishes and confirms; a kit save reconciles; opening a delivered file
 * downloads and decrypts it (a replay after it crashed the engine would only
 * crash it again). Its chunk reads (`store.deliveredFileChunk`) are quick and
 * hold no state a fresh engine has, so they keep the write deadline.
 */
const LONG_CALLS: Record<string, number> = { 'store.deliver': 180_000, 'store.deliverReady': 600_000, 'store.saveKit': 120_000, 'store.openDeliveredFile': 180_000 };

export function methodKind(path: string): MethodKind {
  const module = path.slice(0, path.indexOf('.'));
  if (READS.has(path) || STORE_READS.has(path) || READ_MODULES.has(module)) return 'read';
  if (module === 'engine') return 'control';
  if (module === 'session') return 'session';
  return 'write';
}

/** Host-side deadline per call (ENGINE.md §4.5), counted from when it is sent to the engine. */
export function methodTimeoutMs(path: string): number {
  if (path === 'session.awaitKeyExchange') return 130_000;
  if (path === 'session.awaitKeyRegistration') return 310_000;
  if (LONG_CALLS[path]) return LONG_CALLS[path];
  switch (methodKind(path)) {
    case 'read':
    case 'session':
      return 30_000;
    case 'write':
      return 15_000;
    case 'control':
      return 5_000;
  }
}
