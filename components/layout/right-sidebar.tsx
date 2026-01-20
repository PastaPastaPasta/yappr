'use client'

import Link from 'next/link'
import Image from 'next/image'
import { SearchInput } from '@/components/search/search-input'
import { useAuth } from '@/contexts/auth-context'
import { FeedStats } from './feed-stats'

export function RightSidebar() {
  const { user } = useAuth()

  return (
    <div className="hidden lg:block w-[350px] shrink-0 px-4 py-4 space-y-4 h-[calc(100vh-40px)] sticky top-[40px] overflow-y-auto scrollbar-hide">
      <SearchInput />
      <div className="bg-gray-50 dark:bg-gray-950 rounded-2xl overflow-hidden">
        <h2 className="text-xl font-bold px-4 py-3">Getting Started</h2>
        <div className="px-4 py-3 space-y-3 text-sm">
          <p className="text-gray-600 dark:text-gray-400">
            Welcome to Yappr! Here&apos;s what you can do:
          </p>
          <ul className="space-y-2">
            <li>
              <Link href={user?.identityId ? `/user?id=${user.identityId}&edit=true` : '/settings?section=account'} className="text-yappr-500 hover:text-yappr-600 dark:hover:text-yappr-400 hover:underline">
                • Create your profile
              </Link>
            </li>
            <li>
              <Link href="/feed" className="text-yappr-500 hover:text-yappr-600 dark:hover:text-yappr-400 hover:underline">
                • Share your first post
              </Link>
            </li>
            <li>
              <Link href="/explore" className="text-yappr-500 hover:text-yappr-600 dark:hover:text-yappr-400 hover:underline">
                • Explore and follow users
              </Link>
            </li>
          </ul>
        </div>
      </div>

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

      <div className="px-4 py-2 text-xs text-gray-500 space-x-2">
        <Link href="/terms" className="hover:underline">Terms</Link>
        <Link href="/privacy" className="hover:underline">Privacy</Link>
        <Link href="/cookies" className="hover:underline">Cookies</Link>
        <Link href="/about" className="hover:underline">About</Link>
      </div>
    </div>
  )
}