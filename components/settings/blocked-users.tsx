'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useRequireAuth } from '@/hooks/use-require-auth'
import { Button } from '@/components/ui/button'
import { UserAvatar } from '@/components/ui/avatar-image'
import { NoSymbolIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import Link from 'next/link'
import { resolveUserDetails, type UserDetails } from '@/lib/utils/resolve-user-details'

export function BlockedUsersSettings() {
  const { user } = useAuth()
  const { requireAuth } = useRequireAuth()
  const [blockedUsers, setBlockedUsers] = useState<UserDetails[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [unblockingId, setUnblockingId] = useState<string | null>(null)

  const loadBlockedUsers = useCallback(async () => {
    if (!user?.identityId) {
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const { blockService } = await import('@/lib/services/block-service')

      const blocks = await blockService.getUserBlocks(user.identityId)

      if (blocks.length === 0) {
        setBlockedUsers([])
        return
      }

      const usersWithDetails = await Promise.all(
        blocks.map((block) => resolveUserDetails(block.blockedId))
      )

      setBlockedUsers(usersWithDetails)
    } catch (error) {
      console.error('Error loading blocked users:', error)
      toast.error('Failed to load blocked users')
    } finally {
      setIsLoading(false)
    }
  }, [user?.identityId])

  useEffect(() => {
    loadBlockedUsers().catch(err => console.error('Failed to load blocked users:', err))
  }, [loadBlockedUsers])

  const handleUnblock = async (blockedUserId: string) => {
    const authedUser = requireAuth('block')
    if (!authedUser || unblockingId) return

    setUnblockingId(blockedUserId)

    try {
      const { blockService } = await import('@/lib/services/block-service')
      const result = await blockService.unblockUser(authedUser.identityId, blockedUserId)

      if (result.success) {
        // Remove from local state
        setBlockedUsers(prev => prev.filter(u => u.id !== blockedUserId))
        toast.success('User unblocked')
      } else {
        throw new Error(result.error || 'Failed to unblock user')
      }
    } catch (error) {
      console.error('Error unblocking user:', error)
      toast.error('Failed to unblock user')
    } finally {
      setUnblockingId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <NoSymbolIcon className="h-5 w-5" />
          <h3 className="font-semibold">Blocked Users</h3>
        </div>
        <div className="space-y-3">
          {[1, 2].map(i => (
            <div key={i} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-950 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
                <div>
                  <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse mb-1" />
                  <div className="h-3 w-16 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
                </div>
              </div>
              <div className="h-8 w-20 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <NoSymbolIcon className="h-5 w-5" />
        <h3 className="font-semibold">Blocked Users</h3>
      </div>

      {blockedUsers.length === 0 ? (
        <p className="text-gray-500 text-sm">You haven&apos;t blocked anyone</p>
      ) : (
        <div className="space-y-3">
          {blockedUsers.map(blockedUser => (
            <div
              key={blockedUser.id}
              className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-950 rounded-lg"
            >
              <Link
                href={`/user?id=${blockedUser.id}`}
                className="flex items-center gap-3 hover:opacity-80 transition-opacity"
              >
                <UserAvatar userId={blockedUser.id} size="md" />
                <div>
                  <p className="font-medium">{blockedUser.displayName}</p>
                  {blockedUser.hasDpns && blockedUser.username && (
                    <p className="text-sm text-gray-500">@{blockedUser.username}</p>
                  )}
                </div>
              </Link>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleUnblock(blockedUser.id)}
                disabled={unblockingId === blockedUser.id}
              >
                {unblockingId === blockedUser.id ? 'Unblocking...' : 'Unblock'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
