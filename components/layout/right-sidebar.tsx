'use client'

import { useEffect, useState } from 'react'
import { PoweredByDash } from '@/components/brand/brand'
import { SearchInput } from '@/components/search/search-input'
import { TrendingHashtags } from './trending-hashtags'

/** The right column: 300px (350px from `xl`), sticky, shown from `lg` up. */
export function RightSidebar() {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setVisible(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  // CSS hiding alone still mounts the data loaders on small screens.
  if (!visible) return null

  return (
    <div className="hidden lg:block w-[300px] xl:w-[350px] shrink-0 px-4 py-4 space-y-4 h-screen sticky top-0 overflow-y-auto scrollbar-hide">
      <SearchInput />
      <TrendingHashtags />

      <div className="px-4 py-3 flex justify-center">
        <PoweredByDash />
      </div>
    </div>
  )
}
