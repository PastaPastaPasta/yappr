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
 *   consensus only accepts if the reply is theirs. That reply renders with the
 *   amount it carried.
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
    if (!provedTipsAvailable() || !replyKey) return
    let active = true
    provedTipService
      .getTipsForReplies(replyKey.split(','))
      .then((loaded) => { if (active) setReplyTips(loaded) })
      .catch((error) => logger.warn('useThreadTips: could not load tips on replies', error))
    return () => { active = false }
  }, [replyKey])

  return useMemo(() => {
    const badges = new Map<string, TipBadge>()

    const badgeFor = (postId: string): TipBadge => {
      const existing = badges.get(postId)
      if (existing) return existing
      const created: TipBadge = {}
      badges.set(postId, created)
      return created
    }

    for (const tip of [...tips, ...[...replyTips.values()].flat()]) {
      if (!tip.messageReplyId) continue
      const badge = badgeFor(tip.messageReplyId)
      badge.sentAmount = (badge.sentAmount ?? BigInt(0)) + tip.amount
    }

    for (const [replyId, received] of replyTips) {
      if (received.length === 0) continue
      const badge = badgeFor(replyId)
      badge.receivedAmount = received.reduce((sum, tip) => sum + tip.amount, BigInt(0))
      badge.receivedCount = received.length
    }

    return (postId: string) => badges.get(postId)
  }, [tips, replyTips])
}
