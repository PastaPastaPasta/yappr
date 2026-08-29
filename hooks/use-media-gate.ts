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
 * `isFollowingHint` is the caller's live follow state and takes precedence
 * outright; the cache is consulted only when there is no hint (quoted and
 * embedded cards, which have no follow hook of their own). Deciding it the
 * other way round would let a cache entry that has gone stale re-open the gate
 * on an author the viewer has since unfollowed.
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

  const isFollowedAuthor = isFollowingHint ?? getFollowStatus(`${viewerId}:${authorId}`)
  return { gated: isFollowedAuthor !== true, reveal }
}
