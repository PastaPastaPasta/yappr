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
  'safety.reportsOpen',
]);
const READ_MODULES = new Set(['feed', 'explore']);

export function methodKind(path: string): MethodKind {
  const module = path.slice(0, path.indexOf('.'));
  if (READS.has(path) || READ_MODULES.has(module)) return 'read';
  if (module === 'engine') return 'control';
  if (module === 'session') return 'session';
  return 'write';
}

/** Host-side deadline per call (ENGINE.md §4.5), counted from when it is sent to the engine. */
export function methodTimeoutMs(path: string): number {
  if (path === 'session.awaitKeyExchange') return 130_000;
  if (path === 'session.awaitKeyRegistration') return 310_000;
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
