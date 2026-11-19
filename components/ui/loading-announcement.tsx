'use client'

import { useEffect, useState } from 'react'

/**
 * A polite status the loading view keeps mounted, so assistive technology
 * hears `label` when loading starts; the skeleton shown beside it stays
 * decorative (`aria-hidden`). It mounts empty and takes the label after, so
 * a view that opens already loading still changes a region that exists.
 */
export function LoadingAnnouncement({ loading, label }: { loading: boolean; label: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <p role="status" className="sr-only">
      {mounted && loading ? label : ''}
    </p>
  )
}
