'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useAppStore } from '@/lib/store'
import {
  HomeIcon,
  MagnifyingGlassIcon,
  EnvelopeIcon,
  UserIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import {
  HomeIcon as HomeIconSolid,
  MagnifyingGlassIcon as SearchIconSolid,
  EnvelopeIcon as EnvelopeIconSolid,
  UserIcon as UserIconSolid,
} from '@heroicons/react/24/solid'
import { cn } from '@/lib/utils'

export function MobileBottomNav() {
  const pathname = usePathname()
  const { user } = useAuth()
  const { setComposeOpen } = useAppStore()

  const navItems = [
    {
      name: 'Home',
      href: user ? '/feed' : '/',
      icon: HomeIcon,
      activeIcon: HomeIconSolid,
      match: (path: string) => path === '/feed' || path === '/'
    },
    {
      name: 'Explore',
      href: '/explore',
      icon: MagnifyingGlassIcon,
      activeIcon: SearchIconSolid,
      match: (path: string) => path === '/explore'
    },
    {
      name: 'Messages',
      href: '/messages',
      icon: EnvelopeIcon,
      activeIcon: EnvelopeIconSolid,
      match: (path: string) => path.startsWith('/messages')
    },
    {
      name: 'Profile',
      href: '/profile',
      icon: UserIcon,
      activeIcon: UserIconSolid,
      match: (path: string) => path === '/profile'
    },
  ]

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-black border-t border-gray-200 dark:border-gray-800 safe-area-inset-bottom">
      <div className="flex items-center justify-around h-14">
        {/* First two nav items */}
        {navItems.slice(0, 2).map((item) => {
          const isActive = item.match(pathname)
          const Icon = isActive ? item.activeIcon : item.icon
          return (
            <Link
              key={item.name}
              href={item.href}
              className="flex-1 flex items-center justify-center h-full"
            >
              <Icon className={cn(
                "h-7 w-7",
                isActive ? "text-black dark:text-white" : "text-gray-500"
              )} />
            </Link>
          )
        })}

        {/* Center Post Button (FAB style) */}
        {user ? (
          <button
            onClick={() => setComposeOpen(true)}
            className="flex items-center justify-center -mt-4 h-14 w-14 rounded-full bg-yappr-500 text-white shadow-yappr-lg active:scale-95 transition-transform"
          >
            <PlusIcon className="h-7 w-7" />
          </button>
        ) : (
          <Link
            href="/login"
            className="flex items-center justify-center -mt-4 h-14 w-14 rounded-full bg-yappr-500 text-white shadow-yappr-lg active:scale-95 transition-transform"
          >
            <PlusIcon className="h-7 w-7" />
          </Link>
        )}

        {/* Last two nav items */}
        {navItems.slice(2).map((item) => {
          const isActive = item.match(pathname)
          const Icon = isActive ? item.activeIcon : item.icon
          return (
            <Link
              key={item.name}
              href={item.href}
              className="flex-1 flex items-center justify-center h-full"
            >
              <Icon className={cn(
                "h-7 w-7",
                isActive ? "text-black dark:text-white" : "text-gray-500"
              )} />
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
