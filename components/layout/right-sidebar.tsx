'use client'

import Link from 'next/link'
import Image from 'next/image'
import { SearchInput } from '@/components/search/search-input'
import { useAuth } from '@/contexts/auth-context'
import { FeedStats } from './feed-stats'

export function RightSidebar() {
  const { user } = useAuth()

  return (
    <div className="hidden lg:block w-[340px] shrink-0 px-4 py-4 space-y-4 h-[calc(100vh-40px)] sticky top-[40px] overflow-y-auto scrollbar-hide">
      <SearchInput />
      <div className="bg-zinc-50 dark:bg-zinc-900/50 rounded-2xl overflow-hidden border border-zinc-200/50 dark:border-zinc-800/30">
        <h2 className="text-base font-bold px-4 py-3 text-zinc-900 dark:text-zinc-100">Getting Started</h2>
        <div className="px-4 pb-4 space-y-2.5 text-sm">
          <p className="text-zinc-500 dark:text-zinc-400 text-[13px]">
            Welcome to Yappr! Here&apos;s what you can do:
          </p>
          <ul className="space-y-1.5">
            <li>
              <Link href={user?.identityId ? `/user?id=${user.identityId}&edit=true` : '/settings?section=account'} className="text-yappr-600 dark:text-yappr-400 hover:text-yappr-700 dark:hover:text-yappr-300 text-[13px] font-medium transition-colors">
                Create your profile
              </Link>
            </li>
            <li>
              <Link href="/feed" className="text-yappr-600 dark:text-yappr-400 hover:text-yappr-700 dark:hover:text-yappr-300 text-[13px] font-medium transition-colors">
                Share your first post
              </Link>
            </li>
            <li>
              <Link href="/explore" className="text-yappr-600 dark:text-yappr-400 hover:text-yappr-700 dark:hover:text-yappr-300 text-[13px] font-medium transition-colors">
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
          className="opacity-60 hover:opacity-100 transition-opacity"
        >
          <Image
            src="/pbde-light.png"
            alt="Powered by Dash Evolution"
            width={130}
            height={43}
            className="dark:hidden"
            style={{ width: 'auto', height: 'auto' }}
          />
          <Image
            src="/pbde-dark.png"
            alt="Powered by Dash Evolution"
            width={130}
            height={43}
            className="hidden dark:block"
            style={{ width: 'auto', height: 'auto' }}
          />
        </a>
      </div>

      <div className="px-4 py-2 text-xs text-zinc-400 dark:text-zinc-500 space-x-2.5 text-center">
        <Link href="/terms" className="hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">Terms</Link>
        <Link href="/privacy" className="hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">Privacy</Link>
        <Link href="/cookies" className="hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">Cookies</Link>
        <Link href="/about" className="hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">About</Link>
      </div>
    </div>
  )
}
