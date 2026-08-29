'use client'

import { useState, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { getFollowStatus } from '@/lib/caches/user-status-cache'

export interface MediaGate {
  /** True when the author's media must not be fetched and a placeholder shows instead */
  gated: boolean
  /** Reveal the media for this card (per-mount; covers all media of the post) */
  reveal: () => void
}

/**
 * Decide whether media from an author should be fetched, based on follow status.
 *
 * Deliberately synchronous: reads only the caller's hint and the shared
 * follow-status cache, never issuing a network query (a feed of gated cards
 * must not fan out per-author follow lookups). While follow status is unknown
 * the author is treated as not followed — the gate lifts when the answer
 * arrives and re-renders the card. Logged-out users have no follow graph, so
 * everything is gated for them unless the setting is off.
 *
 * The shared cache is consulted FIRST and the caller's hint is only a fallback,
 * because the cache is the one place every follow change lands: `useFollow`
 * writes it on the optimistic toggle and again on rollback, so it is never
 * staler than any single hook's state — whereas a hint can be. A card seeded
 * from batch enrichment keeps its `initialValue` for its whole lifetime
 * (`useFollow` skips re-checking when one was supplied), so unfollowing an
 * author from one card leaves every OTHER mounted card for that author holding
 * a stale `true`. Reading the cache first re-gates all of them, and any card
 * mounting afterwards, instead of only the one whose button was clicked.
 * The hint still covers the gaps the cache cannot fill: an entry past its TTL,
 * or one cleared by `refresh()` mid-refetch.
 */
export function useMediaGate(authorId: string, isFollowingHint?: boolean): MediaGate {
  const gateEnabled = useSettingsStore((s) => s.gateMediaFromNonFollowed)
  const { user } = useAuth()
  const [revealed, setRevealed] = useState(false)

  const reveal = useCallback(() => setRevealed(true), [])

  const viewerId = user?.identityId
  if (!gateEnabled || revealed) return { gated: false, reveal }
  if (!viewerId) return { gated: true, reveal }
  if (viewerId === authorId) return { gated: false, reveal }

  const isFollowedAuthor = getFollowStatus(`${viewerId}:${authorId}`) ?? isFollowingHint
  return { gated: isFollowedAuthor !== true, reveal }
}
