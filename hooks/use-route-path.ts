'use client'

import { usePathname } from 'next/navigation'

/**
 * The current route as the nav compares it: `/explore`, never `/explore/`.
 * The static export sets `trailingSlash`, so `usePathname()` reports
 * `/explore/` on a deployed build and `/explore` under `next dev`.
 */
export function useRoutePath(): string {
  const pathname = usePathname()
  return pathname.replace(/\/+$/, '') || '/'
}
