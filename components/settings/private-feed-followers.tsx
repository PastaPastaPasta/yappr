'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  UserGroupIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import Link from 'next/link'
import { TREE_CAPACITY } from '@/lib/services'
import { usePrivateFeedRefreshStore } from '@/lib/stores/private-feed-refresh-store'
import { resolveUserDetails, type UserDetails } from '@/lib/utils/resolve-user-details'

interface PrivateFollower extends UserDetails {
  grantedAt: Date
  leafIndex: number
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function PrivateFeedFollowers() {
  const { user } = useAuth()
  const [followers, setFollowers] = useState<PrivateFollower[]>([])
  const [filteredFollowers, setFilteredFollowers] = useState<PrivateFollower[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
  const [hasPrivateFeed, setHasPrivateFeed] = useState(false)
  const refreshKey = usePrivateFeedRefreshStore((s) => s.refreshKey)

  const loadFollowers = useCallback(async () => {
    if (!user?.identityId) {
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const { privateFeedService } = await import('@/lib/services')

      // Check if user has private feed enabled
      const hasFeed = await privateFeedService.hasPrivateFeed(user.identityId)
      setHasPrivateFeed(hasFeed)

      if (!hasFeed) {
        setFollowers([])
        return
      }

      // Get all private followers
      const grants = await privateFeedService.getPrivateFollowers(user.identityId)

      if (grants.length === 0) {
        setFollowers([])
        return
      }

      // Resolve usernames and profiles for followers
      const followersWithDetails = await Promise.all(
        grants.map(async (grant) => {
          const details = await resolveUserDetails(grant.recipientId)
          return {
            ...details,
            grantedAt: new Date(grant.grantedAt),
            leafIndex: grant.leafIndex,
          }
        })
      )

      // Sort by granted date (newest first)
      followersWithDetails.sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())
      setFollowers(followersWithDetails)
      setFilteredFollowers(followersWithDetails)
    } catch (error) {
      logger.error('Error loading private followers:', error)
      toast.error('Failed to load private followers')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId])

  useEffect(() => {
    loadFollowers().catch((err) => logger.error('Failed to load private followers:', err))
  }, [loadFollowers, refreshKey])

  // Filter followers based on search query
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredFollowers(followers)
      return
    }

    const query = searchQuery.toLowerCase()
    const filtered = followers.filter(
      (f) =>
        f.displayName.toLowerCase().includes(query) ||
        (f.username && f.username.toLowerCase().includes(query))
    )
    setFilteredFollowers(filtered)
  }, [searchQuery, followers])

  const handleRevokeClick = (followerId: string) => {
    setConfirmRevokeId(followerId)
  }

  const handleCancelRevoke = () => {
    setConfirmRevokeId(null)
  }

  const handleConfirmRevoke = async (follower: PrivateFollower) => {
    if (!user?.identityId || revokingId) return

    setRevokingId(follower.id)
    setConfirmRevokeId(null)

    try {
      const { privateFeedService } = await import('@/lib/services')
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')

      // Try to get encryption key for automatic sync/recovery (handles WIF and hex)
      const encryptionPrivateKey = getEncryptionKeyBytes(user.identityId) ?? undefined

      const result = await privateFeedService.revokeFollower(
        user.identityId,
        follower.id,
        encryptionPrivateKey
      )

      if (result.success) {
        // Remove from local state
        setFollowers((prev) => prev.filter((f) => f.id !== follower.id))
        toast.success(
          `Revoked access for ${follower.username ? `@${follower.username}` : follower.displayName}`
        )
      } else {
        // Check if this is a sync required error
        if (result.error?.startsWith('SYNC_REQUIRED:')) {
          const { useEncryptionKeyModal } = await import('@/hooks/use-encryption-key-modal')
          useEncryptionKeyModal.getState().open('sync_state', () => {
            toast('Please try revoking again now that your keys are synced')
          })
          toast.error('Your private feed state needs to sync. Please enter your encryption key.')
          setRevokingId(null)
          return
        }
        throw new Error(result.error || 'Failed to revoke access')
      }
    } catch (error) {
      logger.error('Error revoking follower:', error)
      toast.error('Failed to revoke access')
    } finally {
      setRevokingId(null)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserGroupIcon className="h-5 w-5" />
            Private Followers
          </CardTitle>
          <CardDescription>Manage who can access your private posts</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-950 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
                  <div>
                    <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
                    <div className="h-3 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                  </div>
                </div>
                <div className="h-8 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!hasPrivateFeed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserGroupIcon className="h-5 w-5" />
            Private Followers
          </CardTitle>
          <CardDescription>Manage who can access your private posts</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg text-center">
            <LockClosedIcon className="h-8 w-8 mx-auto text-gray-400 mb-2" />
            <p className="text-gray-500 text-sm">
              Enable your private feed to manage followers
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserGroupIcon className="h-5 w-5" />
          Private Followers
          <span className="ml-auto text-sm font-normal text-gray-500">
            {followers.length}/{TREE_CAPACITY}
          </span>
        </CardTitle>
        <CardDescription>Manage who can access your private posts</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {followers.length > 0 && (
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              data-testid="follower-search"
              placeholder="Search followers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        {followers.length === 0 ? (
          <div className="text-center py-8">
            <UserGroupIcon className="h-12 w-12 mx-auto text-gray-300 dark:text-gray-700 mb-3" />
            <p className="text-gray-500 text-sm">No private followers yet</p>
            <p className="text-gray-400 text-xs mt-1">
              Approve follow requests to grant access to your private posts
            </p>
          </div>
        ) : filteredFollowers.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-4">
            No followers match your search
          </p>
        ) : (
          <div className="space-y-3">
            {filteredFollowers.map((follower) => (
              <div
                key={follower.id}
                data-testid={`follower-card-${follower.id}`}
                className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-950 rounded-lg"
              >
                <Link
                  href={`/user?id=${follower.id}`}
                  className="flex items-center gap-3 hover:opacity-80 transition-opacity flex-1 min-w-0"
                >
                  <UserAvatar userId={follower.id} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{follower.displayName}</p>
                    {follower.hasDpns && follower.username && (
                      <p className="text-sm text-gray-500 truncate">@{follower.username}</p>
                    )}
                    <p className="text-xs text-gray-400">
                      Following since {formatDate(follower.grantedAt)}
                    </p>
                  </div>
                </Link>
                <div className="flex-shrink-0 ml-2">
                  {confirmRevokeId === follower.id ? (
                    <div className="flex flex-col gap-2">
                      <Button
                        data-testid={`confirm-revoke-btn-${follower.id}`}
                        variant="destructive"
                        size="sm"
                        onClick={() => handleConfirmRevoke(follower)}
                        disabled={revokingId === follower.id}
                      >
                        {revokingId === follower.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          'Confirm'
                        )}
                      </Button>
                      <Button
                        data-testid={`cancel-revoke-btn-${follower.id}`}
                        variant="outline"
                        size="sm"
                        onClick={handleCancelRevoke}
                        disabled={revokingId === follower.id}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      data-testid={`revoke-btn-${follower.id}`}
                      variant="outline"
                      size="sm"
                      onClick={() => handleRevokeClick(follower.id)}
                      disabled={revokingId !== null}
                      className="text-red-600 hover:text-red-700 hover:border-red-300"
                    >
                      <ExclamationTriangleIcon className="h-4 w-4 mr-1" />
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {followers.length > 0 && (
          <div className="pt-4 border-t text-xs text-gray-500">
            <p>
              Revoking access will prevent the user from seeing your future private posts. They
              will still be able to see posts from when they had access.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
