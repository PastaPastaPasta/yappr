'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  LockClosedIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { formatTime } from '@/lib/utils'
import Link from 'next/link'
import { usePrivateFeedRefreshStore } from '@/lib/stores/private-feed-refresh-store'
import { withoutRevokedGrants } from '@/lib/utils/revoked-grants'
import { resolveUserDetailsBatch } from '@/lib/utils/resolve-user-details'

interface ActivityItem {
  id: string
  type: 'approved' | 'revoked'
  userId: string
  username?: string
  displayName: string
  timestamp: Date
}

/**
 * PrivateFeedDashboard Component
 *
 * Dashboard showing the private feed's followers, waiting requests and recent
 * activity. Capacity numbers stay hidden; only a warning shows when the feed is
 * nearly full.
 * Implements PRD §4.10 - Private Feed Owner Dashboard
 */
export function PrivateFeedDashboard() {
  const { user } = useAuth()
  const [isLoading, setIsLoading] = useState(true)
  const [isEnabled, setIsEnabled] = useState(false)
  const [followerCount, setFollowerCount] = useState(0)
  const [pendingRequestCount, setPendingRequestCount] = useState(0)
  const [currentKeyGeneration, setCurrentKeyGeneration] = useState(1)
  const [caps, setCaps] = useState({ treeCapacity: 0, maxKeyGeneration: 2 })
  const [recentActivity, setRecentActivity] = useState<ActivityItem[]>([])
  const requestIdRef = useRef(0)
  const refreshKey = usePrivateFeedRefreshStore((s) => s.refreshKey)

  const loadDashboardData = useCallback(async () => {
    // Increment request ID to track this specific request
    const currentRequestId = ++requestIdRef.current

    if (!user?.identityId) {
      setIsLoading(false)
      setIsEnabled(false)
      setFollowerCount(0)
      setPendingRequestCount(0)
      setRecentActivity([])
      return
    }

    try {
      const { privateFeedService } = await import('@/lib/services')
      const overview = await privateFeedService.getOverview(user.identityId)

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return

      setIsEnabled(overview !== null)

      if (!overview) {
        setIsLoading(false)
        return
      }
      const { fetchRekeys } = await import('@/lib/services/private-feed-reads')

      // The current feed's followers, without any revoked in this session
      const followers = withoutRevokedGrants(
        overview.followers,
        usePrivateFeedRefreshStore.getState().revokedGrantsFor(user.identityId)
      )
      setFollowerCount(followers.length)
      setCaps({ treeCapacity: overview.feed.treeCapacity, maxKeyGeneration: overview.feed.maxKeyGeneration })
      setCurrentKeyGeneration(overview.keyGeneration)

      const [requests, rekeyDocs] = await Promise.all([
        privateFeedService.getPendingRequests(user.identityId),
        fetchRekeys(user.identityId, overview.feed.feed),
      ])

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return

      setPendingRequestCount(requests.length)

      // Build recent activity from grants (approvals) and rekey documents (revocations)
      const activity: ActivityItem[] = []

      // Add approved followers as activity (sort by grantedAt descending to get most recent)
      const sortedFollowers = [...followers].sort((a, b) => b.grantedAt - a.grantedAt)
      const users = await resolveUserDetailsBatch(sortedFollowers.slice(0, 5).map(follower => follower.recipientId))
      for (const follower of sortedFollowers.slice(0, 5)) {
        // Bail out if a newer request has started
        if (currentRequestId !== requestIdRef.current) return

        const details = users.get(follower.recipientId) ?? { id: follower.recipientId, displayName: `User ${follower.recipientId.slice(-6)}`, hasDpns: false }

        activity.push({
          id: `grant-${follower.recipientId}`,
          type: 'approved',
          userId: follower.recipientId,
          username: details.username,
          displayName: details.displayName,
          timestamp: new Date(follower.grantedAt),
        })
      }

      // Bail out if a newer request has started
      if (currentRequestId !== requestIdRef.current) return


      // Rekeys identify a tree position, so use a neutral label for removal activity.
      for (const rekey of rekeyDocs.slice(-5).reverse()) {
        activity.push({
          id: `rekey-${rekey.keyGeneration}`,
          type: 'revoked',
          userId: '',
          displayName: 'Follower',
          timestamp: new Date(rekey.createdAt),
        })
      }

      // Sort by timestamp descending and take top 5
      activity.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

      // Final bail out check before setting state
      if (currentRequestId !== requestIdRef.current) return

      setRecentActivity(activity.slice(0, 5))

    } catch (error) {
      logger.error('Error loading dashboard data:', error)
    } finally {
      // Only update loading state if this is still the current request
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [user?.identityId])

  useEffect(() => {
    loadDashboardData().catch(err => logger.error('Failed to load dashboard:', err))
  }, [loadDashboardData, refreshKey])

  // Calculate key generation usage percentage with clamping to avoid NaN/overflow
  const rawKeyGenerationPercent = caps.maxKeyGeneration > 1 ? ((currentKeyGeneration - 1) / (caps.maxKeyGeneration - 1)) * 100 : 0
  const keyGenerationUsagePercent = Math.max(0, Math.min(100, rawKeyGenerationPercent))
  const isKeyGenerationWarning = keyGenerationUsagePercent > 90
  const isFollowerWarning = caps.treeCapacity > 0 && followerCount >= caps.treeCapacity * 0.9

  // Don't render anything if private feed is not enabled
  if (!isLoading && !isEnabled) {
    return null
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockClosedIcon className="h-5 w-5" />
            Your Private Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
              <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
              <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
            </div>
            <div className="h-16 bg-gray-200 dark:bg-gray-800 rounded-lg"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LockClosedIcon className="h-5 w-5" />
          Your Private Feed
        </CardTitle>
        <CardDescription>
          Overview of your private feed activity and stats
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <p data-testid="private-feed-summary" className="text-sm text-gray-600 dark:text-gray-400">
          {followerCount} {followerCount === 1 ? 'follower' : 'followers'}
          {pendingRequestCount > 0 && ` · ${pendingRequestCount} waiting for approval`}
        </p>
        {(isKeyGenerationWarning || isFollowerWarning) && (
          <p data-testid="private-feed-nearly-full" role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {isFollowerWarning
              ? 'Your private feed is almost full. Renew it above to approve more followers.'
              : 'Your private feed is almost full. Renew it above to keep removing followers.'}
          </p>
        )}

        {/* Recent Activity */}
        {recentActivity.length > 0 && (
          <div data-testid="recent-activity" className="border-t pt-4">
            <h4 className="font-medium text-sm mb-3">Recent Activity</h4>
            <div className="space-y-2">
              {recentActivity.map((activity) => (
                <div
                  key={activity.id}
                  className="flex items-center gap-3 text-sm py-2 px-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                >
                  {activity.type === 'approved' ? (
                    <CheckCircleIcon className="h-4 w-4 text-green-500 flex-shrink-0" />
                  ) : (
                    <XCircleIcon className="h-4 w-4 text-red-500 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    {activity.type === 'approved' ? (
                      <span>
                        {activity.username ? (
                          <Link
                            href={`/user?id=${activity.userId}`}
                            className="font-medium text-yappr-600 hover:underline"
                          >
                            @{activity.username}
                          </Link>
                        ) : (
                          <span className="font-medium">{activity.displayName}</span>
                        )}
                        {' '}approved
                      </span>
                    ) : (
                      <span>
                        <span className="font-medium">{activity.displayName}</span>
                        {' '}removed
                      </span>
                    )}
                  </div>
                  <span className="text-gray-500 text-xs whitespace-nowrap">
                    {formatTime(activity.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
