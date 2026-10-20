'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A tab panel that mounts the first time it is shown and then stays mounted,
 * only hidden while another tab is active. Switching back is instant: no
 * remount, no refetch, no skeleton. Media playing in it is paused when it is
 * hidden (display:none does not pause video or audio).
 */
export function KeptPanel({ active, children, testId }: { active: boolean; children: ReactNode; testId?: string }) {
  const [seen, setSeen] = useState(active)
  if (active && !seen) setSeen(true)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (active) return
    ref.current?.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => media.pause())
  }, [active])

  if (!seen) return null
  return (
    <div ref={ref} hidden={!active} data-testid={testId}>
      {children}
    </div>
  )
}
