/**
 * Starting 1:1 conversations (docs/DM_V5.md §4.3, §5.1, §5.5).
 *
 * Opening a chat with someone new creates a draft: nothing is written until
 * the first send. Then the one invite is written (unless a conversation with
 * that person already exists, in which case no invite is written) and the
 * self-state is saved immediately, so the user's other devices find the
 * conversation.
 */

import { weekOf } from '@/lib/dm/kdf'
import type { IdentityId } from '@/lib/dm/types'
import type { DirectConv } from './conversation'
import { attachDirect, directConv, isMe, requirePeerKey, type DmContext } from './context'
import { sendInvite } from './invites'

/** Open (or find) the 1:1 with `peer` without writing anything. */
export async function openDirect(ctx: DmContext, peer: IdentityId): Promise<DirectConv> {
  if (isMe(ctx, peer)) throw new Error("You can't message yourself")
  const existing = directConv(ctx, peer)
  if (existing) return existing
  await requirePeerKey(ctx, peer)
  const now = ctx.chain.now()
  const saved = ctx.store.findDirect(peer)
  return attachDirect(ctx, saved ?? { peer, since: weekOf(now), readAt: now, hiddenAt: 0 }, !saved)
}

/**
 * Make sure the 1:1 exists on chain before its first message: one invite if
 * no conversation with the peer is known yet, then an immediate self-state
 * save. Known conversations (including one found from the peer's own invite)
 * write nothing.
 */
export async function ensureStarted(ctx: DmContext, conv: DirectConv, options: { save?: boolean } = {}): Promise<void> {
  if (!conv.draft) return
  if (!ctx.store.findDirect(conv.peer)) {
    await sendInvite(ctx, conv.peer)
    ctx.store.addDirect(conv.entry)
  }
  conv.entry = ctx.store.resolve(conv.entry)
  conv.draft = false
  // Saved at once so the user's other devices find it (§5.5); a batch caller saves once at the end.
  if (options.save !== false) await ctx.store.flush()
}

/** The 1:1 with `peer`, started on chain (used for group grants). */
export async function startedDirect(ctx: DmContext, peer: IdentityId): Promise<DirectConv> {
  const conv = await openDirect(ctx, peer)
  await ensureStarted(ctx, conv)
  return conv
}
