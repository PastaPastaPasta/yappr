'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ModerationMarks } from '@/lib/moderation-view'
import type { ModeratorHideOutcome } from '@/hooks/use-moderator-hide-modal'

/**
 * A detail page's moderator marks, kept current after its own moderator
 * hides or unhides it (the read it came from still holds the old marks):
 * returns the marks to show and the `onChanged` to hand the moderator menu.
 * New marks from the page's own data replace the local ones.
 */
export function useLocalModeration(marks: ModerationMarks | null | undefined): [ModerationMarks | undefined, (outcome: ModeratorHideOutcome) => void] {
  const [local, setLocal] = useState<ModerationMarks | null | undefined>(undefined)
  useEffect(() => {
    setLocal(undefined)
  }, [marks])
  const apply = useCallback((outcome: ModeratorHideOutcome) => {
    if (outcome.moderation !== undefined) setLocal(outcome.moderation)
  }, [])
  return [local === undefined ? marks ?? undefined : local ?? undefined, apply]
}
