'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useAppStore } from '@/lib/store'
import { useNotificationStore } from '@/lib/stores/notification-store'
import {
  HomeIcon,
  MagnifyingGlassIcon,
  EnvelopeIcon,
  PlusIcon,
  Bars3Icon,
  XMarkIcon,
  BuildingStorefrontIcon,
  BellIcon,
  BookmarkIcon,
  UserIcon,
  Cog6ToothIcon,
  UserGroupIcon,
  UsersIcon,
  ArrowRightOnRectangleIcon,
} from '@heroicons/react/24/outline'
import {
  HomeIcon as HomeIconSolid,
  MagnifyingGlassIcon as SearchIconSolid,
  EnvelopeIcon as EnvelopeIconSolid,
} from '@heroicons/react/24/solid'
import { cn } from '@/lib/utils'
import { useLoginModal } from '@/hooks/use-login-modal'
import { useKeyboardVisible } from '@/hooks/use-keyboard-visible'

export function MobileBottomNav() {
  const pathname = usePathname()
  const { user, logout } = useAuth()
  const { setComposeOpen } = useAppStore()
  const openLoginModal = useLoginModal((s) => s.open)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [isHydrated, setIsHydrated] = useState(false)
  const unreadNotificationCount = useNotificationStore((s) => s.getUnreadCount())
  const isKeyboardVisible = useKeyboardVisible()

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Close menu on route change
  useEffect(() => {
    setMoreMenuOpen(false)
  }, [pathname])

  // Close more menu when keyboard opens
  useEffect(() => {
    if (isKeyboardVisible) {
      setMoreMenuOpen(false)
    }
  }, [isKeyboardVisible])

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
  ]

  // More menu items - Store first for prominence, then user-specific items
  const moreMenuItems = [
    { name: 'Store', href: '/store', icon: BuildingStorefrontIcon },
    ...(user ? [
      { name: 'Profile', href: `/user?id=${user.identityId}`, icon: UserIcon },
      { name: 'Notifications', href: '/notifications', icon: BellIcon, badge: isHydrated && unreadNotificationCount > 0 ? unreadNotificationCount : undefined },
      { name: 'Following', href: '/following', icon: UserGroupIcon },
      { name: 'Followers', href: '/followers', icon: UsersIcon },
      { name: 'Bookmarks', href: '/bookmarks', icon: BookmarkIcon },
      { name: 'Settings', href: '/settings', icon: Cog6ToothIcon },
    ] : []),
  ]

  const isMoreActive = moreMenuItems.some(item => pathname === item.href || pathname.startsWith(item.href + '/')) || pathname.startsWith('/store')

  return (
    <>
      {/* Overlay */}
      {moreMenuOpen && !isKeyboardVisible && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMoreMenuOpen(false)}
        />
      )}

      {/* More Menu Sheet - completely unmounted when keyboard is visible */}
      {!isKeyboardVisible && (
      <div className={cn(
        "fixed bottom-14 left-0 right-0 z-40 md:hidden bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-gray-800 rounded-t-2xl shadow-lg transition-transform duration-300 ease-out safe-area-inset-bottom",
        moreMenuOpen ? "translate-y-0" : "translate-y-full pointer-events-none"
      )}>
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Menu</h3>
            <button
              onClick={() => setMoreMenuOpen(false)}
              className="p-2 -mr-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {moreMenuItems.map((item) => {
              const isActive = pathname === item.href
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setMoreMenuOpen(false)}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-xl transition-colors",
                    isActive
                      ? "bg-yappr-500/10 text-yappr-500"
                      : "hover:bg-gray-100 dark:hover:bg-gray-800"
                  )}
                >
                  <div className="relative">
                    <item.icon className="h-6 w-6" />
                    {item.badge !== undefined && (
                      <span className="absolute -top-1 -right-2 min-w-[18px] h-[18px] px-1 bg-yappr-500 text-white text-[10px] font-medium rounded-full flex items-center justify-center">
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    )}
                  </div>
                  <span className="text-xs mt-1 text-center">{item.name}</span>
                </Link>
              )
            })}
          </div>

          {user && (
            <>
              <div className="border-t border-gray-200 dark:border-gray-800 mt-4 pt-4">
                <button
                  onClick={() => {
                    setMoreMenuOpen(false)
                    logout()
                  }}
                  className="flex items-center gap-3 w-full p-3 rounded-xl text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
                >
                  <ArrowRightOnRectangleIcon className="h-5 w-5" />
                  <span className="text-sm font-medium">Log out</span>
                </button>
              </div>
            </>
          )}

          {!user && (
            <div className="border-t border-gray-200 dark:border-gray-800 mt-4 pt-4">
              <button
                onClick={() => {
                  setMoreMenuOpen(false)
                  openLoginModal()
                }}
                className="flex items-center justify-center w-full p-3 rounded-xl bg-yappr-500 text-white font-medium hover:bg-yappr-600 transition-colors"
              >
                Sign In
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Bottom Navigation Bar */}
      <nav className={cn(
        "fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-gray-800 safe-area-inset-bottom transition-transform duration-200 ease-out",
        isKeyboardVisible && "translate-y-full"
      )}>
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
            <button
              onClick={openLoginModal}
              className="flex items-center justify-center -mt-4 h-14 w-14 rounded-full bg-yappr-500 text-white shadow-yappr-lg active:scale-95 transition-transform"
            >
              <PlusIcon className="h-7 w-7" />
            </button>
          )}

          {/* Messages */}
          {navItems.slice(2, 3).map((item) => {
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

          {/* More Button */}
          <button
            onClick={() => setMoreMenuOpen(!moreMenuOpen)}
            className="flex-1 flex items-center justify-center h-full relative"
          >
            <Bars3Icon className={cn(
              "h-7 w-7",
              (moreMenuOpen || isMoreActive) ? "text-black dark:text-white" : "text-gray-500"
            )} />
            {isHydrated && unreadNotificationCount > 0 && !moreMenuOpen && (
              <span className="absolute top-2 right-1/4 w-2 h-2 bg-yappr-500 rounded-full" />
            )}
          </button>
        </div>
      </nav>
    </>
  )
}
