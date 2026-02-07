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
      <div className="bg-surface-100 dark:bg-surface-800 rounded-2xl overflow-hidden border border-surface-200 dark:border-neutral-750">
        <h2 className="text-lg font-bold px-4 py-3 text-gray-900 dark:text-gray-100">Getting Started</h2>
        <div className="px-4 py-3 space-y-3 text-sm">
          <p className="text-gray-500 dark:text-gray-400 leading-relaxed">
            Welcome to Yappr! Here&apos;s what you can do:
          </p>
          <ul className="space-y-2.5">
            <li>
              <Link href={user?.identityId ? `/user?id=${user.identityId}&edit=true` : '/settings?section=account'} className="text-yappr-500 hover:text-yappr-600 dark:text-yappr-400 dark:hover:text-yappr-300 hover:underline transition-colors">
                Create your profile
              </Link>
            </li>
            <li>
              <Link href="/feed" className="text-yappr-500 hover:text-yappr-600 dark:text-yappr-400 dark:hover:text-yappr-300 hover:underline transition-colors">
                Share your first post
              </Link>
            </li>
            <li>
              <Link href="/explore" className="text-yappr-500 hover:text-yappr-600 dark:text-yappr-400 dark:hover:text-yappr-300 hover:underline transition-colors">
                Explore and follow users
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

      <div className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500 space-x-3 text-center">
        <Link href="/terms" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">Terms</Link>
        <Link href="/privacy" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">Privacy</Link>
        <Link href="/cookies" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">Cookies</Link>
        <Link href="/about" className="hover:text-gray-600 dark:hover:text-gray-300 transition-colors">About</Link>
      </div>
    </div>
  )
}
