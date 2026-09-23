/**
 * `dmInvite`: first contact (docs/DM_V5.md §5.1).
 *
 * The scan asks for every invite in my three bucket levels created at or
 * after the scan cursor, in one `bucket in [...]` query ordered by
 * [bucket, $createdAt]. Results come back bucket by bucket, so every page is
 * read before the cursor moves, and invites already read at the cursor time
 * are skipped by id (several can share one block time). The saved cursor
 * never passes an invite whose conversation could not be saved
 * (`SelfStateStore.setScanCursor`).
 */

import { weekOf } from '@/lib/dm/kdf'
import { bucketLevels, createInvite, isInviteForMe } from '@/lib/dm/invite'
import type { IdentityId } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import { attachDirect, directConv, peerKey, type DmContext } from './context'
import type { ChainInvite } from './types'
import { hexId, runNow, type Exclusive } from './util'

/** Trial-decrypt one invite; the recipient is me when `check` verifies against its signed `$ownerId`. */
function inviteIsForMe(ctx: DmContext, invite: ChainInvite): boolean {
  return isInviteForMe(ctx.me.encPriv, invite, invite.ownerId)
}

/** A new 1:1 found from an invite: added unless blocked or already known. */
async function acceptInvite(ctx: DmContext, invite: ChainInvite): Promise<void> {
  const sender = invite.ownerId
  if (ctx.store.isBlocked(sender) || ctx.store.findDirect(sender)) return
  const entry = { peer: sender, since: weekOf(invite.createdAt), readAt: 0, hiddenAt: 0 }
  ctx.store.addDirect(entry, invite.createdAt)
  await attachDirect(ctx, ctx.store.resolve(entry))
}

/** One incremental scan (§6.3 POLL, invite lines). */
export async function scanInvites(ctx: DmContext): Promise<void> {
  const since = ctx.scanCursor
  const invites = await ctx.chain.invitesSince(bucketLevels(ctx.me.id), since)
  let newest = since
  const atNewest = new Set<string>()
  for (const invite of invites) {
    if (invite.createdAt < since) continue
    if (invite.createdAt === since && ctx.seenAtCursor.has(invite.id)) continue
    ctx.cache.recordInvite(invite.bucket, invite.createdAt, ctx.chain.now())
    if (inviteIsForMe(ctx, invite)) await acceptInvite(ctx, invite)
    if (invite.createdAt > newest) {
      newest = invite.createdAt
      atNewest.clear()
    }
    if (invite.createdAt === newest) atNewest.add(invite.id)
  }
  if (newest === since) {
    atNewest.forEach((id) => ctx.seenAtCursor.add(id))
    return
  }
  ctx.scanCursor = newest
  ctx.seenAtCursor = atNewest
  ctx.store.setScanCursor(newest)
}

/**
 * Write the one invite for a new 1:1 (§5.1): skipped when a conversation with
 * the peer already exists in the self-state or from their invite, so at most
 * one invite exists per started pair. The bucket level is the sender's own
 * estimate (§5.1.2); recipients scan every level.
 */
export async function sendInvite(ctx: DmContext, peer: IdentityId): Promise<void> {
  const peerPub = await peerKey(ctx, peer)
  if (!peerPub) throw new Error('This account has no encryption key yet, so it cannot receive encrypted messages.')
  const invite = createInvite({ recipientPublicKey: peerPub, recipientId: peer, senderId: ctx.me.id, bucketLevel: ctx.cache.bucketLevel() })
  const outcome = await ctx.chain.createInvite(invite)
  if (!outcome.ok) throw new Error(outcome.error)
}

/**
 * Lost-state recovery, step 1 (§9): rescan every invite ever sent to me,
 * newest first, level by level, so the most recent contacts reappear first;
 * `onProgress` reports invites read. Pages are fetched and trial-decrypted
 * outside `exclusive` (reads only); the conversations each page found are
 * added inside it, so a long rescan never holds up a send. Afterwards the
 * in-memory scan position moves to the newest invite read, so the regular
 * scan does not read them all again (the saved position follows once
 * recovery saves, §5.5).
 */
export async function rescanAllInvites(
  ctx: DmContext,
  onProgress: (read: number) => void,
  cancelled: () => boolean,
  exclusive: Exclusive = runNow
): Promise<void> {
  let read = 0
  let newest = ctx.scanCursor
  const atNewest = new Set<string>()
  for (const bucket of bucketLevels(ctx.me.id)) {
    let startAfter: string | null = null
    do {
      if (cancelled()) return
      const page = await ctx.chain.invitesNewestFirst(bucket, startAfter)
      for (const invite of page.docs) {
        if (invite.createdAt > newest) {
          newest = invite.createdAt
          atNewest.clear()
        }
        if (invite.createdAt === newest) atNewest.add(invite.id)
      }
      const mine = page.docs.filter((invite) => inviteIsForMe(ctx, invite))
      if (mine.length > 0) {
        await exclusive(async () => {
          for (const invite of mine) {
            try {
              await acceptInvite(ctx, invite)
              const conv = directConv(ctx, invite.ownerId)
              if (conv) conv.deepProbe = true
            } catch (error) {
              logger.warn(`DM v5 recovery: invite from ${hexId(invite.ownerId)} failed:`, error)
            }
          }
        })
      }
      read += page.docs.length
      onProgress(read)
      startAfter = page.next
    } while (startAfter)
  }
  if (newest > ctx.scanCursor) {
    ctx.scanCursor = newest
    ctx.seenAtCursor = atNewest
  }
}
