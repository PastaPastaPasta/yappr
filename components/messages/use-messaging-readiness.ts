'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'

/** What the readiness check needs from the DM engine. */
export interface ReadinessSource {
  canMessage(peerId: string): Promise<boolean | null>
}

/** A failed lookup is retried this soon; a "not set up" answer is re-checked less often. */
const RETRY_FAILED_MS = 5_000
const RECHECK_NOT_SET_UP_MS = 30_000

/**
 * Whether `peerId` can be messaged, for a thread with no v5 conversation to
 * say so: true or false once known, undefined while nothing is known yet.
 * While the thread is selected, a lookup that fails is retried and a "not set
 * up" answer re-checked, keeping the last known answer meanwhile; it stops at
 * the first "yes". Answers are kept per person across reopening.
 */
export function useMessagingReadiness(source: ReadinessSource | null, peerId: string | null, intervals = { failed: RETRY_FAILED_MS, notSetUp: RECHECK_NOT_SET_UP_MS }): boolean | undefined {
  const [known, setKnown] = useState<ReadonlyMap<string, boolean>>(new Map())
  const { failed, notSetUp } = intervals
  useEffect(() => {
    if (!source || !peerId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      source.canMessage(peerId)
        .then((reachable) => {
          if (cancelled) return
          if (reachable !== null) setKnown((current) => current.get(peerId) === reachable ? current : new Map(current).set(peerId, reachable))
          if (reachable !== true) timer = setTimeout(check, reachable === null ? failed : notSetUp)
        })
        .catch((error) => {
          logger.warn('Could not check whether this person can be messaged:', error)
          if (!cancelled) timer = setTimeout(check, failed)
        })
    }
    check()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, peerId, failed, notSetUp])
  return peerId ? known.get(peerId) : undefined
}
