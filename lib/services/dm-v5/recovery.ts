/**
 * Lost-state recovery (docs/DM_V5.md §9). A device without a readable
 * self-state rebuilds what it can, in the background, with progress:
 *
 * 1. every incoming 1:1: rescan every invite ever sent to me, newest first;
 * 2. 1:1s I started: probe the pair's streams for everyone I follow or who
 *    follows me, the last 4 weeks first, then back to 52 weeks;
 * 3. groups I own: probe `gid_n` (§4.4);
 * 4. groups I am in: from grants in the recovered 1:1 streams (the normal
 *    grant path picks those up as the streams are read).
 *
 * Read positions are lost too, so recovered conversations start as read.
 */

import { bytesEqual } from '@/lib/bytes'
import { weekOf } from '@/lib/dm/kdf'
import { messageTag } from '@/lib/dm/stream'
import type { IdentityId } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import { newDirectConv, stream, type DirectConv } from './conversation'
import { attachDirect, curWeek, directConv, peerKey, type DmContext } from './context'
import { recoverOwnedGroups } from './groups'
import { rescanAllInvites } from './invites'
import { pollStreams } from './poller'
import { chunk } from '../pagination-utils'
import { MAX_LOOKBACK_WEEKS, TAGS_PER_QUERY, hexId, range, runNow, type Exclusive } from './util'

/** Weeks probed in the first contact pass; the rest follows in the background (§9.2). */
export const RECENT_WEEKS = 4

export type RecoveryPhase = 'invites' | 'contacts-recent' | 'groups' | 'contacts-older' | 'done'

export interface RecoveryProgress {
  phase: RecoveryPhase
  /** Units done and total in the current phase (invites read, contacts probed). */
  done: number
  total: number
  /** Conversations found so far. */
  found: number
}

/**
 * Probe the 1:1 streams with each contact over `weeks`: the peer's stream and
 * mine, at `j = 0` of each week (100 tags per query). Any hit means a
 * conversation existed; it is added and read from there.
 */
export async function probeContacts(
  ctx: DmContext,
  contacts: IdentityId[],
  weeks: number[],
  onProgress: (done: number) => void,
  cancelled: () => boolean,
  exclusive: Exclusive = runNow
): Promise<IdentityId[]> {
  const found: IdentityId[] = []
  const candidates: DirectConv[] = []
  for (const peer of contacts) {
    if (directConv(ctx, peer) || ctx.store.isBlocked(peer)) continue
    const key = await peerKey(ctx, peer).catch(() => null)
    if (!key) continue
    candidates.push(newDirectConv(ctx.me, { peer, since: 0, readAt: 0, hiddenAt: 0 }, key))
  }

  type Probe = { conv: DirectConv; sender: IdentityId; tag: Uint8Array }
  const probes: Probe[] = []
  for (const conv of candidates) {
    for (const sender of [conv.peer, ctx.me.id]) {
      const st = stream(conv, sender, { b: 0, r: 0 })
      if (!st) continue
      for (const w of weeks) probes.push({ conv, sender, tag: messageTag(st.key, w, 0) })
    }
  }

  const hitConvs = new Set<DirectConv>()
  let done = 0
  for (const batch of chunk(probes, TAGS_PER_QUERY)) {
    if (cancelled()) break
    const byTag = new Map(batch.map((p) => [hexId(p.tag), p]))
    const docs = await ctx.chain.messagesByTags(batch.map((p) => p.tag))
    for (const doc of docs) {
      const probe = byTag.get(hexId(doc.tag))
      // Only the stream's sender counts (§6.1).
      if (probe && bytesEqual(doc.ownerId, probe.sender)) hitConvs.add(probe.conv)
    }
    done += batch.length
    onProgress(Math.round((done / Math.max(1, probes.length)) * candidates.length))
  }

  // The chat may be older than the weeks that hit: start at the lookback limit and let `prev` find the rest.
  const since = Math.max(0, weekOf(ctx.chain.now()) - MAX_LOOKBACK_WEEKS)
  await exclusive(async () => {
    for (const conv of Array.from(hitConvs)) {
      if (directConv(ctx, conv.peer)) continue
      const entry = { peer: conv.peer, since, readAt: ctx.chain.now(), hiddenAt: 0 }
      ctx.store.addDirect(entry)
      const attached = await attachDirect(ctx, ctx.store.resolve(entry))
      attached.deepProbe = true
      attached.probeOwn = true
      found.push(conv.peer)
    }
  })
  return found
}

/**
 * Run the whole recovery. Reads run outside the engine's queue and only the
 * steps that change state run on it (`exclusive`), so a long rescan never
 * blocks a send (§9: "in the background"). Each phase ends with a stream poll,
 * so recovered conversations show up as they are found; `onProgress` drives
 * the progress indicator.
 */
export async function recoverLostState(
  ctx: DmContext,
  exclusive: Exclusive,
  onProgress: (progress: RecoveryProgress) => void,
  cancelled: () => boolean
): Promise<void> {
  const found = () => ctx.convs.size
  const phase = async (name: RecoveryPhase, total: number, task: (report: (done: number) => void) => Promise<unknown>) => {
    if (cancelled()) return false
    onProgress({ phase: name, done: 0, total, found: found() })
    await task((done) => onProgress({ phase: name, done, total, found: found() }))
    await exclusive(() => pollStreams(ctx))
    return !cancelled()
  }
  ctx.recovering = true
  try {
    const ok = await phase('invites', 0, async (report) => {
      await rescanAllInvites(ctx, report, cancelled, exclusive)
      // Read positions are lost too: recovered conversations start as read (§9).
      await exclusive(async () => {
        for (const entry of ctx.store.directs()) ctx.store.touch(entry, { readAt: ctx.chain.now() })
      })
    })
    if (!ok) return
    const contacts = await ctx.chain.contacts()
    const cw = curWeek(ctx)
    const probe = (weeks: number[]) => (report: (done: number) => void) => probeContacts(ctx, contacts, weeks, report, cancelled, exclusive)
    if (!(await phase('contacts-recent', contacts.length, probe(range(cw - RECENT_WEEKS + 1, cw))))) return
    if (!(await phase('groups', 0, () => exclusive(() => recoverOwnedGroups(ctx))))) return
    if (!(await phase('contacts-older', contacts.length, probe(range(Math.max(0, cw - MAX_LOOKBACK_WEEKS), cw - RECENT_WEEKS))))) return
    // Everything found is saved together with the scan position (§5.5).
    await exclusive(async () => {
      ctx.store.setScanCursor(Math.max(ctx.store.state.inviteScanCursor, ctx.scanCursor))
      ctx.store.markDirty()
      await ctx.store.flush()
    })
  } catch (error) {
    logger.warn('DM v5 recovery failed:', error)
  } finally {
    ctx.recovering = false
    onProgress({ phase: 'done', done: 0, total: 0, found: found() })
  }
}
