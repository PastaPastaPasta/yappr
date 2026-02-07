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

export function MobileBottomNav() {
  const pathname = usePathname()
  const { user, logout } = useAuth()
  const { setComposeOpen } = useAppStore()
  const openLoginModal = useLoginModal((s) => s.open)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [isHydrated, setIsHydrated] = useState(false)
  const unreadNotificationCount = useNotificationStore((s) => s.getUnreadCount())

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
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setMoreMenuOpen(false)}
        />
      )}

      {/* More Menu Sheet */}
      <div className={cn(
        "fixed bottom-14 left-0 right-0 z-40 md:hidden bg-white dark:bg-zinc-900 border-t border-zinc-200/50 dark:border-zinc-800/50 rounded-t-2xl shadow-surface-lg transition-transform duration-300 ease-out safe-area-inset-bottom",
        moreMenuOpen ? "translate-y-0" : "translate-y-full pointer-events-none"
      )}>
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Menu</h3>
            <button
              onClick={() => setMoreMenuOpen(false)}
              className="p-2 -mr-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors"
            >
              <XMarkIcon className="h-5 w-5 text-zinc-500" />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {moreMenuItems.map((item) => {
              const isActive = pathname === item.href
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setMoreMenuOpen(false)}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-xl transition-all duration-200",
                    isActive
                      ? "bg-yappr-500/10 text-yappr-600 dark:text-yappr-400"
                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
                  )}
                >
                  <div className="relative">
                    <item.icon className="h-5.5 w-5.5" />
                    {item.badge !== undefined && (
                      <span className="absolute -top-1 -right-2 min-w-[16px] h-[16px] px-1 bg-yappr-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] mt-1.5 text-center font-medium">{item.name}</span>
                </Link>
              )
            })}
          </div>

          {user && (
            <div className="border-t border-zinc-200/50 dark:border-zinc-800/50 mt-3 pt-3">
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
          )}

          {!user && (
            <div className="border-t border-zinc-200/50 dark:border-zinc-800/50 mt-3 pt-3">
              <button
                onClick={() => {
                  setMoreMenuOpen(false)
                  openLoginModal()
                }}
                className="flex items-center justify-center w-full p-3 rounded-xl bg-gradient-yappr text-white font-semibold hover:brightness-110 transition-all shadow-yappr text-sm"
              >
                Sign In
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white/90 dark:bg-zinc-950/90 backdrop-blur-xl border-t border-zinc-200/50 dark:border-zinc-800/50 safe-area-inset-bottom">
        <div className="flex items-center justify-around h-14">
          {/* First two nav items */}
          {navItems.slice(0, 2).map((item) => {
            const isActive = item.match(pathname)
            const Icon = isActive ? item.activeIcon : item.icon
            return (
              <Link
                key={item.name}
                href={item.href}
                className="flex-1 flex flex-col items-center justify-center h-full gap-0.5"
              >
                <Icon className={cn(
                  "h-6 w-6 transition-colors",
                  isActive ? "text-yappr-500" : "text-zinc-400 dark:text-zinc-500"
                )} />
                {isActive && (
                  <div className="w-1 h-1 rounded-full bg-yappr-500" />
                )}
              </Link>
            )
          })}

          {/* Center Post Button (FAB style) */}
          {user ? (
            <button
              onClick={() => setComposeOpen(true)}
              className="flex items-center justify-center -mt-5 h-12 w-12 rounded-2xl bg-gradient-yappr text-white shadow-yappr-lg active:scale-95 transition-all"
            >
              <PlusIcon className="h-6 w-6" />
            </button>
          ) : (
            <button
              onClick={openLoginModal}
              className="flex items-center justify-center -mt-5 h-12 w-12 rounded-2xl bg-gradient-yappr text-white shadow-yappr-lg active:scale-95 transition-all"
            >
              <PlusIcon className="h-6 w-6" />
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
                className="flex-1 flex flex-col items-center justify-center h-full gap-0.5"
              >
                <Icon className={cn(
                  "h-6 w-6 transition-colors",
                  isActive ? "text-yappr-500" : "text-zinc-400 dark:text-zinc-500"
                )} />
                {isActive && (
                  <div className="w-1 h-1 rounded-full bg-yappr-500" />
                )}
              </Link>
            )
          })}

          {/* More Button */}
          <button
            onClick={() => setMoreMenuOpen(!moreMenuOpen)}
            className="flex-1 flex flex-col items-center justify-center h-full relative gap-0.5"
          >
            <Bars3Icon className={cn(
              "h-6 w-6 transition-colors",
              (moreMenuOpen || isMoreActive) ? "text-yappr-500" : "text-zinc-400 dark:text-zinc-500"
            )} />
            {(moreMenuOpen || isMoreActive) && (
              <div className="w-1 h-1 rounded-full bg-yappr-500" />
            )}
            {isHydrated && unreadNotificationCount > 0 && !moreMenuOpen && (
              <span className="absolute top-2.5 right-1/4 w-2 h-2 bg-yappr-500 rounded-full ring-2 ring-white dark:ring-zinc-950" />
            )}
          </button>
        </div>
      </nav>
    </>
  )
}
