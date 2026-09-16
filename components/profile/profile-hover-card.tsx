'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef, useId, ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { EnvelopeIcon, UserPlusIcon, UserMinusIcon } from '@heroicons/react/24/outline'
import * as Popover from '@radix-ui/react-popover'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import { followService } from '@/lib/services/follow-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { loadUserStats } from '@/lib/services/social-stats-service'
import toast from 'react-hot-toast'

interface ProfileHoverCardProps {
  /** The user's identity ID */
  userId: string
  /** Optional pre-loaded username */
  username?: string | null
  /** Optional pre-loaded display name */
  displayName?: string
  /** Optional pre-loaded avatar URL */
  avatarUrl?: string
  /** The trigger element (what gets hovered) */
  children: ReactNode
  /** Whether to disable the hover card (still renders children) */
  disabled?: boolean
  /** Optional callback when DM is clicked */
  onMessageClick?: () => void
  /** Delay before opening in ms */
  openDelay?: number
  /** Delay before closing in ms */
  closeDelay?: number
}

interface ProfileData {
  displayName: string
  bio?: string
  username?: string | null
  avatarUrl: string
  followerCount: number
  followingCount: number
}

export function ProfileHoverCard({
  userId,
  username: preloadedUsername,
  displayName: preloadedDisplayName,
  avatarUrl: preloadedAvatarUrl,
  children,
  disabled = false,
  openDelay = 300,
  closeDelay = 200
}: ProfileHoverCardProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()

  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const keyboardEntryRef = useRef(false)
  const returningFocusRef = useRef(false)
  const previewId = useId()
  const instructionsId = useId()

  const clearTimer = useCallback(() => {
    clearTimeout(timerRef.current)
  }, [])

  const changeOpen = useCallback((open: boolean) => {
    clearTimer()
    if (!open) keyboardEntryRef.current = false
    setIsOpen(open)
  }, [clearTimer])

  const scheduleClose = () => {
    clearTimer()
    timerRef.current = setTimeout(() => {
      const focused = document.activeElement
      if (!contentRef.current?.contains(focused) && !triggerRef.current?.contains(focused)) {
        changeOpen(false)
      }
    }, closeDelay)
  }

  const focusPreview = () => {
    const content = contentRef.current
    const firstControl = content?.querySelector<HTMLElement>('a[href], button:not([disabled])')
    const target = firstControl || content
    target?.focus()
  }

  useEffect(() => {
    changeOpen(false)
    return clearTimer
  }, [userId, disabled, changeOpen, clearTimer])
  const [profileData, setProfileData] = useState<ProfileData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isFollowing, setIsFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [hasLoadedFollowStatus, setHasLoadedFollowStatus] = useState(false)

  // Reset cached state when userId changes to avoid showing stale data
  useEffect(() => {
    setProfileData(null)
    setIsLoading(false)
    setIsFollowing(false)
    setFollowLoading(false)
    setHasLoadedFollowStatus(false)
  }, [userId])

  // Don't show hover card for own profile
  const isOwnProfile = user?.identityId === userId

  // Load profile data when hover card opens
  const loadProfileData = useCallback(async () => {
    if (profileData || isLoading) return

    setIsLoading(true)
    try {
      const stats = await loadUserStats(userId)
      const [profiles, usernameResult, avatars] = await Promise.all([
        unifiedProfileService.getProfilesByIdentityIds([userId]),
        preloadedUsername === undefined ? dpnsService.resolveUsername(userId) : Promise.resolve(preloadedUsername),
        unifiedProfileService.getAvatarUrlsBatch([userId]),
      ])
      const profile = profiles.find(profile => profile.$ownerId === userId)
      const username = usernameResult

      const avatarUrl = preloadedAvatarUrl ||
        avatars.get(userId) ||
        unifiedProfileService.getDefaultAvatarUrl(userId)

      setProfileData({
        displayName: profile?.displayName || preloadedDisplayName || 'Unknown User',
        bio: profile?.bio,
        username: username,
        avatarUrl,
        followerCount: stats.followers,
        followingCount: stats.following
      })
    } catch (error) {
      logger.error('Failed to load profile data:', error)
      // Set minimal data so we show something
      setProfileData({
        displayName: preloadedDisplayName || 'Unknown User',
        bio: undefined,
        username: preloadedUsername,
        avatarUrl: preloadedAvatarUrl || unifiedProfileService.getDefaultAvatarUrl(userId),
        followerCount: 0,
        followingCount: 0
      })
    } finally {
      setIsLoading(false)
    }
  }, [userId, profileData, isLoading, preloadedUsername, preloadedDisplayName, preloadedAvatarUrl])

  // Load follow status when hover card opens (only if logged in)
  const loadFollowStatus = useCallback(async () => {
    if (!user || hasLoadedFollowStatus || isOwnProfile) return

    try {
      const following = await followService.isFollowing(userId, user.identityId)
      setIsFollowing(following)
      setHasLoadedFollowStatus(true)
    } catch (error) {
      logger.error('Failed to load follow status:', error)
    }
  }, [userId, user, hasLoadedFollowStatus, isOwnProfile])

  // Load data when card opens
  useEffect(() => {
    if (isOpen) {
      loadProfileData().catch(err => logger.error('Failed to load profile data:', err))
      loadFollowStatus().catch(err => logger.error('Failed to load follow status:', err))
    }
  }, [isOpen, loadProfileData, loadFollowStatus])

  const handleFollowToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()

    const authedUser = requireAuth()
    if (!authedUser || followLoading) return

    setFollowLoading(true)
    const wasFollowing = isFollowing

    // Optimistic update
    setIsFollowing(!wasFollowing)

    try {
      const result = wasFollowing
        ? await followService.unfollowUser(authedUser.identityId, userId)
        : await followService.followUser(authedUser.identityId, userId)

      if (!result.success) {
        // Rollback
        setIsFollowing(wasFollowing)
        toast.error(result.error || 'Failed to update follow status')
      } else {
        toast.success(wasFollowing ? 'Unfollowed' : 'Following')
        // Update follower count
        if (profileData) {
          setProfileData({
            ...profileData,
            followerCount: profileData.followerCount + (wasFollowing ? -1 : 1)
          })
        }
      }
    } catch (error) {
      // Rollback
      setIsFollowing(wasFollowing)
      logger.error('Follow toggle error:', error)
      toast.error('Failed to update follow status')
    } finally {
      setFollowLoading(false)
    }
  }

  const handleMessageClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()

    if (!requireAuth()) return

    router.push(`/messages?startConversation=${userId}`)
  }

  const handleViewProfile = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  // If disabled, just render children
  if (disabled) {
    return <>{children}</>
  }

  return (
    <Popover.Root open={isOpen} onOpenChange={changeOpen}>
      <Popover.Anchor
        ref={triggerRef}
        asChild
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? previewId : undefined}
        aria-describedby={instructionsId}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch') return
          clearTimer()
          timerRef.current = setTimeout(() => changeOpen(true), openDelay)
        }}
        onPointerLeave={scheduleClose}
        onFocus={() => {
          if (returningFocusRef.current) {
            returningFocusRef.current = false
            return
          }
          changeOpen(true)
        }}
        onBlur={(event) => {
          if (!contentRef.current?.contains(event.relatedTarget)) changeOpen(false)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          event.stopPropagation()
          keyboardEntryRef.current = true
          changeOpen(true)
          focusPreview()
        }}
      >
        {children}
      </Popover.Anchor>
      <span id={instructionsId} className="sr-only">
        Press Arrow Down to access profile actions. Escape closes the preview.
      </span>
      <Popover.Portal>
      <Popover.Content
        ref={contentRef}
        id={previewId}
        aria-label="Profile preview"
        className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-gray-200 bg-white p-4 shadow-lg outline-none dark:border-gray-800 dark:bg-neutral-900"
        side="bottom"
        align="start"
        sideOffset={4}
        onClick={(e) => e.stopPropagation()}
        onPointerEnter={clearTimer}
        onPointerLeave={scheduleClose}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (keyboardEntryRef.current) focusPreview()
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.detail.originalEvent.type === 'focusin' && triggerRef.current?.contains(event.target as Node)) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={() => {
          changeOpen(false)
          if (!triggerRef.current?.contains(document.activeElement)) {
            returningFocusRef.current = true
            triggerRef.current?.focus()
          }
        }}
      >
        {isLoading && !profileData ? (
          <div className="space-y-3" role="status" aria-label="Loading profile">
            <div className="flex items-start gap-3">
              <div className="w-14 h-14 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                <div className="h-3 w-16 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
              </div>
            </div>
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          </div>
        ) : profileData ? (
          <div className="space-y-3">
            {/* Header: Avatar + Name + Actions */}
            <div className="flex items-start justify-between gap-3">
              <Link
                href={`/user?id=${userId}`}
                onClick={handleViewProfile}
                className="flex items-start gap-3 flex-1 min-w-0"
              >
                <UserAvatar
                  userId={userId}
                  size="lg"
                  alt={profileData.displayName}
                  preloadedUrl={profileData.avatarUrl}
                  className="flex-shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 dark:text-gray-100 truncate hover:underline">
                    {profileData.displayName}
                  </p>
                  {profileData.username && (
                    <p className="text-sm text-gray-500 truncate">
                      @{profileData.username}
                    </p>
                  )}
                </div>
              </Link>
            </div>

            {/* Bio */}
            {profileData.bio && (
              <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2">
                {profileData.bio}
              </p>
            )}

            {/* Stats */}
            <div className="flex items-center gap-4 text-sm">
              <Link
                href={`/following?id=${userId}`}
                onClick={handleViewProfile}
                className="hover:underline"
              >
                <span className="font-semibold text-gray-900 dark:text-gray-100">
                  {profileData.followingCount}
                </span>
                <span className="text-gray-500 ml-1">Following</span>
              </Link>
              <Link
                href={`/followers?id=${userId}`}
                onClick={handleViewProfile}
                className="hover:underline"
              >
                <span className="font-semibold text-gray-900 dark:text-gray-100">
                  {profileData.followerCount}
                </span>
                <span className="text-gray-500 ml-1">Followers</span>
              </Link>
            </div>

            {/* Action Buttons - only show for other users */}
            {!isOwnProfile && (
              <div className="flex items-center gap-2 pt-1">
                <Button
                  onClick={handleFollowToggle}
                  disabled={followLoading}
                  variant={isFollowing ? 'outline' : 'default'}
                  size="sm"
                  className="flex-1"
                >
                  {followLoading ? (
                    <span className="animate-pulse">...</span>
                  ) : isFollowing ? (
                    <>
                      <UserMinusIcon className="h-4 w-4 mr-1.5" />
                      Unfollow
                    </>
                  ) : (
                    <>
                      <UserPlusIcon className="h-4 w-4 mr-1.5" />
                      Follow
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleMessageClick}
                  variant="outline"
                  size="sm"
                  className="flex-1"
                >
                  <EnvelopeIcon className="h-4 w-4 mr-1.5" />
                  Message
                </Button>
              </div>
            )}
          </div>
        ) : null}
        <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-500 dark:border-gray-800">
          ↓ Profile actions · Esc Close
        </p>
      </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
