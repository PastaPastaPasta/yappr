'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRoutePath } from '@/hooks/use-route-path'
import { useAuth } from '@/contexts/auth-context'
import { useAppStore } from '@/lib/store'
import { useNotificationStore } from '@/lib/stores/notification-store'
import { useVisibleUnreadNotificationCount } from '@/hooks/use-visible-unread-notification-count'
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
  BellIcon as BellIconSolid,
} from '@heroicons/react/24/solid'
import { cn } from '@/lib/utils'
import { BetaPill } from '@/components/ui/beta-pill'
import type { BetaProduct } from '@/lib/feature-flags'
import { useLoginModal } from '@/hooks/use-login-modal'
import * as Tooltip from '@radix-ui/react-tooltip'
import { LegalLinks } from './legal-links'
import { Modal, ModalTitle } from '@/components/ui/modal'

export function MobileBottomNav() {
  const pathname = useRoutePath()
  const { user, logout } = useAuth()
  const { setComposeOpen } = useAppStore()
  const openLoginModal = useLoginModal((s) => s.open)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [isHydrated, setIsHydrated] = useState(false)
  const moreMenuButtonRef = useRef<HTMLButtonElement>(null)
  const closeMenuButtonRef = useRef<HTMLButtonElement>(null)
  // Where focus goes once the sheet has gone: back to Menu, nowhere (a link
  // or sign-out leaves the page as it is), or into the sign-in dialog.
  const afterCloseRef = useRef<'menu' | 'page' | 'sign-in'>('menu')
  const unreadNotificationCount = useVisibleUnreadNotificationCount()
  // Refreshed by the Sidebar's poll: it is hidden with CSS on mobile, not
  // unmounted, so its effect is the single source of both badge counts.
  const unreadMessageCount = useNotificationStore((s) => s.dmUnreadCount)

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Close menu on route change
  useEffect(() => {
    afterCloseRef.current = 'page'
    setMoreMenuOpen(false)
  }, [pathname])

  const openMoreMenu = () => {
    afterCloseRef.current = 'menu'
    setMoreMenuOpen(true)
  }

  const leaveMoreMenu = () => {
    afterCloseRef.current = 'page'
    setMoreMenuOpen(false)
  }

  // A sheet opened on mobile must also release its focus/scroll lock if the
  // viewport switches to the desktop navigation.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)')
    const closeOnDesktop = () => {
      if (desktop.matches) setMoreMenuOpen(false)
    }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  const navItems: Array<{
    name: string
    href: string
    icon: typeof HomeIcon
    activeIcon: typeof HomeIcon
    match: (path: string) => boolean
    badge?: number
  }> = [
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
    // Signed in, notifications get a tab of their own, as on X and Bluesky.
    ...(user ? [{
      name: 'Notifications',
      href: '/notifications',
      icon: BellIcon,
      activeIcon: BellIconSolid,
      match: (path: string) => path === '/notifications',
      badge: isHydrated ? unreadNotificationCount : 0,
    }] : []),
    {
      name: 'Messages',
      href: '/messages',
      icon: EnvelopeIcon,
      activeIcon: EnvelopeIconSolid,
      match: (path: string) => path.startsWith('/messages'),
      badge: isHydrated && user ? unreadMessageCount : 0,
    },
  ]

  // More menu items - Store first for prominence, then user-specific items
  const moreMenuItems: Array<{ name: string; href: string; icon: typeof HomeIcon; beta?: BetaProduct }> = [
    { name: 'Store', href: '/store', icon: BuildingStorefrontIcon, beta: 'store' },
    { name: 'Blog', href: '/blog', icon: BookOpenIcon, beta: 'blog' },
    ...(user ? [
      { name: 'Profile', href: `/user?id=${user.identityId}`, icon: UserIcon },
      { name: 'Following', href: '/following', icon: UserGroupIcon },
      { name: 'Followers', href: '/followers', icon: UsersIcon },
      { name: 'Bookmarks', href: '/bookmarks', icon: BookmarkIcon },
      { name: 'Settings', href: '/settings', icon: Cog6ToothIcon },
    ] : []),
  ]

  function renderTab(item: (typeof navItems)[number]) {
    const isActive = item.match(pathname)
    const Icon = isActive ? item.activeIcon : item.icon
    const badgeCount = item.badge ?? 0
    return (
      <Link
        key={item.name}
        href={item.href}
        aria-label={badgeCount > 0 ? `${item.name}, ${badgeCount} unread` : item.name}
        aria-current={isActive ? 'page' : undefined}
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
  }

  const isMoreActive = moreMenuItems.some(item => pathname === item.href || pathname.startsWith(item.href + '/')) || pathname.startsWith('/store')

  return (
    <>
      {/* More Menu Sheet */}
      <Modal
        open={moreMenuOpen}
        onOpenChange={setMoreMenuOpen}
        variant="sheet"
        overlayClassName="items-end px-0"
        className="max-h-[100dvh] overflow-y-auto rounded-b-none border-t border-gray-200 safe-area-inset-bottom dark:border-gray-800"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          closeMenuButtonRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const next = afterCloseRef.current
          afterCloseRef.current = 'menu'
          if (next === 'page') return
          moreMenuButtonRef.current?.focus({ preventScroll: true })
          // Open sign-in after this sheet releases its focus scope, so the
          // login modal returns to Menu instead of a departing sheet button.
          if (next === 'sign-in') openLoginModal()
        }}
      >
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <ModalTitle className="mb-0 text-lg">Menu</ModalTitle>
            <button
              aria-label="Close menu"
              ref={closeMenuButtonRef}
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
                  onClick={leaveMoreMenu}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-xl transition-colors",
                    isActive
                      ? "bg-yappr-500/10 text-yappr-500"
                      : "hover:bg-gray-100 dark:hover:bg-gray-800"
                  )}
                >
                  <item.icon className="h-6 w-6" />
                  <span className="text-xs mt-1 text-center">{item.name}</span>
                  {item.beta && <BetaPill product={item.beta} className="mt-1" />}
                </Link>
              )
            })}
          </div>

          {user && (
            <>
              <div className="border-t border-gray-200 dark:border-gray-800 mt-4 pt-4">
                <button
                  onClick={() => {
                    leaveMoreMenu()
                    logout().catch((err) => logger.error('Logout failed:', err))
                  }}
                  className="flex items-center gap-3 w-full p-3 rounded-xl text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
                >
                  <ArrowRightOnRectangleIcon className="h-5 w-5" />
                  <span className="text-sm font-medium">Sign out</span>
                </button>
              </div>
            </>
          )}

          {!user && (
            <div className="border-t border-gray-200 dark:border-gray-800 mt-4 pt-4">
              <button
                onClick={() => {
                  afterCloseRef.current = 'sign-in'
                  setMoreMenuOpen(false)
                }}
                className="flex items-center justify-center w-full p-3 rounded-xl bg-yappr-500 text-white font-medium hover:bg-yappr-600 transition-colors"
              >
                Sign in
              </button>
            </div>
          )}

          <LegalLinks className="mt-4" onNavigate={leaveMoreMenu} />
        </div>
      </Modal>

      {/* Bottom Navigation Bar */}
      <nav aria-label="Mobile navigation" className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-gray-800 safe-area-inset-bottom">
        <div className="flex items-center justify-around h-14">
          {navItems.slice(0, 2).map(renderTab)}

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

          {navItems.slice(2).map(renderTab)}

          {/* More Button */}
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  aria-label="Menu"
                  aria-haspopup="dialog"
                  aria-expanded={moreMenuOpen}
                  ref={moreMenuButtonRef}
                  onClick={openMoreMenu}
                  className="flex-1 flex items-center justify-center h-full relative"
                >
                  <Bars3Icon className={cn(
                    "h-7 w-7",
                    (moreMenuOpen || isMoreActive) ? "text-black dark:text-white" : "text-gray-500"
                  )} />
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
