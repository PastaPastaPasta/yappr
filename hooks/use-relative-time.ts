import { useEffect, useMemo, useState } from 'react'
import { formatTime } from '@/lib/utils'

type RelativeTimeInput = Date | string

const MAX_RELATIVE_AGE_SECONDS = 7 * 24 * 60 * 60

function getNextUpdateDelayMs(dateMs: number, nowMs: number): number | null {
  const elapsedSeconds = Math.floor((nowMs - dateMs) / 1000)

  if (elapsedSeconds < 0) {
    return 1000
  }

  if (elapsedSeconds < 60) {
    return 1000
  }

  if (elapsedSeconds < 60 * 60) {
    return (60 - (elapsedSeconds % 60)) * 1000
  }

  if (elapsedSeconds < 24 * 60 * 60) {
    return (60 * 60 - (elapsedSeconds % (60 * 60))) * 1000
  }

  if (elapsedSeconds < MAX_RELATIVE_AGE_SECONDS) {
    return (24 * 60 * 60 - (elapsedSeconds % (24 * 60 * 60))) * 1000
  }

  return null
}

/**
 * Returns a live relative time label (e.g. "4 seconds ago", "2 minutes ago")
 * with adaptive updates for recent timestamps.
 */
export function useRelativeTime(date: RelativeTimeInput): string {
  const [_tick, setTick] = useState(0)

  const dateMs = useMemo(() => {
    const parsed = typeof date === 'string' ? new Date(date) : date
    return parsed.getTime()
  }, [date])

  useEffect(() => {
    if (!Number.isFinite(dateMs)) {
      return
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const scheduleNextUpdate = () => {
      const delay = getNextUpdateDelayMs(dateMs, Date.now())
      if (delay == null) {
        return
      }

      timeoutId = setTimeout(() => {
        setTick((prev) => prev + 1)
        scheduleNextUpdate()
      }, delay)
    }

    scheduleNextUpdate()

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [dateMs])

  if (!Number.isFinite(dateMs)) {
    return ''
  }

  return formatTime(new Date(dateMs))
}
