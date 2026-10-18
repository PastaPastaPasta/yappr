'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { loadMove, moveProgress, subscribeMove, type MoveJob } from '@/lib/services/private-feed-move-job'

/** This device's unfinished follower move for `ownerId`, live, with its progress; null when there is none. */
export function usePrivateFeedMove(ownerId: string | undefined): { job: MoveJob; done: number; total: number } | null {
  const snapshot = useCallback(() => (ownerId ? JSON.stringify(loadMove(ownerId)) : 'null'), [ownerId])
  const raw = useSyncExternalStore(subscribeMove, snapshot, () => 'null')
  const job = JSON.parse(raw) as MoveJob | null
  return job ? { job, ...moveProgress(job) } : null
}
