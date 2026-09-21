'use client'

import { useEffect, useMemo, useState } from 'react'
import { logger } from '@/lib/logger'
import { provedTipService, type ProvedTip } from '@/lib/services/proved-tip-service'
import { provedTipsAvailable, type TargetKind } from '@/lib/contract-topology'
import type { TipBadge } from '@/components/post/post-card'

/**
 * The proved tips a thread needs to render, keyed by the reply they belong to.
 *
 * Two kinds of tip show up against a reply:
 *
 * - **Sent with it.** A tipper who wanted to say something posts an ordinary
 *   reply and names it in their tip document (`messageReplyId`), which
 *   consensus only accepts if the reply is theirs — it does NOT check that the
 *   two concern the same thread, so a badge here means "this reply's author
 *   also sent these tips", and it is only ever built from tips loaded for THIS
 *   thread.
 * - **Received by it.** Someone tipped the reply itself — a `tipReply`
 *   document, whose payee consensus pinned to the reply's author.
 *
 * Tips on replies are fetched by asking about the reply ids the thread is
 * already showing, so a tip can never be displayed against something the reader
 * cannot see. There is deliberately no "tips in this thread" index: a tip would
 * have to assert which thread it belonged to, and nothing on chain could check
 * that assertion.
 */
export function useThreadTips(
  target: { id: string; kind: TargetKind } | null,
  replyIds: string[]
): (postId: string) => TipBadge | undefined {
  const [tips, setTips] = useState<ProvedTip[]>([])
  const [replyTips, setReplyTips] = useState<Map<string, ProvedTip[]>>(new Map())

  const targetId = target?.id ?? null
  const targetKind = target?.kind ?? null
  // Stable across re-renders that reshuffle the same thread, so loading more
  // replies refetches and a re-assembly of the same set does not.
  const replyKey = useMemo(() => [...replyIds].sort().join(','), [replyIds])
  const sortedReplyIds = useMemo(() => (replyKey ? replyKey.split(',') : []), [replyKey])

  useEffect(() => {
    if (!provedTipsAvailable() || !targetId || !targetKind) return
    let active = true
    provedTipService
      .getTipsFor(targetKind, targetId)
      .then((loaded) => { if (active) setTips(loaded) })
      .catch((error) => logger.warn('useThreadTips: could not load tips on the root', error))
    return () => { active = false }
  }, [targetId, targetKind])

  useEffect(() => {
    if (!provedTipsAvailable() || sortedReplyIds.length === 0) return
    let active = true
    provedTipService
      .getTipsForReplies(sortedReplyIds)
      .then((loaded) => { if (active) setReplyTips(loaded) })
      .catch((error) => logger.warn('useThreadTips: could not load tips on replies', error))
    return () => { active = false }
  }, [sortedReplyIds])

  return useMemo(() => {
    const badges = new Map<string, TipBadge>()

    // A reply named as a tip's message can carry more than one (two people can
    // both tip the same words), so this side accumulates.
    for (const tip of [...tips, ...[...replyTips.values()].flat()]) {
      if (!tip.messageReplyId) continue
      const badge = badges.get(tip.messageReplyId) ?? {}
      badges.set(tip.messageReplyId, { ...badge, sentAmount: (badge.sentAmount ?? BigInt(0)) + tip.amount })
    }

    for (const [replyId, received] of replyTips) {
      if (received.length === 0) continue
      badges.set(replyId, {
        ...badges.get(replyId),
        received: { amount: received.reduce((sum, tip) => sum + tip.amount, BigInt(0)), count: received.length },
      })
    }

    return (postId: string) => badges.get(postId)
  }, [tips, replyTips])
}
