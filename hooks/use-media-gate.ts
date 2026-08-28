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
 * Deliberately synchronous: reads only the enrichment hint and the shared
 * follow-status cache, never issuing a network query (a feed of gated cards
 * must not fan out per-author follow lookups). While follow status is unknown
 * the author is treated as not followed — the gate lifts when enrichment
 * resolves and re-renders the card. Logged-out users have no follow graph, so
 * everything is gated for them unless the setting is off.
 */
export function useMediaGate(authorId: string, isFollowingHint?: boolean): MediaGate {
  const gateEnabled = useSettingsStore((s) => s.gateMediaFromNonFollowed)
  const { user } = useAuth()
  const [revealed, setRevealed] = useState(false)

  const reveal = useCallback(() => setRevealed(true), [])

  if (!gateEnabled || revealed) {
    return { gated: false, reveal }
  }

  const viewerId = user?.identityId
  const isOwnMedia = !!viewerId && viewerId === authorId
  const isFollowedAuthor =
    !!viewerId && (isFollowingHint === true || getFollowStatus(`${viewerId}:${authorId}`) === true)

  return { gated: !isOwnMedia && !isFollowedAuthor, reveal }
}
