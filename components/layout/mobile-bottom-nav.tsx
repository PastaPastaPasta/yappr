'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useRef, useCallback } from 'react'
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
  BookOpenIcon,
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
import * as Tooltip from '@radix-ui/react-tooltip'

export function MobileBottomNav() {
  const pathname = usePathname()
  const { user, logout } = useAuth()
  const { setComposeOpen } = useAppStore()
  const openLoginModal = useLoginModal((s) => s.open)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [isHydrated, setIsHydrated] = useState(false)
  const moreMenuButtonRef = useRef<HTMLButtonElement>(null)
  const closeMenuButtonRef = useRef<HTMLButtonElement>(null)
  const unreadNotificationCount = useNotificationStore((s) => s.getUnreadCount())
  // Refreshed by the Sidebar's poll: it is hidden with CSS on mobile, not
  // unmounted, so its effect is the single source of both badge counts.
  const unreadMessageCount = useNotificationStore((s) => s.dmUnreadCount)

  const closeMoreMenu = useCallback(() => {
    setMoreMenuOpen(false)
    moreMenuButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!moreMenuOpen) return

    closeMenuButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMoreMenu()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [moreMenuOpen, closeMoreMenu])

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Close menu on route change
  useEffect(() => {
    setMoreMenuOpen(false)
  }, [pathname])

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
    { name: 'Blog', href: '/blog', icon: BookOpenIcon },
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
      {moreMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={closeMoreMenu}
        />
      )}

      {/* More Menu Sheet */}
      {/* React 18 emits inert only as a string, while the DOM typings declare it boolean. */}
      <div id="mobile-more-menu" aria-hidden={!moreMenuOpen} inert={moreMenuOpen ? undefined : ('' as unknown as boolean)} className={cn(
        "fixed bottom-14 left-0 right-0 z-40 md:hidden bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-gray-800 rounded-t-2xl shadow-lg transition-transform duration-300 ease-out safe-area-inset-bottom",
        moreMenuOpen ? "translate-y-0" : "translate-y-full pointer-events-none"
      )}>
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Menu</h3>
            <button
              aria-label="Close menu"
              ref={closeMenuButtonRef}
              onClick={closeMoreMenu}
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
                    logout().catch((err) => logger.error('Logout failed:', err))
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

      {/* Bottom Navigation Bar */}
      <nav aria-label="Mobile navigation" className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-gray-800 safe-area-inset-bottom">
        <div className="flex items-center justify-around h-14">
          {/* First two nav items */}
          {navItems.slice(0, 2).map((item) => {
            const isActive = item.match(pathname)
            const Icon = isActive ? item.activeIcon : item.icon
            return (
              <Link
                key={item.name}
                href={item.href}
                aria-label={item.name}
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
              aria-label="Create post"
              onClick={() => setComposeOpen(true)}
              className="flex items-center justify-center -mt-4 h-14 w-14 rounded-full bg-yappr-500 text-white shadow-yappr-lg active:scale-95 transition-transform"
            >
              <PlusIcon className="h-7 w-7" />
            </button>
          ) : (
            <button
              aria-label="Sign in to post"
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
            const badgeCount = isHydrated && user ? unreadMessageCount : 0
            return (
              <Link
                key={item.name}
                href={item.href}
                aria-label={badgeCount > 0 ? `${item.name}, ${badgeCount} unread` : item.name}
                className="flex-1 flex items-center justify-center h-full"
              >
                <div className="relative">
                  <Icon className={cn(
                    "h-7 w-7",
                    isActive ? "text-black dark:text-white" : "text-gray-500"
                  )} />
                  {badgeCount > 0 && (
                    <span className="absolute -top-1 -right-2 min-w-[18px] h-[18px] px-1 bg-yappr-500 text-white text-[10px] font-medium rounded-full flex items-center justify-center">
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </div>
              </Link>
            )
          })}

          {/* More Button */}
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  aria-label="Menu"
                  aria-expanded={moreMenuOpen}
                  aria-controls="mobile-more-menu"
                  ref={moreMenuButtonRef}
                  onClick={() => moreMenuOpen ? closeMoreMenu() : setMoreMenuOpen(true)}
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
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="z-50 bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded" sideOffset={5}>
                  Menu
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
      </nav>
    </>
  )
}
