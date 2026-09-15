'use client'

import Link from 'next/link'
import Image from 'next/image'
import { SearchInput } from '@/components/search/search-input'
import { FeedStats } from './feed-stats'
import { TrendingHashtags } from './trending-hashtags'

export function RightSidebar() {
  return (
    <div className="hidden lg:block w-[350px] shrink-0 px-4 py-4 space-y-4 h-[calc(100vh-40px)] sticky top-[40px] overflow-y-auto scrollbar-hide">
      <SearchInput />
      <TrendingHashtags />

      <FeedStats />

      <div className="px-4 py-3 flex justify-center">
        <a
          href="https://github.com/dashpay/platform"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            src="/pbde-light.png"
            alt="Powered by Dash Evolution"
            width={140}
            height={47}
            className="dark:hidden"
            style={{ width: 'auto', height: 'auto' }}
          />
          <Image
            src="/pbde-dark.png"
            alt="Powered by Dash Evolution"
            width={140}
            height={47}
            className="hidden dark:block"
            style={{ width: 'auto', height: 'auto' }}
          />
        </a>
      </div>

      <div className="px-4 py-2 text-xs text-gray-500 space-x-2 text-center">
        <Link href="/terms" className="hover:underline">Terms</Link>
        <Link href="/privacy" className="hover:underline">Privacy</Link>
        <Link href="/cookies" className="hover:underline">Cookies</Link>
        <Link href="/about" className="hover:underline">About</Link>
      </div>
    </div>
  )
}