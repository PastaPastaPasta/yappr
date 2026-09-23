/**
 * Accepting `0x05` group grants (docs/DM_V5.md §6.2). A grant is accepted
 * only if it came on the counterpart's 1:1 stream (the poller only queues
 * those) and the roster that counterpart owns at `roster(gid)` opens with the
 * granted key, or one derived from it by ratchet or a newer keyring, and
 * lists me. So only the real owner can add me, and a forwarded key adds me to
 * nothing.
 *
 * The owner writes the grant first and replaces the roster right after, so a
 * grant whose roster does not open yet is kept and re-checked for the stale
 * window before it is dropped.
 */

import { checkGrant } from '@/lib/dm/grant'
import { weekOf } from '@/lib/dm/kdf'
import { epochBefore } from '@/lib/dm/keys'
import type { GroupConversation } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import { newGroupConv } from './conversation'
import { groupConv, type DmContext, type PendingGrant } from './context'
import { applyGroups } from './group-apply'
import { STALE_WINDOW_MS } from './util'

/** Reasons a later poll can change: the roster replace has not landed yet. */
const TRANSIENT = new Set(['roster-unreadable', 'stale-roster'])

async function processGrant(ctx: DmContext, grant: PendingGrant): Promise<'done' | 'retry'> {
  if (ctx.store.isBlocked(grant.from)) return 'done'
  const existing = groupConv(ctx, grant.from, grant.gid)
  const epoch = { b: grant.b, r: grant.r }
  if (existing && !existing.removed && !existing.unreadable && existing.keys.get(epoch)) return 'done'

  const entry: GroupConversation = {
    gid: grant.gid,
    owner: grant.from,
    earliestEpoch: epoch,
    earliestKey: grant.key,
    since: weekOf(grant.createdAt),
    // A group joined while recovering lost state starts as read (§9).
    readAt: ctx.recovering ? ctx.chain.now() : 0,
    hiddenAt: 0,
  }
  const probe = newGroupConv(entry)
  await applyGroups(ctx, [probe])
  const roster = probe.lastRoster
  const verdict = checkGrant({
    grant,
    streamSender: grant.from,
    rosterOwner: grant.from,
    roster: roster ? { content: roster, key: probe.keys.get(roster) ?? grant.key } : null,
    memberId: ctx.me.id,
  })
  if (!verdict.accepted) {
    if (TRANSIENT.has(verdict.reason) && ctx.chain.now() - grant.firstSeen < STALE_WINDOW_MS) return 'retry'
    logger.debug(`DM v5: grant rejected (${verdict.reason})`)
    return 'done'
  }

  if (existing) {
    // A resend, or a re-add after removal: take the key and start reading again.
    const wasCutOff = existing.removed || existing.unreadable
    existing.keys.set(epoch, grant.key)
    existing.removed = false
    existing.unreadable = false
    if (epochBefore(epoch, existing.entry.earliestEpoch)) {
      ctx.store.replaceGroupEntry(existing.entry, { ...existing.entry, earliestEpoch: epoch, earliestKey: grant.key, since: Math.min(existing.entry.since, entry.since) })
    } else if (wasCutOff) {
      // The saved key cannot reach this epoch (a keyring in between has no slot for me): keep the
      // re-add key instead, or a reload would find me removed again. History from before the gap
      // stays readable in this session only.
      ctx.store.replaceGroupEntry(existing.entry, { ...existing.entry, earliestEpoch: epoch, earliestKey: grant.key, since: entry.since })
    }
    await applyGroups(ctx, [existing])
    await saveJoin(ctx)
    return 'done'
  }

  ctx.store.addGroup(entry)
  probe.entry = ctx.store.resolve(entry)
  ctx.convs.set(probe.key, probe)
  await saveJoin(ctx)
  return 'done'
}

/**
 * A join (or a re-add key) is saved at once, unlike an incoming 1:1 (§5.5):
 * an invite is permanent and every scan finds it again, but a grant sits in a
 * 1:1 stream the sweep deletes, and after a reload it is not accepted again
 * once the roster has moved on (a removal lists the member no more). Recovery
 * saves everything together at its end instead.
 */
async function saveJoin(ctx: DmContext): Promise<void> {
  if (ctx.recovering) return
  await ctx.store.flush()
}

/** Check every queued grant once. */
export async function processGrants(ctx: DmContext): Promise<void> {
  for (const [id, grant] of Array.from(ctx.pendingGrants.entries())) {
    try {
      if ((await processGrant(ctx, grant)) === 'done') ctx.pendingGrants.delete(id)
    } catch (error) {
      logger.warn('DM v5: checking a grant failed:', error)
    }
  }
}
