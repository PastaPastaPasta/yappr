'use client'

import Image from 'next/image'
import { publicAsset } from '@/lib/public-asset'
import { useEffect, useState } from 'react'
import { SearchInput } from '@/components/search/search-input'
import { TrendingHashtags } from './trending-hashtags'

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
        <a
          href="https://github.com/dashpay/platform"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            src={publicAsset('/pbde-light.png')}
            alt="Powered by Dash Evolution"
            width={140}
            height={47}
            className="dark:hidden"
            style={{ width: 'auto', height: 'auto' }}
          />
          <Image
            src={publicAsset('/pbde-dark.png')}
            alt="Powered by Dash Evolution"
            width={140}
            height={47}
            className="hidden dark:block"
            style={{ width: 'auto', height: 'auto' }}
          />
        </a>
      </div>
    </div>
  )
}
