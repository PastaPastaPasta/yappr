'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import { UserGroupIcon } from '@heroicons/react/24/outline'
import { SettingsSwitch } from '@/components/settings/settings-switch'
import toast from 'react-hot-toast'
import Link from 'next/link'

// Max users whose blocks can be followed
const MAX_BLOCK_FOLLOWS = 100

interface FollowedUserWithBlockStatus {
  id: string
  username?: string
  displayName: string
  isFollowingBlocks: boolean
  hasDpns: boolean
}

export function BlockListSettings() {
  const { user } = useAuth()
  const [followedUsers, setFollowedUsers] = useState<FollowedUserWithBlockStatus[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!user?.identityId) {
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const { followService } = await import('@/lib/services/follow-service')
      const { blockService } = await import('@/lib/services/block-service')
      const { dpnsService } = await import('@/lib/services/dpns-service')
      const { unifiedProfileService } = await import('@/lib/services/unified-profile-service')

      // Load following list and block follows in parallel
      const [follows, blockFollows] = await Promise.all([
        followService.getFollowing(user.identityId),
        blockService.getBlockFollows(user.identityId)
      ])

      if (follows.length === 0) {
        setFollowedUsers([])
        return
      }

      // Create a set of users whose blocks we're following
      const blockFollowSet = new Set(blockFollows)

      // Get unique identity IDs
      const identityIds = follows.map(f => f.followingId).filter(Boolean)

      // Batch fetch usernames and profiles
      const [dpnsNames, profiles] = await Promise.all([
        Promise.all(identityIds.map(async (id) => {
          try {
            const username = await dpnsService.resolveUsername(id)
            return { id, username }
          } catch {
            return { id, username: null }
          }
        })),
        unifiedProfileService.getProfilesByIdentityIds(identityIds)
      ])

      // Create lookup maps
      const dpnsMap = new Map(dpnsNames.map(item => [item.id, item.username]))
      const profileMap = new Map(profiles.map(p => [p.$ownerId, p]))

      // Build user list
      interface FollowDoc { followingId: string }
      const users: FollowedUserWithBlockStatus[] = follows
        .map((follow: FollowDoc) => {
          const followingId = follow.followingId
          if (!followingId) return null

          const username = dpnsMap.get(followingId)
          const profile = profileMap.get(followingId)

          return {
            id: followingId,
            username: username || undefined,
            displayName: profile?.displayName || username || `User ${followingId.slice(-6)}`,
            isFollowingBlocks: blockFollowSet.has(followingId),
            hasDpns: !!username
          }
        })
        .filter(Boolean) as FollowedUserWithBlockStatus[]

      // Sort: users we're following blocks from first
      users.sort((a, b) => {
        if (a.isFollowingBlocks && !b.isFollowingBlocks) return -1
        if (!a.isFollowingBlocks && b.isFollowingBlocks) return 1
        return 0
      })

      setFollowedUsers(users)
    } catch (error) {
      console.error('Error loading block list settings:', error)
      toast.error('Failed to load block lists')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId])

  useEffect(() => {
    loadData().catch(err => console.error('Failed to load block list data:', err))
  }, [loadData])

  const handleToggle = async (targetUserId: string, currentlyFollowing: boolean) => {
    if (!user?.identityId || togglingId) return

    // Check if at max capacity when trying to follow
    const currentFollowingCount = followedUsers.filter(u => u.isFollowingBlocks).length
    if (!currentlyFollowing && currentFollowingCount >= MAX_BLOCK_FOLLOWS) {
      toast.error(`Maximum ${MAX_BLOCK_FOLLOWS} block lists reached`)
      return
    }

    setTogglingId(targetUserId)

    // Optimistic update
    setFollowedUsers(prev =>
      prev.map(u =>
        u.id === targetUserId ? { ...u, isFollowingBlocks: !currentlyFollowing } : u
      )
    )

    try {
      const { blockService } = await import('@/lib/services/block-service')

      const result = currentlyFollowing
        ? await blockService.unfollowUserBlocks(user.identityId, targetUserId)
        : await blockService.followUserBlocks(user.identityId, targetUserId)

      if (!result.success) {
        throw new Error(result.error || 'Operation failed')
      }

      toast.success(currentlyFollowing ? 'Stopped following block list' : 'Following block list')
    } catch (error) {
      // Rollback
      setFollowedUsers(prev =>
        prev.map(u =>
          u.id === targetUserId ? { ...u, isFollowingBlocks: currentlyFollowing } : u
        )
      )
      console.error('Error toggling block follow:', error)
      toast.error('Failed to update block list')
    } finally {
      setTogglingId(null)
    }
  }

  const followingBlocksCount = followedUsers.filter(u => u.isFollowingBlocks).length

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <UserGroupIcon className="h-5 w-5" />
          <h3 className="font-semibold">Block Lists</h3>
        </div>
        <p className="text-sm text-gray-500">
          Follow trusted users&apos; block lists to help filter your feed
        </p>
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex items-center justify-between p-3 bg-surface-1 dark:bg-surface-2 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
                <div>
                  <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
                  <div className="h-3 w-16 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                </div>
              </div>
              <div className="h-6 w-11 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <UserGroupIcon className="h-5 w-5" />
        <h3 className="font-semibold">Block Lists</h3>
      </div>
      <p className="text-sm text-gray-500">
        Follow trusted users&apos; block lists to help filter your feed. When enabled, anyone they block will also be hidden from your feed.
      </p>

      {followedUsers.length === 0 ? (
        <div className="p-4 bg-surface-1 dark:bg-surface-2 rounded-lg text-center">
          <p className="text-gray-500 text-sm">You&apos;re not following anyone yet</p>
          <p className="text-gray-400 text-xs mt-1">Follow users to see them here</p>
        </div>
      ) : (
        <>
          <div className="space-y-1 divide-y divide-border border border-border rounded-lg overflow-hidden">
            {followedUsers.map(followedUser => (
              <div
                key={followedUser.id}
                className="flex items-center justify-between p-3 bg-surface-0 dark:bg-surface-1 hover:bg-surface-1 dark:hover:bg-surface-2 transition-colors"
              >
                <Link
                  href={`/user?id=${followedUser.id}`}
                  className="flex items-center gap-3 hover:opacity-80 transition-opacity min-w-0 flex-1"
                >
                  <UserAvatar userId={followedUser.id} size="sm" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{followedUser.displayName}</p>
                    {followedUser.hasDpns && followedUser.username && (
                      <p className="text-sm text-gray-500 truncate">@{followedUser.username}</p>
                    )}
                  </div>
                </Link>
                <SettingsSwitch
                  checked={followedUser.isFollowingBlocks}
                  onCheckedChange={() => handleToggle(followedUser.id, followedUser.isFollowingBlocks)}
                  disabled={togglingId === followedUser.id}
                  className="flex-shrink-0 ml-3"
                />
              </div>
            ))}
          </div>

          <p className="text-sm text-gray-500">
            Following {followingBlocksCount} block {followingBlocksCount === 1 ? 'list' : 'lists'}
            {followingBlocksCount >= MAX_BLOCK_FOLLOWS && (
              <span className="text-orange-500 ml-1">(maximum reached)</span>
            )}
          </p>
        </>
      )}
    </div>
  )
}
