import { moderationService } from '@/lib/services/moderation-service';
import { chunk } from '@/lib/services/pagination-utils';
import { replyService } from '@/lib/services/reply-service';
import type { MissingParentReads } from './deleted-reply-stubs';
import { provenAbsent } from '@/lib/feed/prove-absent';

/** `documentRemovals` answers for at most this many document ids a read (`readRemovals`). */
const REMOVAL_READ_LIMIT = 100;

/**
 * What keeps the replies under a missing parent in a thread
 * (`withMissingReplyParents`), for every client that reads one (the web thread
 * page and the mobile engine):
 *
 * - the tombstoned parents a live-keyed `repliesOf` does not list, read by id,
 *   and the parents proved gone. Both reads reject, so a failed one fails the
 *   page instead of dropping the replies under it;
 * - where a removed reply's record keeps the reply it answered (v20), that
 *   parent, so its stub goes back under it. A failed record read answers
 *   nothing (`getRemovals`), which only leaves the stub at the top.
 */
export const missingReplyParentReads: MissingParentReads = {
  // Fresh, not cached: a parent tombstoned since it was cached must read as the tombstone.
  getMany: (ids) => replyService.getManyOrThrow(ids),
  provenAbsent: (ids) => provenAbsent('reply', ids, { throwOnError: true }),
  removedReplyParents: async (ids) => {
    const parents = new Map<string, string>();
    for (const batch of chunk(ids, REMOVAL_READ_LIMIT)) {
      for (const [id, removal] of await moderationService.getRemovals('reply', batch)) {
        if (removal.kept.replyToReplyId) parents.set(id, removal.kept.replyToReplyId);
      }
    }
    return parents;
  },
};
