'use client'

import { logger } from '@/lib/logger';
import Image from 'next/image'
import Link from 'next/link'
import { useRoutePath } from '@/hooks/use-route-path'
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
  ArrowRightEndOnRectangleIcon,
  EllipsisHorizontalCircleIcon,
  UserGroupIcon,
  UsersIcon,
  HashtagIcon,
  ArrowPathIcon,
  BellIcon,
  BuildingStorefrontIcon,
  BookOpenIcon,
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
  BookOpenIcon as BookOpenIconSolid,
} from '@heroicons/react/24/solid'
import { cn } from '@/lib/utils'
import { publicAsset } from '@/lib/public-asset'
import { BetaPill } from '@/components/ui/beta-pill'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/lib/store'
import { useVisibleUnreadNotificationCount } from '@/hooks/use-visible-unread-notification-count'
import { useNotificationStore } from '@/lib/stores/notification-store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { UserAvatar } from '@/components/ui/avatar-image'
import { YappBalanceItem } from '@/components/token/yapp-balance-item'
import { useAuth } from '@/contexts/auth-context'
import { notificationService } from '@/lib/services'
import { directMessageService } from '@/lib/services/direct-message-service'
import { useDmV5Badge } from '@/components/messages/use-dm-engine'
import { startVisibilityPolling } from '@/lib/poll-scheduling'
import { dmIsV5 } from '@/lib/constants'
import { useLoginModal } from '@/hooks/use-login-modal'
import { InlineLegalLinks, LegalLinksMenu } from './legal-links'

const getNavigation = (isLoggedIn: boolean, userId?: string) => {
  if (!isLoggedIn) {
    return [
      // Signed out, the public timeline at /feed is home too.
      { name: 'Home', href: '/', icon: HomeIcon, activeIcon: HomeIconSolid, alsoActiveOn: '/feed' },
      { name: 'Explore', href: '/explore', icon: HashtagIcon, activeIcon: HashtagIconSolid },
      { name: 'Store', href: '/store', icon: BuildingStorefrontIcon, activeIcon: BuildingStorefrontIconSolid, beta: 'store' as const },
      { name: 'Blog', href: '/blog', icon: BookOpenIcon, activeIcon: BookOpenIconSolid, beta: 'blog' as const },
    ]
  }

  return [
    { name: 'Home', href: '/feed', icon: HomeIcon, activeIcon: HomeIconSolid },
    { name: 'Following', href: '/following', icon: UserGroupIcon, activeIcon: UserGroupIconSolid },
    { name: 'Followers', href: '/followers', icon: UsersIcon, activeIcon: UsersIconSolid },
    { name: 'Explore', href: '/explore', icon: HashtagIcon, activeIcon: HashtagIconSolid },
    { name: 'Store', href: '/store', icon: BuildingStorefrontIcon, activeIcon: BuildingStorefrontIconSolid, beta: 'store' as const },
    { name: 'Blog', href: '/blog', icon: BookOpenIcon, activeIcon: BookOpenIconSolid, beta: 'blog' as const },
    { name: 'Notifications', href: '/notifications', icon: BellIcon, activeIcon: BellIconSolid },
    { name: 'Messages', href: '/messages', icon: EnvelopeIcon, activeIcon: EnvelopeIconSolid },
    { name: 'Bookmarks', href: '/bookmarks', icon: BookmarkIcon, activeIcon: BookmarkIconSolid },
    { name: 'Profile', href: `/user?id=${userId}`, icon: UserIcon, activeIcon: UserIconSolid },
  ]
}

const NOTIFICATION_POLL_INTERVAL = 30000 // 30 seconds

/**
 * The display name the account chip last showed. Every page mounts its own
 * Sidebar, so without it the chip would show the @name and then swap to the
 * display name on each navigation.
 */
let lastAccountName: { identityId: string; displayName: string | null } | null = null

function cachedAccountName(identityId: string | undefined): string | null {
  return identityId && lastAccountName?.identityId === identityId ? lastAccountName.displayName : null
}

/** A row of the rail: icon only below `xl`, icon and label from `xl` up. */
const NAV_ROW = cn(
  'flex items-center justify-center gap-4 rounded-full p-3 text-xl transition-all duration-200 xl:justify-start',
  'hover:bg-gray-100 dark:hover:bg-gray-900'
)
/** A label that collapses with the rail but stays the control's accessible name. */
const NAV_LABEL = 'sr-only xl:not-sr-only'

/**
 * The brand at the top of the rail: the app icon on the narrow rail, the
 * wordmark on the wide one. The brand workstream swaps what each renders.
 */
function SidebarBrand() {
  return (
    <>
      <Image src={publicAsset('/icon-192.png')} alt="" width={40} height={40} className="rounded-xl xl:hidden" />
      <span className="hidden text-2xl font-bold text-gradient xl:inline">Yappr</span>
    </>
  )
}

