'use client'

import { useEffect, useState } from 'react'

const ANNOUNCE_DELAY_MS = 150

/**
 * A polite status the loading view keeps mounted, so assistive technology
 * hears `label` when loading starts; the skeleton shown beside it stays
 * decorative (`aria-hidden`). The label arrives a moment after loading
 * starts, never in the same task as the region mounts, so a view that opens
 * already loading still changes a region that exists.
 */
export function LoadingAnnouncement({ loading, label }: { loading: boolean; label: string }) {
  const [announced, setAnnounced] = useState(false)
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setAnnounced(true), ANNOUNCE_DELAY_MS)
    return () => {
      clearTimeout(timer)
      setAnnounced(false)
    }
  }, [loading])
  return (
    <p role="status" className="sr-only">
      {loading && announced ? label : ''}
    </p>
  )
}
