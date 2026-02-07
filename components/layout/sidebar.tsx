'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'
import {
  HomeIcon,
  EnvelopeIcon,
  BookmarkIcon,
  UserIcon,
  EllipsisHorizontalIcon,
  PencilSquareIcon,
  Cog6ToothIcon,
  ArrowRightOnRectangleIcon,
  UserGroupIcon,
  UsersIcon,
  HashtagIcon,
  ArrowPathIcon,
  BellIcon,
  BuildingStorefrontIcon,
} from '@heroicons/react/24/outline'
import {
  HomeIcon as HomeIconSolid,
  EnvelopeIcon as EnvelopeIconSolid,
  BookmarkIcon as BookmarkIconSolid,
  UserIcon as UserIconSolid,
  UserGroupIcon as UserGroupIconSolid,
  UsersIcon as UsersIconSolid,
  HashtagIcon as HashtagIconSolid,
  BellIcon as BellIconSolid,
  BuildingStorefrontIcon as BuildingStorefrontIconSolid,
} from '@heroicons/react/24/solid'
import { cn, truncateId } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/lib/store'
import { useNotificationStore } from '@/lib/stores/notification-store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { UserAvatar } from '@/components/ui/avatar-image'
import { useAuth } from '@/contexts/auth-context'
import { notificationService } from '@/lib/services'
import { useLoginModal } from '@/hooks/use-login-modal'

const getNavigation = (isLoggedIn: boolean, userId?: string) => {
  if (!isLoggedIn) {
    return [
      { name: 'Home', href: '/', icon: HomeIcon, activeIcon: HomeIconSolid },
      { name: 'Explore', href: '/explore', icon: HashtagIcon, activeIcon: HashtagIconSolid },
      { name: 'Store', href: '/store', icon: BuildingStorefrontIcon, activeIcon: BuildingStorefrontIconSolid },
    ]
  }

  return [
    { name: 'Home', href: '/feed', icon: HomeIcon, activeIcon: HomeIconSolid },
    { name: 'Following', href: '/following', icon: UserGroupIcon, activeIcon: UserGroupIconSolid },
    { name: 'Followers', href: '/followers', icon: UsersIcon, activeIcon: UsersIconSolid },
    { name: 'Explore', href: '/explore', icon: HashtagIcon, activeIcon: HashtagIconSolid },
    { name: 'Store', href: '/store', icon: BuildingStorefrontIcon, activeIcon: BuildingStorefrontIconSolid },
    { name: 'Notifications', href: '/notifications', icon: BellIcon, activeIcon: BellIconSolid },
    { name: 'Messages', href: '/messages', icon: EnvelopeIcon, activeIcon: EnvelopeIconSolid },
    { name: 'Bookmarks', href: '/bookmarks', icon: BookmarkIcon, activeIcon: BookmarkIconSolid },
    { name: 'Profile', href: `/user?id=${userId}`, icon: UserIcon, activeIcon: UserIconSolid },
  ]
}

const NOTIFICATION_POLL_INTERVAL = 30000 // 30 seconds

