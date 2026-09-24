/** One pass of the §6.3 POLL, in the spec's order. */

import { retryPeerKeys, type DmContext } from './context'
import { processGrants } from './grants'
import { applyGroups } from './group-apply'
import { processLeaves, repairOwnedGroups } from './groups'
import { scanInvites } from './invites'
import { pollStreams } from './poller'
import { logger } from '@/lib/logger'

/**
 * Group documents first (so streams are polled on the current epoch), then
 * every stream, then the invite scan. Conversations found by the scan, and
 * groups joined through grants those streams carried, get their first poll in
 * the same pass. Leaves, then roster repairs of groups I own, are handled
 * last. The first pass after the app opens
 * also polls own streams.
 */
export async function pollOnce(ctx: DmContext): Promise<void> {
  await ctx.store.refresh().catch((error) => logger.debug('DM v5 self-state refresh failed:', error))
  await retryPeerKeys(ctx)
  await applyGroups(ctx)
  await pollStreams(ctx)
  let known = ctx.convs.size
  await scanInvites(ctx)
  if (ctx.convs.size !== known) await pollStreams(ctx)
  known = ctx.convs.size
  await processGrants(ctx)
  if (ctx.convs.size !== known) await pollStreams(ctx)
  // One background owner attempt per group per poll: a group the leave step tried is not repaired again.
  const tried = new Set<string>()
  await processLeaves(ctx, tried)
  await repairOwnedGroups(ctx, tried)
  ctx.appJustOpened = false
  for (const conv of Array.from(ctx.convs.values())) conv.probeOwn = false
}