export function Sidebar() {
  const pathname = useRoutePath()
  const { setComposeOpen } = useAppStore()
  const { user, logout, refreshBalance } = useAuth()
  const openLoginModal = useLoginModal((s) => s.open)

  const unreadNotificationCount = useVisibleUnreadNotificationCount()
  const unreadMessageCount = useNotificationStore((s) => s.dmUnreadCount)
  // Under DM v5 the badge follows the v5 engine, which also runs the background poll (§6.3).
  const dmV5 = dmIsV5()
  useDmV5Badge(user?.identityId, dmV5)

  const [isHydrated, setIsHydrated] = useState(false)
  const [isRefreshingBalance, setIsRefreshingBalance] = useState(false)
  // The chip renders only after hydration, so seeding from the last page's name cannot mismatch.
  const [displayName, setDisplayName] = useState<string | null>(() => cachedAccountName(user?.identityId))

  // Prevent hydration mismatches
  useEffect(() => {
    setIsHydrated(true)
  }, [])

  // The account chip shows the profile's display name over the @name.
  const identityId = user?.identityId
  useEffect(() => {
    // Another account's name must never linger; this one's stays while it refreshes.
    setDisplayName(cachedAccountName(identityId))

    if (!identityId) {
      return
    }

    let mounted = true

    async function fetchDisplayName() {
      try {
        const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')
        const profile = await unifiedProfileService.getProfile(identityId as string)
        lastAccountName = { identityId: identityId as string, displayName: profile?.displayName ?? null }
        if (mounted) {
          setDisplayName(lastAccountName.displayName)
        }
      } catch (error) {
        logger.error('Failed to fetch display name:', error)
        if (mounted) {
          setDisplayName(null)
        }
      }
    }

    fetchDisplayName().catch((err) => logger.error('Failed to fetch display name:', err))

    return () => {
      mounted = false
    }
  }, [identityId])

  // Initial notification fetch and polling
  useEffect(() => {
    // Blocks made this session belong to the account that made them.
    useNotificationStore.getState().setViewer(user?.identityId ?? null)
    if (!user?.identityId) {
      // Logout / user switch: drop the previous user's DM count. Nothing polls
      // while logged out, so a survivor would be shown until the next login.
      useNotificationStore.getState().setDmUnreadCount(0)
      return
    }

    const userId = user.identityId
    let cancelled = false

    async function fetchNotifications(isInitial: boolean): Promise<void> {
      if (cancelled) return

      const store = useNotificationStore.getState()

      // Set loading state for initial fetch
      if (isInitial) {
        store.setLoading(true)
      }

      try {
        const readIds = store.getReadIdsSet()
        // The DM unread total rides this same cadence rather than adding a
        // second timer. The service never rejects (its whole body is inside a
        // try; it answers 0 on v3 and null when it cannot tell), and the catch
        // below is belt and braces so it can never take the notification
        // fetch down with it.
        const [result] = await Promise.all([
          isInitial
            ? notificationService.getInitialNotifications(userId, readIds)
            : notificationService.pollNewNotifications(userId, store.lastFetchTimestamp, readIds),
          (dmV5 ? Promise.resolve(null) : directMessageService.getUnreadTotal(userId)).then((total) => {
            // `null` is "could not tell": hold the previous badge rather than
            // blinking it off for 30s and reading as "all caught up".
            if (!cancelled && total !== null) store.setDmUnreadCount(total)
          }).catch((error) => logger.warn('DM unread total failed:', error)),
        ])

        if (cancelled) return

        if (isInitial) {
          store.setNotifications(result.notifications)
          store.setHasFetchedOnce(true)
        } else if (result.notifications.length > 0) {
          store.addNotifications(result.notifications)
        }
        store.setLastFetchTimestamp(result.latestTimestamp)

        // Blocks change without a new notification (following a block list,
        // a block made on another device): re-check what is already shown.
        const blocked = await notificationService.blockedAmongHeld(userId, useNotificationStore.getState().notifications)
        if (!cancelled && blocked) useNotificationStore.getState().pruneBlocked(blocked, userId)
        // A partial source failure keeps its watermark; it must also slow retries.
        if (result.failure !== undefined) throw result.failure
      } finally {
        if (isInitial && !cancelled) {
          store.setLoading(false)
          store.setHasFetchedOnce(true)
        }
      }
    }

    let initial = true
    const stopPolling = startVisibilityPolling(async () => {
      try {
        await fetchNotifications(initial)
      } finally {
        initial = false
      }
    }, NOTIFICATION_POLL_INTERVAL, (error) => logger.error('Notification fetch failed:', error), true)

    return () => {
      cancelled = true
      stopPolling()
    }
  }, [user?.identityId, dmV5])
  
  // Get navigation based on auth status (use safe defaults during SSR)
  const navigation = getNavigation(isHydrated ? !!user : false, user?.identityId)
  
  const handle = user?.dpnsUsername ? `@${user.dpnsUsername}` : null
  const accountName = displayName || handle || 'Your account'

  // Below `xl` the rail collapses to icons, leaving the centre column room
  // beside the right sidebar (which appears at `lg`).
  return (
    <div className="hidden md:flex h-screen w-[88px] xl:w-[275px] shrink-0 flex-col px-2 sticky top-0">
      <div className="flex-1 space-y-1 py-4 overflow-y-auto scrollbar-hide">
        <Link href="/welcome" aria-label="Yappr" className="flex items-center justify-center xl:justify-start px-3 py-4 mb-2 group">
          <SidebarBrand />
        </Link>

        <nav className="space-y-1">
          {navigation.map((item) => {
            const isActive = pathname === item.href || ('alsoActiveOn' in item && pathname === item.alsoActiveOn)
            const Icon = isActive ? item.activeIcon : item.icon
            // Badges render only after hydration: both counts are client-only,
            // so drawing them during SSR would mismatch.
            const badgeCount = !isHydrated ? 0
              : item.name === 'Notifications' ? unreadNotificationCount
              : item.name === 'Messages' ? unreadMessageCount
              : 0

            return (
              <Link
                key={item.name}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(NAV_ROW, isActive && 'font-bold')}
              >
                <div className="relative">
                  <Icon className="h-7 w-7" />
                  {badgeCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-yappr-500 text-[10px] font-bold text-white">
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </span>
                  )}
                </div>
                <span className={NAV_LABEL}>{item.name}</span>
                {item.beta && <BetaPill product={item.beta} className="hidden xl:inline-flex" />}
              </Link>
            )
          })}
          
          {user && isHydrated && (
            <Link
              href="/settings"
              aria-current={pathname === '/settings' ? 'page' : undefined}
              className={cn(NAV_ROW, pathname === '/settings' && 'font-bold')}
            >
              <Cog6ToothIcon className="h-7 w-7" />
              <span className={NAV_LABEL}>Settings</span>
            </Link>
          )}
        </nav>

        {isHydrated && user ? (
          <Button
            onClick={() => setComposeOpen(true)}
            className="mx-auto mt-8 flex h-12 w-12 px-0 text-base shadow-yappr-lg xl:w-full xl:px-6"
            size="lg"
          >
            <PencilSquareIcon className="h-6 w-6" />
            <span className={NAV_LABEL}>Post</span>
          </Button>
        ) : isHydrated ? (
          <Button
            className="mx-auto mt-8 flex h-12 w-12 px-0 text-base shadow-yappr-lg xl:w-full xl:px-6 xl:text-lg"
            size="lg"
            onClick={openLoginModal}
          >
            <ArrowRightEndOnRectangleIcon className="h-6 w-6 xl:hidden" />
            <span className={NAV_LABEL}>Sign In</span>
          </Button>
        ) : (
          // Show loading state during SSR/hydration
          <div className="mt-8">
            <div className="mx-auto h-12 w-12 xl:w-full bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
          </div>
        )}
      </div>

      <div className="space-y-2 flex-shrink-0 pb-4">
        <div className="flex justify-center xl:hidden">
          <LegalLinksMenu
            trigger={
              <button type="button" className="rounded-full p-3 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900">
                <EllipsisHorizontalCircleIcon className="h-7 w-7" />
              </button>
            }
          />
        </div>
        {user && isHydrated && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                data-testid="user-menu-trigger"
                aria-label={`Account menu, ${accountName}`}
                className="flex items-center justify-center xl:justify-start gap-3 p-3 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors w-full"
              >
                <UserAvatar userId={user.identityId} size="md" alt="" />
                <div className="hidden xl:flex flex-1 min-w-0 items-center text-left">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{accountName}</p>
                    {handle && accountName !== handle && (
                      <p className="text-sm text-gray-500 truncate">{handle}</p>
                    )}
                  </div>
                  <EllipsisHorizontalIcon className="h-5 w-5 text-gray-500 flex-shrink-0" />
                </div>
              </button>
            </DropdownMenu.Trigger>
            
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="min-w-[200px] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50"
                sideOffset={5}
              >
                <DropdownMenu.Item
                  className="px-4 py-3 text-sm outline-none"
                  disabled
                  onSelect={(e) => e.preventDefault()}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-gray-500">Balance</div>
                      <div className="font-mono">
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
                        try {
                          await refreshBalance()
                        } catch (error) {
                          logger.error('Failed to refresh balance:', error)
                        } finally {
                          setIsRefreshingBalance(false)
                        }
                      }}
                      disabled={isRefreshingBalance}
                      className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                      title="Refresh balance"
                    >
                      <ArrowPathIcon className={`h-4 w-4 text-gray-500 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="h-px bg-gray-200 dark:bg-gray-800 my-1" />
                <YappBalanceItem />
                <DropdownMenu.Item
                  className="px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2"
                  onClick={logout}
                >
                  <ArrowRightOnRectangleIcon className="h-4 w-4" />
                  Log out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        <InlineLegalLinks className="hidden xl:flex px-3" />
      </div>
    </div>
  )
}