export function Sidebar() {
  const pathname = usePathname()
  const { setComposeOpen } = useAppStore()
  const { user, logout, refreshBalance } = useAuth()
  const openLoginModal = useLoginModal((s) => s.open)

  // Notification store - only subscribe to unread count for badge display
  const unreadNotificationCount = useNotificationStore((s) => s.getUnreadCount())

  const [isHydrated, setIsHydrated] = useState(false)
  const [isRefreshingBalance, setIsRefreshingBalance] = useState(false)
  const [displayName, setDisplayName] = useState<string | null>(null)

  // Prevent hydration mismatches
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // Fetch display name from profile when no DPNS username
  useEffect(() => {
    // Reset display name at start to avoid stale values
    setDisplayName(null)

    if (!user?.identityId || user.dpnsUsername) {
      return
    }

    let mounted = true

    async function fetchDisplayName() {
      try {
        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
        const profile = await unifiedProfileService.getProfile(user!.identityId)
        if (mounted) {
          setDisplayName(profile?.displayName ?? null)
        }
      } catch (error) {
        console.error('Failed to fetch display name:', error)
        if (mounted) {
          setDisplayName(null)
        }
      }
    }

    fetchDisplayName()

    return () => {
      mounted = false
    }
  }, [user?.identityId, user?.dpnsUsername])

  // Initial notification fetch and polling
  useEffect(() => {
    if (!user?.identityId) return

    const userId = user.identityId
    let timeoutId: NodeJS.Timeout | null = null
    let cancelled = false

    async function fetchAndSchedule(isInitial: boolean): Promise<void> {
      if (cancelled) return

      // Skip poll if page is hidden (but still schedule next poll)
      if (!isInitial && document.hidden) {
        timeoutId = setTimeout(() => fetchAndSchedule(false), NOTIFICATION_POLL_INTERVAL)
        return
      }

      const store = useNotificationStore.getState()

      // Set loading state for initial fetch
      if (isInitial) {
        store.setLoading(true)
      }

      try {
        const readIds = store.getReadIdsSet()
        const result = isInitial
          ? await notificationService.getInitialNotifications(userId, readIds)
          : await notificationService.pollNewNotifications(userId, store.lastFetchTimestamp, readIds)

        if (cancelled) return

        if (isInitial) {
          store.setNotifications(result.notifications)
          store.setHasFetchedOnce(true)
        } else if (result.notifications.length > 0) {
          store.addNotifications(result.notifications)
        }
        store.setLastFetchTimestamp(result.latestTimestamp)
      } catch (error) {
        console.error('Notification fetch error:', error)
      } finally {
        if (isInitial && !cancelled) {
          store.setLoading(false)
          store.setHasFetchedOnce(true)
        }
      }

      if (!cancelled) {
        timeoutId = setTimeout(() => fetchAndSchedule(false), NOTIFICATION_POLL_INTERVAL)
      }
    }

    fetchAndSchedule(true)

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [user?.identityId])

  // Get navigation based on auth status (use safe defaults during SSR)
  const navigation = getNavigation(isHydrated ? !!user : false, user?.identityId)

  // Format identity ID for display (show first 6 and last 4 chars)
  const formatIdentityId = (id: string) => truncateId(id, 6, 4)

  return (
    <div className="hidden md:flex h-[calc(100vh-40px)] w-[275px] shrink-0 flex-col px-3 sticky top-[40px]">
      <div className="flex-1 space-y-1 py-4 overflow-y-auto scrollbar-hide">
        <Link href="/" className="flex items-center px-3 py-4 mb-4 group">
          <span className="font-display text-3xl text-gradient tracking-tight">Yappr</span>
        </Link>

        <nav className="space-y-0.5">
          {navigation.map((item) => {
            const isActive = pathname === item.href
            const Icon = isActive ? item.activeIcon : item.icon
            const showBadge = item.name === 'Notifications' && isHydrated && unreadNotificationCount > 0

            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  'flex items-center gap-4 px-3 py-3 text-[15px] rounded-xl transition-all duration-200',
                  'hover:bg-surface-100 dark:hover:bg-surface-800',
                  isActive
                    ? 'font-bold text-gray-900 dark:text-white bg-surface-100 dark:bg-surface-800'
                    : 'text-gray-600 dark:text-gray-400'
                )}
              >
                <div className="relative">
                  <Icon className="h-6 w-6" />
                  {showBadge && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-yappr-500 text-[10px] font-bold text-white ring-2 ring-white dark:ring-surface-950">
                      {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
                    </span>
                  )}
                </div>
                <span>{item.name}</span>
              </Link>
            )
          })}

          {user && isHydrated && (
            <Link
              href="/settings"
              className={cn(
                "flex items-center gap-4 px-3 py-3 text-[15px] rounded-xl transition-all duration-200",
                "hover:bg-surface-100 dark:hover:bg-surface-800",
                pathname === '/settings'
                  ? 'font-bold text-gray-900 dark:text-white bg-surface-100 dark:bg-surface-800'
                  : 'text-gray-600 dark:text-gray-400'
              )}
            >
              <Cog6ToothIcon className="h-6 w-6" />
              <span>Settings</span>
            </Link>
          )}
        </nav>

        {isHydrated && user ? (
          <Button
            onClick={() => setComposeOpen(true)}
            className="w-full mt-8 h-12 text-base shadow-yappr-lg rounded-xl"
            size="lg"
          >
            <PencilSquareIcon className="h-5 w-5 mr-2" />
            <span>Post</span>
          </Button>
        ) : isHydrated ? (
          <div className="mt-8 space-y-3">
            <Button
              className="w-full h-12 text-base shadow-yappr-lg rounded-xl"
              size="lg"
              onClick={openLoginModal}
            >
              Sign In
            </Button>
            <p className="text-xs text-center text-gray-500 dark:text-gray-400 px-4 leading-relaxed">
              Join Yappr to share your voice on the decentralized web
            </p>
          </div>
        ) : (
          // Show loading state during SSR/hydration
          <div className="mt-8">
            <div className="w-full h-12 bg-surface-100 dark:bg-surface-800 rounded-xl animate-pulse" />
          </div>
        )}
      </div>

      <div className="space-y-2 flex-shrink-0 pb-4">
        {user && isHydrated && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors w-full">
                <UserAvatar userId={user.identityId} size="md" alt="Your avatar" />
                <div className="flex flex-1 text-left">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate text-gray-900 dark:text-gray-100">
                      {user.dpnsUsername ? `@${user.dpnsUsername}` : (displayName || 'Identity')}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate font-mono">{formatIdentityId(user.identityId)}</p>
                  </div>
                  <EllipsisHorizontalIcon className="h-5 w-5 text-gray-400 flex-shrink-0" />
                </div>
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[200px] bg-white dark:bg-surface-900 rounded-xl shadow-elevated-lg border border-surface-200 dark:border-neutral-750 py-2 z-50"
                sideOffset={5}
              >
                <DropdownMenu.Item
                  className="px-4 py-3 text-sm outline-none"
                  disabled
                  onSelect={(e) => e.preventDefault()}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Balance</div>
                      <div className="font-mono text-gray-900 dark:text-gray-100">
                        {(() => {
                          const balance = user.balance || 0;
                          // Balance is in credits, convert to DASH (1 DASH = 100,000,000,000 credits)
                          const dashBalance = balance / 100000000000;
                          return `${dashBalance.toFixed(4)} DASH`;
                        })()}
                      </div>
                    </div>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        setIsRefreshingBalance(true)
                        await refreshBalance()
                        setIsRefreshingBalance(false)
                      }}
                      disabled={isRefreshingBalance}
                      className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                      title="Refresh balance"
                    >
                      <ArrowPathIcon className={`h-4 w-4 text-gray-500 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="h-px bg-surface-200 dark:bg-neutral-750 my-1" />
                <DropdownMenu.Item
                  className="px-4 py-2 text-sm hover:bg-surface-100 dark:hover:bg-surface-800 cursor-pointer outline-none flex items-center gap-2 text-gray-700 dark:text-gray-300"
                  onClick={logout}
                >
                  <ArrowRightOnRectangleIcon className="h-4 w-4" />
                  Log out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </div>
  )
}
